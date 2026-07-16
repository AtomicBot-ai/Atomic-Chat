//! Agent run loop: `prompt -> decide -> run -> observe -> repeat`.
//!
//! (`loop` is a reserved keyword, so the loop lives here.)

use std::path::Path;

use futures_util::future::join_all;
use tokio_util::sync::CancellationToken;

use super::grammar::tool_call_grammar;
use super::llm_client::{parse_tool_calls, CompletionRequest, LlamaClientError, LlamaServerClient};
use super::loop_guard::{
    format_forced_loop_reply, format_repeat_notice, format_veto_instruction,
    format_wandering_redirect, LoopCheckLevel, ToolLoopTracker,
};
use super::prompt::build_prompt;
use super::resource_class::{is_batchable, resource_class_for, ResourceClass};
use super::tools::{self, ApprovalHook, DesktopServices, ToolContext};
use super::types::{
    AgentEvent, LoopLevel, ToolCallPayload, ToolExecution, ToolOutcome, ToolStatus,
};

pub const MAX_STEPS: u32 = 25;
pub const MAX_PARALLEL_TOOL_CALLS: usize = 8;
const AGENT_SLOT_ID: i32 = 0;

pub struct RunTurnInput<'a> {
    pub run_id: &'a str,
    pub user_message: &'a str,
    pub stable_prefix: &'a str,
    pub working_dir: &'a Path,
    pub max_steps: u32,
    pub client: &'a LlamaServerClient,
    pub approval: &'a dyn ApprovalHook,
    pub desktop: &'a dyn DesktopServices,
    pub cancellation: &'a CancellationToken,
}

pub async fn run_turn(
    input: RunTurnInput<'_>,
    mut emit: impl FnMut(AgentEvent) -> Result<(), String>,
) -> Result<(), String> {
    emit(AgentEvent::TurnStarted {
        run_id: input.run_id.to_owned(),
    })?;
    let max_steps = input.max_steps.clamp(1, MAX_STEPS);
    let mut conversation = format!("USER: {}", input.user_message);
    let mut notice: Option<String> = None;
    let mut tracker = ToolLoopTracker::default();
    let loaded_tools = tools::tool_view::LoadedTools::default();

    for step_index in 0..max_steps {
        if input.cancellation.is_cancelled() {
            return finish_cancelled(step_index, &mut emit);
        }
        emit(AgentEvent::StepStarted { step_index })?;
        let loaded_tool_names = loaded_tools.snapshot().await;
        let prompt = build_prompt(
            input.stable_prefix,
            &loaded_tool_names,
            &conversation,
            notice.as_deref(),
        );
        notice = None;
        let request = CompletionRequest::tool_call(prompt, tool_call_grammar(), AGENT_SLOT_ID);
        let completion = match input.client.complete(&request, input.cancellation).await {
            Ok(completion) => completion,
            Err(LlamaClientError::Cancelled) => {
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
                return Err(error.to_string());
            }
        };
        if !completion.reasoning_content.is_empty() {
            emit(AgentEvent::ReasoningDelta {
                step_index,
                text: completion.reasoning_content.clone(),
            })?;
        }
        let parsed = match parse_tool_calls(&completion.content) {
            Ok(parsed) => parsed,
            Err(error) => {
                emit(AgentEvent::StepError {
                    message: error.to_string(),
                    category: "grammar".into(),
                })?;
                emit(AgentEvent::TurnFinished {
                    reason: "failed".into(),
                    step_count: step_index + 1,
                })?;
                return Err(error.to_string());
            }
        };
        if let Some(reasoning) = parsed.reasoning.filter(|value| !value.is_empty()) {
            emit(AgentEvent::ReasoningDelta {
                step_index,
                text: reasoning,
            })?;
        }
        validate_batch(&parsed.calls)?;
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
            emit(AgentEvent::AssistantReply { text: reply })?;
            emit(AgentEvent::TurnFinished {
                reason: "reply".into(),
                step_count: step_index + 1,
            })?;
            return Ok(());
        }

        let tool_context = ToolContext {
            working_dir: input.working_dir,
            approval: input.approval,
            cancellation: input.cancellation,
            loaded_tools: &loaded_tools,
            desktop: input.desktop,
        };
        let has_terminal_tail = parsed
            .calls
            .last()
            .is_some_and(|call| resource_class_for(&call.tool) == ResourceClass::Terminal);
        let parallel_len = batch_size - usize::from(has_terminal_tail);
        let futures = parsed.calls[..parallel_len]
            .iter()
            .zip(planned[..parallel_len].iter())
            .map(|(call, plan)| {
                let tool_context = &tool_context;
                async move {
                    match plan {
                        PlannedCall::Execute => tools::execute(call, tool_context).await,
                        PlannedCall::Denied(outcome) => outcome.clone(),
                    }
                }
            });
        let mut outcomes = join_all(futures).await;
        if has_terminal_tail {
            let call = &parsed.calls[parallel_len];
            let outcome = match &planned[parallel_len] {
                PlannedCall::Execute => tools::execute(call, &tool_context).await,
                PlannedCall::Denied(outcome) => outcome.clone(),
            };
            outcomes.push(outcome);
        }
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
        if let Some((reason, text)) = terminal {
            emit(AgentEvent::AssistantDelta { text: text.clone() })?;
            emit(AgentEvent::AssistantReply { text })?;
            emit(AgentEvent::TurnFinished {
                reason: reason.into(),
                step_count: step_index + 1,
            })?;
            return Ok(());
        }
        append_observations(&mut conversation, &parsed.calls, &outcomes);
    }

    let text =
        "I reached the maximum number of agent steps before completing the request.".to_owned();
    emit(AgentEvent::AssistantReply { text })?;
    emit(AgentEvent::TurnFinished {
        reason: "max_steps".into(),
        step_count: max_steps,
    })?;
    Ok(())
}

enum PlannedCall {
    Execute,
    Denied(ToolOutcome),
}

fn validate_batch(calls: &[ToolCallPayload]) -> Result<(), String> {
    if calls.is_empty() {
        return Err("Tool-call batch cannot be empty".into());
    }
    if calls.len() > MAX_PARALLEL_TOOL_CALLS {
        return Err(format!(
            "Tool-call batch exceeds the limit of {MAX_PARALLEL_TOOL_CALLS}"
        ));
    }
    let mut terminal_count = 0;
    for (index, call) in calls.iter().enumerate() {
        let class = resource_class_for(&call.tool);
        if class == ResourceClass::Unknown {
            return Err(format!("Unknown tool in batch: {}", call.tool));
        }
        if calls.len() > 1 && class != ResourceClass::Terminal && !is_batchable(class) {
            return Err(format!("Tool must run solo: {}", call.tool));
        }
        if class == ResourceClass::Terminal {
            terminal_count += 1;
            if index + 1 != calls.len() || terminal_count > 1 {
                return Err("A terminal tool must be the single final terminal call".into());
            }
        }
    }
    Ok(())
}

fn append_observations(
    conversation: &mut String,
    calls: &[ToolCallPayload],
    outcomes: &[ToolOutcome],
) {
    for (call, outcome) in calls.iter().zip(outcomes) {
        conversation.push_str(&format!(
            "\nASSISTANT_TOOL_CALL: {}\nTOOL_RESULT: status={:?}; {}",
            serde_json::to_string(call).unwrap_or_else(|_| "{}".into()),
            outcome.status,
            outcome.summary
        ));
    }
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
