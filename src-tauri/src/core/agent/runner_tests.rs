use std::time::Duration;

use hyper::StatusCode;
use tokio_util::sync::CancellationToken;

use super::llm_client::{AgentLlmClient, SamplingOverrides};
use super::mcp_tools::{McpBridge, McpToolDescriptor};
use super::path_policy::EditableRoots;
use super::pty::PtyRegistry;
use super::rag_bridge::{DocsAttachment, DocsBridge, DocsChunk, DocsScope};
use super::runner::{run_turn, RunTurnInput};
use super::session::AgentSessionState;
use super::test_support::{
    collect_event, RecordingApproval, RecordingDesktop, RecordingFolderAccess, ScriptedChatServer,
    ScriptedCompletionServer, ScriptedResponse, TestWorkspace,
};
use super::types::{AgentEvent, AgentReasoning, LoopLevel, ToolStatus};

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
    let run = run_script_with_client(workspace, &client, approval, cancellation, max_steps).await;
    TestRun {
        requests: server.requests(),
        ..run
    }
}

/// Chat-transport twin of [`run_script`]. Same loop, same assertions helpers —
/// only the transport differs.
async fn run_chat_script(
    workspace: &TestWorkspace,
    responses: Vec<ScriptedResponse>,
    approval: &RecordingApproval,
    cancellation: &CancellationToken,
    max_steps: u32,
    with_schema: bool,
) -> TestRun {
    let server = ScriptedChatServer::start(responses).await;
    let client = if with_schema {
        server.client()
    } else {
        server.client_without_schema()
    };
    let run = run_script_with_client(workspace, &client, approval, cancellation, max_steps).await;
    TestRun {
        requests: server.requests(),
        ..run
    }
}

async fn run_script_with_client(
    workspace: &TestWorkspace,
    client: &dyn AgentLlmClient,
    approval: &RecordingApproval,
    cancellation: &CancellationToken,
    max_steps: u32,
) -> TestRun {
    run_script_with_reasoning(
        workspace,
        client,
        approval,
        cancellation,
        max_steps,
        AgentReasoning::default(),
    )
    .await
}

async fn run_script_with_reasoning(
    workspace: &TestWorkspace,
    client: &dyn AgentLlmClient,
    approval: &RecordingApproval,
    cancellation: &CancellationToken,
    max_steps: u32,
    reasoning: AgentReasoning,
) -> TestRun {
    run_script_with_options(
        workspace,
        client,
        approval,
        cancellation,
        max_steps,
        reasoning,
        None,
        true,
        None,
        None,
        &std::collections::BTreeSet::new(),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_script_with_options(
    workspace: &TestWorkspace,
    client: &dyn AgentLlmClient,
    approval: &RecordingApproval,
    cancellation: &CancellationToken,
    max_steps: u32,
    reasoning: AgentReasoning,
    mcp: Option<&dyn McpBridge>,
    auto_approve_mcp: bool,
    docs: Option<&dyn DocsBridge>,
    documents_note: Option<&str>,
    disabled_tools: &std::collections::BTreeSet<String>,
) -> TestRun {
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
            reasoning,
            sampling: &SamplingOverrides::default(),
            mcp,
            disabled_tools,
            auto_approve_mcp,
            docs,
            documents_note,
            client,
            approval,
            folder_access: &folder_access,
            desktop: &desktop,
            cancellation,
            session: &mut session,
            skill_registry: &skill_registry,
            bundled_script_runtime: None,
            pty: &PtyRegistry::new(),
            cache_dir: &std::env::temp_dir(),
        },
        |event| collect_event(&mut events, event),
    )
    .await;
    TestRun {
        result,
        events,
        requests: Vec::new(),
        session,
    }
}

/// Scripted [`McpBridge`]: fixed descriptors, canned results, recorded calls.
struct ScriptedMcpBridge {
    descriptors: Vec<McpToolDescriptor>,
    fail_calls: bool,
    calls: std::sync::Mutex<Vec<String>>,
}

impl ScriptedMcpBridge {
    fn new(tools: &[(&str, bool)]) -> Self {
        Self {
            descriptors: tools
                .iter()
                .map(|(tool, read_only)| McpToolDescriptor {
                    agent_name: format!("mcp.test.{tool}"),
                    server: "test".into(),
                    tool: (*tool).into(),
                    description: format!("scripted {tool}"),
                    input_schema: serde_json::json!({"type": "object"}),
                    read_only: *read_only,
                })
                .collect(),
            fail_calls: false,
            calls: std::sync::Mutex::new(Vec::new()),
        }
    }

    fn failing(tools: &[(&str, bool)]) -> Self {
        Self {
            fail_calls: true,
            ..Self::new(tools)
        }
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("mcp calls").clone()
    }
}

#[async_trait::async_trait]
impl McpBridge for ScriptedMcpBridge {
    fn resolve(&self, agent_name: &str) -> Option<&McpToolDescriptor> {
        self.descriptors
            .iter()
            .find(|descriptor| descriptor.agent_name == agent_name)
    }

    fn descriptors(&self) -> &[McpToolDescriptor] {
        &self.descriptors
    }

