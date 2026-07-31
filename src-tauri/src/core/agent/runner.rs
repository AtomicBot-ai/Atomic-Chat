//! Agent run loop: `prompt -> decide -> run -> observe -> repeat`.
//!
//! (`loop` is a reserved keyword, so the loop lives here.)

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use tokio_util::sync::CancellationToken;

use super::batch_executor::{execute_batch, PlannedCall};
use super::grammar::tool_call_grammar_for_profile;
use super::llm_client::{
    parse_tool_calls_for_profile, CompletionRequest, LlamaClientError, LlamaServerClient,
    ParsedToolCalls,
};
use super::loop_guard::{
    format_forced_loop_reply, format_repeat_notice, format_veto_instruction,
    format_wandering_redirect, LoopCheckLevel, ToolLoopTracker,
};
use super::model_profile::AgentModelProfile;
use super::path_policy::EditableRoots;
use super::prompt::{build_prompt_with_workspace_for_profile, format_workspace};
use super::resource_class::{is_batchable, resource_class_for, ResourceClass};
use super::session::AgentSessionState;
use super::skills::{loaded::LoadedSkills, SkillRegistry};
use super::token_budget::{
    compute_effective_conversation_cap, estimate_tokens, COMPLETION_MAX_TOKENS,
    CONFIGURED_CONVERSATION_CAP,
};
use super::tools::{self, ApprovalHook, DesktopServices, FolderAccessHook, ToolContext};
use super::types::{
    AgentEvent, LoopLevel, ToolCallPayload, ToolExecution, ToolOutcome, ToolStatus,
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
    pub client: &'a LlamaServerClient,
    pub approval: &'a dyn ApprovalHook,
    pub folder_access: &'a dyn FolderAccessHook,
    pub desktop: &'a dyn DesktopServices,
    pub cancellation: &'a CancellationToken,
    pub session: &'a mut AgentSessionState,
    pub skill_registry: &'a SkillRegistry,
    pub bundled_script_runtime: Option<&'a Path>,
}

