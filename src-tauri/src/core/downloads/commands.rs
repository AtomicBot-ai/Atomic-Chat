use super::disk::{free_space_report, FreeSpaceReport};
use super::helpers::{
    _download_files_internal, create_proxy_from_config, err_to_string, should_bypass_proxy,
    validate_proxy_config,
};
use super::models::{DownloadItem, DownloadTask, ProxyConfig};
use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::state::AppState;
use std::collections::HashMap;
use std::time::Duration;
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

/// Free space on the volume holding the data folder, for the frontend's
/// check before a download starts. Until now the `disk_full` refusal in
/// `_download_files_internal` was the first thing the user heard, and it
/// arrived as a download error after the row had already flipped to
/// "Downloading"; with this the web side can refuse before creating the entry.
///
/// Async so the volume probe (a `statfs` per mount, which can stall on an
/// unreachable network share) runs off the main thread like the other
/// download commands.
#[tauri::command]
pub async fn get_download_free_space<R: Runtime>(app: tauri::AppHandle<R>) -> FreeSpaceReport {
    free_space_report(&get_jan_data_folder_path(app))
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

/// Where a proxy test request is sent. The host models are actually fetched
/// from, so a pass means "downloads will work", not "some unrelated site is
/// reachable".
const PROXY_TEST_URL: &str = "https://huggingface.co/";
const PROXY_TEST_TIMEOUT_SECS: u64 = 15;

/// Outcome of `test_proxy_connection`, kept machine-readable so the UI owns
/// the wording (and the translations) rather than echoing a Rust string.
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTestResult {
    pub ok: bool,
    /// `ok` | `bypassed` | `invalid_config` | `unreachable` | `auth_failed` | `http_error`
    pub kind: &'static str,
    /// Raw technical detail (status line, transport error). Shown as the toast
    /// description; never the only thing the user is told.
    pub detail: String,
}

/// Try one request through the configured proxy and report what happened.
///
/// ATO — #290/#289: a proxy that refuses connections was only ever discovered
/// by a model download or a file upload failing a minute later, with a message
/// that named neither the proxy nor the address. `validate_proxy_config` checks
/// syntax and nothing else, so nothing in the app had ever actually talked to
/// the address the user typed.
#[tauri::command]
pub async fn test_proxy_connection(config: ProxyConfig) -> Result<ProxyTestResult, String> {
    if let Err(error) = validate_proxy_config(&config) {
        return Ok(ProxyTestResult {
            ok: false,
            kind: "invalid_config",
            detail: error,
        });
    }

    // A no_proxy entry covering the test host would make this request bypass
    // the proxy entirely and pass for the wrong reason.
    let no_proxy = config.no_proxy.as_deref().unwrap_or(&[]);
    if should_bypass_proxy(PROXY_TEST_URL, no_proxy) {
        return Ok(ProxyTestResult {
            ok: true,
            kind: "bypassed",
            detail: format!("{PROXY_TEST_URL} matches a no-proxy entry"),
        });
    }

    let proxy = create_proxy_from_config(&config)?;
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(PROXY_TEST_TIMEOUT_SECS))
        .timeout(Duration::from_secs(PROXY_TEST_TIMEOUT_SECS))
        .proxy(proxy);
    if config.ignore_ssl.unwrap_or(false) {
        builder = builder.danger_accept_invalid_certs(true);
    }
    let client = builder.build().map_err(err_to_string)?;

    log::info!("Testing proxy {} against {PROXY_TEST_URL}", config.url);
    match client.head(PROXY_TEST_URL).send().await {
        Ok(response) => {
            let status = response.status();
            let detail = format!("HTTP {status}");
            // The proxy answered, which is the thing being tested. 407 is the
            // one status that is unambiguously about the proxy itself.
            if status.as_u16() == 407 {
                Ok(ProxyTestResult {
                    ok: false,
                    kind: "auth_failed",
                    detail,
                })
            } else if status.is_client_error() || status.is_server_error() {
                Ok(ProxyTestResult {
                    ok: false,
                    kind: "http_error",
                    detail,
                })
            } else {
                Ok(ProxyTestResult {
                    ok: true,
                    kind: "ok",
                    detail,
                })
            }
        }
        Err(error) => {
            log::warn!("Proxy test for {} failed: {error}", config.url);
            Ok(ProxyTestResult {
                ok: false,
                kind: "unreachable",
                detail: error.to_string(),
            })
        }
    }
}
