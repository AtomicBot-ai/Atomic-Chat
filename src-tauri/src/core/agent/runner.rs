//! Agent run loop: `prompt -> decide -> run -> observe -> repeat`.
//!
//! (`loop` is a reserved keyword, so the loop lives here.)

use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use tokio_util::sync::CancellationToken;

use super::batch_executor::{execute_batch, PlannedCall};
use super::grammar::{tool_call_grammar_dynamic, GENERIC_THINK_CLOSE, GENERIC_THINK_OPEN};
use super::llm_client::{
    parse_tool_calls_for_profile, AgentLlmClient, AgentPrompt, CompletionReasoning,
    CompletionRequest, CompletionResult, LlmClientError, ParsedToolCalls, ReasoningTags,
    SamplingOverrides, StreamChunk,
};
use super::loop_guard::{
    format_forced_loop_reply, format_repeat_notice, format_veto_instruction,
    format_wandering_redirect, LoopCheckLevel, ToolLoopTracker,
};
use super::model_profile::AgentModelProfile;
use super::path_policy::EditableRoots;
use super::mcp_tools::McpBridge;
use super::prompt::{build_prompt_dynamic, build_prompt_parts_dynamic, format_workspace};
use super::pty::PtyRegistry;
use super::reply_stream::ReplyStreamScanner;
use super::resource_class::{is_batchable, resource_class_for_call, ResourceClass};
use super::session::AgentSessionState;
use super::skills::{loaded::LoadedSkills, SkillRegistry};
use super::token_budget::{
    compute_effective_conversation_cap, estimate_tokens, COMPLETION_MAX_TOKENS,
    CONFIGURED_CONVERSATION_CAP,
};
use super::tool_schema::tool_call_response_format_dynamic;
use super::tools::{self, ApprovalHook, DesktopServices, FolderAccessHook, ToolContext};
use super::types::{
    AgentEvent, AgentReasoning, AgentTurnUsage, LoopLevel, ToolCallPayload, ToolExecution,
    ToolOutcome, ToolStatus,
};

pub const MAX_STEPS: u32 = 25;
pub const MAX_PARALLEL_TOOL_CALLS: usize = 8;
const AGENT_SLOT_ID: i32 = 0;
const REPAIR_MAX_TOKENS: u32 = 1024;
#[cfg(not(test))]
const TOOL_STEP_COMPLETION_DEADLINE: Duration = Duration::from_secs(600);
#[cfg(test)]
const TOOL_STEP_COMPLETION_DEADLINE: Duration = Duration::from_millis(100);

pub struct RunTurnInput<'a> {
    pub run_id: &'a str,
    pub session_id: &'a str,
    pub user_message: &'a str,
    pub selected_skill: Option<&'a str>,
    pub stable_prefix: &'a str,
    pub model_profile: AgentModelProfile,
    pub working_dir: &'a Path,
    pub editable_roots: &'a EditableRoots,
    pub external_read_only_roots: &'a [PathBuf],
    pub trusted_read_roots: &'a [PathBuf],
    pub max_steps: u32,
    /// Thinking intent for this turn. Drives the GBNF prelude and, on
    /// llama.cpp, the reasoning-budget sampler.
    pub reasoning: AgentReasoning,
    /// Assistant sampling overrides for this turn. `Default` keeps the agent's
    /// tuned sampler untouched.
    pub sampling: &'a SamplingOverrides,
    /// The turn's MCP catalog and dispatcher. `None` disables `mcp.*` tools.
    pub mcp: Option<&'a dyn McpBridge>,
    /// Built-in tools switched off for this turn (e.g. `os.web.*`).
    pub disabled_tools: &'a std::collections::BTreeSet<String>,
    /// Auto-approve MCP-origin tools (migrated chat `allowAllMCPPermissions`).
    pub auto_approve_mcp: bool,
    pub client: &'a dyn AgentLlmClient,
    pub approval: &'a dyn ApprovalHook,
    pub folder_access: &'a dyn FolderAccessHook,
    pub desktop: &'a dyn DesktopServices,
    pub cancellation: &'a CancellationToken,
    pub session: &'a mut AgentSessionState,
    pub skill_registry: &'a SkillRegistry,
    pub bundled_script_runtime: Option<&'a Path>,
    /// Processes started in earlier turns of this session, plus any this turn
    /// starts. Shared app-wide and scoped by `session_id`.
    pub pty: &'a PtyRegistry,
    /// Cache directory for the code index.
    pub cache_dir: &'a Path,
}

