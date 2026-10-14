//! `agent.delegate`: a coordinating turn hands one task to a specialist.
//!
//! A specialist is an assistant profile the frontend sends with the turn
//! (`AgentTurnRequest::specialists`). Delegating runs a complete, nested agent
//! turn for it:
//!
//! - **Its own prompt.** The stable prefix carries the specialist's
//!   instructions under `### assistant` and no `### specialists` roster, so a
//!   specialist cannot delegate further (one level deep, no recursion).
//! - **The same powers and limits.** Same model client, workspace roots,
//!   MCP/docs bridges, approval gate and cancellation token as the
//!   coordinator. Approval requests therefore reach the user's open thread
//!   exactly as the coordinator's own would.
//! - **A fresh, in-memory session.** The specialist sees only the task text,
//!   never the coordinator's conversation, and its transcript is not saved.
//!
//! Only the specialist's final answer returns to the coordinator, as the
//! `agent.delegate` observation. Its lifecycle events are not forwarded: the
//! frontend ties `TurnStarted`/`TurnFinished` to the coordinator's run.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

use super::llm_client::{AgentLlmClient, SamplingOverrides};
use super::mcp_tools::McpBridge;
use super::model_profile::AgentModelProfile;
use super::path_policy::EditableRoots;
use super::pty::PtyRegistry;
use super::rag_bridge::DocsBridge;
use super::runner::{run_turn, RunTurnInput};
use super::session::AgentSessionState;
use super::skills::SkillRegistry;
use super::tools::{ApprovalHook, DelegateHook, DesktopServices, FolderAccessHook};
use super::types::{AgentEvent, AgentReasoning, AgentSpecialist, ToolOutcome};

/// The tool name, so callers can switch it off without repeating the literal.
pub const DELEGATE_TOOL: &str = "agent.delegate";
/// At most this many specialists per turn; each costs roster prompt space.
pub const MAX_SPECIALISTS: usize = 12;
/// A specialist's turn gets at most this many steps.
pub const MAX_SPECIALIST_STEPS: u32 = 24;
const MAX_NAME_CHARS: usize = 48;
const MAX_DESCRIPTION_CHARS: usize = 1_000;

/// Reject a roster the coordinator could not address unambiguously.
pub fn validate_specialists(specialists: &[AgentSpecialist]) -> Result<(), String> {
    if specialists.len() > MAX_SPECIALISTS {
        return Err(format!(
            "At most {MAX_SPECIALISTS} specialists can join a turn"
        ));
    }
    let mut seen = BTreeSet::new();
    for specialist in specialists {
        let name = specialist.name.trim();
        if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
            return Err(format!(
                "Specialist names must be 1-{MAX_NAME_CHARS} characters: '{name}'"
            ));
        }
        if name.chars().any(char::is_control) {
            return Err(format!(
                "Specialist name contains control characters: '{name}'"
            ));
        }
        if specialist.description.trim().is_empty() {
            return Err(format!("Specialist '{name}' needs a description"));
        }
        if specialist.description.chars().count() > MAX_DESCRIPTION_CHARS {
            return Err(format!("Specialist '{name}' has an overlong description"));
        }
        if !seen.insert(name.to_lowercase()) {
            return Err(format!("Two specialists are named '{name}'"));
        }
    }
    Ok(())
}

/// One specialist ready to run: its display name and pre-built stable prefix.
pub struct PreparedSpecialist {
    pub name: String,
    pub stable_prefix: String,
}

