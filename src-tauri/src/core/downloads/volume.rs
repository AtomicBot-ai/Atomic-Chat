//! What the volume under a download's destination reports: free and total
//! bytes, its file system, its root.
//!
//! The free-space preflight used to find the volume by matching the
//! destination against the mount points `sysinfo` lists. On Windows that match
//! misses on a case difference, a verbatim (`\\?\`) or UNC spelling, a junction
//! or a mapped drive, and a miss skipped the check entirely: the download then
//! ran into `disk_full` mid-transfer instead of being refused upfront. The OS
//! is now asked about the destination itself, through its nearest existing
//! directory (a model's folder does not exist before its first download);
//! the volume list is only the fallback for when that query fails.

use std::io;
use std::path::{Path, PathBuf};

/// The answer of `get_disk_space_info`, read by the web download queue.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DiskSpaceInfo {
    /// Bytes this process may still write there: the caller's quota-aware
    /// figure on Windows, `f_bavail` on Unix.
    pub free_bytes: u64,
    pub total_bytes: u64,
    /// `NTFS`, `exFAT`, `FAT32`, … — known on Windows, and from the volume
    /// list fallback; a Unix `statvfs` does not name it.
    pub fs_name: Option<String>,
    /// `C:\`, `\\server\share\`, a mount point. Same provenance as `fs_name`.
    pub volume_root: Option<String>,
}

/// The deepest existing directory among `path` and its ancestors.
pub fn nearest_existing_dir(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|candidate| !candidate.as_os_str().is_empty() && candidate.is_dir())
        .map(Path::to_path_buf)
}

/// Free space, size, file system and root of the volume that holds `path`,
/// which need not exist yet.
pub fn disk_space_info(path: &Path) -> Result<DiskSpaceInfo, String> {
    let direct = match nearest_existing_dir(path) {
        Some(dir) => query_volume(&dir),
        None => Err(io::Error::new(
            io::ErrorKind::NotFound,
            "no existing directory on the path",
        )),
    };
    match direct {
        Ok(info) => Ok(prefer_important_usage(path, info)),
        Err(error) => {
            log::warn!(
                "Free-space query for {} failed ({error}); falling back to the volume list",
                path.display()
            );
            from_volume_list(path).ok_or_else(|| {
                format!(
                    "Could not determine the volume of {}: {error}",
                    path.display()
                )
            })
        }
    }
}

/// macOS: `statvfs` does not count purgeable space (system caches, local
/// Time Machine snapshots) that APFS frees on demand. Finder, and the volume
/// list through `sysinfo`, report what is available "for important usage",
/// which does — the figure the preflight used before this module. Take the
/// larger, so a Mac with large purgeable caches is not refused a download the
/// system would make room for.
#[cfg(target_os = "macos")]
fn prefer_important_usage(path: &Path, info: DiskSpaceInfo) -> DiskSpaceInfo {
    match from_volume_list(path) {
        Some(listed) if listed.free_bytes > info.free_bytes => DiskSpaceInfo {
            free_bytes: listed.free_bytes,
            fs_name: info.fs_name.or(listed.fs_name),
            volume_root: info.volume_root.or(listed.volume_root),
            ..info
        },
        _ => info,
    }
}

#[cfg(not(target_os = "macos"))]
fn prefer_important_usage(_path: &Path, info: DiskSpaceInfo) -> DiskSpaceInfo {
    info
}

/// Bytes `path` occupies on its volume, or `None` when it does not exist.
///
/// On Unix that is its allocated blocks: a multi-connection partial is
/// pre-sized with `set_len`, which leaves it sparse there. On Windows it is
/// its length: NTFS, exFAT and FAT allocate a file's whole length as soon as
/// it is extended, however little of it has been written.
pub fn allocated_bytes(path: &Path) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(meta.len().min(meta.blocks().saturating_mul(512)))
    }
    #[cfg(not(unix))]
    {
        Some(meta.len())
    }
}

/// The old lookup: the longest mount point `sysinfo` lists that prefixes
/// `path`. `/` matches everything, so a nested mount like `/home` or `D:\` has
/// to be preferred over it.
fn from_volume_list(path: &Path) -> Option<DiskSpaceInfo> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|disk| path.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(|disk| DiskSpaceInfo {
            free_bytes: disk.available_space(),
            total_bytes: disk.total_space(),
            fs_name: Some(disk.file_system().to_string_lossy().into_owned())
                .filter(|name| !name.is_empty()),
            volume_root: Some(disk.mount_point().to_string_lossy().into_owned()),
        })
}

