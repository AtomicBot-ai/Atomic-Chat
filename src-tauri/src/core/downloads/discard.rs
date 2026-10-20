//! Explicit permanent disposal of one unfinished model directory.
use std::path::{Component, Path, PathBuf};
use tauri::Runtime;

fn unfinished_directory(data: &Path, provider: &str, id: &str) -> Result<PathBuf, String> {
    let engine = match provider {
        "llamacpp" | "llamacpp-upstream" => "llamacpp",
        "atomic-prism" => "atomic-prism",
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
        let metadata = std::fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || target.join("model.yml").exists()
        {
            return Err("Refusing to discard an installed model or linked directory".into());
        }
    }
    let mut has_partial = false;
    for entry in std::fs::read_dir(&target).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            return Err("Refusing a directory containing linked files or nested models".into());
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if ![".gguf", ".gguf.tmp", ".gguf.url", ".gguf.parts"]
            .iter()
            .any(|suffix| name.ends_with(suffix))
        {
            return Err("Unexpected files in unfinished model directory; refusing deletion".into());
        }
        has_partial |= name.ends_with(".tmp") || name.ends_with(".parts") || name.ends_with(".url");
    }
    if !has_partial {
        return Err("No unfinished download artifacts found".into());
    }
    Ok(target)
}

/// Never recursively remove a model tree: only unlink the validated leaf's files.
fn delete_unfinished_files(data: &Path, provider: &str, id: &str) -> Result<(), String> {
    let target = unfinished_directory(data, provider, id)?;
    let mut files = std::fs::read_dir(&target)
        .map_err(|e| e.to_string())?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    // Keep sidecars until payload removal completes, so a failed attempt is still identifiable.
    files.sort_by_key(|path| {
        matches!(
            path.extension().and_then(|value| value.to_str()),
            Some("url" | "parts")
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
            target
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