pub async fn run_turn(
    input: RunTurnInput<'_>,
    mut emit: impl FnMut(AgentEvent) -> Result<(), String> + Send,
) -> Result<(), String> {
    emit(AgentEvent::TurnStarted {
        run_id: input.run_id.to_owned(),
        session_id: input.session_id.to_owned(),
    })?;
    let mut usage = TurnUsageTracker::new();
    let max_steps = input.max_steps.clamp(1, MAX_STEPS);
    let mut notice: Option<String> = None;
    let mut tracker = ToolLoopTracker::default();
    let loaded_tools =
        tools::tool_view::LoadedTools::restore(&input.session.loaded_tools, input.mcp);
    let loaded_skills = LoadedSkills::restore(&input.session.loaded_skills, input.skill_registry);
    if let Some(selected_skill) = input.selected_skill {
        let outcome = loaded_skills
            .view(selected_skill, input.skill_registry)
            .await;
        if outcome.status != ToolStatus::Ok {
            let message = outcome.summary;
            emit(AgentEvent::StepError {
                message: message.clone(),
                category: "skill".into(),
            })?;
            emit(AgentEvent::TurnFinished {
                reason: "failed".into(),
                step_count: 0,
                usage: usage.finish(),
            })?;
            return Err(message);
        }
    }
    input.session.push_user(input.user_message);
    // Constrained decoding is transport-specific: llama.cpp enforces the
    // tool-call shape with GBNF, chat transports fall back to the prompt
    // contract plus the repair step. Build only what this client can honour.
    let capabilities = input.client.capabilities();
    let thinking = input.reasoning.is_on();
    let mcp_names = input
        .mcp
        .map(|bridge| {
            bridge
                .descriptors()
                .iter()
                .map(|descriptor| descriptor.agent_name.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let tool_grammar = capabilities.grammar.then(|| {
        tool_call_grammar_dynamic(
            input.skill_registry,
            input.model_profile,
            thinking,
            &mcp_names,
            input.disabled_tools,
        )
    });
    // The repair completion asks for corrected JSON only, and its budget is a
    // tenth of a normal step's — a mandatory think block could swallow it whole.
    // Gemma keeps its prelude: there it is native turn framing, not an effort
    // choice, and the framing must survive the retry.
    let repair_grammar = match (&tool_grammar, input.model_profile.reasoning_open_tag()) {
        (None, _) | (Some(_), Some(_)) => tool_grammar.clone(),
        (Some(_), None) => capabilities.grammar.then(|| {
            tool_call_grammar_dynamic(
                input.skill_registry,
                input.model_profile,
                false,
                &mcp_names,
                input.disabled_tools,
            )
        }),
    };
    let completion_reasoning = completion_reasoning(&input.reasoning, input.model_profile);
    let response_schema = capabilities.json_schema.then(|| {
        Arc::new(tool_call_response_format_dynamic(
            input.skill_registry,
            &mcp_names,
            input.disabled_tools,
        ))
    });

    for step_index in 0..max_steps {
        if input.cancellation.is_cancelled() {
            finish_session(input.session, &loaded_tools, &loaded_skills, None).await;
            return finish_cancelled(step_index, usage.finish(), &mut emit);
        }
        emit(AgentEvent::StepStarted { step_index })?;
        let loaded_tool_names = loaded_tools.snapshot().await;
        let loaded_skill_entries = loaded_skills.snapshot().await;
        let editable_roots = input.editable_roots.snapshot().await;
        let primary_root = editable_roots
            .first()
            .map(PathBuf::as_path)
            .unwrap_or(input.working_dir);
        let workspace = format_workspace(
            primary_root,
            &editable_roots,
            input.external_read_only_roots,
        );
        let fixed_prompt = build_prompt_dynamic(
            input.stable_prefix,
            &loaded_tool_names,
            &loaded_skill_entries,
            Some(&workspace),
            "",
            notice.as_deref(),
            input.model_profile,
            input.mcp,
        );
        let context_window = match input.client.fetch_context_window(input.cancellation).await {
            Ok(value) => value,
            Err(LlmClientError::Cancelled) => {
                finish_session(input.session, &loaded_tools, &loaded_skills, None).await;
                return finish_cancelled(step_index, usage.finish(), &mut emit);
            }
            Err(error) => {
                log::warn!("Agent /props context probe failed; using configured cap: {error}");
                None
            }
        };
        let conversation_cap = compute_effective_conversation_cap(
            CONFIGURED_CONVERSATION_CAP,
            context_window,
            estimate_tokens(&fixed_prompt),
            COMPLETION_MAX_TOKENS,
        );
        let conversation = input.session.render_conversation(conversation_cap);
        let prompt = build_prompt_parts_dynamic(
            input.stable_prefix,
            &loaded_tool_names,
            &loaded_skill_entries,
            Some(&workspace),
            &conversation,
            notice.as_deref(),
            input.model_profile,
            input.mcp,
        );
        notice = None;
        let mut request = CompletionRequest {
            reasoning: completion_reasoning.clone(),
            ..CompletionRequest::tool_call_parts(
                AgentPrompt::parts(prompt.system, prompt.tail),
                tool_grammar.clone(),
                response_schema.clone(),
                AGENT_SLOT_ID,
            )
        };
        input.sampling.apply(&mut request);
        // Stream the completion where the transport can: reasoning deltas go
        // straight to the UI, and when the array opens with `reply` its text
        // value streams live as `AssistantDelta`. Both are best-effort — the
        // parsed completion below stays authoritative.
        let mut scanner =
            ReplyStreamScanner::new(stream_prelude(&completion_reasoning, input.model_profile));
        let mut prelude_reasoning_streamed = false;
        let mut server_reasoning_streamed = false;
        let completion = {
            let scanner = &mut scanner;
            let usage = &mut usage;
            let prelude_flag = &mut prelude_reasoning_streamed;
            let server_flag = &mut server_reasoning_streamed;
            let emit = &mut emit;
            let mut on_chunk = move |chunk: StreamChunk| -> Result<(), String> {
                if !chunk.reasoning_delta.is_empty() {
                    *server_flag = true;
                    usage.mark_output();
                    emit(AgentEvent::ReasoningDelta {
                        step_index,
                        text: chunk.reasoning_delta,
                    })?;
                }
                if !chunk.delta.is_empty() {
                    usage.mark_output();
                    let scanned = scanner.feed(&chunk.delta);
                    if !scanned.reasoning.is_empty() {
                        *prelude_flag = true;
                        emit(AgentEvent::ReasoningDelta {
                            step_index,
                            text: scanned.reasoning,
                        })?;
                    }
                    if !scanned.reply.is_empty() {
                        emit(AgentEvent::AssistantDelta {
                            text: scanned.reply,
                        })?;
                    }
                }
                Ok(())
            };
            complete_streaming_with_deadline(
                input.client,
                &request,
                input.cancellation,
                &mut on_chunk,
            )
            .await
        };
        let mut previous_output = String::new();
        let mut parsed = match completion {
            Ok(completion) => {
                usage.observe(&completion);
                previous_output.clone_from(&completion.content);
                if !completion.reasoning_content.is_empty() && !server_reasoning_streamed {
                    emit(AgentEvent::ReasoningDelta {
                        step_index,
                        text: completion.reasoning_content.clone(),
                    })?;
                }
                match parse_tool_calls_for_profile(&completion.content, input.model_profile) {
                    Ok(parsed) => parsed,
                    Err(error) => {
                        emit(AgentEvent::ParseRetry {
                            step_index,
                            reason: error.to_string(),
                        })?;
                        match repair_tool_calls(
                            input.client,
                            &request,
                            repair_grammar.as_deref(),
                            &completion.content,
                            &error.to_string(),
                            input.cancellation,
                            input.model_profile,
                            input.mcp,
                        )
                        .await
                        {
                            Ok(parsed) => parsed,
                            Err(LlmClientError::Cancelled) => {
                                finish_session(input.session, &loaded_tools, &loaded_skills, None)
                                    .await;
                                return finish_cancelled(step_index, usage.finish(), &mut emit);
                            }
                            Err(error) => {
                                let message = error.to_string();
                                emit(AgentEvent::StepError {
                                    message: message.clone(),
                                    category: repair_error_category(&error).into(),
                                })?;
                                emit(AgentEvent::TurnFinished {
                                    reason: "failed".into(),
                                    step_count: step_index + 1,
                                    usage: usage.finish(),
                                })?;
                                finish_session(input.session, &loaded_tools, &loaded_skills, None)
                                    .await;
                                return Err(message);
                            }
                        }
                    }
                }
            }
            Err(LlmClientError::TimedOut) => {
                emit(AgentEvent::ParseRetry {
                    step_index,
                    reason: "Tool-step completion exceeded the 600-second deadline".into(),
                })?;
                match repair_tool_calls(
                    input.client,
                    &request,
                    repair_grammar.as_deref(),
                    "",
                    "Tool-step completion exceeded the 600-second deadline",
                    input.cancellation,
                    input.model_profile,
                    input.mcp,
                )
                .await
                {
                    Ok(parsed) => parsed,
                    Err(LlmClientError::Cancelled) => {
                        finish_session(input.session, &loaded_tools, &loaded_skills, None).await;
                        return finish_cancelled(step_index, usage.finish(), &mut emit);
                    }
                    Err(error) => {
                        let message = error.to_string();
                        emit(AgentEvent::StepError {
                            message: message.clone(),
                            category: repair_error_category(&error).into(),
                        })?;
                        emit(AgentEvent::TurnFinished {
                            reason: "failed".into(),
                            step_count: step_index + 1,
                            usage: usage.finish(),
                        })?;
                        finish_session(input.session, &loaded_tools, &loaded_skills, None).await;
                        return Err(message);
                    }
                }
            }
            Err(LlmClientError::Cancelled) => {
                finish_session(input.session, &loaded_tools, &loaded_skills, None).await;
                return finish_cancelled(step_index, usage.finish(), &mut emit);
            }
            Err(error) => {
                emit(AgentEvent::StepError {
                    message: error.to_string(),
                    category: completion_error_category(&error).into(),
                })?;
                emit(AgentEvent::TurnFinished {
                    reason: "failed".into(),
                    step_count: step_index,
                    usage: usage.finish(),
                })?;
                finish_session(input.session, &loaded_tools, &loaded_skills, None).await;
                return Err(error.to_string());
            }
        };
        if let Some(reasoning) = parsed.reasoning.filter(|value| !value.is_empty()) {
            // Skip when the prelude already streamed char by char — re-emitting
            // the parsed block would double it in the trace. (A repair after a
            // streamed prelude loses its own reasoning here; the repair grammar
            // drops the generic prelude anyway.)
            if !prelude_reasoning_streamed {
                emit(AgentEvent::ReasoningDelta {
                    step_index,
                    text: reasoning,
                })?;
            }
        }
        if let Err(error) = validate_batch(&parsed.calls, input.mcp) {
            if error.is_approval_only() {
                let (trimmed, dropped_tools) =
                    trim_to_first_approval_gated(&parsed.calls, input.mcp);
                let kept_tool = trimmed[0].tool.clone();
                let reason = error.to_string();
                emit(AgentEvent::BatchTrimmed {
                    step_index,
                    reason: reason.clone(),
                    kept_tool: kept_tool.clone(),
                    dropped_tools: dropped_tools.clone(),
                })?;
                notice = Some(format_batch_trim_notice(&kept_tool, &dropped_tools));
                parsed.calls = trimmed;
            } else {
                emit(AgentEvent::ParseRetry {
                    step_index,
                    reason: error.to_string(),
                })?;
                match repair_tool_calls(
                    input.client,
                    &request,
                    repair_grammar.as_deref(),
                    &previous_output,
                    &error.to_string(),
                    input.cancellation,
                    input.model_profile,
                    input.mcp,
                )
                .await
                {
                    Ok(repaired) => parsed = repaired,
                    Err(LlmClientError::Cancelled) => {
                        finish_session(input.session, &loaded_tools, &loaded_skills, None).await;
                        return finish_cancelled(step_index, usage.finish(), &mut emit);
                    }
                    Err(error) => {
                        let message = error.to_string();
                        emit(AgentEvent::StepError {
                            message: message.clone(),
                            category: repair_error_category(&error).into(),
                        })?;
                        emit(AgentEvent::TurnFinished {
                            reason: "failed".into(),
                            step_count: step_index + 1,
                            usage: usage.finish(),
                        })?;
                        finish_session(input.session, &loaded_tools, &loaded_skills, None).await;
                        return Err(message);
                    }
                }
            }
        }
        let batch_size = parsed.calls.len();
        for (batch_index, call) in parsed.calls.iter().enumerate() {
            emit(AgentEvent::ToolCallParsed {
                call: call.clone(),
                batch_index,
                batch_size,
            })?;
        }

        let mut planned = Vec::with_capacity(batch_size);
        let mut breaker: Option<(String, usize, super::types::LoopDetector)> = None;
        for call in &parsed.calls {
            let verdict = tracker.check(&call.tool, &call.args);
            if tracker.is_wandering_escalated(&call.tool, &call.args) {
                breaker = Some((call.tool.clone(), verdict.count, verdict.detector));
                break;
            }
            match verdict.level {
                LoopCheckLevel::Ok => tracker.record_call(&call.tool, &call.args),
                LoopCheckLevel::Warn => {
                    let message = if verdict.detector == super::types::LoopDetector::Wandering {
                        format_wandering_redirect(&call.tool, verdict.count)
                    } else {
                        format_repeat_notice(&verdict)
                    };
                    if tracker.should_emit_warning(&verdict.warning_key, verdict.count) {
                        emit(AgentEvent::LoopDetected {
                            level: LoopLevel::Warn,
                            detector: verdict.detector,
                            message: message.clone(),
                        })?;
                        notice = Some(message);
                    }
                    tracker.record_call(&call.tool, &call.args);
                }
                LoopCheckLevel::Critical => {
                    let outcome = ToolOutcome::denied(
                        format_veto_instruction(&verdict),
                        super::loop_guard::LOOP_VETO_DENIED_REASON,
                    );
                    tracker.record_call(&call.tool, &call.args);
                    tracker.record_outcome(&call.tool, &call.args, &outcome);
                    emit(AgentEvent::LoopDetected {
                        level: LoopLevel::Critical,
                        detector: verdict.detector,
                        message: outcome.summary.clone(),
                    })?;
                    if tracker.is_breaker_tripped(&call.tool, &call.args) {
                        breaker = Some((call.tool.clone(), verdict.count, verdict.detector));
                        break;
                    }
                    planned.push(PlannedCall::Denied(outcome));
                }
            }
            if !matches!(verdict.level, LoopCheckLevel::Critical) {
                planned.push(PlannedCall::Execute);
            }
        }
        if let Some((tool, count, detector)) = breaker {
            let reply = format_forced_loop_reply(&tool, count);
            emit(AgentEvent::LoopDetected {
                level: LoopLevel::Breaker,
                detector,
                message: reply.clone(),
            })?;
            emit(AgentEvent::AssistantReply {
                text: reply.clone(),
            })?;
            emit(AgentEvent::TurnFinished {
                reason: "reply".into(),
                step_count: step_index + 1,
                usage: usage.finish(),
            })?;
            finish_session(input.session, &loaded_tools, &loaded_skills, Some(&reply)).await;
            return Ok(());
        }

        let tool_context = ToolContext {
            mcp: input.mcp,
            disabled_tools: input.disabled_tools,
            auto_approve_mcp: input.auto_approve_mcp,
            session_id: input.session_id,
            working_dir: input.working_dir,
            editable_roots: input.editable_roots,
            trusted_read_roots: input.trusted_read_roots,
            client: Some(input.client),
            approval: input.approval,
            folder_access: input.folder_access,
            cancellation: input.cancellation,
            loaded_tools: &loaded_tools,
            loaded_skills: &loaded_skills,
            skill_registry: input.skill_registry,
            bundled_script_runtime: input.bundled_script_runtime,
            desktop: input.desktop,
            pty: input.pty,
            cache_dir: input.cache_dir,
        };
        let has_terminal_tail = parsed.calls.last().is_some_and(|call| {
            resource_class_for_call(&call.tool, input.mcp) == ResourceClass::Terminal
        });
        let parallel_len = batch_size - usize::from(has_terminal_tail);
        let outcomes = execute_batch(&parsed.calls, &planned, &tool_context).await;
        let mut terminal: Option<(&str, String)> = None;
        for (batch_index, (call, outcome)) in parsed.calls.iter().zip(outcomes.iter()).enumerate() {
            tracker.record_outcome(&call.tool, &call.args, outcome);
            emit(AgentEvent::ToolCallExecuted {
                result: ToolExecution {
                    call: call.clone(),
                    outcome: outcome.clone(),
                    batch_index,
                    batch_size,
                },
            })?;
            if outcome.status == ToolStatus::Ok && matches!(call.tool.as_str(), "reply" | "finish")
            {
                terminal = Some((call.tool.as_str(), outcome.summary.clone()));
            }
        }
        if batch_size > 1 {
            let verdict = tracker.observe_batch_composite(&parsed.calls, &outcomes);
            if verdict.level != LoopCheckLevel::Ok
                && tracker.should_emit_warning(&verdict.warning_key, verdict.count)
            {
                let message = format_repeat_notice(&verdict);
                emit(AgentEvent::LoopDetected {
                    level: LoopLevel::Warn,
                    detector: verdict.detector,
                    message: message.clone(),
                })?;
                notice = Some(message);
            }
        }
        let observed = super::spill::spill_outcomes(
            input.working_dir,
            input.session_id,
            input.session.turn_count,
            step_index,
            &parsed.calls[..parallel_len],
            &outcomes[..parallel_len],
        );
        input
            .session
            .push_tool_observations(&parsed.calls[..parallel_len], &observed);
        if let Some((reason, text)) = terminal {
            // Reconcile with what the scanner already streamed: emit only the
            // missing suffix, or nothing on a mismatch — `AssistantReply`
            // replaces the accumulated text either way.
            let streamed = scanner.streamed_reply();
            if streamed.is_empty() {
                emit(AgentEvent::AssistantDelta { text: text.clone() })?;
            } else if let Some(suffix) = text.strip_prefix(streamed) {
                if !suffix.is_empty() {
                    emit(AgentEvent::AssistantDelta {
                        text: suffix.to_owned(),
                    })?;
                }
            }
            emit(AgentEvent::AssistantReply { text: text.clone() })?;
            emit(AgentEvent::TurnFinished {
                reason: reason.into(),
                step_count: step_index + 1,
                usage: usage.finish(),
            })?;
            finish_session(input.session, &loaded_tools, &loaded_skills, Some(&text)).await;
            return Ok(());
        }
    }

    let text =
        "I reached the maximum number of agent steps before completing the request.".to_owned();
    emit(AgentEvent::AssistantReply { text: text.clone() })?;
    emit(AgentEvent::TurnFinished {
        reason: "max_steps".into(),
        step_count: max_steps,
        usage: usage.finish(),
    })?;
    finish_session(input.session, &loaded_tools, &loaded_skills, Some(&text)).await;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BatchValidationKind {
    Empty,
    Limit,
    Unknown,
    TerminalPosition,
    EmptyReply,
    ApprovalGatedSolo,
}

#[derive(Debug)]
struct BatchValidationIssue {
    kind: BatchValidationKind,
    message: String,
}

#[derive(Debug)]
struct BatchValidationError {
    issues: Vec<BatchValidationIssue>,
}

impl BatchValidationError {
    fn is_approval_only(&self) -> bool {
        !self.issues.is_empty()
            && self
                .issues
                .iter()
                .all(|issue| issue.kind == BatchValidationKind::ApprovalGatedSolo)
    }
}

impl std::fmt::Display for BatchValidationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(
            &self
                .issues
                .iter()
                .map(|issue| issue.message.as_str())
                .collect::<Vec<_>>()
                .join("; "),
        )
    }
}

fn validate_batch(
    calls: &[ToolCallPayload],
    mcp: Option<&dyn McpBridge>,
) -> Result<(), BatchValidationError> {
    let mut issues = Vec::new();
    if calls.is_empty() {
        issues.push(BatchValidationIssue {
            kind: BatchValidationKind::Empty,
            message: "Tool-call batch cannot be empty".into(),
        });
    }
    if calls.len() > MAX_PARALLEL_TOOL_CALLS {
        issues.push(BatchValidationIssue {
            kind: BatchValidationKind::Limit,
            message: format!("Tool-call batch exceeds the limit of {MAX_PARALLEL_TOOL_CALLS}"),
        });
    }
    let mut terminal_count = 0;
    for (index, call) in calls.iter().enumerate() {
        let class = resource_class_for_call(&call.tool, mcp);
        if class == ResourceClass::Unknown {
            issues.push(BatchValidationIssue {
                kind: BatchValidationKind::Unknown,
                message: format!("Unknown tool in batch: {}", call.tool),
            });
        }
        if calls.len() > 1 && class == ResourceClass::ApprovalGated {
            issues.push(BatchValidationIssue {
                kind: BatchValidationKind::ApprovalGatedSolo,
                message: format!("Tool must run solo: {}", call.tool),
            });
        } else if calls.len() > 1 && class != ResourceClass::Terminal && !is_batchable(class) {
            issues.push(BatchValidationIssue {
                kind: BatchValidationKind::Unknown,
                message: format!("Tool cannot run in a batch: {}", call.tool),
            });
        }
        if class == ResourceClass::Terminal {
            terminal_count += 1;
            if index + 1 != calls.len() || terminal_count > 1 {
                issues.push(BatchValidationIssue {
                    kind: BatchValidationKind::TerminalPosition,
                    message: "A terminal tool must be the single final terminal call".into(),
                });
            }
            if call.tool == "reply"
                && call
                    .args
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .is_none_or(|text| text.trim().is_empty())
            {
                issues.push(BatchValidationIssue {
                    kind: BatchValidationKind::EmptyReply,
                    message: "reply.args.text must be a non-empty string".into(),
                });
            }
        }
    }
    if issues.is_empty() {
        Ok(())
    } else {
        Err(BatchValidationError { issues })
    }
}

fn trim_to_first_approval_gated(
    calls: &[ToolCallPayload],
    mcp: Option<&dyn McpBridge>,
) -> (Vec<ToolCallPayload>, Vec<String>) {
    let kept_index = calls
        .iter()
        .position(|call| resource_class_for_call(&call.tool, mcp) == ResourceClass::ApprovalGated)
        .expect("approval-only validation requires an approval-gated call");
    let kept = calls[kept_index].clone();
    let dropped = calls
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != kept_index)
        .map(|(_, call)| call.tool.clone())
        .collect();
    (vec![kept], dropped)
}

fn format_batch_trim_notice(kept_tool: &str, dropped_tools: &[String]) -> String {
    format!(
        "The previous batch contained a tool that must run alone in a length-1 array. Executed \
         `{kept_tool}` only; re-evaluate before calling the dropped tools: {}.",
        dropped_tools.join(", ")
    )
}

fn parse_and_validate(
    content: &str,
    profile: AgentModelProfile,
    mcp: Option<&dyn McpBridge>,
) -> Result<ParsedToolCalls, String> {
    let parsed =
        parse_tool_calls_for_profile(content, profile).map_err(|error| error.to_string())?;
    validate_batch(&parsed.calls, mcp).map_err(|error| error.to_string())?;
    Ok(parsed)
}

/// The transport-facing form of the turn's thinking intent.
///
/// The tags are whatever the grammar will emit — the profile's native channel
/// when it has one, the generic `<think>` pair otherwise. They must match, or
/// llama.cpp's budget sampler never arms.
fn completion_reasoning(
    reasoning: &AgentReasoning,
    profile: AgentModelProfile,
) -> CompletionReasoning {
    match reasoning {
        AgentReasoning::Unset => CompletionReasoning::Unset,
        AgentReasoning::Off => CompletionReasoning::Off,
        AgentReasoning::On {
            budget_tokens,
            effort_value,
        } => CompletionReasoning::On {
            tags: match (profile.reasoning_open_tag(), profile.reasoning_close_tag()) {
                (Some(open), Some(close)) => ReasoningTags { open, close },
                _ => ReasoningTags {
                    open: GENERIC_THINK_OPEN,
                    close: GENERIC_THINK_CLOSE,
                },
            },
            budget_tokens: *budget_tokens,
            effort_value: effort_value.clone(),
        },
    }
}

#[allow(clippy::too_many_arguments)]
async fn repair_tool_calls(
    client: &dyn AgentLlmClient,
    original_request: &CompletionRequest,
    repair_grammar: Option<&str>,
    invalid_output: &str,
    reason: &str,
    cancellation: &CancellationToken,
    profile: AgentModelProfile,
    mcp: Option<&dyn McpBridge>,
) -> Result<ParsedToolCalls, LlmClientError> {
    let invalid_output = invalid_output.chars().take(4_000).collect::<String>();
    let repair_instruction = format!(
        "### tool-call-repair\nThe previous tool-call output was invalid: {reason}\n\
         Emit one corrected JSON array only. Approval-gated or dependent calls must be emitted \
         as a length-1 array. A terminal call may appear only once and only last.\n\
         Previous output:\n{invalid_output}"
    );
    // The repair block belongs to the variable tail: the stable prefix must
    // stay byte-identical so the prompt cache (llama.cpp slots, provider-side
    // prefix caches) still hits on the retry.
    let original_body = original_request.prompt.body.as_str();
    let repair_body = if let Some(framing) = profile.turn_framing() {
        let suffix = format!(
            "{}\n{}",
            framing.turn_close.trim_end(),
            framing.assistant_open.trim_end()
        );
        let base = original_body
            .trim_end()
            .strip_suffix(&suffix)
            .unwrap_or(original_body.trim_end())
            .trim_end();
        format!(
            "{base}\n\n{repair_instruction}\n\n{}{}",
            framing.turn_close, framing.assistant_open
        )
    } else {
        format!("{original_body}\n\n{repair_instruction}")
    };
    let mut request = original_request.clone();
    request.prompt.body = repair_body;
    request.max_tokens = REPAIR_MAX_TOKENS;
    request.grammar = repair_grammar.map(str::to_owned);
    // No prelude on this grammar means no thinking block to budget.
    if request.grammar.as_deref() != original_request.grammar.as_deref() {
        request.reasoning = CompletionReasoning::Unset;
    }
    let completion = complete_with_deadline(client, &request, cancellation).await?;
    parse_and_validate(&completion.content, profile, mcp)
        .map_err(|error| LlmClientError::InvalidResponse(format!("Repair failed: {error}")))
}

async fn complete_with_deadline(
    client: &dyn AgentLlmClient,
    request: &CompletionRequest,
    cancellation: &CancellationToken,
) -> Result<super::llm_client::CompletionResult, LlmClientError> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(LlmClientError::Cancelled),
        result = tokio::time::timeout(
            TOOL_STEP_COMPLETION_DEADLINE,
            client.complete(request, cancellation),
        ) => match result {
            Ok(result) => result,
            Err(_) => Err(LlmClientError::TimedOut),
        },
    }
}

