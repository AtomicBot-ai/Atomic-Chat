mod dataset;
mod hooks;
mod report;
mod scoring;
mod server;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use clap::Parser;
use indicatif::{ProgressBar, ProgressStyle};
use tokio_util::sync::CancellationToken;

use self::dataset::{GaiaDatasetClient, GaiaFilters, GaiaTask};
use self::hooks::{DenyFolderAccess, HeadlessDesktop, WorkspaceApproval};
use self::report::{
    aggregate_results, write_report, GaiaReport, GaiaTaskResult, GaiaTaskStatus, GaiaToolTrace,
};
use self::scoring::score_answer;
use self::server::{DedicatedLlamaServer, LlamaServerConfig};
use super::llm_client::{LlamaBackend, LlamaServerClient, LlamaSessionTarget};
use super::model_profile::{detect_model_profile, AgentModelProfile};
use super::path_policy::EditableRoots;
use super::prompt::{
    build_stable_prefix_for_profile, CapabilitiesSummary, SkillDescriptor,
    DEFAULT_MAX_PARALLEL_TOOL_CALLS, ITERATION_ONE_TOOLS,
};
use super::runner::{run_turn, RunTurnInput};
use super::session::AgentSessionState;
use super::skills::{available_tool_names, SkillRegistry};
use super::types::{AgentEvent, ToolStatus};

#[derive(Debug, Parser)]
#[command(
    name = "gaia-eval",
    about = "Run sequential GAIA validation evaluations"
)]
pub struct GaiaEvalArgs {
    #[arg(long, env = "GAIA_LLAMA_SERVER")]
    llama_server: PathBuf,
    #[arg(long, env = "GAIA_MODEL")]
    model: PathBuf,
    #[arg(long, env = "GAIA_MMPROJ")]
    mmproj: Option<PathBuf>,
    #[arg(long, env = "GAIA_HF_TOKEN")]
    hf_token: Option<String>,
    #[arg(long, env = "GAIA_LEVEL", default_value = "1")]
    level: Option<u8>,
    #[arg(long, env = "GAIA_LIMIT")]
    limit: Option<usize>,
    #[arg(long, env = "GAIA_TASK_ID")]
    task_id: Option<String>,
    #[arg(long, env = "GAIA_CONTEXT_SIZE", default_value_t = 32768)]
    context_size: u32,
    #[arg(long, env = "GAIA_GPU_LAYERS", default_value_t = -1)]
    gpu_layers: i32,
    #[arg(long, env = "GAIA_SERVER_TIMEOUT_SECS", default_value_t = 1800)]
    server_timeout_secs: u64,
    #[arg(long, env = "GAIA_TASK_TIMEOUT_SECS", default_value_t = 900)]
    task_timeout_secs: u64,
    #[arg(long, env = "GAIA_MAX_STEPS", default_value_t = 25)]
    max_steps: u32,
    #[arg(long, env = "GAIA_SKILLS_DIR")]
    skills_dir: Option<PathBuf>,
    #[arg(long, env = "GAIA_CACHE_DIR", default_value = "target/gaia-eval/cache")]
    cache_dir: PathBuf,
    #[arg(long, env = "GAIA_OUTPUT_DIR", default_value = "target/gaia-eval")]
    output_dir: PathBuf,
    #[arg(long, env = "GAIA_LLAMA_EXTRA_ARGS", value_delimiter = ' ')]
    llama_extra_args: Vec<String>,
}

