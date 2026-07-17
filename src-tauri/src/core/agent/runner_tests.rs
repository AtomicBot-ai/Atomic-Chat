use std::time::Duration;

use hyper::StatusCode;
use tokio_util::sync::CancellationToken;

use super::runner::{run_turn, RunTurnInput};
use super::session::AgentSessionState;
use super::test_support::{
    collect_event, RecordingApproval, RecordingDesktop, ScriptedCompletionServer, ScriptedResponse,
    TestWorkspace,
};
use super::types::{AgentEvent, LoopLevel, ToolStatus};

struct TestRun {
    result: Result<(), String>,
    events: Vec<AgentEvent>,
    requests: Vec<serde_json::Value>,
}

async fn run_script(
    workspace: &TestWorkspace,
    responses: Vec<ScriptedResponse>,
    approval: &RecordingApproval,
    cancellation: &CancellationToken,
    max_steps: u32,
) -> TestRun {
    let server = ScriptedCompletionServer::start(responses).await;
    let client = server.client();
    let desktop = RecordingDesktop::default();
    let mut events = Vec::new();
    let mut session = AgentSessionState::new("test-session");
    let result = run_turn(
        RunTurnInput {
            run_id: "test-run",
            session_id: "test-session",
            user_message: "perform the fixture task",
            stable_prefix: "TEST_STABLE_PREFIX",
            working_dir: workspace.path(),
            max_steps,
            client: &client,
            approval,
            desktop: &desktop,
            cancellation,
            session: &mut session,
        },
        |event| collect_event(&mut events, event),
    )
    .await;
    TestRun {
        result,
        events,
        requests: server.requests(),
    }
}

fn event_kind(event: &AgentEvent) -> &'static str {
    match event {
        AgentEvent::TurnStarted { .. } => "turn_started",
        AgentEvent::StepStarted { .. } => "step_started",
        AgentEvent::ReasoningDelta { .. } => "reasoning_delta",
        AgentEvent::AssistantDelta { .. } => "assistant_delta",
        AgentEvent::ToolCallParsed { .. } => "tool_call_parsed",
        AgentEvent::ToolCallExecuted { .. } => "tool_call_executed",
        AgentEvent::ApprovalRequested { .. } => "approval_requested",
        AgentEvent::LoopDetected { .. } => "loop_detected",
        AgentEvent::ParseRetry { .. } => "parse_retry",
        AgentEvent::BatchTrimmed { .. } => "batch_trimmed",
        AgentEvent::AssistantReply { .. } => "assistant_reply",
        AgentEvent::StepError { .. } => "step_error",
        AgentEvent::TurnFinished { .. } => "turn_finished",
    }
}

fn finished_reason(events: &[AgentEvent]) -> Option<(&str, u32)> {
    events.iter().rev().find_map(|event| match event {
        AgentEvent::TurnFinished { reason, step_count } => Some((reason.as_str(), *step_count)),
        _ => None,
    })
}

fn executed(events: &[AgentEvent]) -> Vec<(&str, ToolStatus)> {
    events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::ToolCallExecuted { result } => {
                Some((result.call.tool.as_str(), result.outcome.status))
            }
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn immediate_reply_preserves_event_order_and_completion_contract() {
    let workspace = TestWorkspace::new();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let run = run_script(
        &workspace,
        vec![ScriptedResponse::completion(
            r#"[{"tool":"reply","args":{"text":"done"}}]"#,
        )],
        &approval,
        &cancellation,
        3,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(
        run.events.iter().map(event_kind).collect::<Vec<_>>(),
        [
            "turn_started",
            "step_started",
            "tool_call_parsed",
            "tool_call_executed",
            "assistant_delta",
            "assistant_reply",
            "turn_finished"
        ]
    );
    assert_eq!(finished_reason(&run.events), Some(("reply", 1)));
    assert_eq!(run.requests.len(), 1);
    let request = &run.requests[0];
    assert_eq!(request["cache_prompt"], true);
    assert_eq!(request["slot_id"], 0);
    assert_eq!(request["id_slot"], 0);
    assert!(request["grammar"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));
    assert!(request["prompt"]
        .as_str()
        .is_some_and(|value| value.contains("### conversation\nUSER: perform the fixture task")));
}

#[tokio::test]
async fn read_observation_is_visible_to_the_next_completion() {
    let workspace = TestWorkspace::new();
    workspace.write("fixture.txt", "SENTINEL_READ_73");
    let run = run_script(
        &workspace,
        vec![
            ScriptedResponse::completion(
                r#"[{"tool":"os.fs.read","args":{"path":"fixture.txt"}}]"#,
            ),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"observed"}}]"#),
        ],
        &RecordingApproval::deny(),
        &CancellationToken::new(),
        3,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(
        executed(&run.events),
        [("os.fs.read", ToolStatus::Ok), ("reply", ToolStatus::Ok)]
    );
    assert!(run.requests[1]["prompt"]
        .as_str()
        .is_some_and(|prompt| prompt.contains("SENTINEL_READ_73")));
}