    async fn call(
        &self,
        descriptor: &McpToolDescriptor,
        _args: &serde_json::Value,
        _cancellation: &CancellationToken,
    ) -> Result<rmcp::model::CallToolResult, String> {
        self.calls
            .lock()
            .expect("mcp calls")
            .push(descriptor.agent_name.clone());
        if self.fail_calls {
            return Err(format!(
                "MCP server '{}' is not connected — it may have stopped; do not retry this tool",
                descriptor.server
            ));
        }
        Ok(rmcp::model::CallToolResult::success(vec![
            rmcp::model::Content::text(format!("result from {}", descriptor.tool)),
        ]))
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
        AgentEvent::TurnFinished {
            reason, step_count, ..
        } => Some((reason.as_str(), *step_count)),
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

async fn run_mcp_script(
    responses: Vec<ScriptedResponse>,
    bridge: &ScriptedMcpBridge,
    approval: &RecordingApproval,
    auto_approve_mcp: bool,
) -> TestRun {
    let workspace = TestWorkspace::new();
    let server = ScriptedCompletionServer::start(responses).await;
    let client = server.client();
    let cancellation = CancellationToken::new();
    let run = run_script_with_options(
        &workspace,
        &client,
        approval,
        &cancellation,
        3,
        AgentReasoning::default(),
        Some(bridge),
        auto_approve_mcp,
        None,
        None,
        &std::collections::BTreeSet::new(),
    )
    .await;
    TestRun {
        requests: server.requests(),
        ..run
    }
}

/// Scripted [`DocsBridge`]: fixed scopes, canned chunks, recorded embeds.
struct ScriptedDocsBridge {
    scopes: Vec<DocsScope>,
    fail_embed: bool,
    embeds: std::sync::Mutex<Vec<String>>,
}

impl ScriptedDocsBridge {
    fn thread_only() -> Self {
        Self {
            scopes: vec![DocsScope::Thread],
            fail_embed: false,
            embeds: std::sync::Mutex::new(Vec::new()),
        }
    }

    fn with_project() -> Self {
        Self {
            scopes: vec![DocsScope::Thread, DocsScope::Project],
            ..Self::thread_only()
        }
    }

    fn embedding_down() -> Self {
        Self {
            fail_embed: true,
            ..Self::thread_only()
        }
    }

    fn embeds(&self) -> Vec<String> {
        self.embeds.lock().expect("embeds").clone()
    }
}

#[async_trait::async_trait]
impl DocsBridge for ScriptedDocsBridge {
    fn scopes(&self) -> &[DocsScope] {
        &self.scopes
    }

    async fn embed(
        &self,
        query: &str,
        _cancellation: &CancellationToken,
    ) -> Result<Vec<f32>, String> {
        if self.fail_embed {
            return Err(super::rag_bridge::EMBEDDING_UNAVAILABLE.into());
        }
        self.embeds.lock().expect("embeds").push(query.to_owned());
        Ok(vec![0.1, 0.2, 0.3])
    }

    async fn list(&self, scope: DocsScope) -> Result<Vec<DocsAttachment>, String> {
        Ok(vec![DocsAttachment {
            id: format!("{}-file", scope.as_str()),
            name: Some(format!("{}.pdf", scope.as_str())),
            file_type: Some("pdf".into()),
            size: Some(1024),
            chunk_count: 4,
            scope: scope.as_str(),
        }])
    }

    async fn retrieve(
        &self,
        scope: DocsScope,
        _query_embedding: &[f32],
        _top_k: usize,
        _file_ids: Option<&[String]>,
    ) -> Result<Vec<DocsChunk>, String> {
        let score = match scope {
            DocsScope::Thread => 0.9,
            DocsScope::Project => 0.8,
        };
        Ok(vec![DocsChunk {
            id: format!("{}-chunk", scope.as_str()),
            text: format!("passage from the {} index", scope.as_str()),
            score: Some(score),
            file_id: format!("{}-file", scope.as_str()),
            chunk_file_order: 0,
            scope: scope.as_str(),
        }])
    }

    async fn chunks(
        &self,
        scope: DocsScope,
        file_id: &str,
        start_order: i64,
        end_order: i64,
    ) -> Result<Vec<DocsChunk>, String> {
        Ok((start_order..=end_order)
            .map(|order| DocsChunk {
                id: format!("{file_id}-{order}"),
                text: format!("chunk {order}"),
                score: None,
                file_id: file_id.to_owned(),
                chunk_file_order: order,
                scope: scope.as_str(),
            })
            .collect())
    }
}

async fn run_docs_script(
    responses: Vec<ScriptedResponse>,
    docs: Option<&dyn DocsBridge>,
    documents_note: Option<&str>,
    disabled_tools: &std::collections::BTreeSet<String>,
) -> TestRun {
    let workspace = TestWorkspace::new();
    let server = ScriptedCompletionServer::start(responses).await;
    let client = server.client();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let run = run_script_with_options(
        &workspace,
        &client,
        &approval,
        &cancellation,
        3,
        AgentReasoning::default(),
        None,
        true,
        docs,
        documents_note,
        disabled_tools,
    )
    .await;
    TestRun {
        requests: server.requests(),
        ..run
    }
}

#[tokio::test]
async fn docs_retrieve_merges_scopes_and_feeds_citations_back() {
    let bridge = ScriptedDocsBridge::with_project();
    let run = run_docs_script(
        vec![
            ScriptedResponse::completion(
                r#"[{"tool":"docs.retrieve","args":{"query":"quarterly revenue","top_k":2}}]"#,
            ),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"cited"}}]"#),
        ],
        Some(&bridge),
        Some("2 indexed document(s): a.pdf, b.pdf."),
        &std::collections::BTreeSet::new(),
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(
        executed(&run.events),
        [("docs.retrieve", ToolStatus::Ok), ("reply", ToolStatus::Ok)]
    );
    assert_eq!(bridge.embeds(), ["quarterly revenue"]);
    // The variable tail carries the documents note; the grammar advertises
    // the docs alternation.
    let prompt = run.requests[0]["prompt"].as_str().expect("prompt");
    assert!(prompt.contains("### documents"));
    assert!(prompt.contains("a.pdf"));
    let grammar = run.requests[0]["grammar"].as_str().expect("grammar");
    assert!(grammar.contains("docs-retrieve"));
    // The observation feeds both scopes' citations back, thread first.
    let followup = run.requests[1]["prompt"].as_str().expect("prompt");
    assert!(followup.contains("passage from the thread index"));
    assert!(followup.contains("passage from the project index"));
}

