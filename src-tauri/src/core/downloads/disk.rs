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

use super::volume::disk_space_info;
use std::future::Future;
use std::io::ErrorKind;
use std::path::Path;
use std::time::{Duration, Instant};

/// Subcauses of a filesystem failure. Kept in sync with `DownloadFailureReason`
/// on the frontend (and the core's `DISK_ERROR_TAGS`); `disk_io` stays the
/// catch-all so the split is additive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiskFault {
    Full,
    Permission,
    FileLocked,
    PathTooLong,
    DeviceLost,
    /// The file is larger than the volume's file system can store in one file
    /// (FAT32: 4 GiB − 1), however much space is free.
    FsLimit,
    Other,
}

impl DiskFault {
    /// Every subcause, in the order of the frontend's union type.
    pub const ALL: [DiskFault; 7] = [
        Self::Full,
        Self::Permission,
        Self::FileLocked,
        Self::PathTooLong,
        Self::DeviceLost,
        Self::FsLimit,
        Self::Other,
    ];

    pub fn tag(self) -> &'static str {
        match self {
            Self::Full => "disk_full",
            Self::Permission => "disk_permission",
            Self::FileLocked => "disk_file_locked",
            Self::PathTooLong => "disk_path_too_long",
            Self::DeviceLost => "disk_device_lost",
            Self::FsLimit => "disk_fs_limit",
            Self::Other => "disk_io",
        }
    }

    pub fn from_tag(tag: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|fault| fault.tag() == tag)
    }
}

/// The subcause a tagged error message carries, read the way the frontend's
/// `diskFaultTag` reads it: the first `[disk_…]` in the text. An unknown tag
/// is `None`, never a guess.
pub fn disk_fault_in(message: &str) -> Option<DiskFault> {
    let start = message.find("[disk_")? + 1;
    let len = message[start..].find(']')?;
    DiskFault::from_tag(&message[start..start + len])
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
/// the last of it. The floor of [`free_space_headroom`]: the frontend's
/// preflight reads it through [`FreeSpaceReport`].
pub const FREE_SPACE_HEADROOM: u64 = 512 * 1024 * 1024;

/// Share of the download kept free on top of it once that exceeds
/// [`FREE_SPACE_HEADROOM`] (from about 25 GB): file-system metadata, cluster
/// slack and whatever else writes to the volume meanwhile grow with the file.
const FREE_SPACE_HEADROOM_PERCENT: u64 = 2;

/// Headroom for a download of `total_size` bytes: 2% of it, at least
/// [`FREE_SPACE_HEADROOM`].
pub fn free_space_headroom(total_size: u64) -> u64 {
    (total_size / 100)
        .saturating_mul(FREE_SPACE_HEADROOM_PERCENT)
        .max(FREE_SPACE_HEADROOM)
}

/// Available bytes on the volume holding `path`, or `None` when it cannot be
/// measured.
///
/// `path` need not exist yet: the volume is asked about its nearest existing
/// directory, so a model directory about to be created resolves to its future
/// volume (see [`super::volume`]).
pub fn available_space_for(path: &Path) -> Option<u64> {
    disk_space_info(path).ok().map(|info| info.free_bytes)
}

/// What the frontend needs to decide, before it creates a download entry,
/// whether a model will fit: the free bytes on the volume holding the data
/// folder and the headroom `ensure_free_space` will insist on at least (a file
/// over ~25 GB gets 2% of its size, see [`free_space_headroom`]).
/// `available` is `None` when the volume cannot be measured; the frontend then
/// lets the download try and the transfer-time check stays the guard.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreeSpaceReport {
    pub available: Option<u64>,
    pub headroom: u64,
}

pub fn free_space_report(target_dir: &Path) -> FreeSpaceReport {
    FreeSpaceReport {
        available: available_space_for(target_dir),
        headroom: FREE_SPACE_HEADROOM,
    }
}

/// How many bytes of `total_size` still have to be written, given what a
/// resumed download already holds on disk per file.
///
/// Without this a resumed 20 GB download would be refused on a disk with 19 GB
/// free even when 15 GB of it is already downloaded. The counts come from
/// `helpers::bytes_held_on_disk`: a multi-connection partial is created at
/// full size, which NTFS allocates at once, so its whole length is already
/// taken from the free space however little of it is written.
pub fn remaining_bytes(total_size: u64, already_downloaded: &[u64]) -> u64 {
    let already: u64 = already_downloaded.iter().sum();
    total_size.saturating_sub(already)
}

