use std::{
    fs, io,
    path::{Path, PathBuf},
};

/// Recursively copy a directory from src to dst. `exclude_dirs` are entry names left out at every
/// depth; `exclude_paths` are entries named by their path relative to `src`, for a name that must
/// stay behind in one place only.
pub fn copy_dir_recursive_except(
    src: &PathBuf,
    dst: &PathBuf,
    exclude_dirs: &[&str],
    exclude_paths: &[&Path],
) -> Result<(), io::Error> {
    copy_dir_level(src, dst, Path::new(""), exclude_dirs, exclude_paths)
}

fn copy_dir_level(
    src: &PathBuf,
    dst: &PathBuf,
    relative: &Path,
    exclude_dirs: &[&str],
    exclude_paths: &[&Path],
) -> Result<(), io::Error> {
    if !dst.exists() {
        fs::create_dir_all(dst)?;
    }

    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let relative_path = relative.join(entry.file_name());

        if let Some(name) = entry.file_name().to_str() {
            if exclude_dirs.contains(&name) {
                continue;
            }
        }
        if exclude_paths.contains(&relative_path.as_path()) {
            continue;
        }

        let is_dir = file_type.is_dir() || (file_type.is_symlink() && src_path.is_dir());

        if is_dir {
            copy_dir_level(
                &src_path,
                &dst_path,
                &relative_path,
                exclude_dirs,
                exclude_paths,
            )?;
        } else if file_type.is_file() || file_type.is_symlink() {
            fs::copy(&src_path, &dst_path)?;
        } else {
            log::debug!("Skipping non-regular file: {src_path:?}");
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn a_path_exclusion_leaves_out_that_entry_and_not_its_namesakes() {
        let from = tempdir().unwrap();
        let to = tempdir().unwrap();
        let src = from.path().to_path_buf();
        fs::create_dir_all(src.join("atomic-core/model-claims")).unwrap();
        fs::create_dir_all(src.join("threads/t1")).unwrap();
        fs::write(src.join("atomic-core/instance.lock"), "{}").unwrap();
        fs::write(src.join("atomic-core/settings.json"), "{}").unwrap();
        fs::write(src.join("atomic-core/model-claims/m.json"), "{}").unwrap();
        fs::write(src.join("threads/t1/instance.lock"), "user data").unwrap();

        copy_dir_recursive_except(
            &src,
            &to.path().to_path_buf(),
            &[],
            &[
                Path::new("atomic-core/instance.lock"),
                Path::new("atomic-core/model-claims"),
            ],
        )
        .unwrap();

        assert!(!to.path().join("atomic-core/instance.lock").exists());
        assert!(!to.path().join("atomic-core/model-claims").exists());
        assert!(to.path().join("atomic-core/settings.json").exists());
        assert!(to.path().join("threads/t1/instance.lock").exists());
    }
}