#[tokio::test]
async fn missing_embedding_session_is_a_structured_error_and_the_turn_recovers() {
    let bridge = ScriptedDocsBridge::embedding_down();
    let run = run_docs_script(
        vec![
            ScriptedResponse::completion(
                r#"[{"tool":"docs.retrieve","args":{"query":"quarterly revenue"}}]"#,
            ),
            ScriptedResponse::completion(
                r#"[{"tool":"reply","args":{"text":"cannot search right now"}}]"#,
            ),
        ],
        Some(&bridge),
        Some("1 indexed document(s): a.pdf."),
        &std::collections::BTreeSet::new(),
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(
        executed(&run.events),
        [
            ("docs.retrieve", ToolStatus::Error),
            ("reply", ToolStatus::Ok)
        ]
    );
    let summary = run
        .events
        .iter()
        .find_map(|event| match event {
            AgentEvent::ToolCallExecuted { result } if result.call.tool == "docs.retrieve" => {
                Some(result.outcome.summary.clone())
            }
            _ => None,
        })
        .expect("docs execution outcome");
    assert!(summary.contains("embedding model is not running"));
    assert!(summary.contains("do not retry"));
}

#[tokio::test]
async fn docs_tools_stay_disabled_without_rag_context() {
    let disabled: std::collections::BTreeSet<String> = super::tools::docs::DOCS_TOOL_NAMES
        .into_iter()
        .map(str::to_owned)
        .collect();
    let run = run_docs_script(
        vec![
            ScriptedResponse::completion(
                r#"[{"tool":"docs.retrieve","args":{"query":"quarterly revenue"}}]"#,
            ),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"no docs"}}]"#),
        ],
        None,
        None,
        &disabled,
    )
    .await;

    assert!(run.result.is_ok());
    // The grammar never advertises the docs tools, and the defense-in-depth
    // dispatch guard refuses the call anyway.
    let grammar = run.requests[0]["grammar"].as_str().expect("grammar");
    assert!(!grammar.contains("docs-retrieve"));
    let prompt = run.requests[0]["prompt"].as_str().expect("prompt");
    assert!(!prompt.contains("### documents"));
    let executions = executed(&run.events);
    assert_eq!(executions.last(), Some(&("reply", ToolStatus::Ok)));
    if executions.len() == 2 {
        assert_eq!(executions[0].0, "docs.retrieve");
        assert_eq!(executions[0].1, ToolStatus::Error);
    }
}

#[tokio::test]
async fn two_docs_retrieves_batch_as_pure_reads() {
    let bridge = ScriptedDocsBridge::thread_only();
    let run = run_docs_script(
        vec![
            ScriptedResponse::completion(
                r#"[{"tool":"docs.retrieve","args":{"query":"first topic"}},{"tool":"docs.retrieve","args":{"query":"second topic"}}]"#,
            ),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"both"}}]"#),
        ],
        Some(&bridge),
        Some("1 indexed document(s): a.pdf."),
        &std::collections::BTreeSet::new(),
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(
        executed(&run.events),
        [
            ("docs.retrieve", ToolStatus::Ok),
            ("docs.retrieve", ToolStatus::Ok),
            ("reply", ToolStatus::Ok)
        ]
    );
    let mut embeds = bridge.embeds();
    embeds.sort();
    assert_eq!(embeds, ["first topic", "second topic"]);
}

#[tokio::test]
async fn read_only_mcp_tool_executes_without_any_approval() {
    let bridge = ScriptedMcpBridge::new(&[("search", true)]);
    let approval = RecordingApproval::deny();
    let run = run_mcp_script(
        vec![
            ScriptedResponse::completion(
                r#"[{"tool":"mcp.test.search","args":{"query":"atomic"}}]"#,
            ),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"found"}}]"#),
        ],
        &bridge,
        &approval,
        false,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(
        executed(&run.events),
        [
            ("mcp.test.search", ToolStatus::Ok),
            ("reply", ToolStatus::Ok)
        ]
    );
    assert!(
        approval.requests().is_empty(),
        "readOnlyHint skips the gate"
    );
    assert_eq!(bridge.calls(), ["mcp.test.search"]);
    // The grammar for the step advertises the MCP alternation.
    let grammar = run.requests[0]["grammar"].as_str().expect("grammar");
    assert!(grammar.contains("mcp-tool-name"));
    assert!(grammar.contains("mcp.test.search"));
}

#[tokio::test]
async fn non_read_only_mcp_tool_is_gated_and_fails_closed_on_deny() {
    let bridge = ScriptedMcpBridge::new(&[("create_issue", false)]);
    let approval = RecordingApproval::deny();
    let run = run_mcp_script(
        vec![
            ScriptedResponse::completion(
                r#"[{"tool":"mcp.test.create_issue","args":{"title":"bug"}}]"#,
            ),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"could not"}}]"#),
        ],
        &bridge,
        &approval,
        false,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(
        executed(&run.events),
        [
            ("mcp.test.create_issue", ToolStatus::Denied),
            ("reply", ToolStatus::Ok)
        ]
    );
    let requests = approval.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].tool, "mcp.test.create_issue");
    assert!(requests[0].can_remember, "Always allow must be offered");
    assert!(requests[0]
        .affected_resources
        .iter()
        .any(|resource| resource.kind == "mcp"));
    assert!(
        bridge.calls().is_empty(),
        "denied call never reaches the server"
    );
}

