//! Tauri commands for starting and cancelling an isolated agent turn.

use std::path::{Path, PathBuf};
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
use super::session::{load_session, save_session, validate_session_id};
use super::tools::DesktopServices;
use super::types::{AgentApprovalDecision, AgentEvent, AgentTurnRequest};
use super::workspace::default_agent_workspace;
use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::state::{AgentSessionLocks, AppState};

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
    let data_folder = get_jan_data_folder_path(app_handle.clone());
    let working_dir = resolve_working_dir(request.working_dir.as_deref(), &data_folder).await?;
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
    let session_lock = get_session_lock(&state.agent_session_locks, &request.session_id).await;
    let result = {
        let _session_guard = session_lock.lock().await;
        match load_session(&data_folder, &request.session_id).await {
            Ok(mut session) => {
                let run_result = run_turn(
                    RunTurnInput {
                        run_id: &request.run_id,
                        session_id: &request.session_id,
                        user_message: &request.user_message,
                        stable_prefix: &stable_prefix,
                        working_dir: &working_dir,
                        max_steps: request.max_steps.unwrap_or(MAX_STEPS),
                        client: &client,
                        approval: &approval,
                        desktop: &desktop,
                        cancellation: &cancellation,
                        session: &mut session,
                    },
                    |event| on_event.send(event).map_err(|error| error.to_string()),
                )
                .await;
                match save_session(&data_folder, &session).await {
                    Ok(()) => run_result,
                    Err(error) => Err(error),
                }
            }
            Err(error) => Err(error),
        }
    };
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
    validate_session_id(&request.session_id)?;
    if request.model_id.trim().is_empty() {
        return Err("model_id must not be empty".into());
    }
    if request.user_message.trim().is_empty() {
        return Err("user_message must not be empty".into());
    }
    Ok(())
}

async fn get_session_lock(
    locks: &AgentSessionLocks,
    session_id: &str,
) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = locks.lock().await;
    locks
        .entry(session_id.to_owned())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

async fn resolve_working_dir(value: Option<&str>, data_folder: &Path) -> Result<PathBuf, String> {
    let path = match value {
        Some(value) if !value.trim().is_empty() => expand_home(value)?,
        _ => {
            let workspace = default_agent_workspace(data_folder);
            tokio::fs::create_dir_all(&workspace)
                .await
                .map_err(|error| {
                    format!(
                        "Failed to create default Agent workspace '{}': {error}",
                        workspace.display()
                    )
                })?;
            workspace
        }
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

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::core::agent::test_support::TestWorkspace;

    #[tokio::test]
    async fn same_session_serializes_while_different_sessions_remain_independent() {
        let locks: AgentSessionLocks = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let first = get_session_lock(&locks, "thread-a").await;
        let same = get_session_lock(&locks, "thread-a").await;
        let different = get_session_lock(&locks, "thread-b").await;
        assert!(Arc::ptr_eq(&first, &same));
        assert!(!Arc::ptr_eq(&first, &different));

        let first_guard = first.lock_owned().await;
        let (acquired_tx, acquired_rx) = tokio::sync::oneshot::channel();
        let waiter = tokio::spawn(async move {
            let _guard = same.lock_owned().await;
            let _ = acquired_tx.send(());
        });

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), acquired_rx)
                .await
                .is_err()
        );
        assert!(different.try_lock().is_ok());

        drop(first_guard);
        waiter.await.expect("same-session waiter");
    }

    #[tokio::test]
    async fn missing_working_dir_uses_default_agent_workspace() {
        let data_folder = TestWorkspace::new();

        let resolved = resolve_working_dir(None, data_folder.path())
            .await
            .expect("resolve default Agent workspace");
        let expected = tokio::fs::canonicalize(
            data_folder
                .path()
                .join(super::super::workspace::DEFAULT_AGENT_WORKSPACE_DIR),
        )
        .await
        .expect("canonicalize default Agent workspace");

        assert_eq!(resolved, expected);
        assert!(resolved.is_dir());
    }
}