pub async fn run(args: GaiaEvalArgs) -> Result<PathBuf, String> {
    validate_args(&args)?;
    let started = Instant::now();
    let timestamp = unix_millis();
    let run_dir = args.output_dir.join("runs").join(timestamp.to_string());
    std::fs::create_dir_all(&run_dir)
        .map_err(|error| format!("Failed to create {}: {error}", run_dir.display()))?;
    let token = args
        .hf_token
        .clone()
        .or_else(|| std::env::var("HF_TOKEN").ok())
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| "GAIA_HF_TOKEN or HF_TOKEN is required".to_string())?;
    let dataset = GaiaDatasetClient::new(token, args.cache_dir.clone())?;
    let filters = GaiaFilters {
        level: args.level,
        limit: args.limit,
        task_id: args.task_id.clone(),
    };
    let tasks = dataset.load_tasks(&filters).await?;
    if tasks.is_empty() {
        return Err("No GAIA tasks matched the requested filters".into());
    }

    let server = DedicatedLlamaServer::start(
        &LlamaServerConfig {
            executable: args.llama_server.clone(),
            model: args.model.clone(),
            mmproj: args.mmproj.clone(),
            context_size: args.context_size,
            gpu_layers: args.gpu_layers,
            startup_timeout: Duration::from_secs(args.server_timeout_secs),
            extra_args: args.llama_extra_args.clone(),
        },
        &run_dir.join("server"),
    )
    .await?;
    let target = LlamaSessionTarget {
        port: i32::from(server.port()),
        api_key: String::new(),
        model_id: args
            .model
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("gaia-model")
            .to_string(),
        has_vision: args.mmproj.is_some(),
        backend: LlamaBackend::LlamacppUpstream,
    };
    let client = LlamaServerClient::new(&target).map_err(|error| error.to_string())?;
    let cancellation = CancellationToken::new();
    let model_profile = match client.fetch_props(&cancellation).await {
        Ok(props) => detect_model_profile(&props),
        Err(error) => {
            eprintln!("Model-profile probe failed; using plain profile: {error}");
            AgentModelProfile::Plain
        }
    };
    let skill_registry = load_skills(args.skills_dir.as_deref(), &run_dir)?;

    let progress = ProgressBar::new(tasks.len() as u64);
    progress.set_style(
        ProgressStyle::with_template(
            "{spinner:.green} [{elapsed_precise}] {bar:40.cyan/blue} {pos}/{len} {msg}",
        )
        .map_err(|error| error.to_string())?
        .progress_chars("=>-"),
    );
    let mut results = Vec::with_capacity(tasks.len());
    for task in tasks {
        progress.set_message(format!("Level {} · {}", task.level, task.task_id));
        let result = run_task(
            &task,
            &dataset,
            &run_dir,
            &client,
            model_profile,
            &skill_registry,
            args.max_steps,
            Duration::from_secs(args.task_timeout_secs),
        )
        .await;
        results.push(result);
        progress.inc(1);
    }
    progress.finish_with_message("GAIA evaluation complete");

    let report_path = args
        .output_dir
        .join(format!("gaia-report-{timestamp}.json"));
    let report = GaiaReport {
        dataset: "gaia-benchmark/GAIA:2023_all/validation".into(),
        model: target.model_id,
        generated_at_unix_ms: timestamp,
        summary: aggregate_results(&results, started.elapsed().as_millis()),
        tasks: results,
    };
    write_report(&report, &report_path)?;
    print_summary(&report, &report_path);
    drop(server);
    Ok(report_path)
}

