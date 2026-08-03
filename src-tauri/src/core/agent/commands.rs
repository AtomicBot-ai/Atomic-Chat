//! Tauri commands for starting and cancelling an isolated agent turn.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, Manager, Runtime, State};
use tauri_plugin_llamacpp::state::LlamacppState;
use tauri_plugin_llamacpp_upstream::state::LlamacppState as LlamacppUpstreamState;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::approval::ApprovalGate;
use super::attachments::stage_attachments;
use super::folder_access::FolderAccessGate;
use super::llm_client::{
    find_session_by_model_and_backend, find_session_by_model_id, ContextExpansionHook,
    LlamaClientError, LlamaServerClient, LlamaSessionTarget,
};
use super::model_profile::{detect_model_profile, AgentModelProfile};
use super::path_policy::{canonical_directory, expand_home, lexical_normalize, EditableRoots};
use super::prompt::{
    build_stable_prefix_for_profile, CapabilitiesSummary, SkillDescriptor,
    DEFAULT_MAX_PARALLEL_TOOL_CALLS, ITERATION_ONE_TOOLS,
};
use super::runner::{run_turn, RunTurnInput, MAX_STEPS};
use super::session::{load_session, save_session, validate_session_id};
use super::skills::load_registry;
use super::tools::DesktopServices;
use super::types::{
    AgentApprovalDecision, AgentEvent, AgentFolderAccessDecision, AgentTurnRequest,
    ApprovalDecision,
};
use super::workspace::default_agent_workspace;
use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::server::context_expansion::request_context_increase;
use crate::core::state::{AgentSessionLocks, AppState};