async fn complete_streaming_with_deadline(
    client: &dyn AgentLlmClient,
    request: &CompletionRequest,
    cancellation: &CancellationToken,
    on_chunk: &mut (dyn FnMut(StreamChunk) -> Result<(), String> + Send),
) -> Result<super::llm_client::CompletionResult, LlmClientError> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(LlmClientError::Cancelled),
        result = tokio::time::timeout(
            TOOL_STEP_COMPLETION_DEADLINE,
            client.complete_streaming(request, cancellation, on_chunk),
        ) => match result {
            Ok(result) => result,
            Err(_) => Err(LlmClientError::TimedOut),
        },
    }
}

/// The reasoning tag pair the grammar puts ahead of the tool-call array for
/// this turn — the scanner uses it to stream the thinking block live. `None`
/// when the completion opens straight with JSON.
fn stream_prelude(
    reasoning: &CompletionReasoning,
    profile: AgentModelProfile,
) -> Option<(&'static str, &'static str)> {
    match (profile.reasoning_open_tag(), profile.reasoning_close_tag()) {
        (Some(open), Some(close)) => Some((open, close)),
        _ => match reasoning {
            CompletionReasoning::On { tags, .. } => Some((tags.open, tags.close)),
            _ => None,
        },
    }
}

/// Aggregates model usage across a turn's completions for `TurnFinished`.
///
/// The prompt is re-sent (and mostly cache-hit) every step, so `tokens_in`
/// reports the *last* completion's prompt-side size — evaluated plus cached —
/// which is what the context gauge wants. `tokens_out` sums generation across
/// steps. Repair completions are not observed; they are rare and bounded.
struct TurnUsageTracker {
    started: Instant,
    first_output: Option<Instant>,
    tokens_in: f64,
    tokens_out: f64,
    last_tps: Option<f64>,
    observed: bool,
}

