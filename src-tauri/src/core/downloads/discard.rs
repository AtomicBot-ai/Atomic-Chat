//! Explicit permanent disposal of one unfinished model directory.
use std::path::{Component, Path, PathBuf};
use tauri::Runtime;

fn unfinished_directory(data: &Path, provider: &str, id: &str) -> Result<Option<PathBuf>, String> {
    let engine = match provider {
        "llamacpp" | "llamacpp-upstream" | "atomic-prism" => "llamacpp",
        _ => return Err("This provider does not support safe download disposal yet".into()),
    };
    let relative = Path::new(id);
    if id.contains('\\')
        || relative.components().count() < 2
        || relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Invalid model download id".into());
    }
    // A disconnected/missing data root is not evidence that its download was
    // deleted. Keep recovery state until the configured storage is accessible.
    let data_metadata = std::fs::metadata(data)
        .map_err(|error| format!("Cannot access configured model data folder: {error}"))?;
    if !data_metadata.is_dir() {
        return Err("Configured model data folder is not a directory".into());
    }
    let root = data.join(engine).join("models");
    let mut target = data.to_path_buf();
    // Refuse symbolic links at every existing ancestor below the configured data root.
    for component in root
        .strip_prefix(data)
        .map_err(|e| e.to_string())?
        .components()
        .chain(relative.components())
    {
        target.push(component.as_os_str());
        let metadata = match std::fs::symlink_metadata(&target) {
            Ok(metadata) => metadata,
            // A persisted row may outlive its directory, or a previous attempt
            // may have removed it before the UI could clear the recovery state.
            // Validate every existing ancestor first; never follow a link to
            // decide that an external target is missing.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || target.join("model.yml").exists()
        {
            return Err("Refusing to discard an installed model or linked directory".into());
        }
    }
    let mut has_partial = false;
    let mut has_files = false;
    for entry in std::fs::read_dir(&target).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        has_files = true;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            return Err("Refusing a directory containing linked files or nested models".into());
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if ![
            ".gguf",
            ".gguf.tmp",
            ".gguf.url",
            ".gguf.parts",
            ".gguf.parts.new",
        ]
        .iter()
        .any(|suffix| name.ends_with(suffix))
        {
            return Err("Unexpected files in unfinished model directory; refusing deletion".into());
        }
        has_partial |= name.ends_with(".tmp")
            || name.ends_with(".parts")
            || name.ends_with(".url")
            || name.ends_with(".parts.new");
    }
    if has_files && !has_partial {
        return Err("No unfinished download artifacts found".into());
    }
    Ok(Some(target))
}