/// Everything a specialist's nested turn shares with the coordinator.
pub struct SpecialistDelegator<'a> {
    pub specialists: Vec<PreparedSpecialist>,
    pub run_id: &'a str,
    pub session_id: &'a str,
    pub model_profile: AgentModelProfile,
    pub working_dir: &'a Path,
    pub editable_roots: &'a EditableRoots,
    pub external_read_only_roots: &'a [PathBuf],
    pub trusted_read_roots: &'a [PathBuf],
    pub max_steps: u32,
    pub reasoning: AgentReasoning,
    pub sampling: &'a SamplingOverrides,
    pub mcp: Option<&'a dyn McpBridge>,
    pub docs: Option<&'a dyn DocsBridge>,
    pub documents_note: Option<&'a str>,
    /// The coordinator's disabled set plus `agent.delegate`.
    pub disabled_tools: &'a BTreeSet<String>,
    pub auto_approve_mcp: bool,
    pub client: &'a dyn AgentLlmClient,
    pub approval: &'a dyn ApprovalHook,
    pub folder_access: &'a dyn FolderAccessHook,
    pub desktop: &'a dyn DesktopServices,
    pub cancellation: &'a CancellationToken,
    pub skill_registry: &'a SkillRegistry,
    pub bundled_script_runtime: Option<&'a Path>,
    pub pty: &'a PtyRegistry,
    pub cache_dir: &'a Path,
}

impl SpecialistDelegator<'_> {
    fn find(&self, name: &str) -> Option<&PreparedSpecialist> {
        self.specialists
            .iter()
            .find(|specialist| specialist.name.eq_ignore_ascii_case(name))
    }

    fn roster(&self) -> String {
        self.specialists
            .iter()
            .map(|specialist| specialist.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// Session id for a specialist's nested turn: distinct from the coordinator's
/// so spill files and processes never collide, and a safe path component.
pub fn specialist_session_id(session_id: &str, specialist: &str) -> String {
    let slug: String = specialist
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "specialist" } else { slug };
    let mut id = format!("{session_id}--{slug}");
    id.truncate(128);
    id
}

#[async_trait]
impl DelegateHook for SpecialistDelegator<'_> {
    async fn delegate(&self, specialist: &str, task: &str) -> ToolOutcome {
        let Some(prepared) = self.find(specialist) else {
            return ToolOutcome::error(format!(
                "Unknown specialist '{specialist}'. Available: {}",
                self.roster()
            ));
        };
        let session_id = specialist_session_id(self.session_id, &prepared.name);
        let run_id = format!("{}::{}", self.run_id, session_id);
        let mut session = AgentSessionState::new(session_id.clone());
        let mut reply: Option<String> = None;
        let result = run_turn(
            RunTurnInput {
                run_id: &run_id,
                session_id: &session_id,
                user_message: task,
                selected_skill: None,
                stable_prefix: &prepared.stable_prefix,
                model_profile: self.model_profile,
                working_dir: self.working_dir,
                editable_roots: self.editable_roots,
                external_read_only_roots: self.external_read_only_roots,
                trusted_read_roots: self.trusted_read_roots,
                max_steps: self.max_steps.min(MAX_SPECIALIST_STEPS),
                reasoning: self.reasoning.clone(),
                sampling: self.sampling,
                mcp: self.mcp,
                docs: self.docs,
                documents_note: self.documents_note,
                disabled_tools: self.disabled_tools,
                auto_approve_mcp: self.auto_approve_mcp,
                delegate: None,
                client: self.client,
                approval: self.approval,
                folder_access: self.folder_access,
                desktop: self.desktop,
                cancellation: self.cancellation,
                session: &mut session,
                skill_registry: self.skill_registry,
                bundled_script_runtime: self.bundled_script_runtime,
                pty: self.pty,
                cache_dir: self.cache_dir,
            },
            |event| {
                if let AgentEvent::AssistantReply { text } = event {
                    reply = Some(text);
                }
                Ok(())
            },
        )
        .await;
        if self.cancellation.is_cancelled() {
            return ToolOutcome::error(format!("{} was cancelled", prepared.name));
        }
        match (result, reply) {
            (Ok(()), Some(text)) => ToolOutcome::ok(format!("{} answered:\n{text}", prepared.name)),
            (Ok(()), None) => {
                ToolOutcome::error(format!("{} finished without an answer", prepared.name))
            }
            (Err(error), _) => ToolOutcome::error(format!("{} failed: {error}", prepared.name)),
        }
    }
}
