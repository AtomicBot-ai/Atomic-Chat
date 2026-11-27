//! Tauri commands for starting and cancelling an isolated agent turn.

use std::path::PathBuf;
use crate::core::workspace_files::resolve_working_dir;
use std::sync::Arc;

use async_trait::async_trait;
use tauri::{ipc::Channel, AppHandle, Manager, Runtime, State};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::approval::ApprovalGate;
use super::attachments::stage_attachments;
use super::folder_access::FolderAccessGate;
use super::llm_client::{
    find_session_by_model_and_backend, AgentLlmClient, ContextExpansionHook, LlamaServerClient,
    LlamaSessionTarget, SamplingOverrides,
};
use super::mcp_tools::{snapshot_catalog, LiveMcpBridge, McpBridge};
use super::openai_client::{
    OpenAiCompatibleClient, OpenAiTarget, OpenAiTargetKind, SessionReloadHook,
};
use super::path_policy::{canonical_directory, expand_home, EditableRoots};
use super::prompt::{
    build_stable_prefix_with, CapabilitiesSummary, SkillDescriptor, StablePrefixArgs,
    DEFAULT_MAX_PARALLEL_TOOL_CALLS, ITERATION_ONE_TOOLS,
};
use super::rag_bridge::{DocsBridge, LiveDocsBridge};
use super::runner::{run_turn, RunTurnInput, MAX_STEPS};
use super::session::{load_session, save_session, validate_session_id, AgentReseedMessage};
use super::skills::load_registry;
use super::target::{resolve_agent_target, resolve_mlx_target, AgentTarget};
use super::tools::DesktopServices;
use super::types::{
    AgentApprovalDecision, AgentEvent, AgentFolderAccessDecision, AgentReasoning, AgentTurnRequest,
    ApprovalDecision,
};
use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::server::context_expansion::request_context_increase;
use crate::core::state::{AgentSessionLocks, AppState};

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
        // Re-resolve after the reload: the model is running in a new process on a new port, and
        // the target the caller handed us describes the one that just went away.
        let app_state: State<AppState> = self.app_handle.state();
        let resolver = crate::core::sessions::resolver_for(&self.app_handle, &app_state);
        find_session_by_model_and_backend(&target.model_id, target.backend, &resolver)
            .await
            .map_err(|error| error.to_string())
    }
}

/// MLX counterpart of [`AgentContextExpansion`].
///
/// The MLX extension already subscribes to the shared `auto_increase_ctx`
/// channel with `backend: "mlx"`, so the ladder is reused verbatim. A reload
/// spawns a fresh process, so the replacement target must be re-resolved to
/// pick up the new port.
struct AgentMlxContextExpansion<R: Runtime> {
    app_handle: AppHandle<R>,
    state: Arc<crate::core::state::AutoIncreaseState>,
    request: AgentTurnRequest,
}

