use super::helpers::_download_files_internal;
use super::models::{DownloadItem, DownloadTask};
use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::state::AppState;
use std::collections::HashMap;
use tauri::{Runtime, State};

#[tauri::command]
pub async fn download_files<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    items: Vec<DownloadItem>,
    task_id: &str,
    headers: HashMap<String, String>,
    resume: bool,
) -> Result<(), String> {
    // insert cancel tokens
    let task = DownloadTask::new();
    let cancel_token = task.cancel_token.clone();
    {
        let mut download_manager = state.download_manager.lock().await;
        if let Some(existing) = download_manager.cancel_tokens.remove(task_id) {
            log::info!("Cancelling existing download task: {task_id}");
            existing.supersede();
        }
        download_manager
            .cancel_tokens
            .insert(task_id.to_string(), task.clone());
    }
    let result = _download_files_internal(
        app.clone(),
        &items,
        &headers,
        task_id,
        resume,
        cancel_token.clone(),
    )
    .await;

    // cleanup — but only our own registration. A successor that took this id
    // over is the live task now, and dropping its token would leave it
    // uncancellable.
    {
        let mut download_manager = state.download_manager.lock().await;
        let is_ours = download_manager
            .cancel_tokens
            .get(task_id)
            .is_some_and(|current| current.is_same_task(&task));
        if is_ours {
            download_manager.cancel_tokens.remove(task_id);
        }
    }

    if cancel_token.is_cancelled() {
        // A cancelled download owns its `.tmp` and `.url` partials, and nothing
        // else. `save_path` is the *finished* file: when the download was a
        // re-fetch of a model already on disk, that is the user's existing
        // copy, and removing it here turned "cancel" (or a pause, which
        // cancels the same token) into "delete my model". The partials stay
        // put — pause/resume is built on them.
        if task.was_superseded() {
            log::info!(
                "Download task {task_id} was superseded by a newer task for the same id; \
                 leaving its files alone"
            );
        } else {
            let jan_data_folder = get_jan_data_folder_path(app.clone());
            for item in &items {
                log::info!(
                    "Download cancelled, keeping partial and finished files for {}",
                    jan_data_folder.join(&item.save_path).display()
                );
            }
        }
    }

    result
}

#[tauri::command]
pub async fn cancel_download_task(state: State<'_, AppState>, task_id: &str) -> Result<(), String> {
    // NOTE: might want to add User-Agent header
    let mut download_manager = state.download_manager.lock().await;
    if let Some(task) = download_manager.cancel_tokens.remove(task_id) {
        task.cancel_token.cancel();
        log::info!("Cancelled download task: {task_id}");
        Ok(())
    } else {
        Err(format!("No download task: {task_id}"))
    }
}
