//! Tauri commands for the Ollama panel in Settings > Runtimes.

use std::collections::HashMap;

use serde::Serialize;
use tauri::{Emitter, Runtime, State};
use tokio_util::sync::CancellationToken;

use super::{
    api::{self, ModelList, PullProgress},
    install::{self, Binary, BinarySource},
    process::{self, OllamaState},
    settings::{self, OllamaSettings},
};
use crate::core::{
    app::commands::get_jan_data_folder_path,
    downloads::{commands::download_files, models::DownloadItem},
    runtimes::probe::normalize_base_url,
    state::AppState,
};

/// An Ollama answering where Radium's would, that Radium did not start.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalOllama {
    pub base_url: String,
    pub version: Option<String>,
    /// Processes that would be stopped to take it over.
    pub processes: Vec<process::ExternalProcess>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStatus {
    /// Radium's Ollama is running.
    pub running: bool,
    pub pid: Option<u32>,
    pub base_url: String,
    pub started_at_ms: Option<u64>,
    /// The version the running server reports.
    pub version: Option<String>,
    /// The `ollama` Radium would run, if any.
    pub binary: Option<Binary>,
    /// Radium can download its own copy on this system.
    pub can_install: bool,
    pub install_version: &'static str,
    pub install_bytes: Option<u64>,
    pub settings: OllamaSettings,
    /// Where models live when the folder setting is empty.
    pub default_models_dir: Option<String>,
    /// Set when another Ollama already answers on Radium's port.
    pub external: Option<ExternalOllama>,
}

async fn status_of<R: Runtime>(
    app: &tauri::AppHandle<R>,
    state: &OllamaState,
) -> Result<OllamaStatus, String> {
    let data_dir = get_jan_data_folder_path(app.clone());
    let settings = settings::load(&install::settings_path(&data_dir));
    let base_url = settings.base_url();

    let (running, pid, started_at_ms) = {
        let mut guard = state.running.lock().await;
        if let Some(current) = guard.as_mut() {
            if matches!(current.child.try_wait(), Ok(None)) {
                (true, current.child.id(), Some(current.started_at_ms))
            } else {
                *guard = None;
                (false, None, None)
            }
        } else {
            (false, None, None)
        }
    };

    let version = process::version_at(&base_url).await;
    let external = if !running && version.is_some() {
        Some(ExternalOllama {
            base_url: base_url.clone(),
            version: version.clone(),
            processes: process::external_processes(None),
        })
    } else {
        None
    };

    let asset = install::pinned_asset();
    Ok(OllamaStatus {
        running,
        pid,
        base_url,
        started_at_ms,
        version: if running { version } else { None },
        binary: install::resolve(&data_dir),
        can_install: asset.is_some(),
        install_version: install::VERSION,
        install_bytes: asset.map(|asset| asset.approx_bytes),
        default_models_dir: install::default_models_dir().map(|p| p.display().to_string()),
        settings,
        external,
    })
}

#[tauri::command]
pub async fn ollama_status<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, OllamaState>,
) -> Result<OllamaStatus, String> {
    status_of(&app, &state).await
}

