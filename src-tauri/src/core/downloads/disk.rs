//! ATO-467: turning `disk_io` into something actionable.
//!
//! `disk_io` is the largest single cause of failed model downloads — bigger
//! than the network — but it is one bucket covering at least five unrelated
//! faults (no space, no permission, file locked by another process, path over
//! the Windows limit, removable volume unplugged mid-transfer). Nothing can be
//! fixed while they are indistinguishable, so every filesystem error raised on
//! the download path is tagged here with the subcause, and the two faults we
//! can see coming — no space, path too long — are checked before the first
//! byte is fetched instead of at 80% of a 20 GB transfer.
//!
//! The tag travels to the frontend inside the error string as a `[tag]`
//! prefix (`classifyDownloadFailure` in `web-app/src/lib/telemetry.ts` reads
//! it) because the download boundary is stringly-typed all the way to the
//! `model_download` PostHog event. Tags are an enum, never free text, and
//! carry no path or hostname — the PII contract for the event still holds.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// Subcauses of a filesystem failure. Kept in sync with `DownloadFailureReason`
/// on the frontend; `disk_io` stays the catch-all so the split is additive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiskFault {
    Full,
    Permission,
    FileLocked,
    PathTooLong,
    DeviceLost,
    Other,
}

impl DiskFault {
    pub fn tag(self) -> &'static str {
        match self {
            Self::Full => "disk_full",
            Self::Permission => "disk_permission",
            Self::FileLocked => "disk_file_locked",
            Self::PathTooLong => "disk_path_too_long",
            Self::DeviceLost => "disk_device_lost",
            Self::Other => "disk_io",
        }
    }
}

// Windows system error codes. `std::io::ErrorKind` collapses most of these into
// `Other`/`PermissionDenied`, so the raw code is the only way to tell "the
// antivirus is holding the file" from "the directory is read-only".
#[cfg(windows)]
mod win_codes {
    pub const ERROR_ACCESS_DENIED: i32 = 5;
    pub const ERROR_PATH_NOT_FOUND: i32 = 3;
    pub const ERROR_NOT_READY: i32 = 21;
    pub const ERROR_SHARING_VIOLATION: i32 = 32;
    pub const ERROR_LOCK_VIOLATION: i32 = 33;
    pub const ERROR_HANDLE_DISK_FULL: i32 = 39;
    pub const ERROR_DEV_NOT_EXIST: i32 = 55;
    pub const ERROR_NETNAME_DELETED: i32 = 64;
    pub const ERROR_DISK_FULL: i32 = 112;
    pub const ERROR_BUFFER_OVERFLOW: i32 = 111;
    pub const ERROR_FILENAME_EXCED_RANGE: i32 = 206;
    pub const ERROR_WRITE_PROTECT: i32 = 19;
}

/// Classify an `io::Error` from the download write path into a subcause.
pub fn classify_io_error(error: &std::io::Error) -> DiskFault {
    if let Some(code) = error.raw_os_error() {
        if let Some(fault) = classify_raw_os_error(code) {
            return fault;
        }
    }

    // No raw code (or an unmapped one): fall back to the portable kind.
    match error.kind() {
        ErrorKind::PermissionDenied => DiskFault::Permission,
        ErrorKind::NotFound => DiskFault::DeviceLost,
        ErrorKind::StorageFull => DiskFault::Full,
        _ => DiskFault::Other,
    }
}

#[cfg(unix)]
fn classify_raw_os_error(code: i32) -> Option<DiskFault> {
    // ENOSPC and EDQUOT both mean "the write has nowhere to go" to the user,
    // even though only one of them is the physical disk being full.
    match code {
        libc::ENOSPC | libc::EDQUOT | libc::EFBIG => Some(DiskFault::Full),
        libc::EACCES | libc::EPERM | libc::EROFS => Some(DiskFault::Permission),
        libc::ETXTBSY | libc::EBUSY => Some(DiskFault::FileLocked),
        libc::ENAMETOOLONG => Some(DiskFault::PathTooLong),
        // A network share or external disk that went away mid-transfer surfaces
        // as the path or the device itself disappearing.
        libc::ENODEV | libc::ENXIO | libc::ESTALE | libc::EIO => Some(DiskFault::DeviceLost),
        _ => None,
    }
}