/// Never recursively remove a model tree: only unlink the validated leaf's files.
fn delete_unfinished_files(data: &Path, provider: &str, id: &str) -> Result<(), String> {
    let Some(target) = unfinished_directory(data, provider, id)? else {
        return Ok(());
    };
    let mut files = std::fs::read_dir(&target)
        .map_err(|e| e.to_string())?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    // Keep sidecars until payload removal completes, so a failed attempt is still identifiable.
    files.sort_by_key(|path| {
        matches!(
            path.extension().and_then(|value| value.to_str()),
            Some("url" | "parts" | "new")
        )
    });
    for path in files {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    std::fs::remove_dir(target).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_unfinished_model_download<R: Runtime>(
    app: tauri::AppHandle<R>,
    provider: String,
    id: String,
) -> Result<(), String> {
    let data = crate::core::app::commands::get_jan_data_folder_path(app);
    tokio::task::spawn_blocking(move || delete_unfinished_files(&data, &provider, &id))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disposal_is_restricted_to_one_unfinished_leaf() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("llamacpp/models/org/model");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("part.gguf.tmp"), b"partial").unwrap();
        assert_eq!(
            unfinished_directory(temp.path(), "llamacpp-upstream", "org/model").unwrap(),
            Some(target.clone())
        );
        assert!(unfinished_directory(temp.path(), "llamacpp", "../model").is_err());
        assert!(unfinished_directory(temp.path(), "llamacpp", "/org/model").is_err());
        assert!(unfinished_directory(temp.path(), "mlx", "org/model").is_err());
        std::fs::write(target.join("model.yml"), b"installed").unwrap();
        assert!(unfinished_directory(temp.path(), "llamacpp", "org/model").is_err());
        assert_eq!(
            std::fs::read(target.join("part.gguf.tmp")).unwrap(),
            b"partial"
        );
    }
    #[test]
    fn permanent_deletion_removes_only_the_selected_disposable_fixture() {
        let temp = tempfile::tempdir().unwrap();
        let selected = temp.path().join("llamacpp/models/org/selected");
        let neighbour = temp.path().join("llamacpp/models/org/keep");
        for folder in [&selected, &neighbour] {
            std::fs::create_dir_all(folder).unwrap();
            std::fs::write(folder.join("part.gguf.tmp"), b"partial").unwrap();
            std::fs::write(folder.join("finished.gguf"), b"finished").unwrap();
        }
        delete_unfinished_files(temp.path(), "llamacpp-upstream", "org/selected").unwrap();
        assert!(!selected.exists());
        assert_eq!(
            std::fs::read(neighbour.join("part.gguf.tmp")).unwrap(),
            b"partial"
        );
        assert_eq!(
            std::fs::read(neighbour.join("finished.gguf")).unwrap(),
            b"finished"
        );
        std::fs::write(neighbour.join("personal.txt"), b"keep me").unwrap();
        assert!(delete_unfinished_files(temp.path(), "llamacpp", "org/keep").is_err());
        assert_eq!(
            std::fs::read(neighbour.join("personal.txt")).unwrap(),
            b"keep me"
        );
        assert_eq!(
            std::fs::read(neighbour.join("part.gguf.tmp")).unwrap(),
            b"partial"
        );
    }
    #[test]
    fn deletion_is_idempotent_for_missing_and_empty_directories() {
        let temp = tempfile::tempdir().unwrap();
        delete_unfinished_files(temp.path(), "llamacpp", "org/missing").unwrap();
        let empty = temp.path().join("llamacpp/models/org/empty");
        std::fs::create_dir_all(&empty).unwrap();
        delete_unfinished_files(temp.path(), "llamacpp", "org/empty").unwrap();
        assert!(!empty.exists());
        delete_unfinished_files(temp.path(), "llamacpp", "org/empty").unwrap();
        let installed = temp.path().join("llamacpp/models/org/complete");
        std::fs::create_dir_all(&installed).unwrap();
        std::fs::write(installed.join("finished.gguf"), b"keep").unwrap();
        assert!(delete_unfinished_files(temp.path(), "llamacpp", "org/complete").is_err());
        assert_eq!(
            std::fs::read(installed.join("finished.gguf")).unwrap(),
            b"keep"
        );
    }

    #[test]
    fn unavailable_data_root_does_not_clear_recovery_state() {
        let temp = tempfile::tempdir().unwrap();
        assert!(
            delete_unfinished_files(&temp.path().join("unmounted"), "llamacpp", "org/model")
                .is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn missing_targets_below_links_are_still_refused() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), temp.path().join("llamacpp")).unwrap();
        assert!(delete_unfinished_files(temp.path(), "llamacpp", "org/missing").is_err());
    }

    #[test]
    fn prism_uses_the_shared_gguf_root_and_new_manifest_sidecar() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("llamacpp/models/org/prism");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("model.gguf.parts.new"), b"manifest").unwrap();
        delete_unfinished_files(temp.path(), "atomic-prism", "org/prism").unwrap();
        assert!(!target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn linked_payloads_are_refused() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("llamacpp/models/org/model");
        std::fs::create_dir_all(&target).unwrap();
        std::os::unix::fs::symlink(temp.path(), target.join("linked.tmp")).unwrap();
        assert!(unfinished_directory(temp.path(), "llamacpp", "org/model").is_err());
    }
}