/// Downloads and unpacks Radium's pinned copy, reporting progress on the
/// download manager's `download-{task_id}` event.
#[tauri::command]
pub async fn ollama_install<R: Runtime>(
    app: tauri::AppHandle<R>,
    downloads: State<'_, AppState>,
    task_id: String,
) -> Result<Binary, String> {
    let asset = install::pinned_asset().ok_or_else(|| {
        "Radium installs Ollama on Windows. On this system, install Ollama from ollama.com; Radium will find and run it.".to_string()
    })?;
    let data_dir = get_jan_data_folder_path(app.clone());
    let item = DownloadItem {
        url: asset.url.to_string(),
        save_path: install::archive_save_path(asset),
        proxy: None,
        sha256: Some(asset.sha256.to_string()),
        size: None,
        model_id: Some("runtime:ollama".into()),
    };
    download_files(app, downloads, vec![item], &task_id, HashMap::new(), false).await?;
    let path = tauri::async_runtime::spawn_blocking(move || install::finish_install(&data_dir, asset))
        .await
        .map_err(|error| error.to_string())??;
    Ok(Binary {
        path,
        source: BinarySource::Radium,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSettings {
    pub settings: OllamaSettings,
    /// Radium's Ollama is running with the old settings.
    pub needs_restart: bool,
}

#[tauri::command]
pub async fn ollama_settings_set<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, OllamaState>,
    settings: OllamaSettings,
) -> Result<SavedSettings, String> {
    let path = install::settings_path(&get_jan_data_folder_path(app));
    let previous = settings::load(&path);
    settings::save(&path, &settings)?;
    let running = state
        .running
        .lock()
        .await
        .as_mut()
        .is_some_and(|current| matches!(current.child.try_wait(), Ok(None)));
    Ok(SavedSettings {
        needs_restart: running && previous.needs_restart(&settings),
        settings,
    })
}

async fn start_with<R: Runtime>(
    app: &tauri::AppHandle<R>,
    state: &OllamaState,
    binary_override: Option<Binary>,
) -> Result<OllamaStatus, String> {
    let data_dir = get_jan_data_folder_path(app.clone());
    let settings = settings::load(&install::settings_path(&data_dir));
    {
        let mut guard = state.running.lock().await;
        if let Some(current) = guard.as_mut() {
            if matches!(current.child.try_wait(), Ok(None)) {
                drop(guard);
                return status_of(app, state).await;
            }
        }
        *guard = None;
    }
    if !crate::core::runtimes::ports::is_free_on_loopback(settings.port) {
        return Err(if process::version_at(&settings.base_url()).await.is_some() {
            format!(
                "Another Ollama is already running on port {}. Let Radium take it over, or connect to it instead.",
                settings.port
            )
        } else {
            format!("Port {} is in use by another program; pick another port in Settings.", settings.port)
        });
    }
    let binary = match binary_override.or_else(|| install::resolve(&data_dir)) {
        Some(binary) => binary,
        None => {
            return Err("Ollama is not installed. Install it from this panel first.".into())
        }
    };
    let running = process::start(&binary, &settings, &state.logs).await?;
    log::info!(
        "[ollama] started {} (pid {:?}) on {}",
        binary.path.display(),
        running.child.id(),
        settings.base_url()
    );
    *state.running.lock().await = Some(running);
    status_of(app, state).await
}

#[tauri::command]
pub async fn ollama_start<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, OllamaState>,
) -> Result<OllamaStatus, String> {
    start_with(&app, &state, None).await
}

#[tauri::command]
pub async fn ollama_stop<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, OllamaState>,
) -> Result<OllamaStatus, String> {
    if let Some(mut current) = state.running.lock().await.take() {
        process::stop(&mut current.child).await?;
    }
    status_of(&app, &state).await
}

#[tauri::command]
pub async fn ollama_restart<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, OllamaState>,
) -> Result<OllamaStatus, String> {
    let binary = {
        let mut guard = state.running.lock().await;
        match guard.take() {
            Some(mut current) => {
                process::stop(&mut current.child).await?;
                Some(current.binary)
            }
            None => None,
        }
    };
    // Wait for the port before starting again.
    let data_dir = get_jan_data_folder_path(app.clone());
    let port = settings::load(&install::settings_path(&data_dir)).port;
    for _ in 0..40 {
        if crate::core::runtimes::ports::is_free_on_loopback(port) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    start_with(&app, &state, binary).await
}

/// Stops the Ollama the user started (tray app and server) and starts it
/// again under Radium, with Radium's settings and the same models folder.
/// Uses the user's own `ollama` when Radium has no copy of its own.
#[tauri::command]
pub async fn ollama_take_over<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, OllamaState>,
) -> Result<OllamaStatus, String> {
    let data_dir = get_jan_data_folder_path(app.clone());
    let settings = settings::load(&install::settings_path(&data_dir));
    let own_pid = match state.running.lock().await.as_ref() {
        Some(current) => current.child.id(),
        None => None,
    };
    let processes = process::external_processes(own_pid);
    if processes.is_empty() {
        return Err("No Ollama started outside Radium was found.".into());
    }
    let their_binary = process::server_exe(&processes).map(|path| Binary {
        path,
        source: BinarySource::System,
    });
    log::info!(
        "[ollama] taking over {} external process(es): {:?}",
        processes.len(),
        processes.iter().map(|p| (&p.name, p.pid)).collect::<Vec<_>>()
    );
    process::stop_external(&processes, settings.port).await?;
    let binary = install::resolve(&data_dir)
        .filter(|binary| binary.source == BinarySource::Radium)
        .or(their_binary)
        .or_else(|| install::resolve(&data_dir));
    start_with(&app, &state, binary).await
}