#[cfg(windows)]
fn classify_raw_os_error(code: i32) -> Option<DiskFault> {
    use win_codes::*;
    match code {
        ERROR_DISK_FULL | ERROR_HANDLE_DISK_FULL => Some(DiskFault::Full),
        ERROR_ACCESS_DENIED | ERROR_WRITE_PROTECT => Some(DiskFault::Permission),
        // The classic Windows failure on multi-gigabyte writes: a realtime
        // antivirus scanner holds the handle while we are still appending.
        ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION => Some(DiskFault::FileLocked),
        ERROR_FILENAME_EXCED_RANGE | ERROR_BUFFER_OVERFLOW => Some(DiskFault::PathTooLong),
        ERROR_PATH_NOT_FOUND | ERROR_NOT_READY | ERROR_DEV_NOT_EXIST | ERROR_NETNAME_DELETED => {
            Some(DiskFault::DeviceLost)
        }
        _ => None,
    }
}

#[cfg(not(any(unix, windows)))]
fn classify_raw_os_error(_code: i32) -> Option<DiskFault> {
    None
}

/// Render a filesystem error for the frontend, tagged with its subcause.
///
/// Mirrors `err_to_string`'s `Error: ` prefix so existing frontend matching on
/// the message body keeps working; the tag is additive.
pub fn disk_err_to_string(error: &std::io::Error) -> String {
    format!("Error: [{}] {error}", classify_io_error(error).tag())
}

/// Render a preflight refusal (no `io::Error` behind it) with the same tag
/// shape, so both sides of the check classify identically.
pub fn disk_fault_message(fault: DiskFault, detail: &str) -> String {
    format!("Error: [{}] {detail}", fault.tag())
}

// ===== Preflight: free space =====

/// Bytes we refuse to consume on top of the download itself. A volume driven to
/// literally zero free bytes takes the rest of the app down with it (logs, the
/// thread database, the model index), so the download is not allowed to claim
/// the last of it.
pub const FREE_SPACE_HEADROOM: u64 = 512 * 1024 * 1024;

/// Available bytes on the volume holding `path`, or `None` when the volume
/// cannot be identified.
///
/// `path` need not exist yet — matching is by mount point prefix, so a model
/// directory about to be created resolves to its future volume.
pub fn available_space_for(path: &Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();

    // Longest matching mount point wins: `/` matches everything, so a nested
    // mount like `/home` or `D:\` has to be preferred over it.
    disks
        .list()
        .iter()
        .filter(|disk| path.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(|disk| disk.available_space())
}

/// How many bytes of `total_size` still have to be written, given the partial
/// files already on disk for a resumed download.
///
/// Without this a resumed 20 GB download would be refused on a disk with 19 GB
/// free even when 15 GB of it is already downloaded.
pub fn remaining_bytes(total_size: u64, partial_paths: &[PathBuf]) -> u64 {
    let already: u64 = partial_paths
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok())
        .map(|meta| meta.len())
        .sum();
    total_size.saturating_sub(already)
}

/// Refuse the download before the first byte when the volume cannot hold it.
///
/// Returns `Ok(())` when there is room *or* when free space could not be
/// determined — an unidentifiable volume is not a reason to block a download
/// that might well succeed.
pub fn ensure_free_space(target_dir: &Path, needed: u64) -> Result<(), String> {
    if needed == 0 {
        return Ok(());
    }
    let Some(available) = available_space_for(target_dir) else {
        log::warn!(
            "Could not determine free space for {}; skipping preflight",
            target_dir.display()
        );
        return Ok(());
    };

    let required = needed.saturating_add(FREE_SPACE_HEADROOM);
    if available >= required {
        return Ok(());
    }

    log::warn!(
        "Refusing download: needs {} bytes (+{} headroom), {} available",
        needed,
        FREE_SPACE_HEADROOM,
        available
    );
    Err(disk_fault_message(
        DiskFault::Full,
        &format!(
            "Not enough free disk space: {} needed, {} available",
            format_bytes(required),
            format_bytes(available)
        ),
    ))
}

