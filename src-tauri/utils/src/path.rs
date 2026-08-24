#[cfg(windows)]
use std::path::Prefix;
use std::path::{Component, Path, PathBuf};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

#[cfg(windows)]
use std::ffi::OsStr;

#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;

/// Normalizes file paths by handling path components, prefixes, and resolving relative paths
/// Based on: https://github.com/rust-lang/cargo/blob/rust-1.67.0/crates/cargo-util/src/paths.rs#L82-L107
pub fn normalize_path(path: &Path) -> PathBuf {
    let mut components = path.components().peekable();
    let mut ret = if let Some(c @ Component::Prefix(_prefix_component)) = components.peek().cloned()
    {
        #[cfg(windows)]
        // Remove only the Verbatim prefix, but keep the drive letter (e.g., C:\)
        match _prefix_component.kind() {
            Prefix::VerbatimDisk(disk) => {
                components.next(); // skip this prefix
                                   // Re-add the disk prefix (e.g., C:)
                let mut pb = PathBuf::new();
                pb.push(format!("{}:", disk as char));
                pb
            }
            // `\\?\UNC\server\share` is the verbatim spelling of
            // `\\server\share`. Dropping the prefix outright threw the host
            // and share away, leaving a path that could never satisfy a
            // containment check on a redirected or network data folder.
            Prefix::VerbatimUNC(server, share) => {
                components.next(); // skip this prefix
                PathBuf::from(format!(
                    "\\\\{}\\{}",
                    server.to_string_lossy(),
                    share.to_string_lossy()
                ))
            }
            Prefix::Verbatim(_) => {
                components.next(); // skip this prefix
                PathBuf::new()
            }
            _ => {
                components.next();
                PathBuf::from(c.as_os_str())
            }
        }
        #[cfg(not(windows))]
        {
            components.next(); // skip this prefix
            PathBuf::from(c.as_os_str())
        }
    } else {
        PathBuf::new()
    };

    for component in components {
        match component {
            Component::Prefix(..) => unreachable!(),
            Component::RootDir => {
                ret.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                ret.pop();
            }
            Component::Normal(c) => {
                ret.push(c);
            }
        }
    }
    ret
}

/// Whether `path` lives inside `root`, compared the way the host filesystem
/// would compare them.
///
/// Both sides are normalized first, because one typically arrived through
/// [`std::fs::canonicalize`] (which on Windows yields a `\\?\`-verbatim
/// prefix) while the other came from a stored configuration string. Windows
/// also compares paths case-insensitively, whereas [`Path::starts_with`]
/// compares components byte-wise on every platform — so a data folder recorded
/// as `C:\Users\Bob\...` would fail to contain a file resolved as
/// `C:\Users\bob\...`.
pub fn is_within(path: &Path, root: &Path) -> bool {
    let path = normalize_path(path);
    let root = normalize_path(root);

    #[cfg(windows)]
    {
        let path = path.to_string_lossy().to_lowercase();
        let root = root.to_string_lossy().to_lowercase();
        Path::new(&path).starts_with(Path::new(&root))
    }
    #[cfg(not(windows))]
    {
        path.starts_with(&root)
    }
}