#[tauri::command]
pub fn ollama_logs(state: State<'_, OllamaState>, lines: Option<usize>) -> Vec<String> {
    state
        .logs
        .lock()
        .map(|buffer| buffer.tail(lines.unwrap_or(300)))
        .unwrap_or_default()
}

#[tauri::command]
pub async fn ollama_models(base_url: String) -> Result<ModelList, String> {
    api::list(&normalize_base_url(&base_url)?).await
}

/// Downloads a model, emitting `ollama-pull-{task_id}` with each update.
#[tauri::command]
pub async fn ollama_pull<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, OllamaState>,
    base_url: String,
    model: String,
    task_id: String,
) -> Result<(), String> {
    let base_url = normalize_base_url(&base_url)?;
    let cancel = CancellationToken::new();
    if let Ok(mut pulls) = state.pulls.lock() {
        pulls.insert(task_id.clone(), cancel.clone());
    }
    let event = format!("ollama-pull-{task_id}");
    let result = api::pull(&base_url, &model, cancel, |progress: PullProgress| {
        let _ = app.emit(&event, progress);
    })
    .await;
    if let Ok(mut pulls) = state.pulls.lock() {
        pulls.remove(&task_id);
    }
    result
}

#[tauri::command]
pub fn ollama_pull_cancel(state: State<'_, OllamaState>, task_id: String) -> bool {
    state
        .pulls
        .lock()
        .ok()
        .and_then(|mut pulls| pulls.remove(&task_id))
        .map(|token| token.cancel())
        .is_some()
}

#[tauri::command]
pub async fn ollama_delete_model(base_url: String, model: String) -> Result<(), String> {
    api::delete(&normalize_base_url(&base_url)?, &model).await
}

#[tauri::command]
pub async fn ollama_load_model(base_url: String, model: String) -> Result<(), String> {
    api::set_loaded(&normalize_base_url(&base_url)?, &model, None).await
}

#[tauri::command]
pub async fn ollama_unload_model(base_url: String, model: String) -> Result<(), String> {
    api::set_loaded(&normalize_base_url(&base_url)?, &model, Some("0")).await
}

/// Starts Radium's Ollama when Radium starts, if the user asked for that.
/// Never fails the app start: problems are logged.
pub async fn auto_start<R: Runtime>(app: tauri::AppHandle<R>) {
    use tauri::Manager;
    let data_dir = get_jan_data_folder_path(app.clone());
    let settings = settings::load(&install::settings_path(&data_dir));
    if !settings.auto_start {
        return;
    }
    let state = app.state::<OllamaState>();
    match start_with(&app, &state, None).await {
        Ok(_) => log::info!("[ollama] started with Radium"),
        Err(error) => log::warn!("[ollama] auto-start skipped: {error}"),
    }
}

/// Stops Radium's Ollama when Radium quits.
pub async fn stop_on_exit(state: &OllamaState) {
    if let Some(mut current) = state.running.lock().await.take() {
        let _ = process::stop(&mut current.child).await;
    }
}