/// Free bytes the volume must have before the first byte of a `total_size`
/// download: what is still to be written plus [`free_space_headroom`], or zero
/// when nothing is left to write.
pub fn required_free_bytes(total_size: u64, already_on_disk: &[u64]) -> u64 {
    let remaining = remaining_bytes(total_size, already_on_disk);
    if remaining == 0 {
        return 0;
    }
    remaining.saturating_add(free_space_headroom(total_size))
}

/// Refuse the download before the first byte when the volume holding `target`
/// does not have `required` bytes free ([`required_free_bytes`]).
///
/// Returns `Ok(())` when there is room *or* when free space could not be
/// measured at all (the direct query and the volume list both failed, which
/// is logged) — an unmeasurable volume is not a reason to block a download
/// that might well succeed.
pub fn ensure_free_space(target: &Path, required: u64) -> Result<(), String> {
    if required == 0 {
        return Ok(());
    }
    let available = available_space_for(target);
    if available.is_none() {
        log::warn!(
            "Could not measure free space for {}; letting the download try",
            target.display()
        );
    }
    check_reported_free_space(available, required)
}

/// The same refusal against a number someone else measured: the core's free space for the
/// managed models root (TensorRT-LLM, vLLM), which on Windows is in the WSL guest where the volume list cannot see
/// (change `add-tensorrt-llm-windows`). `None` — not measured — never refuses.
pub fn check_reported_free_space(available: Option<u64>, required: u64) -> Result<(), String> {
    let Some(available) = available else {
        return Ok(());
    };
    if required == 0 || available >= required {
        return Ok(());
    }

    log::warn!(
        "Refusing download: needs {required} bytes free (headroom included), {available} available"
    );
    Err(disk_fault_message(
        DiskFault::Full,
        &format!(
            "Not enough free disk space: {} needed, {} available (required {required} bytes, free {available} bytes)",
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

/// Why a save path will not survive the Windows path limit, or `None` when it will. Pure, and
/// compiled everywhere so its cases are tested on every platform.
///
/// HuggingFace repo ids nest deeply (`unsloth/Model-Name-Long-GGUF/file.gguf`) under an
/// already-long per-user data folder, and the downloader appends its sidecar extensions on top, so
/// the longest sidecar is what actually overflows first — that is the length checked here. A UNC
/// path (`\\wsl.localhost\…`, Atomic Chat's WSL distribution, change `add-tensorrt-llm-windows`)
/// is held to the same limit; only a verbatim path (`\\?\C:\…`, `\\?\UNC\…`) bypasses it.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn path_limit_error(text: &str) -> Option<String> {
    // Legacy `MAX_PATH`. Long-path support needs both a `longPathAware` manifest and an opt-in
    // registry key, so a path over this limit fails on a large share of installs regardless of
    // what the app declares.
    const LIMIT: usize = 260;
    if text.starts_with(r"\\?\") {
        return None;
    }
    // `.tmp` / `.url` are appended while downloading, and a multi-connection
    // download also writes its segment map as `.parts`, through `.parts.new`
    // — the longest name the downloader creates.
    let effective = text.chars().count() + ".parts.new".len();
    if effective < LIMIT {
        return None;
    }
    log::warn!("Refusing download: save path is {effective} chars, over the {LIMIT} limit");
    // The data folder can move; the folder of the WSL distribution cannot, so there the only
    // part that can be shorter is the model's own.
    let advice = if text.starts_with(r"\\") {
        "The model's files sit too deep in Atomic Chat's WSL distribution; choose a model with a shorter repository name."
    } else {
        "Move the Jan data folder closer to the drive root and retry."
    };
    Some(disk_fault_message(
        DiskFault::PathTooLong,
        &format!("File path is {effective} characters, over the {LIMIT}-character Windows limit. {advice}"),
    ))
}

/// Reject a save path that will not survive the Windows path limit ([`path_limit_error`]).
#[cfg(windows)]
pub fn ensure_path_within_limit(save_path: &Path) -> Result<(), String> {
    match path_limit_error(&save_path.to_string_lossy()) {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg(not(windows))]
pub fn ensure_path_within_limit(_save_path: &Path) -> Result<(), String> {
    Ok(())
}

// ===== Preflight: the file system's largest file =====

/// The largest file FAT12/16/32 can store: one byte short of 4 GiB.
pub const FAT_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024 - 1;

/// Whether `fs_name`, as `GetVolumeInformationW` spells it, is a FAT variant.
/// `exFAT` is not one: its files have no practical size limit.
pub fn is_fat_file_system(fs_name: &str) -> bool {
    ["FAT", "FAT12", "FAT16", "FAT32"]
        .iter()
        .any(|fat| fs_name.eq_ignore_ascii_case(fat))
}

/// Why a file of `file_size` bytes cannot be stored on a volume formatted as
/// `fs_name`, or `None` when it can or the file system is unknown. Pure, and
/// compiled everywhere so its cases are tested on every platform.
///
/// Catalog files are 8–27 GB. On a FAT32 drive the pre-sizing `set_len` or the
/// write crossing 4 GiB fails with `ERROR_DISK_FULL`, which was tagged
/// `disk_full` on a drive with plenty of free space, and told the user to free
/// space that would never have helped.
pub fn fs_file_limit_error(fs_name: Option<&str>, file_size: u64) -> Option<String> {
    let fs_name = fs_name?;
    if file_size <= FAT_MAX_FILE_BYTES || !is_fat_file_system(fs_name) {
        return None;
    }
    log::warn!("Refusing download: a {file_size}-byte file does not fit on a {fs_name} volume");
    Some(disk_fault_message(
        DiskFault::FsLimit,
        &format!(
            "This file is {}, but its drive is formatted as {fs_name}, which cannot store a file larger than 4 GB. Move the Atomic Chat data folder to a folder on an NTFS or exFAT drive and retry.",
            format_bytes(file_size)
        ),
    ))
}

/// Refuse, before the first byte, a file its volume's file system cannot hold
/// ([`fs_file_limit_error`]). Windows only: that is where FAT32 data folders
/// (USB sticks, old external drives) show up in the failure reports.
#[cfg(windows)]
pub fn ensure_file_fits_file_system(save_path: &Path, file_size: u64) -> Result<(), String> {
    if file_size <= FAT_MAX_FILE_BYTES {
        return Ok(());
    }
    let fs_name = match disk_space_info(save_path) {
        Ok(info) => info.fs_name,
        Err(error) => {
            log::warn!("Could not read the file system of the download target: {error}");
            None
        }
    };
    match fs_file_limit_error(fs_name.as_deref(), file_size) {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg(not(windows))]
pub fn ensure_file_fits_file_system(_save_path: &Path, _file_size: u64) -> Result<(), String> {
    Ok(())
}

// ===== Transient locks: retrying a rename or a delete =====

/// `ERROR_ACCESS_DENIED`, `ERROR_SHARING_VIOLATION`, `ERROR_LOCK_VIOLATION`.
const TRANSIENT_LOCK_CODES: [i32; 3] = [5, 32, 33];

/// Whether a failed rename or delete is worth retrying: on Windows, Defender,
/// the search indexer and OneDrive open a file the moment it is finished and
/// hold it for seconds, and every rename or delete meanwhile fails with access
/// denied or a sharing/lock violation. Elsewhere nothing behaves like that, so
/// nothing is retried. Pure, so its cases are tested on every platform.
pub fn is_transient_lock(raw_os_error: Option<i32>, kind: ErrorKind, on_windows: bool) -> bool {
    on_windows
        && (raw_os_error.is_some_and(|code| TRANSIENT_LOCK_CODES.contains(&code))
            || kind == ErrorKind::PermissionDenied)
}

pub fn is_transient_lock_error(error: &std::io::Error) -> bool {
    is_transient_lock(error.raw_os_error(), error.kind(), cfg!(windows))
}

/// How long and how often a locked rename or delete is retried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LockRetry {
    /// No retry starts once its delay would end past this, counted from the
    /// first attempt.
    pub budget: Duration,
    pub first_delay: Duration,
    pub max_delay: Duration,
}

impl LockRetry {
    /// About ten seconds in all: 0.1, 0.2, 0.4, 0.8, 1.6, then 2 s apart.
    pub const DEFAULT: Self = Self {
        budget: Duration::from_secs(10),
        first_delay: Duration::from_millis(100),
        max_delay: Duration::from_secs(2),
    };

    /// The wait before retry `attempt` (0 for the first): doubling from
    /// `first_delay`, capped at `max_delay`.
    pub fn delay(&self, attempt: u32) -> Duration {
        self.first_delay
            .saturating_mul(1u32 << attempt.min(16))
            .min(self.max_delay)
    }
}

/// Run `op` until it succeeds, fails with an error `is_transient` rejects, or
/// the policy's budget runs out; every retry is logged. Returns the last
/// error.
pub async fn retry_while_locked<T, F, Fut>(
    what: &str,
    path: &Path,
    policy: LockRetry,
    is_transient: impl Fn(&std::io::Error) -> bool,
    mut op: F,
) -> std::io::Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = std::io::Result<T>>,
{
    let started = Instant::now();
    let mut attempt = 0u32;
    loop {
        match op().await {
            Ok(value) => {
                if attempt > 0 {
                    log::info!(
                        "{what} {} succeeded after {attempt} retries",
                        path.display()
                    );
                }
                return Ok(value);
            }
            Err(error) => {
                let delay = policy.delay(attempt);
                if !is_transient(&error) {
                    return Err(error);
                }
                if started.elapsed() + delay > policy.budget {
                    log::warn!(
                        "{what} {} still failing after {attempt} retries over {} ms: {error}",
                        path.display(),
                        started.elapsed().as_millis()
                    );
                    return Err(error);
                }
                attempt += 1;
                log::warn!(
                    "{what} {} failed ({error}); another process may be holding it. Retry {attempt} in {} ms",
                    path.display(),
                    delay.as_millis()
                );
                tokio::time::sleep(delay).await;
            }
        }
    }
}

/// `tokio::fs::rename`, retried while another process holds either file.
pub async fn rename_retrying(from: &Path, to: &Path) -> std::io::Result<()> {
    retry_while_locked(
        "Renaming",
        from,
        LockRetry::DEFAULT,
        is_transient_lock_error,
        || tokio::fs::rename(from, to),
    )
    .await
}

/// `tokio::fs::remove_file`, retried while another process holds the file.
pub async fn remove_file_retrying(path: &Path) -> std::io::Result<()> {
    retry_while_locked(
        "Removing",
        path,
        LockRetry::DEFAULT,
        is_transient_lock_error,
        || tokio::fs::remove_file(path),
    )
    .await
}

/// Remove a file whose survival breaks nothing — a sidecar of a finished
/// download, a partial being cleaned up: retried while locked, then only
/// logged. A file already gone is what was wanted.
pub async fn remove_file_best_effort(path: &Path) {
    match remove_file_retrying(path).await {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => log::warn!("Could not remove {} ({error}); leaving it", path.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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
        assert_eq!(DiskFault::FsLimit.tag(), "disk_fs_limit");
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
        assert_eq!(remaining_bytes(10_000, &[4096]), 10_000 - 4096);
        assert_eq!(remaining_bytes(10_000, &[4096, 1000]), 10_000 - 5096);
        // Nothing on disk yet leaves the whole requirement.
        assert_eq!(remaining_bytes(10_000, &[]), 10_000);
        // A partial larger than the total must not wrap around.
        assert_eq!(remaining_bytes(1_000, &[4096]), 0);
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
    fn the_free_space_the_core_reports_refuses_a_download_that_does_not_fit() {
        // Change add-tensorrt-llm-windows: the models root is in the WSL guest, which the volume
        // list cannot see; the core measures it.
        let error = check_reported_free_space(Some(10 * 1024 * 1024 * 1024), 20 * 1024 * 1024 * 1024).unwrap_err();
        assert!(error.starts_with("Error: [disk_full] "), "got {error}");
        assert!(check_reported_free_space(Some(30 * 1024 * 1024 * 1024), 20 * 1024 * 1024 * 1024).is_ok());
        // Unmeasured is not a reason to refuse.
        assert!(check_reported_free_space(None, u64::MAX / 2).is_ok());
    }

    #[test]
    fn a_long_path_in_the_wsl_distribution_is_refused_with_advice_about_the_model() {
        let unc = format!(
            r"\\wsl.localhost\AtomicChat\var\lib\atomic-chat\scopes\{}\managed-models\{}",
            "k".repeat(36),
            "a".repeat(200)
        );
        let error = path_limit_error(&unc).expect("over the limit");
        assert!(error.starts_with("Error: [disk_path_too_long] "), "got {error}");
        assert!(error.contains("WSL"), "got {error}");
        assert!(!error.contains("data folder"), "got {error}");
        // The verbatim spelling of a UNC path is exempt, as any verbatim path.
        assert_eq!(path_limit_error(&format!(r"\\?\UNC\{}", &unc[2..])), None);
        assert_eq!(path_limit_error(r"\\wsl.localhost\AtomicChat\short"), None);
    }

    #[cfg(not(windows))]
    #[test]
    fn path_limit_is_a_no_op_off_windows() {
        let long = PathBuf::from(format!("/{}/model.gguf", "x".repeat(300)));
        assert!(ensure_path_within_limit(&long).is_ok());
    }

    // ===== Frontend preflight: free-space report =====

    #[test]
    fn free_space_report_carries_the_headroom_the_downloader_enforces() {
        let dir = tempfile::tempdir().unwrap();
        let report = free_space_report(dir.path());
        assert_eq!(report.headroom, FREE_SPACE_HEADROOM);
        // Free space drifts between two reads (sibling tests write files), so
        // only the provenance is exact: known here iff known to the volume probe.
        assert_eq!(
            report.available.is_some(),
            available_space_for(dir.path()).is_some()
        );
    }

    #[test]
    fn free_space_report_agrees_with_the_transfer_time_check() {
        // The frontend refuses when `size + headroom > available`, computed
        // from this report. Both sides of that boundary must match what
        // `ensure_free_space` would decide for the same numbers.
        let dir = tempfile::tempdir().unwrap();
        let report = free_space_report(dir.path());
        let Some(available) = report.available else {
            return;
        };
        // Does not fit: the whole volume, with no room for the headroom.
        let error = ensure_free_space(dir.path(), required_free_bytes(available, &[])).unwrap_err();
        assert!(error.starts_with("Error: [disk_full] "), "got {error}");
        // Fits: what is left once the headroom is set aside, less a margin for
        // the bytes sibling tests write between this read and the next. Capped
        // where the 2% headroom overtakes the floor the report carries: past
        // that the frontend's estimate is deliberately the looser one.
        let margin = 64 * 1024 * 1024;
        if available > report.headroom + margin {
            let needed = (available - report.headroom - margin).min(FREE_SPACE_HEADROOM * 50);
            assert_eq!(free_space_headroom(needed), report.headroom);
            assert!(ensure_free_space(dir.path(), required_free_bytes(needed, &[])).is_ok());
        }
    }

    #[test]
    fn free_space_report_is_unknown_off_any_volume() {
        // A relative path is under no mount point, which is the `None` the
        // frontend treats as "cannot tell, let the download try".
        let report = free_space_report(Path::new("nowhere/on/a/volume"));
        assert_eq!(report.available, None);
        assert_eq!(report.headroom, FREE_SPACE_HEADROOM);
    }

    #[test]
    fn free_space_report_serializes_for_the_frontend() {
        // The web side reads `{ available: number | null, headroom: number }`.
        let known = FreeSpaceReport {
            available: Some(10 * 1024 * 1024 * 1024),
            headroom: FREE_SPACE_HEADROOM,
        };
        assert_eq!(
            serde_json::to_value(known).unwrap(),
            serde_json::json!({ "available": 10_737_418_240u64, "headroom": 536_870_912u64 })
        );
        let unknown = FreeSpaceReport {
            available: None,
            headroom: FREE_SPACE_HEADROOM,
        };
        assert_eq!(
            serde_json::to_value(unknown).unwrap(),
            serde_json::json!({ "available": null, "headroom": 536_870_912u64 })
        );
    }
}