/// Resolve symlinks in `path` as far as it actually exists, keeping any
/// not-yet-created tail as-is.
///
/// [`normalize_path`] only rewrites a path lexically, so two names for the same
/// directory stay different strings. On atomic Fedora variants (Silverblue and
/// friends) `/home` is a symlink to `/var/home`, so a download target resolved
/// through one name failed a containment check written against the other, and
/// the backend update was refused with "is outside of Jan data folder".
///
/// [`std::fs::canonicalize`] would answer that, but it requires the whole path
/// to exist — and the file being checked is usually the one about to be
/// created. So canonicalize the deepest existing ancestor and re-attach the
/// rest. A path that resolves to nothing existing is returned unchanged.
pub fn canonicalize_existing_prefix(path: &Path) -> PathBuf {
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let mut cursor = path;

    loop {
        if let Ok(resolved) = cursor.canonicalize() {
            let mut out = resolved;
            for part in tail.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (cursor.file_name(), cursor.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name);
                cursor = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// Removes file:/ and file:\ prefixes from file paths
pub fn normalize_file_path(path: &str) -> String {
    path.replace("file:/", "").replace("file:\\", "")
}

/// Removes prefix from path string with proper formatting
pub fn remove_prefix(path: &str, prefix: &str) -> String {
    if !prefix.is_empty() && path.starts_with(prefix) {
        let result = path[prefix.len()..].to_string();
        if result.is_empty() {
            "/".to_string()
        } else if result.starts_with('/') {
            result
        } else {
            format!("/{}", result)
        }
    } else {
        path.to_string()
    }
}

/// Get Windows short path to avoid issues with spaces and special characters
#[cfg(windows)]
pub fn get_short_path<P: AsRef<std::path::Path>>(path: P) -> Option<String> {
    let wide: Vec<u16> = OsStr::new(path.as_ref())
        .encode_wide()
        .chain(Some(0))
        .collect();

    let mut buffer = vec![0u16; 260];
    let len = unsafe { GetShortPathNameW(wide.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) };

    if len > 0 {
        Some(String::from_utf16_lossy(&buffer[..len as usize]))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reproduces the atomic-Fedora layout: `/home` -> `/var/home`.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_parent_resolves_to_the_same_place() {
        let tmp = std::env::temp_dir().join(format!(
            "jan-path-test-{}-{}",
            std::process::id(),
            line!()
        ));
        let real = tmp.join("var/home/user");
        let link = tmp.join("home");
        std::fs::create_dir_all(&real).unwrap();
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(tmp.join("var/home"), &link).unwrap();

        let via_link = canonicalize_existing_prefix(&link.join("user"));
        let via_real = canonicalize_existing_prefix(&real);

        assert_eq!(
            via_link, via_real,
            "the same directory reached by two names must compare equal"
        );

        std::fs::remove_dir_all(&tmp).ok();
    }

    /// The file being checked usually does not exist yet — that must not stop
    /// the parent from being resolved.
    #[cfg(unix)]
    #[test]
    fn a_missing_tail_keeps_its_name_while_the_parent_resolves() {
        let tmp = std::env::temp_dir().join(format!(
            "jan-path-test-{}-{}",
            std::process::id(),
            line!()
        ));
        let real = tmp.join("var/data");
        let link = tmp.join("data");
        std::fs::create_dir_all(&real).unwrap();
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let target = link.join("models/not-downloaded-yet.gguf");
        let resolved = canonicalize_existing_prefix(&target);

        assert!(resolved.starts_with(canonicalize_existing_prefix(&real)));
        assert!(resolved.ends_with("models/not-downloaded-yet.gguf"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_path_inside_the_root_is_contained() {
        assert!(is_within(
            Path::new("/data/llamacpp/models/m/model.yml"),
            Path::new("/data")
        ));
        assert!(!is_within(Path::new("/elsewhere/model.yml"), Path::new("/data")));
    }

    /// The data folder arrives as a stored config string while the file was
    /// resolved through `canonicalize`, so the two can disagree on both the
    /// prefix spelling and the casing.
    #[cfg(windows)]
    #[test]
    fn a_verbatim_path_is_contained_by_its_plain_root() {
        assert!(is_within(
            Path::new(r"\\?\C:\Users\Bob\AppData\Roaming\Atomic Chat\data\model.yml"),
            Path::new(r"C:\Users\bob\AppData\Roaming\Atomic Chat\data")
        ));
    }

    /// `\\?\UNC\server\share` and `\\server\share` name the same place.
    #[cfg(windows)]
    #[test]
    fn a_verbatim_unc_path_keeps_its_host_and_share() {
        assert_eq!(
            normalize_path(Path::new(r"\\?\UNC\server\share\data\model.yml")),
            PathBuf::from(r"\\server\share\data\model.yml")
        );
        assert!(is_within(
            Path::new(r"\\?\UNC\server\share\data\model.yml"),
            Path::new(r"\\server\share\data")
        ));
    }

    #[test]
    fn a_path_with_nothing_existing_is_returned_unchanged() {
        let path = Path::new("/definitely/not/here/at/all.gguf");
        assert_eq!(canonicalize_existing_prefix(path), path.to_path_buf());
    }

    #[cfg(windows)]
    #[test]
    fn test_get_short_path() {
        // Test with a real path that should exist on Windows
        use std::env;
        if let Ok(temp_dir) = env::var("TEMP") {
            let result = get_short_path(&temp_dir);
            // Should return some short path or None (both are valid)
            // We can't assert the exact value as it depends on the system
            println!("Short path result: {:?}", result);
        }
    }
}
