use std::fs::File;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use super::llm_client::{LlamaServerClient, LlamaSessionTarget};
use super::path_policy::EditableRoots;
use super::prompt::{
    build_stable_prefix, CapabilitiesSummary, DEFAULT_MAX_PARALLEL_TOOL_CALLS, ITERATION_ONE_TOOLS,
};
use super::runner::{run_turn, RunTurnInput};
use super::session::AgentSessionState;
use super::test_support::{
    collect_event, RecordingApproval, RecordingDesktop, RecordingFolderAccess, TestWorkspace,
};
use super::types::{AgentEvent, ToolStatus};

const REQUIRED_MODEL_ID: &str = "unsloth/Qwen3_5-9B-GGUF-Qwen3_5-9B-IQ4_XS";

struct ManagedLlamaServer {
    child: Child,
    stdout_log: PathBuf,
    stderr_log: PathBuf,
}

impl ManagedLlamaServer {
    fn diagnostics(&mut self) -> String {
        let status = self.child.try_wait().ok().flatten();
        format!(
            "process_status={status:?}\n--- stdout ---\n{}\n--- stderr ---\n{}",
            read_log_tail(&self.stdout_log),
            read_log_tail(&self.stderr_log)
        )
    }
}

impl Drop for ManagedLlamaServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct LiveHarness {
    process: ManagedLlamaServer,
    workspace: TestWorkspace,
    client: LlamaServerClient,
    stable_prefix: String,
    timeout: Duration,
}

impl LiveHarness {
    async fn start() -> Self {
        let server_path = required_env_path("ATOMIC_AGENT_E2E_LLAMA_SERVER");
        let model_path = required_env_path("ATOMIC_AGENT_E2E_MODEL");
        assert_target_model(&model_path);

        let workspace = TestWorkspace::new();
        let port = reserve_loopback_port();
        let timeout = Duration::from_secs(env_u64("ATOMIC_AGENT_E2E_TIMEOUT_SECS", 900));
        let stdout_log = workspace.path().join("llama-server.stdout.log");
        let stderr_log = workspace.path().join("llama-server.stderr.log");
        print_provenance(&server_path, &model_path);

        let stdout = File::create(&stdout_log).expect("create llama-server stdout log");
        let stderr = File::create(&stderr_log).expect("create llama-server stderr log");
        let n_gpu_layers =
            std::env::var("ATOMIC_AGENT_E2E_N_GPU_LAYERS").unwrap_or_else(|_| "-1".into());
        let child = Command::new(&server_path)
            .args([
                "--model",
                model_path.to_str().expect("UTF-8 model path"),
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "--parallel",
                "1",
                "--ctx-size",
                "8192",
                "--no-webui",
                "--jinja",
                "-ctk",
                "turbo3",
                "-ctv",
                "turbo3",
                "-fa",
                "on",
                "-ngl",
                &n_gpu_layers,
            ])
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .spawn()
            .unwrap_or_else(|error| panic!("failed to start {}: {error}", server_path.display()));
        let mut process = ManagedLlamaServer {
            child,
            stdout_log,
            stderr_log,
        };
        if let Err(error) = wait_for_health(port, timeout, &mut process).await {
            panic!("{error}\n{}", process.diagnostics());
        }

        let client = LlamaServerClient::new(&LlamaSessionTarget {
            port: i32::from(port),
            api_key: String::new(),
            model_id: REQUIRED_MODEL_ID.into(),
            has_vision: false,
            backend: super::llm_client::LlamaBackend::Llamacpp,
        })
        .expect("create live llama-server client");
        let stable_prefix = build_stable_prefix(
            ITERATION_ONE_TOOLS,
            &[],
            &CapabilitiesSummary {
                platform: std::env::consts::OS.into(),
                arch: std::env::consts::ARCH.into(),
                browser_channel: "none".into(),
                working_dir: workspace.path().display().to_string(),
                has_clipboard: false,
                has_wmctrl: false,
                has_notifications: false,
            },
            DEFAULT_MAX_PARALLEL_TOOL_CALLS,
            None,
        );
        Self {
            process,
            workspace,
            client,
            stable_prefix,
            timeout,
        }
    }