#[tokio::test]
async fn sequential_runs_share_the_session_transcript() {
    let workspace = TestWorkspace::new();
    workspace.write("fixture.txt", "DURABLE_OBSERVATION");
    let server = ScriptedCompletionServer::start(vec![
        ScriptedResponse::completion(r#"[{"tool":"os.fs.read","args":{"path":"fixture.txt"}}]"#),
        ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"first reply"}}]"#),
        ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"second reply"}}]"#),
    ])
    .await;
    let client = server.client();
    let approval = RecordingApproval::deny();
    let desktop = RecordingDesktop::default();
    let cancellation = CancellationToken::new();
    let mut session = AgentSessionState::new("shared-session");

    for (run_id, user_message) in [("run-1", "first user"), ("run-2", "second user")] {
        run_turn(
            RunTurnInput {
                run_id,
                session_id: "shared-session",
                user_message,
                stable_prefix: "TEST_STABLE_PREFIX",
                working_dir: workspace.path(),
                max_steps: 3,
                client: &client,
                approval: &approval,
                desktop: &desktop,
                cancellation: &cancellation,
                session: &mut session,
            },
            |_| Ok(()),
        )
        .await
        .expect("run shared session turn");
    }

    assert_eq!(session.turn_count, 2);
    let requests = server.requests();
    assert!(requests[2]["prompt"].as_str().is_some_and(|prompt| {
        prompt.contains("USER: first user")
            && prompt.contains("DURABLE_OBSERVATION")
            && prompt.contains("ASSISTANT: first reply")
            && prompt.contains("USER: second user")
    }));
}

#[tokio::test]
async fn pure_reads_complete_before_the_tail_terminal() {
    let workspace = TestWorkspace::new();
    workspace.write("a.txt", "ALPHA");
    workspace.write("b.txt", "BETA");
    let run = run_script(
        &workspace,
        vec![ScriptedResponse::completion(
            r#"[
                {"tool":"os.fs.read","args":{"path":"a.txt"}},
                {"tool":"os.fs.read","args":{"path":"b.txt"}},
                {"tool":"reply","args":{"text":"both read"}}
            ]"#,
        )],
        &RecordingApproval::deny(),
        &CancellationToken::new(),
        2,
    )
    .await;

    assert!(run.result.is_ok());
    let executions = run
        .events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::ToolCallExecuted { result } => Some((
                result.call.tool.as_str(),
                result.batch_index,
                result.batch_size,
            )),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        executions,
        [("os.fs.read", 0, 3), ("os.fs.read", 1, 3), ("reply", 2, 3)]
    );
    assert_eq!(finished_reason(&run.events), Some(("reply", 1)));
}

#[tokio::test]
async fn approved_write_changes_the_workspace() {
    let workspace = TestWorkspace::new();
    let approval = RecordingApproval::allow();
    let run = run_script(
        &workspace,
        vec![
            ScriptedResponse::completion(
                r#"[{"tool":"os.fs.write","args":{"path":"written.txt","content":"EXACT_BYTES"}}]"#,
            ),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"done"}}]"#),
        ],
        &approval,
        &CancellationToken::new(),
        3,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(workspace.read("written.txt"), b"EXACT_BYTES");
    assert_eq!(approval.requests().len(), 1);
    assert_eq!(executed(&run.events)[0].1, ToolStatus::Ok);
}

#[tokio::test]
async fn denied_write_has_no_side_effect() {
    let workspace = TestWorkspace::new();
    let approval = RecordingApproval::deny();
    let run = run_script(
        &workspace,
        vec![
            ScriptedResponse::completion(
                r#"[{"tool":"os.fs.write","args":{"path":"denied.txt","content":"forbidden"}}]"#,
            ),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"denied"}}]"#),
        ],
        &approval,
        &CancellationToken::new(),
        3,
    )
    .await;

    assert!(run.result.is_ok());
    assert!(!workspace.path().join("denied.txt").exists());
    assert_eq!(approval.requests().len(), 1);
    assert_eq!(executed(&run.events)[0].1, ToolStatus::Denied);
}