const DEFAULT_WORKSPACE_TEXT_BYTES: usize = 512 * 1024;
const MAX_WORKSPACE_TEXT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceRequest {
    #[serde(default)]
    pub working_dir: Option<String>,
    #[serde(default)]
    pub root_id: Option<String>,
    #[serde(default)]
    pub root_path: Option<String>,
    #[serde(default, alias = "path")]
    pub relative_path: Option<String>,
    #[serde(default)]
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceRootRequest {
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceRoot {
    pub root_id: String,
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: Option<u64>,
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceFile {
    pub path: String,
    pub absolute_path: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
    pub extension: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceText {
    pub path: String,
    pub content: String,
    pub truncated: bool,
}

#[tauri::command]
pub async fn agent_workspace_root<R: Runtime>(
    app_handle: AppHandle<R>,
    request: AgentWorkspaceRootRequest,
) -> Result<AgentWorkspaceRoot, String> {
    let data_folder = get_jan_data_folder_path(app_handle);
    let root = resolve_working_dir(request.path.as_deref(), &data_folder).await?;
    Ok(AgentWorkspaceRoot {
        root_id: super::path_policy::root_id_for_path(&root),
        path: root.to_string_lossy().into_owned(),
        name: root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned()),
    })
}

struct AgentDesktopServices<R: Runtime> {
    app_handle: AppHandle<R>,
}

struct AgentContextExpansion<R: Runtime> {
    app_handle: AppHandle<R>,
    state: Arc<crate::core::state::AutoIncreaseState>,
}

#[async_trait]
impl<R: Runtime> ContextExpansionHook for AgentContextExpansion<R> {
    async fn expand(
        &self,
        target: &LlamaSessionTarget,
        cancellation: &CancellationToken,
    ) -> Result<LlamaSessionTarget, String> {
        let outcome = request_context_increase(
            &self.app_handle,
            &self.state,
            target.backend.as_str(),
            &target.model_id,
            "error",
            Some(cancellation),
        )
        .await;
        if !outcome.ok {
            return Err(format!(
                "Context expansion failed: {}",
                outcome.reason.as_deref().unwrap_or("unknown")
            ));
        }
        let llama_state: State<LlamacppState> = self.app_handle.state();
        let upstream_state: State<LlamacppUpstreamState> = self.app_handle.state();
        find_session_by_model_and_backend(
            &target.model_id,
            target.backend,
            &llama_state,
            &upstream_state,
        )
        .await
        .map_err(|error| error.to_string())
    }
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
pub async fn agent_workspace_list<R: Runtime>(
    app_handle: AppHandle<R>,
    request: AgentWorkspaceRequest,
) -> Result<Vec<AgentWorkspaceEntry>, String> {
    let (root, path) = resolve_workspace_path(
        app_handle,
        &request,
        request.relative_path.as_deref().unwrap_or(""),
    )
    .await?;
    list_workspace_directory(&root, &path).await
}

async fn list_workspace_directory(
    root: &Path,
    path: &Path,
) -> Result<Vec<AgentWorkspaceEntry>, String> {
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("Could not inspect '{}': {error}", path.display()))?;
    if !metadata.is_dir() {
        return Err(format!(
            "Workspace path is not a directory: {}",
            path.display()
        ));
    }

    let mut directory = tokio::fs::read_dir(&path)
        .await
        .map_err(|error| format!("Could not list '{}': {error}", path.display()))?;
    let mut entries = Vec::new();
    while let Some(entry) = directory
        .next_entry()
        .await
        .map_err(|error| format!("Could not read '{}': {error}", path.display()))?
    {
        let entry_path = entry.path();
        let metadata = tokio::fs::metadata(&entry_path).await.ok();
        let kind = metadata
            .as_ref()
            .map(|value| if value.is_dir() { "directory" } else { "file" })
            .unwrap_or("unknown")
            .to_string();
        entries.push(AgentWorkspaceEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: workspace_relative_path(&root, &entry_path)?,
            kind,
            size: metadata
                .as_ref()
                .and_then(|value| value.is_file().then_some(value.len())),
            modified_ms: metadata.as_ref().and_then(modified_ms),
        });
    }
    entries.sort_by(|left, right| {
        let left_rank = if left.kind == "directory" { 0 } else { 1 };
        let right_rank = if right.kind == "directory" { 0 } else { 1 };
        left_rank
            .cmp(&right_rank)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub async fn agent_workspace_stat<R: Runtime>(
    app_handle: AppHandle<R>,
    request: AgentWorkspaceRequest,
) -> Result<AgentWorkspaceFile, String> {
    let relative = request
        .relative_path
        .as_deref()
        .ok_or_else(|| "Workspace file path is required".to_string())?;
    let (root, path) = resolve_workspace_path(app_handle, &request, relative).await?;
    let metadata = workspace_file_metadata(&path).await?;
    Ok(AgentWorkspaceFile {
        path: workspace_relative_path(&root, &path)?,
        absolute_path: path.to_string_lossy().into_owned(),
        size: metadata.len(),
        modified_ms: modified_ms(&metadata),
        extension: path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase(),
    })
}

#[tauri::command]
pub async fn agent_workspace_resolve_path<R: Runtime>(
    app_handle: AppHandle<R>,
    request: AgentWorkspaceRequest,
) -> Result<String, String> {
    let relative = request
        .relative_path
        .as_deref()
        .ok_or_else(|| "Workspace path is required".to_string())?;
    let (_, path) = resolve_workspace_path(app_handle, &request, relative).await?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn agent_workspace_read_text<R: Runtime>(
    app_handle: AppHandle<R>,
    request: AgentWorkspaceRequest,
) -> Result<AgentWorkspaceText, String> {
    let relative = request
        .relative_path
        .as_deref()
        .ok_or_else(|| "Workspace file path is required".to_string())?;
    let (root, path) = resolve_workspace_path(app_handle, &request, relative).await?;
    workspace_file_metadata(&path).await?;
    let limit = request
        .max_bytes
        .unwrap_or(DEFAULT_WORKSPACE_TEXT_BYTES)
        .clamp(1, MAX_WORKSPACE_TEXT_BYTES);
    let (content, truncated) = read_workspace_text(&path, limit).await?;
    Ok(AgentWorkspaceText {
        path: workspace_relative_path(&root, &path)?,
        content,
        truncated,
    })
}

async fn workspace_file_metadata(path: &Path) -> Result<std::fs::Metadata, String> {
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("Could not inspect '{}': {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("Workspace path is not a file: {}", path.display()));
    }
    Ok(metadata)
}

async fn read_workspace_text(path: &Path, limit: usize) -> Result<(String, bool), String> {
    use tokio::io::AsyncReadExt;

    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|error| format!("Could not open '{}': {error}", path.display()))?;
    let mut bytes = Vec::with_capacity(limit.saturating_add(1));
    file.take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| format!("Could not read '{}': {error}", path.display()))?;
    let truncated = bytes.len() > limit;
    bytes.truncate(limit);
    let content = match String::from_utf8(bytes) {
        Ok(content) => content,
        Err(error) if truncated && error.utf8_error().error_len().is_none() => {
            let valid_up_to = error.utf8_error().valid_up_to();
            String::from_utf8(error.into_bytes()[..valid_up_to].to_vec())
                .expect("valid UTF-8 prefix")
        }
        Err(_) => {
            return Err(format!(
                "Workspace file is not valid UTF-8 text: {}",
                path.display()
            ))
        }
    };
    Ok((content, truncated))
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
    state
        .agent_approval_allowlist
        .lock()
        .await
        .load_for_data_folder(&data_folder)?;
    let working_dir = resolve_working_dir(request.working_dir.as_deref(), &data_folder).await?;
    let mut editable_external_roots = Vec::new();
    let mut read_only_external_roots = Vec::new();
    for root in &request.external_roots {
        let expanded = expand_home(&root.path)?;
        if root.can_edit {
            editable_external_roots.push(expanded);
        } else {
            read_only_external_roots.push(canonical_directory(&expanded).await?);
        }
    }
    let editable_roots = EditableRoots::new(&working_dir, &editable_external_roots).await?;
    let llama_state: State<LlamacppState> = app_handle.state();
    let upstream_state: State<LlamacppUpstreamState> = app_handle.state();
    let target = find_session_by_model_id(&request.model_id, &llama_state, &upstream_state)
        .await
        .map_err(|error| error.to_string())?;
    let has_images = request
        .attachments
        .iter()
        .any(|attachment| attachment.kind == super::types::AgentAttachmentKind::Image);
    ensure_vision_requirement(has_images, target.has_vision)?;
    let staged = stage_attachments(&data_folder, &request.session_id, &request.attachments).await?;
    let user_message = staged.append_manifest(&request.user_message);
    let mut trusted_read_roots = read_only_external_roots;
    let external_read_only_count = trusted_read_roots.len();
    if let Some(attachment_root) = staged.trusted_root.as_ref() {
        trusted_read_roots.push(attachment_root.clone());
    }
    let cancellation = CancellationToken::new();
    let context_expansion = Arc::new(AgentContextExpansion {
        app_handle: app_handle.clone(),
        state: state.auto_increase_ctx.clone(),
    });
    let client = LlamaServerClient::new(&target)
        .map_err(|error| error.to_string())?
        .with_context_expansion(context_expansion);
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
    let skill_registry = load_registry(&data_folder)?;
    let bundled_script_runtime = resolve_bundled_script_runtime(&app_handle);
    let skill_descriptors = skill_registry
        .enabled()
        .map(|record| SkillDescriptor {
            name: record.manifest.name.clone(),
            description: record.manifest.description.clone(),
            version: record.manifest.version.clone(),
            requires_tools: record.manifest.requires_tools.clone(),
            requires_scripts: record.manifest.requires_scripts.clone(),
            dangerous: record.manifest.dangerous,
        })
        .collect::<Vec<_>>();
    let model_profile = match client.fetch_props(&cancellation).await {
        Ok(props) => detect_model_profile(&props),
        Err(LlamaClientError::Cancelled) => AgentModelProfile::Plain,
        Err(error) => {
            log::warn!("Agent model-profile probe failed; using plain profile: {error}");
            AgentModelProfile::Plain
        }
    };
    let stable_prefix = build_stable_prefix_for_profile(
        ITERATION_ONE_TOOLS,
        &skill_descriptors,
        &capabilities,
        DEFAULT_MAX_PARALLEL_TOOL_CALLS,
        None,
        model_profile,
    );
    let approval_events = on_event.clone();
    let approval = ApprovalGate::new(
        request.run_id.clone(),
        request.auto_approve,
        state.agent_pending_approvals.clone(),
        state.agent_approval_allowlist.clone(),
        Arc::new(move |event| {
            approval_events
                .send(event)
                .map_err(|error| error.to_string())
        }),
        cancellation.clone(),
    );
    let folder_access_events = on_event.clone();
    let folder_access = FolderAccessGate::new(
        request.run_id.clone(),
        state.agent_pending_folder_access.clone(),
        Arc::new(move |event| {
            folder_access_events
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
                        user_message: &user_message,
                        selected_skill: request.selected_skill.as_deref(),
                        stable_prefix: &stable_prefix,
                        model_profile,
                        working_dir: &working_dir,
                        editable_roots: &editable_roots,
                        external_read_only_roots: &trusted_read_roots[..external_read_only_count],
                        trusted_read_roots: &trusted_read_roots,
                        max_steps: request.max_steps.unwrap_or(MAX_STEPS),
                        client: &client,
                        approval: &approval,
                        folder_access: &folder_access,
                        desktop: &desktop,
                        cancellation: &cancellation,
                        session: &mut session,
                        skill_registry: &skill_registry,
                        bundled_script_runtime: bundled_script_runtime.as_deref(),
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
    clear_pending_folder_access_for_run(&state, &request.run_id).await;
    result
}

fn resolve_bundled_script_runtime<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    let executable = if cfg!(windows) { "bun.exe" } else { "bun" };
    app_handle
        .path()
        .resource_dir()
        .ok()
        .map(|root| root.join("resources/bin").join(executable))
        .filter(|path| path.is_file())
}

fn ensure_vision_requirement(has_images: bool, has_vision: bool) -> Result<(), String> {
    if has_images && !has_vision {
        Err(
            "AGENT_VISION_MODEL_REQUIRED: Select a vision-capable model before sending images"
                .into(),
        )
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod attachment_tests {
    use super::ensure_vision_requirement;

    #[test]
    fn rejects_image_turns_for_text_only_sessions() {
        assert!(ensure_vision_requirement(true, false)
            .unwrap_err()
            .starts_with("AGENT_VISION_MODEL_REQUIRED"));
        assert!(ensure_vision_requirement(true, true).is_ok());
        assert!(ensure_vision_requirement(false, false).is_ok());
    }
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
    clear_pending_folder_access_for_run(&state, &run_id).await;
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
    if decision.decision == ApprovalDecision::AlwaysAllow {
        if !pending.can_remember {
            let _ = pending.sender.send(ApprovalDecision::Deny);
            return Err("This Agent action cannot be remembered".into());
        }
        if let Err(error) = state
            .agent_approval_allowlist
            .lock()
            .await
            .insert(pending.fingerprint.clone())
        {
            let _ = pending.sender.send(ApprovalDecision::Deny);
            return Err(error);
        }
    }
    pending
        .sender
        .send(decision.decision)
        .map_err(|_| format!("Approval '{}' is no longer active", decision.approval_id))
}

#[tauri::command]
pub async fn agent_resolve_folder_access(
    state: State<'_, AppState>,
    decision: AgentFolderAccessDecision,
) -> Result<(), String> {
    let mut pending = state.agent_pending_folder_access.lock().await;
    let request = pending
        .get(&decision.access_id)
        .ok_or_else(|| format!("Folder access '{}' is not pending", decision.access_id))?;
    if request.run_id != decision.run_id {
        return Err(format!(
            "Folder access '{}' belongs to another Agent run",
            decision.access_id
        ));
    }
    let request = pending
        .remove(&decision.access_id)
        .expect("pending folder access was checked above");
    request
        .sender
        .send(decision.allow)
        .map_err(|_| format!("Folder access '{}' is no longer active", decision.access_id))
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
            let _ = approval.sender.send(ApprovalDecision::Deny);
        }
    }
}

async fn clear_pending_folder_access_for_run(state: &AppState, run_id: &str) {
    let mut pending = state.agent_pending_folder_access.lock().await;
    let access_ids = pending
        .iter()
        .filter(|(_, access)| access.run_id == run_id)
        .map(|(access_id, _)| access_id.clone())
        .collect::<Vec<_>>();
    for access_id in access_ids {
        if let Some(access) = pending.remove(&access_id) {
            let _ = access.sender.send(false);
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

async fn resolve_workspace_path<R: Runtime>(
    app_handle: AppHandle<R>,
    request: &AgentWorkspaceRequest,
    relative: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let data_folder = get_jan_data_folder_path(app_handle);
    let requested_root = request
        .root_path
        .as_deref()
        .or(request.working_dir.as_deref());
    let root = resolve_working_dir(requested_root, &data_folder).await?;
    if let Some(root_id) = request.root_id.as_deref() {
        if root_id != super::path_policy::root_id_for_path(&root) {
            return Err("Workspace root identifier does not match its canonical path".into());
        }
    }
    let candidate = resolve_workspace_candidate(&root, relative).await?;
    Ok((root, candidate))
}

async fn resolve_workspace_candidate(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative.components().any(|component| {
            !matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
    {
        return Err("Workspace path must be relative and stay inside the workspace".into());
    }
    let candidate = tokio::fs::canonicalize(root.join(relative))
        .await
        .map_err(|error| format!("Could not resolve workspace path: {error}"))?;
    if !candidate.starts_with(&root) {
        return Err("Workspace path escapes the selected Agent workspace".into());
    }
    Ok(candidate)
}

fn workspace_relative_path(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Workspace path escapes the selected Agent workspace".to_string())?;
    Ok(relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn modified_ms(metadata: &std::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
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
    use std::fs;

    use super::*;
    use crate::core::agent::test_support::TestWorkspace;

    #[cfg(windows)]
    fn create_junction(link: &Path, target: &Path) {
        let output = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("run mklink /J");
        assert!(
            output.status.success(),
            "mklink /J failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(windows)]
    fn create_directory_symlink_if_allowed(link: &Path, target: &Path) -> bool {
        match std::os::windows::fs::symlink_dir(target, link) {
            Ok(()) => true,
            Err(error)
                if error.kind() == std::io::ErrorKind::PermissionDenied
                    || error.raw_os_error() == Some(1314) =>
            {
                false
            }
            Err(error) => panic!("create directory symlink: {error}"),
        }
    }

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

    #[tokio::test]
    async fn workspace_candidate_stays_inside_root() {
        let workspace = TestWorkspace::new();
        fs::create_dir_all(workspace.path().join("src")).expect("create src");
        fs::write(workspace.path().join("src/main.rs"), "fn main() {}").expect("write file");
        let root = tokio::fs::canonicalize(workspace.path())
            .await
            .expect("canonical root");

        let resolved = resolve_workspace_candidate(&root, "src/main.rs")
            .await
            .expect("resolve file");

        assert_eq!(
            workspace_relative_path(&root, &resolved).unwrap(),
            "src/main.rs"
        );
    }

    #[tokio::test]
    async fn workspace_candidate_rejects_parent_traversal() {
        let workspace = TestWorkspace::new();
        let root = tokio::fs::canonicalize(workspace.path())
            .await
            .expect("canonical root");

        let error = resolve_workspace_candidate(&root, "../outside.txt")
            .await
            .unwrap_err();

        assert!(error.contains("must be relative"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_candidate_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let workspace = TestWorkspace::new();
        let outside = TestWorkspace::new();
        fs::write(outside.path().join("secret.txt"), "secret").expect("write outside file");
        symlink(outside.path(), workspace.path().join("outside")).expect("create symlink");
        let root = tokio::fs::canonicalize(workspace.path())
            .await
            .expect("canonical root");

        let error = resolve_workspace_candidate(&root, "outside/secret.txt")
            .await
            .unwrap_err();

        assert!(error.contains("escapes"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn workspace_candidate_rejects_windows_reparse_point_escapes() {
        let workspace = TestWorkspace::new();
        let outside = TestWorkspace::new();
        fs::write(outside.path().join("secret.txt"), "secret").expect("write outside file");
        let root = tokio::fs::canonicalize(workspace.path())
            .await
            .expect("canonical root");

        let junction = workspace.path().join("junction");
        create_junction(&junction, outside.path());
        let junction_error = resolve_workspace_candidate(&root, "junction/secret.txt")
            .await
            .unwrap_err();
        assert!(junction_error.contains("escapes"));
        fs::remove_dir(&junction).expect("remove junction");

        let symlink = workspace.path().join("symlink");
        if create_directory_symlink_if_allowed(&symlink, outside.path()) {
            let symlink_error = resolve_workspace_candidate(&root, "symlink/secret.txt")
                .await
                .unwrap_err();
            assert!(symlink_error.contains("escapes"));
            fs::remove_dir(&symlink).expect("remove symlink");
        }
    }

    #[tokio::test]
    async fn workspace_list_returns_directories_before_files() {
        let workspace = TestWorkspace::new();
        fs::create_dir_all(workspace.path().join("src")).expect("create directory");
        fs::write(workspace.path().join("README.md"), "read me").expect("write file");
        let root = tokio::fs::canonicalize(workspace.path())
            .await
            .expect("canonical root");

        let entries = list_workspace_directory(&root, &root)
            .await
            .expect("list workspace");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "src");
        assert_eq!(entries[0].kind, "directory");
        assert_eq!(entries[1].name, "README.md");
        assert_eq!(entries[1].kind, "file");
    }

    #[tokio::test]
    async fn workspace_file_metadata_rejects_directory() {
        let workspace = TestWorkspace::new();

        let error = workspace_file_metadata(workspace.path()).await.unwrap_err();

        assert!(error.contains("not a file"));
    }

    #[tokio::test]
    async fn workspace_text_read_reports_truncation() {
        let workspace = TestWorkspace::new();
        let file = workspace.path().join("notes.txt");
        fs::write(&file, "abcdef").expect("write text");

        let (content, truncated) = read_workspace_text(&file, 4).await.unwrap();

        assert_eq!(content, "abcd");
        assert!(truncated);
    }

    #[tokio::test]
    async fn workspace_text_read_rejects_invalid_utf8() {
        let workspace = TestWorkspace::new();
        let file = workspace.path().join("binary.bin");
        fs::write(&file, [0xff, 0xfe, 0xfd]).expect("write bytes");

        let error = read_workspace_text(&file, 16).await.unwrap_err();

        assert!(error.contains("not valid UTF-8"));
    }
}