#[tokio::test]
async fn auto_approve_mcp_bypasses_the_gate_for_mcp_tools_only() {
    let bridge = ScriptedMcpBridge::new(&[("create_issue", false)]);
    let approval = RecordingApproval::deny();
    let run = run_mcp_script(
        vec![
            ScriptedResponse::completion(
                r#"[{"tool":"mcp.test.create_issue","args":{"title":"bug"}}]"#,
            ),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"done"}}]"#),
        ],
        &bridge,
        &approval,
        true,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(
        executed(&run.events),
        [
            ("mcp.test.create_issue", ToolStatus::Ok),
            ("reply", ToolStatus::Ok)
        ]
    );
    assert!(approval.requests().is_empty());
    assert_eq!(bridge.calls(), ["mcp.test.create_issue"]);
}

#[tokio::test]
async fn dead_mcp_server_yields_a_structured_error_outcome() {
    let bridge = ScriptedMcpBridge::failing(&[("search", true)]);
    let approval = RecordingApproval::deny();
    let run = run_mcp_script(
        vec![
            ScriptedResponse::completion(
                r#"[{"tool":"mcp.test.search","args":{"query":"atomic"}}]"#,
            ),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"server gone"}}]"#),
        ],
        &bridge,
        &approval,
        false,
    )
    .await;

    assert!(run.result.is_ok());
    let executions = executed(&run.events);
    assert_eq!(executions[0].0, "mcp.test.search");
    assert_eq!(executions[0].1, ToolStatus::Error);
    let error_summary = run
        .events
        .iter()
        .find_map(|event| match event {
            AgentEvent::ToolCallExecuted { result } if result.call.tool == "mcp.test.search" => {
                Some(result.outcome.summary.clone())
            }
            _ => None,
        })
        .expect("mcp execution outcome");
    assert!(error_summary.contains("not connected"));
    assert!(error_summary.contains("do not retry"));
}

#[tokio::test]
async fn unknown_mcp_name_stays_out_of_the_batch() {
    // A name the bridge cannot resolve classifies as Unknown → validation
    // rejects the batch and the repair path takes over.
    let bridge = ScriptedMcpBridge::new(&[("search", true)]);
    let approval = RecordingApproval::deny();
    let run = run_mcp_script(
        vec![
            ScriptedResponse::completion(r#"[{"tool":"mcp.test.missing","args":{}}]"#),
            // Repair completion returns a valid array.
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"ok"}}]"#),
        ],
        &bridge,
        &approval,
        false,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(executed(&run.events), [("reply", ToolStatus::Ok)]);
    assert!(bridge.calls().is_empty());
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
    // `assistant_delta` precedes the parse events: `reply.args.text` streams
    // live out of the constrained completion.
    assert_eq!(
        run.events.iter().map(event_kind).collect::<Vec<_>>(),
        [
            "turn_started",
            "step_started",
            "assistant_delta",
            "tool_call_parsed",
            "tool_call_executed",
            "assistant_reply",
            "turn_finished"
        ]
    );
    let streamed = run
        .events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::AssistantDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    assert_eq!(streamed, "done");
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
            reasoning: AgentReasoning::default(),
            sampling: &SamplingOverrides::default(),
            mcp: None,
            disabled_tools: &std::collections::BTreeSet::new(),
            auto_approve_mcp: true,
            docs: None,
            documents_note: None,
            client: &client,
            approval: &approval,
            folder_access: &folder_access,
            desktop: &desktop,
            cancellation: &cancellation,
            session: &mut session,
            skill_registry: &skill_registry,
            bundled_script_runtime: None,
            pty: &PtyRegistry::new(),
            cache_dir: &std::env::temp_dir(),
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
async fn verbose_read_reaches_the_model_uncompressed() {
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
    assert!(next_prompt.contains("EVENT_DETAIL_LINE_00"));
    assert!(next_prompt.contains("EVENT_DETAIL_LINE_29"));
    assert!(!next_prompt.contains("omitted"));
}

