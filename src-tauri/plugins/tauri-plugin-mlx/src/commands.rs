//! What the app still asks the MLX plugin: which `mlx-server` build it bundles. Loading, unloading
//! and sessions belong to `atomic-chat-core`.

use tauri::{Manager, Runtime};

#[derive(serde::Serialize)]
pub struct MlxServerVersion {
    pub version: String,
    pub backend: String,
}

#[tauri::command]
pub fn get_mlx_server_version<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<MlxServerVersion, String> {
    let res_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {e}"))?;

    let bin_dir = res_dir.join("resources/bin");

    let version = std::fs::read_to_string(bin_dir.join("mlx-server-version.txt"))
        .unwrap_or_default()
        .trim()
        .to_string();

    let backend = std::fs::read_to_string(bin_dir.join("mlx-server-backend.txt"))
        .unwrap_or_else(|_| "macos-arm64".to_string())
        .trim()
        .to_string();

    Ok(MlxServerVersion { version, backend })
}