impl TurnUsageTracker {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            first_output: None,
            tokens_in: 0.0,
            tokens_out: 0.0,
            last_tps: None,
            observed: false,
        }
    }

    fn mark_output(&mut self) {
        if self.first_output.is_none() {
            self.first_output = Some(Instant::now());
        }
    }

    fn observe(&mut self, completion: &CompletionResult) {
        self.observed = true;
        self.mark_output();
        let prompt_side = completion.timing.prompt_tokens + completion.cache_hit_tokens;
        if prompt_side > 0.0 {
            self.tokens_in = prompt_side;
        }
        self.tokens_out += completion.timing.predicted_tokens;
        if completion.timing.predicted_ms > 0.0 && completion.timing.predicted_tokens > 0.0 {
            self.last_tps = Some(
                completion.timing.predicted_tokens / (completion.timing.predicted_ms / 1000.0),
            );
        }
    }

    fn finish(&self) -> Option<AgentTurnUsage> {
        if !self.observed {
            return None;
        }
        Some(AgentTurnUsage {
            tokens_in: self.tokens_in,
            tokens_out: self.tokens_out,
            tps: self.last_tps,
            ttft_ms: self
                .first_output
                .map(|at| at.duration_since(self.started).as_secs_f64() * 1000.0),
        })
    }
}

