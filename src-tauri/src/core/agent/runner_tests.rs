use std::time::Duration;

use hyper::StatusCode;
use tokio_util::sync::CancellationToken;

use super::path_policy::EditableRoots;
use super::runner::{run_turn, RunTurnInput};
use super::session::AgentSessionState;
use super::test_support::{
    collect_event, RecordingApproval, RecordingDesktop, RecordingFolderAccess,
    ScriptedCompletionServer, ScriptedResponse, TestWorkspace,
};
use super::types::{AgentEvent, LoopLevel, ToolStatus};

struct TestRun {
    result: Result<(), String>,
    events: Vec<AgentEvent>,
    requests: Vec<serde_json::Value>,
    session: AgentSessionState,
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
    let skill_registry = workspace.skill_registry();
    let editable_roots = EditableRoots::new(workspace.path(), &[]).await.unwrap();
    let folder_access = RecordingFolderAccess::deny();
    let result = run_turn(
        RunTurnInput {
            run_id: "test-run",
            session_id: "test-session",
            user_message: "perform the fixture task",
            selected_skill: None,
            stable_prefix: "TEST_STABLE_PREFIX",
            model_profile: super::model_profile::AgentModelProfile::Plain,
            working_dir: workspace.path(),
            editable_roots: &editable_roots,
            external_read_only_roots: &[],
            trusted_read_roots: &[],
            max_steps,
            client: &client,
            approval,
            folder_access: &folder_access,
            desktop: &desktop,
            cancellation,
            session: &mut session,
            skill_registry: &skill_registry,
            bundled_script_runtime: None,
        },
        |event| collect_event(&mut events, event),
    )
    .await;
    TestRun {
        result,
        events,
        requests: server.requests(),
        session,
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
        AgentEvent::FolderAccessRequested { .. } => "folder_access_requested",
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
async fn gemma4_turn_uses_native_framing_and_parses_channel_reasoning() {
    let workspace = TestWorkspace::new();
    let server = ScriptedCompletionServer::start(vec![ScriptedResponse::completion(
        "<|channel>thought\ninspect first<channel|>\
         [{\"tool\":\"reply\",\"args\":{\"text\":\"done\"}}]",
    )])
    .await;
    let client = server.client();
    let desktop = RecordingDesktop::default();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let mut events = Vec::new();
    let mut session = AgentSessionState::new("gemma-session");
    let skill_registry = workspace.skill_registry();
    let editable_roots = EditableRoots::for_test(workspace.path());
    let folder_access = RecordingFolderAccess::deny();

    let result = run_turn(
        RunTurnInput {
            run_id: "gemma-run",
            session_id: "gemma-session",
            user_message: "perform the fixture task",
            selected_skill: None,
            stable_prefix: "<|turn>system\n<|think|>\n### system\nTEST_STABLE_PREFIX",
            model_profile: super::model_profile::AgentModelProfile::Gemma4Think,
            working_dir: workspace.path(),
            editable_roots: &editable_roots,
            external_read_only_roots: &[],
            trusted_read_roots: &[],
            max_steps: 1,
            client: &client,
            approval: &approval,
            folder_access: &folder_access,
            desktop: &desktop,
            cancellation: &cancellation,
            session: &mut session,
            skill_registry: &skill_registry,
            bundled_script_runtime: None,
        },
        |event| collect_event(&mut events, event),
    )
    .await;

    assert!(result.is_ok());
    let request = &server.requests()[0];
    assert!(request["prompt"]
        .as_str()
        .is_some_and(|prompt| prompt.ends_with("<turn|>\n<|turn>model\n")));
    assert!(request["grammar"]
        .as_str()
        .is_some_and(|grammar| grammar.starts_with("root ::= channel-prelude tool-call-array\n")));
    assert!(events.iter().any(|event| matches!(
        event,
        AgentEvent::ReasoningDelta { text, .. } if text == "inspect first"
    )));
    assert_eq!(finished_reason(&events), Some(("reply", 1)));
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
async fn verbose_observation_is_compact_for_the_model_but_detailed_in_the_event() {
    let workspace = TestWorkspace::new();
    let detailed = (0..30)
        .map(|index| format!("EVENT_DETAIL_LINE_{index:02}"))
        .collect::<Vec<_>>()
        .join("\n");
    workspace.write("verbose.txt", &detailed);
    let run = run_script(
        &workspace,
        vec![
            ScriptedResponse::completion(
                r#"[{"tool":"os.fs.read","args":{"path":"verbose.txt"}}]"#,
            ),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"observed"}}]"#),
        ],
        &RecordingApproval::deny(),
        &CancellationToken::new(),
        3,
    )
    .await;