pub async fn run_turn(
    input: RunTurnInput<'_>,
    mut emit: impl FnMut(AgentEvent) -> Result<(), String>,
) -> Result<(), String> {
    emit(AgentEvent::TurnStarted {
        run_id: input.run_id.to_owned(),
        session_id: input.session_id.to_owned(),
    })?;
    let max_steps = input.max_steps.clamp(1, MAX_STEPS);
    let mut notice: Option<String> = None;
    let mut tracker = ToolLoopTracker::default();
    let loaded_tools = tools::tool_view::LoadedTools::restore(&input.session.loaded_tools);
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
            })?;
            return Err(message);
        }
    }
    input.session.push_user(input.user_message);
    let tool_grammar = tool_call_grammar_for_profile(input.skill_registry, input.model_profile);

    for step_index in 0..max_steps {
        if input.cancellation.is_cancelled() {
            finish_session(input.session, &loaded_tools, &loaded_skills, None).await;
            return finish_cancelled(step_index, &mut emit);
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
        let fixed_prompt = build_prompt_with_workspace_for_profile(
            input.stable_prefix,
            &loaded_tool_names,
            &loaded_skill_entries,
            Some(&workspace),
            "",
            notice.as_deref(),
            input.model_profile,
        );
        let context_window = match input.client.fetch_context_window(input.cancellation).await {
            Ok(value) => value,
            Err(LlamaClientError::Cancelled) => {
                finish_session(input.session, &loaded_tools, &loaded_skills, None).await;
                return finish_cancelled(step_index, &mut emit);
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
        let prompt = build_prompt_with_workspace_for_profile(
            input.stable_prefix,
            &loaded_tool_names,
            &loaded_skill_entries,
            Some(&workspace),
            &conversation,
            notice.as_deref(),
            input.model_profile,
        );
        notice = None;
        let request = CompletionRequest::tool_call(prompt, tool_grammar.clone(), AGENT_SLOT_ID);
        let completion = complete_with_deadline(input.client, &request, input.cancellation).await;
        let mut previous_output = String::new();
        let mut parsed = match completion {
            Ok(completion) => {
                previous_output.clone_from(&completion.content);
                if !completion.reasoning_content.is_empty() {
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
                            &completion.content,
                            &error.to_string(),
                            input.cancellation,
                            input.model_profile,
                        )
                        .await
                        {
                            Ok(parsed) => parsed,
                            Err(LlamaClientError::Cancelled) => {
                                finish_session(input.session, &loaded_tools, &loaded_skills, None)
                                    .await;
                                return finish_cancelled(step_index, &mut emit);
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
                                })?;
                                finish_session(input.session, &loaded_tools, &loaded_skills, None)
                                    .await;
                                return Err(message);
                            }
                        }
                    }
                }
            }
            Err(LlamaClientError::TimedOut) => {
                emit(AgentEvent::ParseRetry {
                    step_index,
                    reason: "Tool-step completion exceeded the 600-second deadline".into(),
                })?;
                match repair_tool_calls(
                    input.client,
                    &request,
                    "",
                    "Tool-step completion exceeded the 600-second deadline",
                    input.cancellation,
                    input.model_profile,
                )
                .await
                {
                    Ok(parsed) => parsed,
                    Err(LlamaClientError::Cancelled) => {
                        finish_session(input.session, &loaded_tools, &loaded_skills, None).await;
                        return finish_cancelled(step_index, &mut emit);
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
                        })?;
                        finish_session(input.session, &loaded_tools, &loaded_skills, None).await;
                        return Err(message);
                    }
                }
            }
            Err(LlamaClientError::Cancelled) => {
                finish_session(input.session, &loaded_tools, &loaded_skills, None).await;
                return finish_cancelled(step_index, &mut emit);
            }
            Err(error) => {
                emit(AgentEvent::StepError {
                    message: error.to_string(),
                    category: "llm".into(),
                })?;
                emit(AgentEvent::TurnFinished {
                    reason: "failed".into(),
                    step_count: step_index,
                })?;
                finish_session(input.session, &loaded_tools, &loaded_skills, None).await;
                return Err(error.to_string());
            }
        };
        if let Some(reasoning) = parsed.reasoning.filter(|value| !value.is_empty()) {
            emit(AgentEvent::ReasoningDelta {
                step_index,
                text: reasoning,
            })?;
        }
        if let Err(error) = validate_batch(&parsed.calls) {
            if error.is_approval_only() {
                let (trimmed, dropped_tools) = trim_to_first_approval_gated(&parsed.calls);
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
                    &previous_output,
                    &error.to_string(),
                    input.cancellation,
                    input.model_profile,
                )
                .await
                {
                    Ok(repaired) => parsed = repaired,
                    Err(LlamaClientError::Cancelled) => {
                        finish_session(input.session, &loaded_tools, &loaded_skills, None).await;
                        return finish_cancelled(step_index, &mut emit);
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
            })?;
            finish_session(input.session, &loaded_tools, &loaded_skills, Some(&reply)).await;
            return Ok(());
        }

        let tool_context = ToolContext {
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
        };
        let has_terminal_tail = parsed
            .calls
            .last()
            .is_some_and(|call| resource_class_for(&call.tool) == ResourceClass::Terminal);
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
        input
            .session
            .push_tool_observations(&parsed.calls[..parallel_len], &outcomes[..parallel_len]);
        if let Some((reason, text)) = terminal {
            emit(AgentEvent::AssistantDelta { text: text.clone() })?;
            emit(AgentEvent::AssistantReply { text: text.clone() })?;
            emit(AgentEvent::TurnFinished {
                reason: reason.into(),
                step_count: step_index + 1,
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

fn validate_batch(calls: &[ToolCallPayload]) -> Result<(), BatchValidationError> {
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
        let class = resource_class_for(&call.tool);
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

fn trim_to_first_approval_gated(calls: &[ToolCallPayload]) -> (Vec<ToolCallPayload>, Vec<String>) {
    let kept_index = calls
        .iter()
        .position(|call| resource_class_for(&call.tool) == ResourceClass::ApprovalGated)
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
) -> Result<ParsedToolCalls, String> {
    let parsed =
        parse_tool_calls_for_profile(content, profile).map_err(|error| error.to_string())?;
    validate_batch(&parsed.calls).map_err(|error| error.to_string())?;
    Ok(parsed)
}

async fn repair_tool_calls(
    client: &LlamaServerClient,
    original_request: &CompletionRequest,
    invalid_output: &str,
    reason: &str,
    cancellation: &CancellationToken,
    profile: AgentModelProfile,
) -> Result<ParsedToolCalls, LlamaClientError> {
    let invalid_output = invalid_output.chars().take(4_000).collect::<String>();
    let repair_instruction = format!(
        "### tool-call-repair\nThe previous tool-call output was invalid: {reason}\n\
         Emit one corrected JSON array only. Approval-gated or dependent calls must be emitted \
         as a length-1 array. A terminal call may appear only once and only last.\n\
         Previous output:\n{invalid_output}"
    );
    let repair_prompt = if let Some(framing) = profile.turn_framing() {
        let suffix = format!(
            "{}\n{}",
            framing.turn_close.trim_end(),
            framing.assistant_open.trim_end()
        );
        let base = original_request
            .prompt
            .trim_end()
            .strip_suffix(&suffix)
            .unwrap_or(original_request.prompt.trim_end())
            .trim_end();
        format!(
            "{base}\n\n{repair_instruction}\n\n{}{}",
            framing.turn_close, framing.assistant_open
        )
    } else {
        format!("{}\n\n{repair_instruction}", original_request.prompt)
    };
    let mut request = original_request.clone();
    request.prompt = repair_prompt;
    request.max_tokens = REPAIR_MAX_TOKENS;
    let completion = complete_with_deadline(client, &request, cancellation).await?;
    parse_and_validate(&completion.content, profile)
        .map_err(|error| LlamaClientError::InvalidResponse(format!("Repair failed: {error}")))
}

async fn complete_with_deadline(
    client: &LlamaServerClient,
    request: &CompletionRequest,
    cancellation: &CancellationToken,
) -> Result<super::llm_client::CompletionResult, LlamaClientError> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(LlamaClientError::Cancelled),
        result = tokio::time::timeout(
            TOOL_STEP_COMPLETION_DEADLINE,
            client.complete(request, cancellation),
        ) => match result {
            Ok(result) => result,
            Err(_) => Err(LlamaClientError::TimedOut),
        },
    }
}

fn repair_error_category(error: &LlamaClientError) -> &'static str {
    match error {
        LlamaClientError::InvalidResponse(_) => "grammar",
        LlamaClientError::Cancelled => "cancelled",
        LlamaClientError::TimedOut => "timeout",
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
    emit: &mut impl FnMut(AgentEvent) -> Result<(), String>,
) -> Result<(), String> {
    emit(AgentEvent::TurnFinished {
        reason: "cancelled".into(),
        step_count,
    })
}