async fn run_task(
    task: &GaiaTask,
    dataset: &GaiaDatasetClient,
    run_dir: &Path,
    client: &LlamaServerClient,
    model_profile: AgentModelProfile,
    skill_registry: &SkillRegistry,
    max_steps: u32,
    timeout: Duration,
) -> GaiaTaskResult {
    let started = Instant::now();
    let workspace = run_dir.join("tasks").join(safe_task_id(&task.task_id));
    let base = || GaiaTaskResult {
        task_id: task.task_id.clone(),
        level: task.level,
        question: task.question.clone(),
        prediction: None,
        normalized_prediction: None,
        gold_answer: task.gold_answer.clone(),
        correct: false,
        status: GaiaTaskStatus::Error,
        terminal_reason: None,
        step_count: 0,
        tool_trace: Vec::new(),
        duration_ms: started.elapsed().as_millis(),
        error: None,
    };
    if let Err(error) = std::fs::create_dir_all(&workspace) {
        return task_error(base(), format!("Failed to create task workspace: {error}"));
    }
    let attachment = match dataset.stage_attachment(task, &workspace).await {
        Ok(attachment) => attachment,
        Err(error) => return task_error(base(), error),
    };
    let editable_roots = match EditableRoots::new(&workspace, &[]).await {
        Ok(roots) => roots,
        Err(error) => return task_error(base(), error),
    };
    let approval = match WorkspaceApproval::new(&workspace) {
        Ok(approval) => approval,
        Err(error) => return task_error(base(), error),
    };
    let session_id = format!("gaia-{}", task.task_id);
    let run_id = format!("{session_id}-{}", uuid::Uuid::new_v4());
    let mut session = AgentSessionState::new(&session_id);
    let cancellation = CancellationToken::new();
    let capabilities = CapabilitiesSummary {
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        browser_channel: "none".into(),
        working_dir: workspace.display().to_string(),
        has_clipboard: false,
        has_wmctrl: false,
        has_notifications: false,
    };
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
    let stable_prefix = build_stable_prefix_for_profile(
        ITERATION_ONE_TOOLS,
        &skill_descriptors,
        &capabilities,
        DEFAULT_MAX_PARALLEL_TOOL_CALLS,
        None,
        model_profile,
    );
    let attachment_instruction = attachment
        .as_ref()
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .map(|name| format!("\nThe task attachment is available at the relative path `{name}`."))
        .unwrap_or_default();
    let question = format!(
        "{}{}\nReturn only the final answer required by the question, without explanation.",
        task.question, attachment_instruction
    );
    let mut capture = TaskCapture::default();
    let future = run_turn(
        RunTurnInput {
            run_id: &run_id,
            session_id: &session_id,
            user_message: &question,
            selected_skill: None,
            stable_prefix: &stable_prefix,
            model_profile,
            working_dir: &workspace,
            editable_roots: &editable_roots,
            external_read_only_roots: &[],
            trusted_read_roots: &[],
            max_steps,
            client,
            approval: &approval,
            folder_access: &DenyFolderAccess,
            desktop: &HeadlessDesktop,
            cancellation: &cancellation,
            session: &mut session,
            skill_registry,
            bundled_script_runtime: None,
        },
        |event| {
            capture.observe(event);
            Ok(())
        },
    );
    let run_result = tokio::time::timeout(timeout, future).await;
    let duration_ms = started.elapsed().as_millis();
    match run_result {
        Err(_) => {
            cancellation.cancel();
            let mut result = base();
            result.status = GaiaTaskStatus::Timeout;
            result.terminal_reason = Some("timeout".into());
            result.step_count = capture.step_count;
            result.tool_trace = capture.tool_trace;
            result.duration_ms = duration_ms;
            result.error = Some(format!("Task timed out after {timeout:?}"));
            result
        }
        Ok(Err(error)) => {
            let mut result = task_error(base(), error);
            result.terminal_reason = capture.terminal_reason;
            result.step_count = capture.step_count;
            result.tool_trace = capture.tool_trace;
            result.duration_ms = duration_ms;
            result
        }
        Ok(Ok(())) => {
            let Some(prediction) = capture.reply else {
                let mut result = task_error(base(), "Agent returned no final reply".into());
                result.terminal_reason = capture.terminal_reason;
                result.step_count = capture.step_count;
                result.tool_trace = capture.tool_trace;
                result.duration_ms = duration_ms;
                return result;
            };
            let correct = score_answer(&prediction, &task.gold_answer);
            let mut result = GaiaTaskResult::prediction(
                task.task_id.clone(),
                task.level,
                task.question.clone(),
                prediction,
                task.gold_answer.clone(),
                correct,
            );
            result.terminal_reason = capture.terminal_reason;
            result.step_count = capture.step_count;
            result.tool_trace = capture.tool_trace;
            result.duration_ms = duration_ms;
            result.error = capture.error;
            result
        }
    }
}

#[derive(Default)]
struct TaskCapture {
    reply: Option<String>,
    terminal_reason: Option<String>,
    step_count: u32,
    tool_trace: Vec<GaiaToolTrace>,
    error: Option<String>,
}

impl TaskCapture {
    fn observe(&mut self, event: AgentEvent) {
        match event {
            AgentEvent::StepStarted { step_index } => {
                self.step_count = self.step_count.max(step_index + 1);
            }
            AgentEvent::AssistantReply { text } => self.reply = Some(text),
            AgentEvent::ToolCallExecuted { result } => self.tool_trace.push(GaiaToolTrace {
                tool: result.call.tool,
                args: result.call.args,
                status: match result.outcome.status {
                    ToolStatus::Ok => "ok",
                    ToolStatus::Error => "error",
                    ToolStatus::Denied => "denied",
                    ToolStatus::Cancelled => "cancelled",
                }
                .into(),
                summary: result.outcome.summary,
                details: result.outcome.details,
            }),
            AgentEvent::StepError { message, category } => {
                self.error = Some(format!("{category}: {message}"));
            }
            AgentEvent::TurnFinished { reason, step_count } => {
                self.terminal_reason = Some(reason);
                self.step_count = step_count;
            }
            _ => {}
        }
    }
}