#[tokio::test]
async fn malformed_completion_is_repaired_once() {
    let workspace = TestWorkspace::new();
    let run = run_script(
        &workspace,
        vec![
            ScriptedResponse::completion("not-json"),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"repaired"}}]"#),
        ],
        &RecordingApproval::deny(),
        &CancellationToken::new(),
        2,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(finished_reason(&run.events), Some(("reply", 1)));
    assert_eq!(
        run.events
            .iter()
            .filter(|event| matches!(event, AgentEvent::ParseRetry { .. }))
            .count(),
        1
    );
    assert_eq!(run.requests.len(), 2);
    assert_eq!(run.requests[1]["n_predict"], 1024);
    assert!(run.requests[1]["prompt"]
        .as_str()
        .is_some_and(|prompt| prompt.contains("### tool-call-repair")));
}

#[tokio::test]
async fn repeated_repair_failure_finishes_as_grammar_failure() {
    let workspace = TestWorkspace::new();
    let run = run_script(
        &workspace,
        vec![
            ScriptedResponse::completion("not-json"),
            ScriptedResponse::completion("still-not-json"),
        ],
        &RecordingApproval::deny(),
        &CancellationToken::new(),
        2,
    )
    .await;

    assert!(run.result.is_err());
    assert!(run.events.iter().any(|event| matches!(
        event,
        AgentEvent::StepError { category, .. } if category == "grammar"
    )));
    assert_eq!(finished_reason(&run.events), Some(("failed", 1)));
    assert_eq!(run.requests.len(), 2);
}

#[tokio::test]
async fn approval_gated_batch_is_trimmed_without_repair_and_noticed_next_step() {
    let workspace = TestWorkspace::new();
    let run = run_script(
        &workspace,
        vec![
            ScriptedResponse::completion(
                r#"[
                    {"tool":"os.fs.write","args":{"path":"kept.txt","content":"KEPT"}},
                    {"tool":"os.fs.edit","args":{"path":"kept.txt","oldString":"KEPT","newString":"DROPPED"}}
                ]"#,
            ),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"done"}}]"#),
        ],
        &RecordingApproval::allow(),
        &CancellationToken::new(),
        3,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(workspace.read("kept.txt"), b"KEPT");
    assert_eq!(
        executed(&run.events),
        [("os.fs.write", ToolStatus::Ok), ("reply", ToolStatus::Ok)]
    );
    assert!(!run
        .events
        .iter()
        .any(|event| matches!(event, AgentEvent::ParseRetry { .. })));
    assert!(run.events.iter().any(|event| matches!(
        event,
        AgentEvent::BatchTrimmed { kept_tool, dropped_tools, .. }
            if kept_tool == "os.fs.write" && dropped_tools == &["os.fs.edit"]
    )));
    assert_eq!(run.requests.len(), 2);
    assert!(run.requests[1]["prompt"]
        .as_str()
        .is_some_and(|prompt| prompt.contains("### notice")
            && prompt.contains("os.fs.edit")
            && prompt.contains("length-1")));
}

#[tokio::test]
async fn mixed_read_and_approval_batch_keeps_the_approval_call() {
    let workspace = TestWorkspace::new();
    workspace.write("edit.txt", "OLD");
    let run = run_script(
        &workspace,
        vec![
            ScriptedResponse::completion(
                r#"[
                    {"tool":"os.fs.read","args":{"path":"edit.txt"}},
                    {"tool":"os.fs.edit","args":{"path":"edit.txt","oldString":"OLD","newString":"NEW"}}
                ]"#,
            ),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"done"}}]"#),
        ],
        &RecordingApproval::allow(),
        &CancellationToken::new(),
        3,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(workspace.read("edit.txt"), b"NEW");
    assert_eq!(
        executed(&run.events),
        [("os.fs.edit", ToolStatus::Ok), ("reply", ToolStatus::Ok)]
    );
    assert!(!run
        .events
        .iter()
        .any(|event| matches!(event, AgentEvent::ParseRetry { .. })));
}

#[tokio::test]
async fn misplaced_terminal_and_empty_reply_are_repaired() {
    for invalid in [
        r#"[
            {"tool":"reply","args":{"text":"too early"}},
            {"tool":"os.fs.read","args":{"path":"missing.txt"}}
        ]"#,
        r#"[{"tool":"reply","args":{"text":"   "}}]"#,
    ] {
        let workspace = TestWorkspace::new();
        let run = run_script(
            &workspace,
            vec![
                ScriptedResponse::completion(invalid),
                ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"fixed"}}]"#),
            ],
            &RecordingApproval::deny(),
            &CancellationToken::new(),
            2,
        )
        .await;

        assert!(run.result.is_ok());
        assert_eq!(finished_reason(&run.events), Some(("reply", 1)));
        assert_eq!(
            run.events
                .iter()
                .filter(|event| matches!(event, AgentEvent::ParseRetry { .. }))
                .count(),
            1
        );
        assert_eq!(run.requests.len(), 2);
    }
}