#[cfg(unix)]
fn query_volume(dir: &Path) -> io::Result<DiskSpaceInfo> {
    use std::os::unix::ffi::OsStrExt;

    let c_path = std::ffi::CString::new(dir.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"))?;
    // SAFETY: `statvfs` is plain old data, so all-zero is a valid value, and
    // the call only writes into it.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c_path` is NUL-terminated and outlives the call; `stat` is a
    // valid, exclusively borrowed `statvfs`.
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // The field widths differ per platform (32-bit block counts on macOS).
    #[allow(clippy::unnecessary_cast)]
    let (fragment, available, blocks) = (
        stat.f_frsize as u64,
        stat.f_bavail as u64,
        stat.f_blocks as u64,
    );
    Ok(DiskSpaceInfo {
        free_bytes: available.saturating_mul(fragment),
        total_bytes: blocks.saturating_mul(fragment),
        fs_name: None,
        volume_root: None,
    })
}

#[cfg(windows)]
fn query_volume(dir: &Path) -> io::Result<DiskSpaceInfo> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    // A UNC share root is only accepted with its trailing separator, and any
    // other directory is accepted with one too.
    let mut text = dir.as_os_str().to_os_string();
    if !text.to_string_lossy().ends_with(['\\', '/']) {
        text.push("\\");
    }
    let wide: Vec<u16> = text.encode_wide().chain(Some(0)).collect();
    let mut free_to_caller = 0u64;
    let mut total = 0u64;
    // SAFETY: `wide` is NUL-terminated and outlives the call; both out-pointers
    // point at live `u64`s; the total-free out-parameter is documented as
    // optional.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut free_to_caller,
            &mut total,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let volume_root = windows_volume_root(&wide);
    let fs_name = volume_root.as_deref().and_then(windows_file_system_name);
    Ok(DiskSpaceInfo {
        free_bytes: free_to_caller,
        total_bytes: total,
        fs_name,
        volume_root,
    })
}

/// `GetVolumePathNameW`: the root (`C:\`, `\\server\share\`, a mounted folder)
/// of the volume holding the NUL-terminated `wide_path`.
#[cfg(windows)]
fn windows_volume_root(wide_path: &[u16]) -> Option<String> {
    use windows_sys::Win32::Storage::FileSystem::GetVolumePathNameW;

    // The root is never longer than the path it was found from.
    let mut buffer = vec![0u16; wide_path.len().max(261)];
    // SAFETY: `wide_path` is NUL-terminated; `buffer` is writable for the
    // length passed with it.
    let ok =
        unsafe { GetVolumePathNameW(wide_path.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) };
    if ok == 0 {
        log::warn!("GetVolumePathNameW failed: {}", io::Error::last_os_error());
        return None;
    }
    Some(from_wide_until_nul(&buffer))
}

/// `GetVolumeInformationW`: the file-system name (`NTFS`, `FAT32`, …) of the
/// volume whose root is `root`.
#[cfg(windows)]
fn windows_file_system_name(root: &str) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetVolumeInformationW;

    let wide: Vec<u16> = std::ffi::OsStr::new(root)
        .encode_wide()
        .chain(Some(0))
        .collect();
    // MAX_PATH + 1, the documented maximum for the name.
    let mut name = [0u16; 261];
    // SAFETY: `wide` is NUL-terminated; `name` is writable for the length
    // passed with it; every other out-parameter is optional and passed null.
    let ok = unsafe {
        GetVolumeInformationW(
            wide.as_ptr(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            name.as_mut_ptr(),
            name.len() as u32,
        )
    };
    if ok == 0 {
        log::warn!(
            "GetVolumeInformationW failed: {}",
            io::Error::last_os_error()
        );
        return None;
    }
    Some(from_wide_until_nul(&name)).filter(|fs_name| !fs_name.is_empty())
}

#[cfg(windows)]
fn from_wide_until_nul(buffer: &[u16]) -> String {
    let len = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..len])
}

#[cfg(not(any(unix, windows)))]
fn query_volume(_dir: &Path) -> io::Result<DiskSpaceInfo> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "no free-space query on this platform",
    ))
}