/// Category for a failed completion, before any repair was attempted.
///
/// Only the transport-level conditions the UI can act on are broken out;
/// everything else stays `llm` so existing consumers keep their behaviour.
fn completion_error_category(error: &LlmClientError) -> &'static str {
    match error {
        LlmClientError::Unauthorized { .. } | LlmClientError::RateLimited { .. } => "auth",
        LlmClientError::ContextOverflow(_) => "context",
        LlmClientError::LocalServerUnavailable => "server",
        LlmClientError::SessionNotFound(_) => "session",
        _ => "llm",
    }
}

fn repair_error_category(error: &LlmClientError) -> &'static str {
    match error {
        LlmClientError::InvalidResponse(_) => "grammar",
        LlmClientError::Cancelled => "cancelled",
        LlmClientError::TimedOut => "timeout",
        LlmClientError::Unauthorized { .. } | LlmClientError::RateLimited { .. } => "auth",
        LlmClientError::ContextOverflow(_) => "context",
        LlmClientError::LocalServerUnavailable => "server",
        _ => "llm",
    }
}

async fn finish_session(
    session: &mut AgentSessionState,
    loaded_tools: &tools::tool_view::LoadedTools,
    loaded_skills: &LoadedSkills,
    reply: Option<&str>,
) {
    if let Some(reply) = reply {
        session.push_reply(reply);
    }
    session.set_loaded_tools(loaded_tools.snapshot().await);
    session.set_loaded_skills(loaded_skills.snapshot().await);
    session.finish_turn();
}

fn finish_cancelled(
    step_count: u32,
    usage: Option<AgentTurnUsage>,
    emit: &mut impl FnMut(AgentEvent) -> Result<(), String>,
) -> Result<(), String> {
    emit(AgentEvent::TurnFinished {
        reason: "cancelled".into(),
        step_count,
        usage,
    })
}