#[tokio::test]
async fn llama_http_error_is_reported_as_llm_failure() {
    let workspace = TestWorkspace::new();
    let run = run_script(
        &workspace,
        vec![ScriptedResponse::http_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "model unavailable",
        )],
        &RecordingApproval::deny(),
        &CancellationToken::new(),
        2,
    )
    .await;

    assert!(run.result.is_err());
    assert!(run.events.iter().any(|event| matches!(
        event,
        AgentEvent::StepError { category, message }
            if category == "llm" && message.contains("model unavailable")
    )));
    assert_eq!(finished_reason(&run.events), Some(("failed", 0)));
}

#[tokio::test]
async fn cancellation_interrupts_an_in_flight_completion() {
    let workspace = TestWorkspace::new();
    let server = ScriptedCompletionServer::start(vec![ScriptedResponse::completion(
        r#"[{"tool":"reply","args":{"text":"late"}}]"#,
    )
    .delayed(Duration::from_secs(5))])
    .await;
    let client = server.client();
    let approval = RecordingApproval::deny();
    let desktop = RecordingDesktop::default();
    let cancellation = CancellationToken::new();
    let mut events = Vec::new();
    let mut session = AgentSessionState::new("cancel-session");
    let cancel = cancellation.clone();
    let run = run_turn(
        RunTurnInput {
            run_id: "cancel-run",
            session_id: "cancel-session",
            user_message: "wait",
            stable_prefix: "TEST_STABLE_PREFIX",
            working_dir: workspace.path(),
            max_steps: 2,
            client: &client,
            approval: &approval,
            desktop: &desktop,
            cancellation: &cancellation,
            session: &mut session,
        },
        |event| collect_event(&mut events, event),
    );
    let cancel_soon = async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        cancel.cancel();
    };
    let (result, ()) = tokio::join!(run, cancel_soon);

    assert!(result.is_ok());
    assert_eq!(finished_reason(&events), Some(("cancelled", 0)));
    assert!(executed(&events).is_empty());
}

#[tokio::test]
async fn max_steps_terminates_without_an_extra_completion() {
    let workspace = TestWorkspace::new();
    workspace.write("fixture.txt", "constant");
    let call =
        ScriptedResponse::completion(r#"[{"tool":"os.fs.read","args":{"path":"fixture.txt"}}]"#);
    let run = run_script(
        &workspace,
        vec![call.clone(), call],
        &RecordingApproval::deny(),
        &CancellationToken::new(),
        2,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(run.requests.len(), 2);
    assert_eq!(finished_reason(&run.events), Some(("max_steps", 2)));
}

#[tokio::test]
async fn repeated_no_progress_calls_trip_the_breaker() {
    let workspace = TestWorkspace::new();
    workspace.write("fixture.txt", "constant");
    let response =
        ScriptedResponse::completion(r#"[{"tool":"os.fs.read","args":{"path":"fixture.txt"}}]"#);
    let run = run_script(
        &workspace,
        vec![response; 8],
        &RecordingApproval::deny(),
        &CancellationToken::new(),
        10,
    )
    .await;

    assert!(run.result.is_ok());
    assert!(run.events.iter().any(|event| matches!(
        event,
        AgentEvent::LoopDetected {
            level: LoopLevel::Warn,
            ..
        }
    )));
    assert!(run.events.iter().any(|event| matches!(
        event,
        AgentEvent::LoopDetected {
            level: LoopLevel::Critical,
            ..
        }
    )));
    assert!(run.events.iter().any(|event| matches!(
        event,
        AgentEvent::LoopDetected {
            level: LoopLevel::Breaker,
            ..
        }
    )));
    assert_eq!(finished_reason(&run.events), Some(("reply", 7)));
}

#[tokio::test]
async fn tool_view_exposes_the_rare_schema_on_the_following_step() {
    let workspace = TestWorkspace::new();
    workspace.write("fixture.txt", "hash me");
    let run = run_script(
        &workspace,
        vec![
            ScriptedResponse::completion(r#"[{"tool":"tool.view","args":{"name":"os.fs.hash"}}]"#),
            ScriptedResponse::completion(
                r#"[{"tool":"os.fs.hash","args":{"path":"fixture.txt","algorithm":"sha256"}}]"#,
            ),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"hashed"}}]"#),
        ],
        &RecordingApproval::deny(),
        &CancellationToken::new(),
        4,
    )
    .await;

    assert!(run.result.is_ok());
    assert!(!run.requests[0]["prompt"]
        .as_str()
        .expect("first prompt")
        .contains("### loaded-tools"));
    for request in &run.requests[1..] {
        let prompt = request["prompt"].as_str().expect("later prompt");
        assert!(prompt.contains("### loaded-tools"));
        assert!(prompt.contains("- os.fs.hash { path: string, algorithm?:"));
    }
}