    async fn run(
        &mut self,
        run_id: &str,
        user_message: &str,
        approval: &RecordingApproval,
        max_steps: u32,
    ) -> Vec<AgentEvent> {
        let desktop = RecordingDesktop::default();
        let cancellation = CancellationToken::new();
        let mut session = AgentSessionState::new(run_id);
        let skill_registry = self.workspace.skill_registry();
        let editable_roots = EditableRoots::new(self.workspace.path(), &[])
            .await
            .unwrap();
        let folder_access = RecordingFolderAccess::deny();
        let mut events = Vec::new();
        let result = tokio::time::timeout(
            self.timeout,
            run_turn(
                RunTurnInput {
                    run_id,
                    session_id: run_id,
                    user_message,
                    selected_skill: None,
                    stable_prefix: &self.stable_prefix,
                    model_profile: super::model_profile::AgentModelProfile::Plain,
                    working_dir: self.workspace.path(),
                    editable_roots: &editable_roots,
                    external_read_only_roots: &[],
                    trusted_read_roots: &[],
                    max_steps,
                    client: &self.client,
                    approval,
                    folder_access: &folder_access,
                    desktop: &desktop,
                    cancellation: &cancellation,
                    session: &mut session,
                    skill_registry: &skill_registry,
                    bundled_script_runtime: None,
                },
                |event| collect_event(&mut events, event),
            ),
        )
        .await;
        match result {
            Ok(Ok(())) => events,
            Ok(Err(error)) => panic!(
                "agent scenario {run_id} failed: {error}\nevents: {events:#?}\n{}",
                self.process.diagnostics()
            ),
            Err(_) => panic!(
                "agent scenario {run_id} exceeded {:?}\n{}",
                self.timeout,
                self.process.diagnostics()
            ),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires local TurboQuant llama-server and the exact Qwen3.5 9B IQ4_XS GGUF"]
async fn managed_model_agent_scenarios() {
    let mut harness = LiveHarness::start().await;

    let terminal = harness
        .run(
            "model-terminal",
            "Call reply now with text exactly MODEL_E2E_READY.",
            &RecordingApproval::deny(),
            2,
        )
        .await;
    assert_finished(&terminal, "reply");
    assert_eq!(parsed_tools(&terminal), ["reply"]);

    harness.workspace.write("first.txt", "SENTINEL_ALPHA_481");
    harness.workspace.write("second.txt", "SENTINEL_BETA_927");
    let reads = harness
        .run(
            "model-reads",
            "On the first step, call exactly two tools in one array: os.fs.read with path first.txt, then os.fs.read with path second.txt. Do not call reply on that step. After observing both unique sentinel values, call reply on the next step. Do not guess either value.",
            &RecordingApproval::deny(),
            4,
        )
        .await;
    assert_finished(&reads, "reply");
    let read_tools = parsed_tools(&reads);
    assert!(
        read_tools
            .iter()
            .filter(|tool| tool.as_str() == "os.fs.read")
            .count()
            >= 2,
        "expected both fixture reads, got {read_tools:?}"
    );
    assert!(executed_summaries(&reads)
        .iter()
        .any(|summary| summary.contains("SENTINEL_ALPHA_481")));
    assert!(executed_summaries(&reads)
        .iter()
        .any(|summary| summary.contains("SENTINEL_BETA_927")));

    let write_approval = RecordingApproval::allow();
    let write = harness
        .run(
            "model-write-allow",
            "On the first step, call exactly one tool: os.fs.write with path approved.txt and content WRITE_SENTINEL_314159. Do not add a newline and do not call reply on that step. After observing the successful write, call reply on the next step.",
            &write_approval,
            4,
        )
        .await;
    assert_finished(&write, "reply");
    assert!(
        harness.workspace.path().join("approved.txt").is_file(),
        "approved write produced no file; events: {write:#?}"
    );
    assert_eq!(
        harness.workspace.read("approved.txt"),
        b"WRITE_SENTINEL_314159"
    );
    assert_eq!(
        write_approval.requests().len(),
        1,
        "expected one write approval; events: {write:#?}"
    );
    assert_tool_status(&write, "os.fs.write", ToolStatus::Ok);

    let deny_approval = RecordingApproval::deny();
    let denied = harness
        .run(
            "model-write-deny",
            "On the first step, call exactly one tool: os.fs.write with path denied.txt and content FORBIDDEN. Do not call reply on that step. After the write is denied, do not retry it; call reply on the next step.",
            &deny_approval,
            4,
        )
        .await;
    assert_finished(&denied, "reply");
    assert!(!harness.workspace.path().join("denied.txt").exists());
    assert_eq!(
        deny_approval.requests().len(),
        1,
        "expected one denied write approval; events: {denied:#?}"
    );
    assert_tool_status(&denied, "os.fs.write", ToolStatus::Denied);

    harness.workspace.write("rare.txt", "RARE_SCHEMA_SENTINEL");
    let rare = harness
        .run(
            "model-tool-view",
            "On the first step, call exactly one tool: tool.view with name os.fs.hash. Do not call os.fs.hash or reply on that step. After the full schema is loaded, call exactly one os.fs.hash for path rare.txt with algorithm sha256. After observing the hash result, call reply on the following step.",
            &RecordingApproval::deny(),
            5,
        )
        .await;
    assert_finished(&rare, "reply");
    let rare_tools = parsed_tools(&rare);
    let view_index = rare_tools
        .iter()
        .position(|tool| tool == "tool.view")
        .unwrap_or_else(|| panic!("model must call tool.view; events: {rare:#?}"));
    let hash_index = rare_tools
        .iter()
        .position(|tool| tool == "os.fs.hash")
        .unwrap_or_else(|| panic!("model must call os.fs.hash; events: {rare:#?}"));
    assert!(view_index < hash_index);
    assert_tool_status(&rare, "os.fs.hash", ToolStatus::Ok);
}

fn required_env_path(name: &str) -> PathBuf {
    let value = std::env::var(name)
        .unwrap_or_else(|_| panic!("{name} is required for managed_model_agent_scenarios"));
    let path = PathBuf::from(value);
    assert!(path.is_file(), "{name} is not a file: {}", path.display());
    path
}

fn assert_target_model(path: &Path) {
    let normalized = path.to_string_lossy().to_ascii_lowercase();
    assert!(
        normalized.contains("qwen3_5-9b") && normalized.contains("iq4_xs"),
        "ATOMIC_AGENT_E2E_MODEL must point to the exact {REQUIRED_MODEL_ID} GGUF; got {}",
        path.display()
    );
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn reserve_loopback_port() -> u16 {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .expect("reserve loopback port");
    listener.local_addr().expect("reserved address").port()
}

fn print_provenance(server_path: &Path, model_path: &Path) {
    let version = Command::new(server_path)
        .arg("--version")
        .output()
        .map(|output| {
            format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
        })
        .unwrap_or_else(|error| format!("<version probe failed: {error}>"));
    let version_file = server_path
        .ancestors()
        .skip(1)
        .map(|parent| parent.join("version.txt"))
        .find(|candidate| candidate.is_file());
    let version_file_text = version_file
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_else(|| "<not found>".into());
    eprintln!(
        "managed agent E2E provenance:\nmodel_id={REQUIRED_MODEL_ID}\nmodel_path={}\nllama_server={}\nllama_server_version={}\nversion_file={:?}\nversion_file_contents={}",
        model_path.display(),
        server_path.display(),
        version.trim(),
        version_file,
        version_file_text.trim()
    );
}

async fn wait_for_health(
    port: u16,
    timeout: Duration,
    process: &mut ManagedLlamaServer,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| error.to_string())?;
    let health_url = format!("http://127.0.0.1:{port}/health");
    let started = Instant::now();
    loop {
        if let Some(status) = process
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
        {
            return Err(format!("llama-server exited before readiness: {status}"));
        }
        if let Ok(response) = client.get(&health_url).send().await {
            if response.status().is_success() {
                return Ok(());
            }
        }
        if started.elapsed() >= timeout {
            return Err(format!(
                "llama-server health check timed out after {timeout:?}"
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn parsed_tools(events: &[AgentEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::ToolCallParsed { call, .. } => Some(call.tool.clone()),
            _ => None,
        })
        .collect()
}

fn executed_summaries(events: &[AgentEvent]) -> Vec<&str> {
    events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::ToolCallExecuted { result } => Some(result.outcome.summary.as_str()),
            _ => None,
        })
        .collect()
}

fn assert_tool_status(events: &[AgentEvent], tool: &str, status: ToolStatus) {
    assert!(events.iter().any(|event| matches!(
        event,
        AgentEvent::ToolCallExecuted { result }
            if result.call.tool == tool && result.outcome.status == status
    )));
}

fn assert_finished(events: &[AgentEvent], expected_reason: &str) {
    assert!(
        events.iter().any(|event| matches!(
            event,
            AgentEvent::TurnFinished { reason, .. } if reason == expected_reason
        )),
        "expected TurnFinished({expected_reason:?}), got {events:#?}"
    );
}

fn read_log_tail(path: &Path) -> String {
    const MAX_LOG_CHARS: usize = 20_000;
    let Ok(content) = std::fs::read_to_string(path) else {
        return "<unavailable>".into();
    };
    let chars = content.chars().collect::<Vec<_>>();
    chars[chars.len().saturating_sub(MAX_LOG_CHARS)..]
        .iter()
        .collect()
}