#[tokio::test]
async fn oversized_observation_is_spilled_with_a_locator_and_full_text_on_disk() {
    let workspace = TestWorkspace::new();
    let body = (0..150)
        .map(|index| format!("SPILL_MATCH_LINE_{index:03} with trailing detail padding"))
        .collect::<Vec<_>>()
        .join("\n");
    workspace.write("large.txt", &body);
    let run = run_script(
        &workspace,
        vec![
            ScriptedResponse::completion(
                r#"[{"tool":"os.fs.grep","args":{"pattern":"SPILL_MATCH_LINE_","path":"."}}]"#,
            ),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"observed"}}]"#),
        ],
        &RecordingApproval::deny(),
        &CancellationToken::new(),
        3,
    )
    .await;

    assert!(run.result.is_ok());
    let next_prompt = run.requests[1]["prompt"].as_str().expect("next prompt");
    assert!(next_prompt.contains("Full output saved to `"));
    assert!(next_prompt.contains("… [omitted"));
    assert!(next_prompt.contains("SPILL_MATCH_LINE_000"));
    let spill_dir = workspace.path().join(".agent/observations");
    let spilled = std::fs::read_dir(&spill_dir)
        .expect("spill dir exists")
        .filter_map(Result::ok)
        .find(|entry| entry.file_name().to_string_lossy().contains("os-fs-grep"))
        .expect("spilled grep observation");
    let full = std::fs::read_to_string(spilled.path()).expect("read spill file");
    assert!(full.contains("SPILL_MATCH_LINE_000"));
    assert!(full.contains("SPILL_MATCH_LINE_149"));
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
                reasoning: AgentReasoning::default(),
                sampling: &SamplingOverrides::default(),
                mcp: None,
                disabled_tools: &std::collections::BTreeSet::new(),
                auto_approve_mcp: true,
                docs: None,
                documents_note: None,
                client: &client,
                approval: &approval,
                folder_access: &folder_access,
                desktop: &desktop,
                cancellation: &cancellation,
                session: &mut session,
                skill_registry: &skill_registry,
                bundled_script_runtime: None,
                pty: &PtyRegistry::new(),
                cache_dir: &std::env::temp_dir(),
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
async fn surplus_terminal_calls_are_trimmed_instead_of_repaired() {
    // What small local models actually emit when they over-close a turn. The
    // extra terminal carries no new intent, so the batch is salvaged in place:
    // no repair round-trip, no failed turn.
    let workspace = TestWorkspace::new();
    let run = run_script(
        &workspace,
        vec![ScriptedResponse::completion(
            r#"[
                {"tool":"os.fs.list","args":{}},
                {"tool":"reply","args":{"text":"answered"}},
                {"tool":"reply","args":{"text":"answered again"}}
            ]"#,
        )],
        &RecordingApproval::deny(),
        &CancellationToken::new(),
        2,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(finished_reason(&run.events), Some(("reply", 1)));
    assert_eq!(
        executed(&run.events),
        [("os.fs.list", ToolStatus::Ok), ("reply", ToolStatus::Ok)]
    );
    assert_eq!(run.requests.len(), 1);
    assert!(!run
        .events
        .iter()
        .any(|event| matches!(event, AgentEvent::ParseRetry { .. })));
    assert!(run.events.iter().any(|event| matches!(
        event,
        AgentEvent::BatchTrimmed { kept_tool, dropped_tools, .. }
            if kept_tool == "reply" && dropped_tools == &["reply".to_string()]
    )));
    assert!(run
        .events
        .iter()
        .any(|event| matches!(event, AgentEvent::AssistantReply { text } if text == "answered")));
}

/// A surplus terminal behind a call that must run solo is not salvageable —
/// the trimmed prefix still breaks the batch rules, so the model gets its
/// round-trip.
#[tokio::test]
async fn a_surplus_terminal_after_an_approval_gated_call_still_repairs() {
    let workspace = TestWorkspace::new();
    let run = run_script(
        &workspace,
        vec![
            ScriptedResponse::completion(
                r#"[
                    {"tool":"os.shell.run","args":{"cmd":"echo"}},
                    {"tool":"reply","args":{"text":"early"}},
                    {"tool":"reply","args":{"text":"early again"}}
                ]"#,
            ),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"fixed"}}]"#),
        ],
        &RecordingApproval::deny(),
        &CancellationToken::new(),
        2,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(finished_reason(&run.events), Some(("reply", 1)));
    assert_eq!(run.requests.len(), 2);
    assert_eq!(
        run.events
            .iter()
            .filter(|event| matches!(event, AgentEvent::ParseRetry { .. }))
            .count(),
        1
    );
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
    // Bound outside the call: this future is held across statements, so the
    // registry has to outlive the `run_turn` expression.
    let pty = PtyRegistry::new();
    let cache_dir = std::env::temp_dir();
    let sampling = SamplingOverrides::default();
    let disabled_tools = std::collections::BTreeSet::new();
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
            reasoning: AgentReasoning::default(),
            sampling: &sampling,
            mcp: None,
            disabled_tools: &disabled_tools,
            auto_approve_mcp: true,
            docs: None,
            documents_note: None,
            client: &client,
            approval: &approval,
            folder_access: &folder_access,
            desktop: &desktop,
            cancellation: &cancellation,
            session: &mut session,
            skill_registry: &skill_registry,
            bundled_script_runtime: None,
            pty: &pty,
            cache_dir: &cache_dir,
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
            reasoning: AgentReasoning::default(),
            sampling: &SamplingOverrides::default(),
            mcp: None,
            disabled_tools: &std::collections::BTreeSet::new(),
            auto_approve_mcp: true,
            docs: None,
            documents_note: None,
            client: &client,
            approval: &approval,
            folder_access: &folder_access,
            desktop: &desktop,
            cancellation: &cancellation,
            session: &mut restored_session,
            skill_registry: &registry,
            bundled_script_runtime: None,
            pty: &PtyRegistry::new(),
            cache_dir: &std::env::temp_dir(),
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
            reasoning: AgentReasoning::default(),
            sampling: &SamplingOverrides::default(),
            mcp: None,
            disabled_tools: &std::collections::BTreeSet::new(),
            auto_approve_mcp: true,
            docs: None,
            documents_note: None,
            client: &client,
            approval: &approval,
            folder_access: &folder_access,
            desktop: &desktop,
            cancellation: &cancellation,
            session: &mut session,
            skill_registry: &registry,
            bundled_script_runtime: None,
            pty: &PtyRegistry::new(),
            cache_dir: &std::env::temp_dir(),
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
            reasoning: AgentReasoning::default(),
            sampling: &SamplingOverrides::default(),
            mcp: None,
            disabled_tools: &std::collections::BTreeSet::new(),
            auto_approve_mcp: true,
            docs: None,
            documents_note: None,
            client: &client,
            approval: &approval,
            folder_access: &folder_access,
            desktop: &desktop,
            cancellation: &cancellation,
            session: &mut session,
            skill_registry: &registry,
            bundled_script_runtime: None,
            pty: &PtyRegistry::new(),
            cache_dir: &std::env::temp_dir(),
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