    assert!(run.result.is_ok());
    let event_summary = run
        .events
        .iter()
        .find_map(|event| match event {
            AgentEvent::ToolCallExecuted { result } if result.call.tool == "os.fs.read" => {
                Some(result.outcome.summary.as_str())
            }
            _ => None,
        })
        .expect("read execution event");
    assert_eq!(event_summary, detailed);
    let next_prompt = run.requests[1]["prompt"].as_str().expect("next prompt");
    assert!(next_prompt.contains("… [omitted 18 lines]"));
    assert!(next_prompt.contains("EVENT_DETAIL_LINE_29"));
    assert!(!next_prompt.contains("EVENT_DETAIL_LINE_00"));
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
    let skill_registry = workspace.skill_registry();
    let editable_roots = EditableRoots::for_test(workspace.path());
    let folder_access = RecordingFolderAccess::deny();

    for (run_id, user_message) in [("run-1", "first user"), ("run-2", "second user")] {
        run_turn(
            RunTurnInput {
                run_id,
                session_id: "shared-session",
                user_message,
                selected_skill: None,
                stable_prefix: "TEST_STABLE_PREFIX",
                model_profile: super::model_profile::AgentModelProfile::Plain,
                working_dir: workspace.path(),
                editable_roots: &editable_roots,
                external_read_only_roots: &[],
                trusted_read_roots: &[],
                max_steps: 3,
                client: &client,
                approval: &approval,
                folder_access: &folder_access,
                desktop: &desktop,
                cancellation: &cancellation,
                session: &mut session,
                skill_registry: &skill_registry,
                bundled_script_runtime: None,
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
async fn safe_write_changes_the_workspace_without_approval() {
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
    assert!(approval.requests().is_empty());
    assert_eq!(executed(&run.events)[0].1, ToolStatus::Ok);
}

#[tokio::test]
async fn safe_write_is_not_blocked_by_a_denied_approval_policy() {
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
    assert_eq!(workspace.read("denied.txt"), b"forbidden");
    assert!(approval.requests().is_empty());
    assert_eq!(executed(&run.events)[0].1, ToolStatus::Ok);
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
    assert_eq!(run.requests[0]["n_predict"], 8192);
    assert_eq!(run.requests[1]["n_predict"], 1024);
    assert!(run.requests[1]["prompt"]
        .as_str()
        .is_some_and(|prompt| prompt.contains("### tool-call-repair")));
}

#[tokio::test]
async fn timed_out_completion_is_repaired_once() {
    let workspace = TestWorkspace::new();
    let run = run_script(
        &workspace,
        vec![
            ScriptedResponse::completion("late").delayed(Duration::from_millis(250)),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"repaired"}}]"#),
        ],
        &RecordingApproval::deny(),
        &CancellationToken::new(),
        2,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(finished_reason(&run.events), Some(("reply", 1)));
    assert!(run.events.iter().any(|event| matches!(
        event,
        AgentEvent::ParseRetry { reason, .. }
            if reason.contains("600-second deadline")
    )));
    assert_eq!(run.requests.len(), 2);
    assert_eq!(run.requests[1]["n_predict"], 1024);
    assert_eq!(run.requests[0]["grammar"], run.requests[1]["grammar"]);
}

#[tokio::test]
async fn timed_out_completion_and_repair_finish_as_timeout_failure() {
    let workspace = TestWorkspace::new();
    let run = run_script(
        &workspace,
        vec![
            ScriptedResponse::completion("late").delayed(Duration::from_millis(250)),
            ScriptedResponse::completion("also late").delayed(Duration::from_millis(250)),
        ],
        &RecordingApproval::deny(),
        &CancellationToken::new(),
        2,
    )
    .await;

    assert!(run.result.is_err());
    assert!(run.events.iter().any(|event| matches!(
        event,
        AgentEvent::StepError { category, message }
            if category == "timeout" && message.contains("600-second deadline")
    )));
    assert_eq!(finished_reason(&run.events), Some(("failed", 1)));
    assert_eq!(run.requests.len(), 2);
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
async fn safe_filesystem_writes_share_a_serial_batch_without_trimming() {
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
    assert_eq!(workspace.read("kept.txt"), b"DROPPED");
    assert_eq!(
        executed(&run.events),
        [
            ("os.fs.write", ToolStatus::Ok),
            ("os.fs.edit", ToolStatus::Ok),
            ("reply", ToolStatus::Ok)
        ]
    );
    assert!(!run
        .events
        .iter()
        .any(|event| matches!(event, AgentEvent::ParseRetry { .. })));
    assert!(!run
        .events
        .iter()
        .any(|event| matches!(event, AgentEvent::BatchTrimmed { .. })));
    assert_eq!(run.requests.len(), 2);
}

#[tokio::test]
async fn mixed_read_and_safe_write_batch_executes_both_calls() {
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
        [
            ("os.fs.read", ToolStatus::Ok),
            ("os.fs.edit", ToolStatus::Ok),
            ("reply", ToolStatus::Ok)
        ]
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
    let skill_registry = workspace.skill_registry();
    let editable_roots = EditableRoots::for_test(workspace.path());
    let folder_access = RecordingFolderAccess::deny();
    let cancel = cancellation.clone();
    let run = run_turn(
        RunTurnInput {
            run_id: "cancel-run",
            session_id: "cancel-session",
            user_message: "wait",
            selected_skill: None,
            stable_prefix: "TEST_STABLE_PREFIX",
            model_profile: super::model_profile::AgentModelProfile::Plain,
            working_dir: workspace.path(),
            editable_roots: &editable_roots,
            external_read_only_roots: &[],
            trusted_read_roots: &[],
            max_steps: 2,
            client: &client,
            approval: &approval,
            folder_access: &folder_access,
            desktop: &desktop,
            cancellation: &cancellation,
            session: &mut session,
            skill_registry: &skill_registry,
            bundled_script_runtime: None,
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
    assert!(!events
        .iter()
        .any(|event| matches!(event, AgentEvent::ParseRetry { .. })));
    assert_eq!(server.requests().len(), 1);
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
async fn repeated_identical_batches_emit_advisory_notice_and_still_reply() {
    let workspace = TestWorkspace::new();
    workspace.write("alpha.txt", "alpha");
    workspace.write("beta.txt", "beta");
    let batch = ScriptedResponse::completion(
        r#"[
            {"tool":"os.fs.read","args":{"path":"alpha.txt"}},
            {"tool":"os.fs.read","args":{"path":"beta.txt"}}
        ]"#,
    );
    let run = run_script(
        &workspace,
        vec![
            batch.clone(),
            batch.clone(),
            batch.clone(),
            batch,
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"done"}}]"#),
        ],
        &RecordingApproval::deny(),
        &CancellationToken::new(),
        6,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(finished_reason(&run.events), Some(("reply", 5)));
    assert!(run.events.iter().any(|event| matches!(
        event,
        AgentEvent::LoopDetected {
            level: LoopLevel::Warn,
            message,
            ..
        } if message.contains("`<batch>`")
    )));
    let final_prompt = run.requests[4]["prompt"].as_str().expect("final prompt");
    assert!(final_prompt.contains("### notice"));
    assert!(final_prompt.contains("`<batch>`"));
    assert_eq!(
        executed(&run.events)
            .iter()
            .filter(|(tool, status)| *tool == "os.fs.read" && *status == ToolStatus::Ok)
            .count(),
        8
    );
}

#[tokio::test]
async fn permuted_batch_does_not_count_as_an_identical_composite() {
    let workspace = TestWorkspace::new();
    workspace.write("alpha.txt", "alpha");
    workspace.write("beta.txt", "beta");
    let original = ScriptedResponse::completion(
        r#"[
            {"tool":"os.fs.read","args":{"path":"alpha.txt"}},
            {"tool":"os.fs.read","args":{"path":"beta.txt"}}
        ]"#,
    );
    let permuted = ScriptedResponse::completion(
        r#"[
            {"tool":"os.fs.read","args":{"path":"beta.txt"}},
            {"tool":"os.fs.read","args":{"path":"alpha.txt"}}
        ]"#,
    );
    let run = run_script(
        &workspace,
        vec![
            original.clone(),
            original.clone(),
            original,
            permuted,
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"done"}}]"#),
        ],
        &RecordingApproval::deny(),
        &CancellationToken::new(),
        6,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(finished_reason(&run.events), Some(("reply", 5)));
    assert!(!run.events.iter().any(|event| matches!(
        event,
        AgentEvent::LoopDetected { message, .. } if message.contains("`<batch>`")
    )));
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