/// Human-readable size for the message the user actually reads.
pub fn format_bytes(bytes: u64) -> String {
    const GB: f64 = (1024 * 1024 * 1024) as f64;
    const MB: f64 = (1024 * 1024) as f64;
    let bytes = bytes as f64;
    if bytes >= GB {
        format!("{:.1} GB", bytes / GB)
    } else {
        format!("{:.0} MB", (bytes / MB).max(1.0))
    }
}

// ===== Preflight: Windows path length =====

/// Legacy `MAX_PATH`. Long-path support needs both a `longPathAware` manifest
/// and an opt-in registry key, so a path over this limit fails on a large share
/// of installs regardless of what the app declares.
#[cfg(windows)]
const MAX_PATH: usize = 260;

/// Reject a save path that will not survive the Windows path limit.
///
/// HuggingFace repo ids nest deeply (`unsloth/Model-Name-Long-GGUF/file.gguf`)
/// under an already-long per-user data folder, and the downloader appends
/// `.tmp` on top, so the partial file is what actually overflows first — that
/// is the length checked here.
#[cfg(windows)]
pub fn ensure_path_within_limit(save_path: &Path) -> Result<(), String> {
    // A verbatim path (`\\?\C:\...`) bypasses the limit entirely.
    let text = save_path.to_string_lossy();
    if text.starts_with(r"\\?\") {
        return Ok(());
    }

    // `.tmp` is appended to the save path while downloading, and the `.url`
    // sidecar is the same length, so the partial is the longest name we write.
    let effective = text.chars().count() + ".tmp".len();
    if effective < MAX_PATH {
        return Ok(());
    }

    log::warn!("Refusing download: save path is {effective} chars, over the {MAX_PATH} limit");
    Err(disk_fault_message(
        DiskFault::PathTooLong,
        &format!(
            "File path is {effective} characters, over the {MAX_PATH}-character Windows limit. \
             Move the Jan data folder closer to the drive root and retry."
        ),
    ))
}