// ---------------------------------------------------------------------------
// Chat transport (MLX and the Local API Server proxy)
//
// Same loop, same events, same terminal reasons — only the wire format
// differs. The llama.cpp assertions above must keep passing unchanged; these
// pin the chat-shaped equivalent.
// ---------------------------------------------------------------------------

fn chat_messages(request: &serde_json::Value) -> &Vec<serde_json::Value> {
    request["messages"].as_array().expect("messages array")
}

#[tokio::test]
async fn chat_transport_sends_system_and_user_messages() {
    let workspace = TestWorkspace::new();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let run = run_chat_script(
        &workspace,
        vec![ScriptedResponse::chat_completion(
            r#"[{"tool":"reply","args":{"text":"done"}}]"#,
        )],
        &approval,
        &cancellation,
        3,
        true,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(finished_reason(&run.events), Some(("reply", 1)));
    assert_eq!(run.requests.len(), 1);

    let request = &run.requests[0];
    let messages = chat_messages(request);
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], "system");
    assert_eq!(messages[0]["content"], "TEST_STABLE_PREFIX");
    assert_eq!(messages[1]["role"], "user");
    assert!(messages[1]["content"]
        .as_str()
        .is_some_and(|value| value.contains("### conversation\nUSER: perform the fixture task")));
    // Step completions stream, with usage opted in for the whole-run counters.
    assert_eq!(request["stream"], true);
    assert_eq!(
        request["stream_options"],
        serde_json::json!({"include_usage": true})
    );

    // llama.cpp-only fields must not leak onto an OpenAI-compatible endpoint.
    for absent in [
        "prompt",
        "grammar",
        "cache_prompt",
        "slot_id",
        "id_slot",
        "n_predict",
        "top_k",
        "repeat_penalty",
        "repeat_last_n",
    ] {
        assert!(
            request.get(absent).is_none(),
            "chat request must not carry `{absent}`"
        );
    }
}

#[tokio::test]
async fn chat_transport_sends_response_format_when_supported() {
    let workspace = TestWorkspace::new();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let run = run_chat_script(
        &workspace,
        vec![ScriptedResponse::chat_completion(
            r#"[{"tool":"reply","args":{"text":"done"}}]"#,
        )],
        &approval,
        &cancellation,
        3,
        true,
    )
    .await;

    let schema = &run.requests[0]["response_format"];
    assert_eq!(schema["type"], "json_schema");
    assert_eq!(schema["json_schema"]["name"], "atomic_agent_tool_calls");
    assert_eq!(schema["json_schema"]["schema"]["type"], "array");
    assert!(
        schema["json_schema"]["schema"]["items"]["properties"]["tool"]["enum"]
            .as_array()
            .is_some_and(|names| names.iter().any(|name| name == "reply"))
    );
}

#[tokio::test]
async fn chat_transport_omits_response_format_when_unsupported() {
    let workspace = TestWorkspace::new();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let run = run_chat_script(
        &workspace,
        vec![ScriptedResponse::chat_completion(
            r#"[{"tool":"reply","args":{"text":"done"}}]"#,
        )],
        &approval,
        &cancellation,
        3,
        false,
    )
    .await;

    assert!(run.result.is_ok());
    assert!(run.requests[0].get("response_format").is_none());
}

