use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_llamacpp::state::LlamacppState;
use tauri_plugin_llamacpp_upstream::state::LlamacppState as LlamacppUpstreamState;
use tauri_plugin_mlx::state::MlxState;

use crate::core::server::proxy;
use crate::core::server::request_inspector::ApiRequestLogSnapshot;
use crate::core::server::state_file;
use crate::core::state::{AppState, LocalServerEndpoint};

#[derive(serde::Deserialize)]
pub struct StartServerConfig {
    pub host: String,
    pub port: u16,
    pub prefix: String,
    pub api_key: String,
    pub trusted_hosts: Vec<String>,
    pub proxy_timeout: u64,
}

#[tauri::command]
pub async fn start_server<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, AppState>,
    config: StartServerConfig,
) -> Result<u16, String> {
    let StartServerConfig {
        host,
        port,
        prefix,
        api_key,
        trusted_hosts,
        proxy_timeout,
    } = config;
    // The CLI is headless and cannot read these settings out of the webview's
    // localStorage, so mirror the effective address to disk for `server status`.
    let requires_api_key = !api_key.is_empty();
    let mirror_host = host.clone();
    let mirror_prefix = prefix.clone();
    let server_handle = state.server_handle.clone();
    let llama_state: State<LlamacppState> = app_handle.state();
    let sessions = llama_state.llama_server_process.clone();

    let llama_upstream_state: State<LlamacppUpstreamState> = app_handle.state();
    let sessions_upstream = llama_upstream_state.llama_server_process.clone();

    let mlx_state: State<MlxState> = app_handle.state();
    let mlx_sessions = mlx_state.mlx_server_process.clone();

    // `AppState` is built before `.setup()`, so this is the first point where
    // the inspector and an `AppHandle` exist together. Idempotent.
    state.api_request_inspector.attach(app_handle.clone());

    let actual_port = proxy::start_server(
        app_handle.clone(),
        server_handle,
        sessions,
        sessions_upstream,
        mlx_sessions,
        host.clone(),
        port,
        prefix.clone(),
        api_key.clone(),
        vec![trusted_hosts],
        proxy_timeout,
        state.provider_configs.clone(),
        state.auto_increase_ctx.clone(),
        state.api_request_inspector.clone(),
    )
    .await
    .map_err(|e| e.to_string())?;
    // Publish the effective endpoint so in-process callers (the agent's cloud
    // path) can reach the proxy. `actual_port` matters: a requested port of 0
    // is auto-assigned.
    *state.local_server_endpoint.lock().await = Some(LocalServerEndpoint::new(
        &host,
        actual_port,
        &prefix,
        &api_key,
    ));

    state_file::mark_running(&mirror_host, actual_port, &mirror_prefix, requires_api_key);

    Ok(actual_port)
}

#[tauri::command]
pub async fn stop_server(state: State<'_, AppState>) -> Result<(), String> {
    let server_handle = state.server_handle.clone();

    proxy::stop_server(server_handle)
        .await
        .map_err(|e| e.to_string())?;
    state.local_server_endpoint.lock().await.take();

    state_file::mark_stopped();

    Ok(())
}

#[tauri::command]
pub async fn get_server_status(state: State<'_, AppState>) -> Result<bool, String> {
    let server_handle = state.server_handle.clone();

    Ok(proxy::is_server_running(server_handle).await)
}

/// Snapshot of the live request log, used to hydrate the API screen on mount.
#[tauri::command]
pub async fn get_api_request_log(
    state: State<'_, AppState>,
) -> Result<ApiRequestLogSnapshot, String> {
    Ok(state.api_request_inspector.snapshot())
}

/// Refcounted: recording only happens while at least one view is watching, and
/// the ring is wiped when the last one leaves so prompt previews do not
/// outlive the screen showing them.
#[tauri::command]
pub async fn set_api_inspector_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    state.api_request_inspector.set_enabled(enabled);
    Ok(())
}

#[tauri::command]
pub async fn clear_api_request_log(state: State<'_, AppState>) -> Result<(), String> {
    state.api_request_inspector.clear();
    Ok(())
}
