//! Tauri commands for starting and cancelling an isolated agent turn.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use tauri::{ipc::Channel, AppHandle, Manager, Runtime, State};
use tauri_plugin_llamacpp::state::LlamacppState;
use tauri_plugin_llamacpp_upstream::state::LlamacppState as LlamacppUpstreamState;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::approval::ApprovalGate;
use super::llm_client::{find_session_by_model_id, LlamaServerClient};
use super::path_policy::{expand_home, lexical_normalize};
use super::prompt::{
    build_stable_prefix, CapabilitiesSummary, DEFAULT_MAX_PARALLEL_TOOL_CALLS, ITERATION_ONE_TOOLS,
};
use super::runner::{run_turn, RunTurnInput, MAX_STEPS};
use super::tools::DesktopServices;
use super::types::{AgentApprovalDecision, AgentEvent, AgentTurnRequest};
use crate::core::state::AppState;

struct AgentDesktopServices<R: Runtime> {
    app_handle: AppHandle<R>,
}

#[async_trait]
impl<R: Runtime> DesktopServices for AgentDesktopServices<R> {
    async fn write_clipboard(&self, text: String) -> Result<(), String> {
        #[cfg(desktop)]
        {
            tauri::async_runtime::spawn_blocking(move || {
                crate::core::tray_status::write_clipboard(&text)
            })
            .await
            .map_err(|error| format!("Clipboard task failed: {error}"))?
        }
        #[cfg(not(desktop))]
        {
            let _ = text;
            Err("Clipboard write is unavailable on this platform".into())
        }
    }

    async fn notify(&self, title: String, body: String) -> Result<(), String> {
        #[cfg(desktop)]
        {
            crate::core::system::commands::show_desktop_notification(
                self.app_handle.clone(),
                title,
                body,
            )
            .await
        }
        #[cfg(not(desktop))]
        {
            let _ = (&self.app_handle, title, body);
            Err("Desktop notifications are unavailable on this platform".into())
        }
    }
}

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
        has_clipboard: cfg!(desktop),
        has_wmctrl: false,
        has_notifications: cfg!(desktop),
    };
    let stable_prefix = build_stable_prefix(
        ITERATION_ONE_TOOLS,
        &capabilities,
        DEFAULT_MAX_PARALLEL_TOOL_CALLS,
        None,
    );
    let approval_events = on_event.clone();
    let approval = ApprovalGate::new(
        request.run_id.clone(),
        request.auto_approve,
        state.agent_pending_approvals.clone(),
        Arc::new(move |event| {
            approval_events
                .send(event)
                .map_err(|error| error.to_string())
        }),
        cancellation.clone(),
    );
    let desktop = AgentDesktopServices {
        app_handle: app_handle.clone(),
    };
    let result = run_turn(
        RunTurnInput {
            run_id: &request.run_id,
            user_message: &request.user_message,
            stable_prefix: &stable_prefix,
            working_dir: &working_dir,
            max_steps: request.max_steps.unwrap_or(MAX_STEPS),
            client: &client,
            approval: &approval,
            desktop: &desktop,
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
    clear_pending_approvals_for_run(&state, &request.run_id).await;
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
    clear_pending_approvals_for_run(&state, &run_id).await;
    Ok(())
}

#[tauri::command]
pub async fn agent_resolve_approval(
    state: State<'_, AppState>,
    decision: AgentApprovalDecision,
) -> Result<(), String> {
    let pending = state
        .agent_pending_approvals
        .lock()
        .await
        .remove(&decision.approval_id)
        .ok_or_else(|| format!("Approval '{}' is not pending", decision.approval_id))?;
    pending
        .sender
        .send(decision.approved)
        .map_err(|_| format!("Approval '{}' is no longer active", decision.approval_id))
}

async fn clear_pending_approvals_for_run(state: &AppState, run_id: &str) {
    let mut pending = state.agent_pending_approvals.lock().await;
    let approval_ids = pending
        .iter()
        .filter(|(_, approval)| approval.run_id == run_id)
        .map(|(approval_id, _)| approval_id.clone())
        .collect::<Vec<_>>();
    for approval_id in approval_ids {
        if let Some(approval) = pending.remove(&approval_id) {
            let _ = approval.sender.send(false);
        }
    }
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
        Some(value) if !value.trim().is_empty() => expand_home(value)?,
        _ => std::env::current_dir().map_err(|error| error.to_string())?,
    };
    let path = if path.is_absolute() {
        lexical_normalize(&path)
    } else {
        lexical_normalize(
            &std::env::current_dir()
                .map_err(|error| error.to_string())?
                .join(path),
        )
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