/// The chat-transport analogue of the llama.cpp KV-cache invariant: without
/// `cache_prompt`/`slot_id`, prefix reuse depends entirely on the system
/// message staying byte-identical across steps.
#[tokio::test]
async fn chat_transport_system_message_is_stable_across_steps() {
    let workspace = TestWorkspace::new();
    workspace.write("notes.txt", "hello");
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let run = run_chat_script(
        &workspace,
        vec![
            ScriptedResponse::chat_completion(r#"[{"tool":"os.fs.list","args":{}}]"#),
            ScriptedResponse::chat_completion(
                r#"[{"tool":"os.fs.read","args":{"path":"notes.txt"}}]"#,
            ),
            ScriptedResponse::chat_completion(r#"[{"tool":"reply","args":{"text":"done"}}]"#),
        ],
        &approval,
        &cancellation,
        5,
        true,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(run.requests.len(), 3);
    let first_system = &chat_messages(&run.requests[0])[0];
    for request in &run.requests[1..] {
        assert_eq!(&chat_messages(request)[0], first_system);
    }
    // The user half does grow — that is where the conversation lives.
    assert_ne!(
        chat_messages(&run.requests[0])[1],
        chat_messages(&run.requests[2])[1]
    );
}

#[tokio::test]
async fn chat_transport_repair_appends_to_the_user_message() {
    let workspace = TestWorkspace::new();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let run = run_chat_script(
        &workspace,
        vec![
            ScriptedResponse::chat_completion("not a tool call at all"),
            ScriptedResponse::chat_completion(r#"[{"tool":"reply","args":{"text":"done"}}]"#),
        ],
        &approval,
        &cancellation,
        3,
        true,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(run.requests.len(), 2);

    let repair = &run.requests[1];
    let messages = chat_messages(repair);
    assert_eq!(messages[0], chat_messages(&run.requests[0])[0]);
    assert!(messages[1]["content"]
        .as_str()
        .is_some_and(|value| value.contains("### tool-call-repair")));
    assert_eq!(repair["max_tokens"], 1024);
    // Repair completions stay non-streaming.
    assert_eq!(repair["stream"], false);
    assert!(repair.get("stream_options").is_none());
}

#[tokio::test]
async fn chat_transport_degrades_on_response_format_rejection() {
    let workspace = TestWorkspace::new();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let run = run_chat_script(
        &workspace,
        vec![
            ScriptedResponse::http_error(
                StatusCode::BAD_REQUEST,
                "Invalid schema for response_format 'atomic_agent_tool_calls'",
            ),
            ScriptedResponse::chat_completion(r#"[{"tool":"reply","args":{"text":"done"}}]"#),
        ],
        &approval,
        &cancellation,
        3,
        true,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(finished_reason(&run.events), Some(("reply", 1)));
    assert_eq!(run.requests.len(), 2);
    assert!(run.requests[0].get("response_format").is_some());
    assert!(run.requests[1].get("response_format").is_none());
}

#[tokio::test]
async fn chat_transport_degrades_on_speculative_decoding_conflict() {
    let workspace = TestWorkspace::new();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let run = run_chat_script(
        &workspace,
        vec![
            ScriptedResponse::http_error(
                StatusCode::BAD_REQUEST,
                "structured outputs and speculative decoding are mutually exclusive",
            ),
            ScriptedResponse::chat_completion(r#"[{"tool":"reply","args":{"text":"done"}}]"#),
        ],
        &approval,
        &cancellation,
        3,
        true,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(run.requests.len(), 2);
    assert!(run.requests[1].get("response_format").is_none());
}

#[tokio::test]
async fn chat_transport_drops_stream_options_when_rejected() {
    let workspace = TestWorkspace::new();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let run = run_chat_script(
        &workspace,
        vec![
            ScriptedResponse::http_error(
                StatusCode::BAD_REQUEST,
                "Unrecognized request argument supplied: stream_options",
            ),
            ScriptedResponse::chat_completion(r#"[{"tool":"reply","args":{"text":"done"}}]"#),
        ],
        &approval,
        &cancellation,
        3,
        true,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(finished_reason(&run.events), Some(("reply", 1)));
    assert_eq!(run.requests.len(), 2);
    assert!(run.requests[0].get("stream_options").is_some());
    // The retry still streams — only the usage opt-in is dropped, sticky.
    assert_eq!(run.requests[1]["stream"], true);
    assert!(run.requests[1].get("stream_options").is_none());
}

#[tokio::test]
async fn chat_transport_falls_back_to_non_streaming_when_streaming_rejected() {
    let workspace = TestWorkspace::new();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let run = run_chat_script(
        &workspace,
        vec![
            ScriptedResponse::http_error(
                StatusCode::BAD_REQUEST,
                "stream mode is not supported for this model",
            ),
            ScriptedResponse::chat_completion(r#"[{"tool":"reply","args":{"text":"done"}}]"#),
        ],
        &approval,
        &cancellation,
        3,
        true,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(finished_reason(&run.events), Some(("reply", 1)));
    assert_eq!(run.requests.len(), 2);
    assert_eq!(run.requests[0]["stream"], true);
    // Sticky fallback: the whole run continues non-streaming after one 400.
    assert_eq!(run.requests[1]["stream"], false);
    assert!(run.requests[1].get("stream_options").is_none());
}

async fn run_thinking_script(
    workspace: &TestWorkspace,
    responses: Vec<ScriptedResponse>,
    approval: &RecordingApproval,
    cancellation: &CancellationToken,
    max_steps: u32,
    reasoning: AgentReasoning,
) -> TestRun {
    let server = ScriptedCompletionServer::start(responses).await;
    let client = server.client();
    let run = run_script_with_reasoning(
        workspace,
        &client,
        approval,
        cancellation,
        max_steps,
        reasoning,
    )
    .await;
    TestRun {
        requests: server.requests(),
        ..run
    }
}

#[tokio::test]
async fn thinking_turn_arms_the_reasoning_budget_sampler() {
    let workspace = TestWorkspace::new();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let run = run_thinking_script(
        &workspace,
        vec![ScriptedResponse::completion(
            "<think>weighing the options</think>\
             [{\"tool\":\"reply\",\"args\":{\"text\":\"done\"}}]",
        )],
        &approval,
        &cancellation,
        1,
        AgentReasoning::On {
            budget_tokens: Some(1024),
            effort_value: None,
        },
    )
    .await;

    assert!(run.result.is_ok());
    let request = &run.requests[0];
    assert_eq!(request["reasoning_budget_tokens"], 1024);
    assert_eq!(request["reasoning_budget_start_tag"], "<think>");
    assert_eq!(request["reasoning_budget_end_tag"], "</think>");
    // Without a forced message the server builds the sampler but never closes
    // the block, so the budget would be inert.
    assert_eq!(request["reasoning_budget_message"], "");
    // A control-token `<think>` is stripped from `content` unless preserved,
    // which would hide the whole block from the parser.
    assert_eq!(
        request["preserved_tokens"],
        serde_json::json!(["<think>", "</think>"])
    );
    assert!(request["grammar"]
        .as_str()
        .is_some_and(|grammar| grammar.starts_with("root ::= think-prelude tool-call-array")));
    // The thinking text reaches the trace and never the tool-call parser.
    assert!(run.events.iter().any(|event| matches!(
        event,
        AgentEvent::ReasoningDelta { text, .. } if text == "weighing the options"
    )));
    assert_eq!(finished_reason(&run.events), Some(("reply", 1)));
}

#[tokio::test]
async fn an_uncapped_level_still_arms_the_sampler_with_no_budget() {
    let workspace = TestWorkspace::new();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let run = run_thinking_script(
        &workspace,
        vec![ScriptedResponse::completion(
            "<think>brief</think>[{\"tool\":\"reply\",\"args\":{\"text\":\"done\"}}]",
        )],
        &approval,
        &cancellation,
        1,
        AgentReasoning::On {
            budget_tokens: None,
            effort_value: None,
        },
    )
    .await;

    assert!(run.result.is_ok());
    // -1 is the server's "no cap"; the grammar close tag still ends the block.
    assert_eq!(run.requests[0]["reasoning_budget_tokens"], -1);
}

#[tokio::test]
async fn a_non_thinking_turn_sends_no_reasoning_fields() {
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
        1,
    )
    .await;

    assert!(run.result.is_ok());
    let request = &run.requests[0];
    for field in [
        "reasoning_budget_tokens",
        "reasoning_budget_start_tag",
        "reasoning_budget_end_tag",
        "reasoning_budget_message",
        "preserved_tokens",
    ] {
        assert!(request.get(field).is_none(), "unexpected {field}");
    }
    assert!(request["grammar"]
        .as_str()
        .is_some_and(|grammar| grammar.starts_with("root ::= tool-call-array")));
}

#[tokio::test]
async fn the_repair_completion_drops_the_think_prelude() {
    let workspace = TestWorkspace::new();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let run = run_thinking_script(
        &workspace,
        vec![
            ScriptedResponse::completion("<think>hmm</think>not json at all"),
            ScriptedResponse::completion(r#"[{"tool":"reply","args":{"text":"done"}}]"#),
        ],
        &approval,
        &cancellation,
        1,
        AgentReasoning::On {
            budget_tokens: Some(256),
            effort_value: None,
        },
    )
    .await;

    assert_eq!(run.requests.len(), 2);
    let repair = &run.requests[1];
    // The repair budget is a tenth of a step's; a mandatory think block could
    // swallow it whole before the array is reached.
    assert!(repair["grammar"]
        .as_str()
        .is_some_and(|grammar| grammar.starts_with("root ::= tool-call-array")));
    assert!(repair.get("reasoning_budget_tokens").is_none());
    assert!(repair.get("preserved_tokens").is_none());
}

#[tokio::test]
async fn chat_transport_lifts_reasoning_content() {
    let workspace = TestWorkspace::new();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let run = run_chat_script(
        &workspace,
        vec![ScriptedResponse::chat_completion_with_reasoning(
            r#"[{"tool":"reply","args":{"text":"done"}}]"#,
            "weighing the options",
        )],
        &approval,
        &cancellation,
        3,
        true,
    )
    .await;

    assert!(run.result.is_ok());
    assert!(run.events.iter().any(|event| matches!(
        event,
        AgentEvent::ReasoningDelta { text, .. } if text == "weighing the options"
    )));
}

#[tokio::test]
async fn chat_transport_reply_preserves_event_order() {
    let workspace = TestWorkspace::new();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let run = run_chat_script(
        &workspace,
        vec![ScriptedResponse::chat_completion(
            r#"[{"tool":"reply","args":{"text":"done"}}]"#,
        )],
        &approval,
        &cancellation,
        3,
        true,
    )
    .await;

    // Same contract as the llama.cpp transport: `reply.args.text` streams
    // live out of the SSE completion, so the delta precedes the parse events.
    assert_eq!(
        run.events.iter().map(event_kind).collect::<Vec<_>>(),
        [
            "turn_started",
            "step_started",
            "assistant_delta",
            "tool_call_parsed",
            "tool_call_executed",
            "assistant_reply",
            "turn_finished"
        ]
    );
    let streamed = run
        .events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::AssistantDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    assert_eq!(streamed, "done");
}

#[tokio::test]
async fn chat_transport_maps_proxy_auth_failure_to_the_auth_category() {
    let workspace = TestWorkspace::new();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let run = run_chat_script(
        &workspace,
        vec![ScriptedResponse::text_error(
            StatusCode::UNAUTHORIZED,
            "Invalid or missing authorization token",
        )],
        &approval,
        &cancellation,
        3,
        true,
    )
    .await;

    assert!(run.result.is_err());
    assert!(run.events.iter().any(|event| matches!(
        event,
        AgentEvent::StepError { category, message }
            if category == "auth" && message.contains("Local API Server")
    )));
    assert_eq!(finished_reason(&run.events), Some(("failed", 0)));
}

#[tokio::test]
async fn chat_transport_maps_missing_session_to_a_step_error() {
    let workspace = TestWorkspace::new();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let run = run_chat_script(
        &workspace,
        vec![ScriptedResponse::http_error(
            StatusCode::NOT_FOUND,
            "No running session found for model 'scripted-test-model'",
        )],
        &approval,
        &cancellation,
        3,
        true,
    )
    .await;

    assert!(run
        .result
        .as_ref()
        .is_err_and(|error| error.contains("no active session")));
    assert_eq!(finished_reason(&run.events), Some(("failed", 0)));
}

#[tokio::test]
async fn chat_transport_retries_once_on_rate_limit() {
    let workspace = TestWorkspace::new();
    let approval = RecordingApproval::deny();
    let cancellation = CancellationToken::new();
    let run = run_chat_script(
        &workspace,
        vec![
            ScriptedResponse::http_error(StatusCode::TOO_MANY_REQUESTS, "slow down"),
            ScriptedResponse::chat_completion(r#"[{"tool":"reply","args":{"text":"done"}}]"#),
        ],
        &approval,
        &cancellation,
        3,
        true,
    )
    .await;

    assert!(run.result.is_ok());
    assert_eq!(run.requests.len(), 2);
    assert_eq!(finished_reason(&run.events), Some(("reply", 1)));
}