#[tokio::test]
async fn skill_view_loads_the_body_and_restores_it_on_the_next_turn() {
    let workspace = TestWorkspace::new();
    workspace.write(
        ".agent-skills/pdf/SKILL.md",
        "---\nname: pdf\ndescription: PDF workflow\nversion: 1.0.0\n---\n# Durable PDF instructions",
    );
    let first = run_script(
        &workspace,
        vec![
            ScriptedResponse::completion(r#"[{"tool":"skill.view","args":{"name":"pdf"}}]"#),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"loaded"}}]"#),
        ],
        &RecordingApproval::deny(),
        &CancellationToken::new(),
        3,
    )
    .await;
    assert!(first.result.is_ok());
    assert_eq!(first.session.loaded_skills[0].name, "pdf");
    let loaded_prompt = first.requests[1]["prompt"]
        .as_str()
        .expect("prompt after skill.view");
    assert!(loaded_prompt.contains("### loaded-skills\n# skill: pdf (v1.0.0)"));
    assert!(loaded_prompt.contains("This skill declares no bundled scripts"));
    assert!(loaded_prompt.contains("# Durable PDF instructions"));

    let server = ScriptedCompletionServer::start(vec![ScriptedResponse::completion(
        r#"[{"tool":"reply","args":{"text":"restored"}}]"#,
    )])
    .await;
    let client = server.client();
    let desktop = RecordingDesktop::default();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let registry = workspace.skill_registry();
    let mut restored_session: AgentSessionState =
        serde_json::from_slice(&serde_json::to_vec(&first.session).unwrap()).unwrap();
    let mut events = Vec::new();
    let editable_roots = EditableRoots::for_test(workspace.path());
    let folder_access = RecordingFolderAccess::deny();
    run_turn(
        RunTurnInput {
            run_id: "restore-run",
            session_id: "test-session",
            user_message: "use the loaded skill",
            selected_skill: None,
            stable_prefix: "TEST_STABLE_PREFIX",
            model_profile: super::model_profile::AgentModelProfile::Plain,
            working_dir: workspace.path(),
            editable_roots: &editable_roots,
            external_read_only_roots: &[],
            trusted_read_roots: &[],
            max_steps: 2,
            client: &client,
            approval: &approval,
            folder_access: &folder_access,
            desktop: &desktop,
            cancellation: &cancellation,
            session: &mut restored_session,
            skill_registry: &registry,
            bundled_script_runtime: None,
        },
        |event| collect_event(&mut events, event),
    )
    .await
    .expect("restored turn");

    let restored_requests = server.requests();
    let restored_prompt = restored_requests[0]["prompt"]
        .as_str()
        .expect("restored prompt");
    assert!(restored_prompt.contains("### loaded-skills\n# skill: pdf (v1.0.0)"));
    assert!(restored_prompt.contains("This skill declares no bundled scripts"));
    assert!(restored_prompt.contains("# Durable PDF instructions"));
}

#[tokio::test]
async fn selected_skill_is_loaded_into_the_first_prompt_without_skill_view() {
    let workspace = TestWorkspace::new();
    workspace.write(
        ".agent-skills/pdf/SKILL.md",
        "---\nname: pdf\ndescription: PDF workflow\nversion: 1.0.0\n---\n# Deterministic PDF instructions",
    );
    let server = ScriptedCompletionServer::start(vec![ScriptedResponse::completion(
        r#"[{"tool":"reply","args":{"text":"loaded"}}]"#,
    )])
    .await;
    let client = server.client();
    let desktop = RecordingDesktop::default();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let registry = workspace.skill_registry();
    let mut session = AgentSessionState::new("selected-skill-session");
    let mut events = Vec::new();
    let editable_roots = EditableRoots::for_test(workspace.path());
    let folder_access = RecordingFolderAccess::deny();

    run_turn(
        RunTurnInput {
            run_id: "selected-skill-run",
            session_id: "selected-skill-session",
            user_message: "use the selected workflow",
            selected_skill: Some("pdf"),
            stable_prefix: "TEST_STABLE_PREFIX",
            model_profile: super::model_profile::AgentModelProfile::Plain,
            working_dir: workspace.path(),
            editable_roots: &editable_roots,
            external_read_only_roots: &[],
            trusted_read_roots: &[],
            max_steps: 2,
            client: &client,
            approval: &approval,
            folder_access: &folder_access,
            desktop: &desktop,
            cancellation: &cancellation,
            session: &mut session,
            skill_registry: &registry,
            bundled_script_runtime: None,
        },
        |event| collect_event(&mut events, event),
    )
    .await
    .expect("selected skill turn");

    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    let first_prompt = requests[0]["prompt"].as_str().expect("first prompt");
    assert!(first_prompt.contains("### loaded-skills\n# skill: pdf (v1.0.0)"));
    assert!(first_prompt.contains("# Deterministic PDF instructions"));
    assert!(!events.iter().any(|event| {
        matches!(
            event,
            AgentEvent::ToolCallExecuted { result } if result.call.tool == "skill.view"
        )
    }));
    assert_eq!(session.loaded_skills[0].name, "pdf");
}

#[tokio::test]
async fn unknown_selected_skill_fails_before_completion() {
    let workspace = TestWorkspace::new();
    let server = ScriptedCompletionServer::start(vec![ScriptedResponse::completion(
        r#"[{"tool":"reply","args":{"text":"must not run"}}]"#,
    )])
    .await;
    let client = server.client();
    let desktop = RecordingDesktop::default();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let registry = workspace.skill_registry();
    let mut session = AgentSessionState::new("missing-skill-session");
    let mut events = Vec::new();
    let editable_roots = EditableRoots::for_test(workspace.path());
    let folder_access = RecordingFolderAccess::deny();

    let error = run_turn(
        RunTurnInput {
            run_id: "missing-skill-run",
            session_id: "missing-skill-session",
            user_message: "must not be persisted",
            selected_skill: Some("missing"),
            stable_prefix: "TEST_STABLE_PREFIX",
            model_profile: super::model_profile::AgentModelProfile::Plain,
            working_dir: workspace.path(),
            editable_roots: &editable_roots,
            external_read_only_roots: &[],
            trusted_read_roots: &[],
            max_steps: 2,
            client: &client,
            approval: &approval,
            folder_access: &folder_access,
            desktop: &desktop,
            cancellation: &cancellation,
            session: &mut session,
            skill_registry: &registry,
            bundled_script_runtime: None,
        },
        |event| collect_event(&mut events, event),
    )
    .await
    .expect_err("missing selected skill must fail");

    assert!(error.contains("missing, disabled, incompatible, or unavailable"));
    assert!(server.requests().is_empty());
    assert!(session.turns.is_empty());
    assert_eq!(finished_reason(&events), Some(("failed", 0)));
}