#[cfg(not(windows))]
pub fn ensure_path_within_limit(_save_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os_error(code: i32) -> std::io::Error {
        std::io::Error::from_raw_os_error(code)
    }

    #[test]
    fn tags_are_stable() {
        // The frontend enum (`DownloadFailureReason`) is keyed off these exact
        // strings, and so is every saved PostHog insight. Renaming one silently
        // splits a metric in half.
        assert_eq!(DiskFault::Full.tag(), "disk_full");
        assert_eq!(DiskFault::Permission.tag(), "disk_permission");
        assert_eq!(DiskFault::FileLocked.tag(), "disk_file_locked");
        assert_eq!(DiskFault::PathTooLong.tag(), "disk_path_too_long");
        assert_eq!(DiskFault::DeviceLost.tag(), "disk_device_lost");
        assert_eq!(DiskFault::Other.tag(), "disk_io");
    }

    #[cfg(unix)]
    #[test]
    fn classifies_unix_errno() {
        assert_eq!(classify_io_error(&os_error(libc::ENOSPC)), DiskFault::Full);
        assert_eq!(classify_io_error(&os_error(libc::EDQUOT)), DiskFault::Full);
        assert_eq!(
            classify_io_error(&os_error(libc::EACCES)),
            DiskFault::Permission
        );
        assert_eq!(
            classify_io_error(&os_error(libc::EROFS)),
            DiskFault::Permission
        );
        assert_eq!(
            classify_io_error(&os_error(libc::ENAMETOOLONG)),
            DiskFault::PathTooLong
        );
        assert_eq!(
            classify_io_error(&os_error(libc::ENODEV)),
            DiskFault::DeviceLost
        );
        assert_eq!(
            classify_io_error(&os_error(libc::ETXTBSY)),
            DiskFault::FileLocked
        );
    }

    #[cfg(windows)]
    #[test]
    fn classifies_windows_codes() {
        use win_codes::*;
        assert_eq!(
            classify_io_error(&os_error(ERROR_DISK_FULL)),
            DiskFault::Full
        );
        assert_eq!(
            classify_io_error(&os_error(ERROR_ACCESS_DENIED)),
            DiskFault::Permission
        );
        // The antivirus-holds-the-file case, indistinguishable from a plain
        // write error before this split.
        assert_eq!(
            classify_io_error(&os_error(ERROR_SHARING_VIOLATION)),
            DiskFault::FileLocked
        );
        assert_eq!(
            classify_io_error(&os_error(ERROR_FILENAME_EXCED_RANGE)),
            DiskFault::PathTooLong
        );
        assert_eq!(
            classify_io_error(&os_error(ERROR_NOT_READY)),
            DiskFault::DeviceLost
        );
    }

    #[test]
    fn unmapped_errors_stay_in_the_catch_all() {
        let error = std::io::Error::other("something we have never seen");
        assert_eq!(classify_io_error(&error), DiskFault::Other);
        assert!(disk_err_to_string(&error).starts_with("Error: [disk_io] "));
    }

    #[test]
    fn tagged_message_keeps_the_legacy_prefix() {
        // Frontend classification falls back to substring matching on the
        // message body for clients that predate the tag, so the body has to
        // survive alongside it.
        let message = disk_err_to_string(&os_error(28));
        assert!(message.starts_with("Error: ["), "got {message}");
        assert!(message.contains("os error 28"), "got {message}");
    }

    #[test]
    fn remaining_bytes_discounts_existing_partials() {
        let dir = tempfile::tempdir().unwrap();
        let partial = dir.path().join("model.gguf.tmp");
        std::fs::write(&partial, vec![0u8; 4096]).unwrap();

        assert_eq!(remaining_bytes(10_000, &[partial.clone()]), 10_000 - 4096);
        // A partial that is not there yet must not underflow the requirement.
        assert_eq!(
            remaining_bytes(10_000, &[dir.path().join("absent.tmp")]),
            10_000
        );
        // Nor may a partial larger than the total wrap around.
        assert_eq!(remaining_bytes(1_000, &[partial]), 0);
    }

    #[test]
    fn free_space_check_passes_when_nothing_is_needed() {
        let dir = tempfile::tempdir().unwrap();
        assert!(ensure_free_space(dir.path(), 0).is_ok());
    }

    #[test]
    fn free_space_check_refuses_an_impossible_download() {
        let dir = tempfile::tempdir().unwrap();
        // Skip on a host whose volume we cannot identify — there the check is
        // deliberately a no-op rather than a false refusal.
        if available_space_for(dir.path()).is_none() {
            return;
        }
        let error = ensure_free_space(dir.path(), u64::MAX / 2).unwrap_err();
        assert!(error.starts_with("Error: [disk_full] "), "got {error}");
    }

    #[test]
    fn free_space_check_allows_a_download_that_fits() {
        let dir = tempfile::tempdir().unwrap();
        assert!(ensure_free_space(dir.path(), 1024).is_ok());
    }

    #[test]
    fn formats_sizes_for_humans() {
        assert_eq!(format_bytes(0), "1 MB");
        assert_eq!(format_bytes(700 * 1024 * 1024), "700 MB");
        assert_eq!(format_bytes(3 * 1024 * 1024 * 1024), "3.0 GB");
    }

    #[cfg(windows)]
    #[test]
    fn rejects_paths_over_the_windows_limit() {
        let long = PathBuf::from(format!(r"C:\{}\model.gguf", "x".repeat(300)));
        let error = ensure_path_within_limit(&long).unwrap_err();
        assert!(
            error.starts_with("Error: [disk_path_too_long] "),
            "got {error}"
        );

        assert!(ensure_path_within_limit(Path::new(r"C:\jan\model.gguf")).is_ok());
        // A verbatim path is exempt from MAX_PATH entirely.
        let verbatim = PathBuf::from(format!(r"\\?\C:\{}\model.gguf", "x".repeat(300)));
        assert!(ensure_path_within_limit(&verbatim).is_ok());
    }

    #[cfg(not(windows))]
    #[test]
    fn path_limit_is_a_no_op_off_windows() {
        let long = PathBuf::from(format!("/{}/model.gguf", "x".repeat(300)));
        assert!(ensure_path_within_limit(&long).is_ok());
    }
}