fn load_skills(skills_dir: Option<&Path>, run_dir: &Path) -> Result<SkillRegistry, String> {
    let root = skills_dir
        .map(Path::to_path_buf)
        .unwrap_or_else(|| run_dir.join("skills"));
    SkillRegistry::load(root, &BTreeSet::new(), &available_tool_names())
}

fn task_error(mut result: GaiaTaskResult, error: String) -> GaiaTaskResult {
    result.error = Some(error);
    result
}

fn validate_args(args: &GaiaEvalArgs) -> Result<(), String> {
    if !args.llama_server.is_file() {
        return Err(format!(
            "GAIA_LLAMA_SERVER is not a file: {}",
            args.llama_server.display()
        ));
    }
    if !args.model.is_file() {
        return Err(format!(
            "GAIA_MODEL is not a file: {}",
            args.model.display()
        ));
    }
    if args.level.is_some_and(|level| !(1..=3).contains(&level)) {
        return Err("GAIA_LEVEL must be 1, 2, or 3".into());
    }
    if args.limit == Some(0) {
        return Err("GAIA_LIMIT must be greater than zero".into());
    }
    Ok(())
}

fn print_summary(report: &GaiaReport, path: &Path) {
    println!("\nGAIA validation results");
    println!(
        "Overall: {:.2}% ({}/{})",
        report.summary.accuracy * 100.0,
        report.summary.correct,
        report.summary.total
    );
    for level in 1..=3 {
        let summary = report
            .summary
            .by_level
            .get(&level)
            .cloned()
            .unwrap_or_default();
        println!(
            "Level {level}: {:.2}% ({}/{})",
            summary.accuracy * 100.0,
            summary.correct,
            summary.total
        );
    }
    println!(
        "correct={} incorrect={} error={} timeout={}",
        report.summary.correct,
        report.summary.incorrect,
        report.summary.error,
        report.summary.timeout
    );
    println!("elapsed={:.1}s", report.summary.elapsed_ms as f64 / 1000.0);
    println!("report={}", path.display());
}

fn safe_task_id(task_id: &str) -> String {
    task_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::types::{ToolCallPayload, ToolExecution, ToolOutcome};

    #[test]
    fn task_capture_records_reply_tools_errors_and_terminal_state() {
        let mut capture = TaskCapture::default();
        capture.observe(AgentEvent::StepStarted { step_index: 1 });
        capture.observe(AgentEvent::ToolCallExecuted {
            result: ToolExecution {
                call: ToolCallPayload {
                    tool: "os.fs.read".into(),
                    args: serde_json::json!({ "path": "input.txt" }),
                },
                outcome: ToolOutcome {
                    status: ToolStatus::Ok,
                    summary: "read input.txt".into(),
                    details: Some(serde_json::json!({ "bytes": 10 })),
                },
                batch_index: 0,
                batch_size: 1,
            },
        });
        capture.observe(AgentEvent::AssistantReply { text: "42".into() });
        capture.observe(AgentEvent::StepError {
            message: "repair attempted".into(),
            category: "grammar".into(),
        });
        capture.observe(AgentEvent::TurnFinished {
            reason: "reply".into(),
            step_count: 2,
        });

        assert_eq!(capture.reply.as_deref(), Some("42"));
        assert_eq!(capture.tool_trace.len(), 1);
        assert_eq!(capture.tool_trace[0].tool, "os.fs.read");
        assert_eq!(
            capture.tool_trace[0].args,
            serde_json::json!({ "path": "input.txt" })
        );
        assert_eq!(
            capture.tool_trace[0].details,
            Some(serde_json::json!({ "bytes": 10 }))
        );
        assert_eq!(capture.error.as_deref(), Some("grammar: repair attempted"));
        assert_eq!(capture.terminal_reason.as_deref(), Some("reply"));
        assert_eq!(capture.step_count, 2);
    }
}
