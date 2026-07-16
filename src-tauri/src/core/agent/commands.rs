//! Tauri commands for starting and cancelling an isolated agent turn.

use std::path::PathBuf;

use tauri::{ipc::Channel, AppHandle, Manager, Runtime, State};
use tauri_plugin_llamacpp::state::LlamacppState;
use tauri_plugin_llamacpp_upstream::state::LlamacppState as LlamacppUpstreamState;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::llm_client::{find_session_by_model_id, LlamaServerClient};
use super::prompt::{
    build_stable_prefix, CapabilitiesSummary, DEFAULT_MAX_PARALLEL_TOOL_CALLS, ITERATION_ONE_TOOLS,
};
use super::runner::{run_turn, RunTurnInput, MAX_STEPS};
use super::tools::DenyApprovalHook;
use super::types::{AgentEvent, AgentTurnRequest};
use crate::core::state::AppState;

#[tauri::command]
pub async fn agent_run_turn<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, AppState>,
    request: AgentTurnRequest,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    validate_request(&request)?;
    let working_dir = resolve_working_dir(request.working_dir.as_deref()).await?;
    let llama_state: State<LlamacppState> = app_handle.state();
    let upstream_state: State<LlamacppUpstreamState> = app_handle.state();
    let target = find_session_by_model_id(&request.model_id, &llama_state, &upstream_state)
        .await
        .map_err(|error| error.to_string())?;
    let client = LlamaServerClient::new(&target).map_err(|error| error.to_string())?;
    let cancellation = CancellationToken::new();
    let (cancel_tx, cancel_rx) = oneshot::channel();
    {
        let mut cancellations = state.tool_call_cancellations.lock().await;
        if cancellations.contains_key(&request.run_id) {
            return Err(format!("Agent run '{}' is already active", request.run_id));
        }
        cancellations.insert(request.run_id.clone(), cancel_tx);
    }
    let cancellation_bridge = cancellation.clone();
    tokio::spawn(async move {
        if cancel_rx.await.is_ok() {
            cancellation_bridge.cancel();
        }
    });

    let capabilities = CapabilitiesSummary {
        platform: platform_name().into(),
        arch: std::env::consts::ARCH.into(),
        browser_channel: "none".into(),
        working_dir: working_dir.display().to_string(),
        has_clipboard: true,
        has_wmctrl: false,
        has_notifications: false,
    };
    let stable_prefix = build_stable_prefix(
        ITERATION_ONE_TOOLS,
        &capabilities,
        DEFAULT_MAX_PARALLEL_TOOL_CALLS,
        None,
    );
    let approval = DenyApprovalHook;
    let result = run_turn(
        RunTurnInput {
            run_id: &request.run_id,
            user_message: &request.user_message,
            stable_prefix: &stable_prefix,
            working_dir: &working_dir,
            max_steps: request.max_steps.unwrap_or(MAX_STEPS),
            client: &client,
            approval: &approval,
            cancellation: &cancellation,
        },
        |event| on_event.send(event).map_err(|error| error.to_string()),
    )
    .await;
    state
        .tool_call_cancellations
        .lock()
        .await
        .remove(&request.run_id);
    result
}

#[tauri::command]
pub async fn agent_cancel_turn(state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    let sender = state
        .tool_call_cancellations
        .lock()
        .await
        .remove(&run_id)
        .ok_or_else(|| format!("Agent run '{run_id}' is not active"))?;
    let _ = sender.send(());
    Ok(())
}

fn validate_request(request: &AgentTurnRequest) -> Result<(), String> {
    if request.run_id.trim().is_empty() {
        return Err("run_id must not be empty".into());
    }
    if request.model_id.trim().is_empty() {
        return Err("model_id must not be empty".into());
    }
    if request.user_message.trim().is_empty() {
        return Err("user_message must not be empty".into());
    }
    Ok(())
}

async fn resolve_working_dir(value: Option<&str>) -> Result<PathBuf, String> {
    let path = match value {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => std::env::current_dir().map_err(|error| error.to_string())?,
    };
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("Invalid working directory '{}': {error}", path.display()))?;
    if !metadata.is_dir() {
        return Err(format!(
            "Working directory is not a directory: {}",
            path.display()
        ));
    }
    tokio::fs::canonicalize(&path)
        .await
        .map_err(|error| format!("Could not resolve working directory: {error}"))
}

fn platform_name() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}
