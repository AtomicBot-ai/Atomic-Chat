//! How much of a set of files the OS already holds in its page cache.
//!
//! ATO-530: loading a model whose weights the OS still has cached is a copy
//! from memory, while the first load after a reboot reads every byte off the
//! disk — for a large model that is the difference between seconds and
//! minutes. The loading status says which of the two the user is waiting on,
//! and this is where it finds out.
//!
//! Unix answers through `mincore(2)` on a read-only mapping: mapping a file
//! reads nothing, and `mincore` reports which of its pages are resident
//! without faulting any in. Windows has no public equivalent for the file
//! cache, so there the answer is unknown.

use std::path::{Path, PathBuf};

/// Fraction (0.0–1.0) of the combined bytes of `paths` that is resident in
/// the page cache, weighted by file size. A directory stands for the files
/// directly inside it — an MLX model is a folder of shards. `None` when the
/// platform cannot tell, or when any file cannot be probed — a partial answer
/// would misreport the wait.
pub fn page_cache_resident_fraction<P: AsRef<Path>>(paths: &[P]) -> Option<f64> {
    let mut resident: u64 = 0;
    let mut total: u64 = 0;
    for file in expand_directories(paths)? {
        let (file_resident, file_total) = resident_bytes(&file)?;
        resident += file_resident;
        total += file_total;
    }
    if total == 0 {
        return None;
    }
    Some(resident as f64 / total as f64)
}

fn expand_directories<P: AsRef<Path>>(paths: &[P]) -> Option<Vec<PathBuf>> {
    let mut files = Vec::new();
    for path in paths {
        let path = path.as_ref();
        if path.is_dir() {
            for entry in std::fs::read_dir(path).ok()? {
                let entry = entry.ok()?;
                if entry.file_type().ok()?.is_file() {
                    files.push(entry.path());
                }
            }
        } else {
            files.push(path.to_path_buf());
        }
    }
    Some(files)
}

#[cfg(unix)]
fn resident_bytes(path: &Path) -> Option<(u64, u64)> {
    use std::fs::File;
    use std::os::unix::io::AsRawFd;

    let file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len == 0 {
        return Some((0, 0));
    }
    let map_len = usize::try_from(len).ok()?;
    let page_size = usize::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).ok()?;
    if page_size == 0 {
        return None;
    }

    // SAFETY: a fresh read-only shared mapping of a file we hold open. It is
    // only handed to `mincore` and unmapped before returning; nothing reads
    // through it, so a concurrent truncation cannot fault this process.
    let addr = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            map_len,
            libc::PROT_READ,
            libc::MAP_SHARED,
            file.as_raw_fd(),
            0,
        )
    };
    if addr == libc::MAP_FAILED {
        return None;
    }

    let pages = map_len.div_ceil(page_size);
    let mut vec = vec![0u8; pages];
    // SAFETY: `vec` holds one byte per page of the `map_len` mapping at `addr`.
    let rc = unsafe { libc::mincore(addr as _, map_len, vec.as_mut_ptr() as _) };
    // SAFETY: unmaps exactly the mapping created above.
    unsafe { libc::munmap(addr, map_len) };
    if rc != 0 {
        return None;
    }

    // Bit 0 is "resident" on every Unix; the other bits vary by platform.
    let resident_pages = vec.iter().filter(|b| **b & 1 != 0).count() as u64;
    let resident = (resident_pages * page_size as u64).min(len);
    Some((resident, len))
}

#[cfg(not(unix))]
fn resident_bytes(_path: &Path) -> Option<(u64, u64)> {
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn a_file_just_written_reads_as_cached() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(&vec![7u8; 4 * 1024 * 1024]).unwrap();
        file.flush().unwrap();

        let fraction = page_cache_resident_fraction(&[file.path()]).unwrap();

        assert!(
            fraction > 0.9,
            "freshly written pages are resident, got {fraction}"
        );
    }

    #[test]
    fn a_directory_counts_the_files_inside_it() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("model-00001.safetensors"),
            vec![1u8; 1 << 20],
        )
        .unwrap();
        std::fs::write(
            dir.path().join("model-00002.safetensors"),
            vec![2u8; 1 << 20],
        )
        .unwrap();

        let fraction = page_cache_resident_fraction(&[dir.path()]).unwrap();

        assert!(
            fraction > 0.9,
            "freshly written shards are resident, got {fraction}"
        );
    }

    #[test]
    fn a_missing_file_gives_no_answer() {
        assert_eq!(
            page_cache_resident_fraction(&["/nonexistent/atomic-chat/model.gguf"]),
            None
        );
    }

    #[test]
    fn nothing_to_probe_gives_no_answer() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let empty: [&Path; 0] = [];

        assert_eq!(page_cache_resident_fraction(&empty), None);
        assert_eq!(page_cache_resident_fraction(&[file.path()]), None);
    }
}
