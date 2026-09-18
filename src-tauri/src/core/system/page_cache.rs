/// Fraction (0.0–1.0) of the model files at `paths` that the OS already holds
/// in its page cache, or `None` when that cannot be told (Windows, or a file
/// that cannot be probed).
///
/// Engine extensions ask this right before spawning a server, so the loading
/// status can tell a load from cache apart from a cold read off the disk
/// (ATO-530).
#[tauri::command]
pub async fn get_page_cache_resident_fraction(paths: Vec<String>) -> Option<f64> {
    tokio::task::spawn_blocking(move || jan_utils::page_cache::page_cache_resident_fraction(&paths))
        .await
        .unwrap_or(None)
}