#[async_trait]
impl<R: Runtime> SessionReloadHook for AgentMlxContextExpansion<R> {
    async fn reload_with_larger_context(
        &self,
        target: &OpenAiTarget,
        cancellation: &CancellationToken,
    ) -> Result<OpenAiTarget, String> {
        let outcome = request_context_increase(
            &self.app_handle,
            &self.state,
            "mlx",
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
        resolve_mlx_target(&self.app_handle, &self.request).await
    }
}

/// Builds the transport for a resolved target, attaching the context-expansion
/// hook that belongs to that backend. Cloud targets get none: there is nothing
/// to reload, and an honest error beats a silent truncation.
fn build_agent_client<R: Runtime>(
    target: AgentTarget,
    app_handle: &AppHandle<R>,
    state: &AppState,
    request: &AgentTurnRequest,
) -> Result<Box<dyn AgentLlmClient>, String> {
    match target {
        AgentTarget::Llama(target) => {
            let hook = Arc::new(AgentContextExpansion {
                app_handle: app_handle.clone(),
                state: state.auto_increase_ctx.clone(),
            });
            Ok(Box::new(
                LlamaServerClient::new(&target)
                    .map_err(|error| error.to_string())?
                    .with_context_expansion(hook),
            ))
        }
        AgentTarget::OpenAi(target) => {
            let is_mlx = target.kind == OpenAiTargetKind::LocalMlx;
            let mut client =
                OpenAiCompatibleClient::new(target).map_err(|error| error.to_string())?;
            if is_mlx {
                client = client.with_session_reload(Arc::new(AgentMlxContextExpansion {
                    app_handle: app_handle.clone(),
                    state: state.auto_increase_ctx.clone(),
                    request: request.clone(),
                }));
            }
            Ok(Box::new(client))
        }
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

/// Where the tree-sitter symbol index caches parsed files, under the app data
/// folder. Pure derivative of the working tree: safe to delete at any time.
const CODE_INDEX_CACHE_DIR: &str = "agent-code-index";

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
    let target = resolve_agent_target(&app_handle, &state, &request).await?;
    let has_images = request
        .attachments
        .iter()
        .any(|attachment| attachment.kind == super::types::AgentAttachmentKind::Image);
    ensure_vision_requirement(has_images, target.has_vision())?;
    let staged = stage_attachments(&data_folder, &request.session_id, &request.attachments).await?;
    let user_message = staged.append_manifest(&request.user_message);
    let mut trusted_read_roots = read_only_external_roots;
    let external_read_only_count = trusted_read_roots.len();
    if let Some(attachment_root) = staged.trusted_root.as_ref() {
        trusted_read_roots.push(attachment_root.clone());
    }
    let cancellation = CancellationToken::new();
    let client = build_agent_client(target, &app_handle, &state, &request)?;
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
    let model_profile = client.probe_model_profile(&cancellation).await;
    let reasoning = AgentReasoning::from_request(request.reasoning.as_ref());
    // Assistant sampling reaches the loop only once the user explicitly tuned
    // it; otherwise the agent keeps its own calibrated sampler.
    let sampling = SamplingOverrides::from_request(if request.sampling_overridden {
        request.sampling.as_ref()
    } else {
        None
    });
    // Per-turn switch for the built-in web tools. The prompt, grammar, schema
    // and dispatch all read this one set.
    let mut disabled_tools: std::collections::BTreeSet<String> = if request.web_search {
        std::collections::BTreeSet::new()
    } else {
        ["os.web.search", "os.web.fetch"]
            .into_iter()
            .map(str::to_owned)
            .collect()
    };
    // Threads without documents keep the docs.* tools out of the prompt,
    // grammar, schema and dispatch — the stable prefix stays byte-identical
    // to pre-RAG turns.
    if request.rag.is_none() {
        disabled_tools.extend(
            super::tools::docs::DOCS_TOOL_NAMES
                .into_iter()
                .map(str::to_owned),
        );
    }
    let enabled_descriptors: Vec<super::prompt::ToolDescriptor> = ITERATION_ONE_TOOLS
        .iter()
        .filter(|descriptor| !disabled_tools.contains(descriptor.name))
        .cloned()
        .collect();
    // Snapshot the MCP catalog once: the tool set is frozen for the whole
    // turn, so every step's prompt stays byte-stable.
    let mcp_bridge: Option<LiveMcpBridge> = if request.mcp_enabled {
        let disabled_keys = request
            .disabled_mcp_tools
            .iter()
            .cloned()
            .collect::<std::collections::BTreeSet<String>>();
        let catalog = snapshot_catalog(&state, &disabled_keys).await;
        if catalog.is_empty() {
            None
        } else {
            let call_timeout = state.mcp_settings.lock().await.tool_call_timeout_duration();
            Some(LiveMcpBridge::new(
                catalog,
                state.mcp_servers.clone(),
                call_timeout,
            ))
        }
    } else {
        None
    };
    let mcp: Option<&dyn McpBridge> = mcp_bridge.as_ref().map(|bridge| bridge as &dyn McpBridge);
    // Document-index bridge for turns that carry rag context. Collection
    // names arrive verbatim from the frontend (validated above); the
    // embedding session is TS-owned and merely looked up per call.
    let docs_bridge: Option<LiveDocsBridge> = request.rag.as_ref().map(|rag| {
        let vector_db = app_handle.state::<tauri_plugin_vector_db::VectorDBState>();
        LiveDocsBridge::new(
            vector_db.base_dir.clone(),
            rag.thread_collection.clone(),
            rag.project_collection.clone(),
            crate::core::sessions::resolver_for(&app_handle, &state),
        )
    });
    let docs: Option<&dyn DocsBridge> =
        docs_bridge.as_ref().map(|bridge| bridge as &dyn DocsBridge);
    let documents_note = request.rag.as_ref().map(format_documents_note);
    let stable_prefix = build_stable_prefix_with(&StablePrefixArgs {
        tool_descriptors: &enabled_descriptors,
        skill_descriptors: &skill_descriptors,
        capabilities: &capabilities,
        max_parallel_tool_calls: DEFAULT_MAX_PARALLEL_TOOL_CALLS,
        system_persona: None,
        assistant_instructions: request.assistant_instructions.as_deref(),
        mcp_tools: mcp.map(|bridge| bridge.descriptors()).unwrap_or(&[]),
        mcp_omitted: mcp_bridge
            .as_ref()
            .map(|bridge| bridge.omitted())
            .unwrap_or(0),
        profile: model_profile,
        thinking: reasoning.is_on(),
    });
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
    let code_index_cache = data_folder.join(CODE_INDEX_CACHE_DIR);
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
                        reasoning: reasoning.clone(),
                        sampling: &sampling,
                        mcp,
                        disabled_tools: &disabled_tools,
                        auto_approve_mcp: request.auto_approve_mcp,
                        docs,
                        documents_note: documents_note.as_deref(),
                        client: client.as_ref(),
                        approval: &approval,
                        folder_access: &folder_access,
                        desktop: &desktop,
                        cancellation: &cancellation,
                        session: &mut session,
                        skill_registry: &skill_registry,
                        bundled_script_runtime: bundled_script_runtime.as_deref(),
                        pty: &state.agent_pty_sessions,
                        cache_dir: &code_index_cache,
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

/// Re-seed the durable agent transcript from the authoritative frontend
/// message list — after edit/delete/regenerate, or lazily when a thread has
/// turns the loop never saw (legacy chat history, fallback-engine turns).
///
/// Serialized on the per-session lock, so it can never interleave a running
/// turn's `save_session`; the frontend must cancel or await any active run
/// first. Spawned PTY processes are left alone — they are session resources
/// that survive history edits and die with the thread.
#[tauri::command]
pub async fn agent_session_reseed<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, AppState>,
    session_id: String,
    messages: Vec<AgentReseedMessage>,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let data_folder = get_jan_data_folder_path(app_handle);
    let session_lock = get_session_lock(&state.agent_session_locks, &session_id).await;
    let _session_guard = session_lock.lock().await;
    let mut session = load_session(&data_folder, &session_id).await?;
    session.reseed(&messages);
    save_session(&data_folder, &session).await
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

/// Kill every process `os.proc.spawn` started for one agent session.
///
/// Deliberately *not* wired to `agent_cancel_turn`: a dev server the agent
/// started should survive the turn that started it, and usually the next one
/// too. It should not survive the conversation, so the frontend calls this when
/// the thread is closed or deleted.
#[tauri::command]
pub async fn agent_kill_session_procs(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<usize, String> {
    Ok(state.agent_pty_sessions.kill_session(&session_id))
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
    if let Some(rag) = &request.rag {
        validate_collection_name(&rag.thread_collection)?;
        if let Some(project) = &rag.project_collection {
            validate_collection_name(project)?;
        }
    }
    Ok(())
}

/// Collection names become SQLite file names under the vector-db base dir;
/// only the charset the TS extension generates is accepted.
fn validate_collection_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    {
        return Err(format!("Invalid collection name: '{name}'"));
    }
    Ok(())
}

/// The `### documents` note rendered into the variable tail on RAG turns:
/// tells the model the documents live in the index, not in attachment files.
fn format_documents_note(rag: &super::types::AgentRagRequest) -> String {
    const NAME_LIST_MAX_CHARS: usize = 2_000;
    let names: Vec<&str> = rag
        .attached_file_names
        .iter()
        .map(String::as_str)
        .filter(|name| !name.trim().is_empty())
        .collect();
    let mut note = String::new();
    if names.is_empty() {
        note.push_str("This conversation has indexed documents.");
    } else {
        let mut list = String::new();
        let mut listed = 0usize;
        for name in &names {
            let entry = if list.is_empty() {
                (*name).to_string()
            } else {
                format!(", {name}")
            };
            if list.len() + entry.len() > NAME_LIST_MAX_CHARS {
                break;
            }
            list.push_str(&entry);
            listed += 1;
        }
        note.push_str(&format!("{} indexed document(s): {list}", names.len()));
        if names.len() > listed {
            note.push_str(&format!(" (+{} more)", names.len() - listed));
        }
        note.push('.');
    }
    if rag.project_collection.is_some() {
        note.push_str(" Project-wide documents are also indexed (scope: \"project\").");
    }
    note.push_str(
        " Search them with docs.retrieve (semantic query), enumerate them with docs.list, and \
         read nearby passages with docs.chunks. Do not guess document contents — retrieve first.",
    );
    note
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

    #[test]
    fn documents_note_lists_names_and_caps_the_list() {
        let note = format_documents_note(&crate::core::agent::types::AgentRagRequest {
            thread_collection: "attachments_t1".into(),
            project_collection: None,
            attached_file_names: vec!["report.pdf".into(), "notes.md".into()],
        });
        assert!(note.starts_with("2 indexed document(s): report.pdf, notes.md."));
        assert!(note.contains("docs.retrieve"));
        assert!(!note.contains("scope: \"project\""));

        let long_names: Vec<String> = (0..200).map(|i| format!("document-{i:03}.pdf")).collect();
        let capped = format_documents_note(&crate::core::agent::types::AgentRagRequest {
            thread_collection: "attachments_t1".into(),
            project_collection: Some("project_p1".into()),
            attached_file_names: long_names,
        });
        assert!(capped.contains("more)"), "long lists truncate with a count");
        assert!(capped.len() < 3_000);
        assert!(capped.contains("scope: \"project\""));

        let bare = format_documents_note(&crate::core::agent::types::AgentRagRequest {
            thread_collection: "attachments_t1".into(),
            project_collection: None,
            attached_file_names: Vec::new(),
        });
        assert!(bare.starts_with("This conversation has indexed documents."));
    }

    #[test]
    fn collection_names_validate_a_safe_charset() {
        assert!(validate_collection_name("attachments_thread-1.a").is_ok());
        assert!(validate_collection_name("").is_err());
        assert!(validate_collection_name("has space").is_err());
        assert!(validate_collection_name("has/slash").is_err());
        assert!(validate_collection_name("has\\backslash").is_err());
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
}
