use crate::core::app::commands::get_jan_data_folder_path;
use jan_utils::{normalize_file_path, normalize_path};
use std::path::PathBuf;
use tauri::Runtime;

pub fn resolve_path<R: Runtime>(app_handle: tauri::AppHandle<R>, path: &str) -> PathBuf {
    let path = if path.starts_with("file:/") || path.starts_with("file:\\") {
        let normalized = normalize_file_path(path);
        let relative_normalized = normalized
            .trim_start_matches(std::path::MAIN_SEPARATOR)
            .trim_start_matches('/')
            .trim_start_matches('\\');
        get_jan_data_folder_path(app_handle).join(relative_normalized)
    } else {
        PathBuf::from(path)
    };

    if path.starts_with("http://") || path.starts_with("https://") {
        path
    } else {
        // On Windows `canonicalize` returns an extended-length (`\\?\`) path.
        // Those escape into the frontend through `readdir_sync` / `join_path`,
        // get persisted as `model_path` in `model.yml`, and are handed to
        // `llama-server` on the command line. Normalize the prefix away so
        // callers only ever see ordinary paths (issue #256).
        normalize_path(&path.canonicalize().unwrap_or(path))
    }
}
