mod answer;
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
use self::scoring::score_answer;
use self::report::{
    aggregate_results, write_report, GaiaReport, GaiaSampleResult, GaiaTaskResult, GaiaTaskStatus,
    GaiaToolTrace,
};
use self::server::{DedicatedLlamaServer, LlamaServerConfig};
use super::llm_client::{AgentLlmClient, LlamaBackend, LlamaServerClient, LlamaSessionTarget, SamplingOverrides};
use super::model_profile::{detect_model_profile, AgentModelProfile};
use super::path_policy::EditableRoots;
use super::prompt::{
    build_stable_prefix_for_profile, CapabilitiesSummary, SkillDescriptor,
    DEFAULT_MAX_PARALLEL_TOOL_CALLS, ITERATION_ONE_TOOLS,
};
use super::runner::{run_turn, RunTurnInput};
use super::session::AgentSessionState;
use super::skills::{available_tool_names, SkillRegistry};
use super::types::{AgentEvent, AgentReasoning, ToolStatus};

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
    /// Pre-extract entities/constraints/format hints into the task prompt.
    #[arg(long, env = "GAIA_PLAN_HINTS", default_value_t = true, action = clap::ArgAction::Set)]
    plan_hints: bool,
    /// Independent samples per task, combined by normalized majority vote.
    #[arg(long, env = "GAIA_SAMPLES", default_value_t = 1)]
    samples: usize,
    /// Thinking effort for the agent loop: unset|off|low|medium|high|xhigh.
    #[arg(long, env = "GAIA_REASONING", default_value = "unset")]
    reasoning: String,
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
    let skills_root = args
        .skills_dir
        .clone()
        .unwrap_or_else(|| run_dir.join("skills"));
    let skill_registry = load_skills(&skills_root)?;
    let skills_root = skills_root.is_dir().then_some(skills_root);

    let progress = ProgressBar::new(tasks.len() as u64);
    progress.set_style(
        ProgressStyle::with_template(
            "{spinner:.green} [{elapsed_precise}] {bar:40.cyan/blue} {pos}/{len} {msg}",
        )
        .map_err(|error| error.to_string())?
        .progress_chars("=>-"),
    );
    let reasoning = parse_reasoning(&args.reasoning)?;
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
            skills_root.as_deref(),
            args.max_steps,
            Duration::from_secs(args.task_timeout_secs),
            args.plan_hints,
            args.samples,
            reasoning.clone(),
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

#[allow(clippy::too_many_arguments)]
async fn run_task(
    task: &GaiaTask,
    dataset: &GaiaDatasetClient,
    run_dir: &Path,
    client: &dyn AgentLlmClient,
    model_profile: AgentModelProfile,
    skill_registry: &SkillRegistry,
    skills_root: Option<&Path>,
    max_steps: u32,
    timeout: Duration,
    plan_hints_enabled: bool,
    samples: usize,
    reasoning: AgentReasoning,
) -> GaiaTaskResult {
    if samples <= 1 {
        return run_task_sample(
            task,
            dataset,
            run_dir,
            client,
            model_profile,
            skill_registry,
            skills_root,
            max_steps,
            timeout,
            plan_hints_enabled,
            0,
            reasoning,
        )
        .await;
    }
    let mut sample_results = Vec::with_capacity(samples);
    for sample_index in 0..samples {
        sample_results.push(
            run_task_sample(
                task,
                dataset,
                run_dir,
                client,
                model_profile,
                skill_registry,
                skills_root,
                max_steps,
                timeout,
                plan_hints_enabled,
                sample_index,
                reasoning.clone(),
            )
            .await,
        );
    }
    vote_on_samples(sample_results)
}

/// Canonical vote key, mirroring the scorer's branch selection so co-voting
/// answers are exactly those the scorer would grade identically. A comma is
/// the LIST branch (never a thousands separator): normalize each element the
/// way the scorer does; a plain-parseable answer is a NUMBER; otherwise a
/// whitespace/punctuation-normalized string.
fn vote_key(prediction: &str) -> String {
    let trimmed = prediction.trim();
    if trimmed.contains(',') || trimmed.contains(';') {
        let elements = trimmed
            .split([',', ';'])
            .map(scoring::normalize_element)
            .collect::<Vec<_>>()
            .join("|");
        return format!("list:{elements}");
    }
    if let Some(number) = scoring::normalize_number(trimmed) {
        return format!("num:{number}");
    }
    format!("str:{}", scoring::normalize_answer(trimmed))
}

/// Majority vote over per-sample predictions (ties break to the earliest
/// sample). The winning sample's full result becomes the task result, with
/// every sample summarized alongside for variance reporting.
fn vote_on_samples(sample_results: Vec<GaiaTaskResult>) -> GaiaTaskResult {
    let vote_size = sample_results.len();
    let mut tallies: Vec<(String, usize, usize)> = Vec::new(); // key, count, first index
    for (index, sample) in sample_results.iter().enumerate() {
        let Some(prediction) = sample.prediction.as_deref() else {
            continue;
        };
        let key = vote_key(prediction);
        match tallies.iter_mut().find(|(existing, _, _)| *existing == key) {
            Some((_, count, _)) => *count += 1,
            None => tallies.push((key, 1, index)),
        }
    }
    let winner_index = tallies
        .iter()
        .max_by(|a, b| a.1.cmp(&b.1).then(b.2.cmp(&a.2)))
        .map(|(_, _, index)| *index)
        .unwrap_or(0);
    let total_duration: u128 = sample_results.iter().map(|sample| sample.duration_ms).sum();
    let samples_summary = sample_results
        .iter()
        .enumerate()
        .map(|(index, sample)| GaiaSampleResult {
            sample_index: index,
            prediction: sample.prediction.clone(),
            normalized_prediction: sample.normalized_prediction.clone(),
            correct: sample.correct,
            status: sample.status.clone(),
            terminal_reason: sample.terminal_reason.clone(),
            step_count: sample.step_count,
            duration_ms: sample.duration_ms,
            error: sample.error.clone(),
        })
        .collect();
    let mut result = sample_results
        .into_iter()
        .nth(winner_index)
        .expect("winner index within sample results");
    result.samples = samples_summary;
    result.vote_size = Some(vote_size);
    result.duration_ms = total_duration;
    result
}

fn parse_reasoning(value: &str) -> Result<AgentReasoning, String> {
    let budget = |tokens: u32| AgentReasoning::On {
        budget_tokens: Some(tokens),
        effort_value: None,
    };
    Ok(match value {
        "unset" => AgentReasoning::Unset,
        "off" => AgentReasoning::Off,
        "low" => budget(256),
        "medium" => budget(1_024),
        "high" => budget(4_096),
        "xhigh" => budget(8_192),
        other => {
            return Err(format!(
                "GAIA_REASONING must be unset|off|low|medium|high|xhigh, got '{other}'"
            ))
        }
    })
}

#[allow(clippy::too_many_arguments)]
async fn run_task_sample(
    task: &GaiaTask,
    dataset: &GaiaDatasetClient,
    run_dir: &Path,
    client: &dyn AgentLlmClient,
    model_profile: AgentModelProfile,
    skill_registry: &SkillRegistry,
    skills_root: Option<&Path>,
    max_steps: u32,
    timeout: Duration,
    plan_hints_enabled: bool,
    sample_index: usize,
    reasoning: AgentReasoning,
) -> GaiaTaskResult {
    let started = Instant::now();
    let workspace = run_dir
        .join("tasks")
        .join(safe_task_id(&task.task_id))
        .join(format!("sample-{sample_index}"));
    let base = || GaiaTaskResult {
        task_id: task.task_id.clone(),
        level: task.level,
        question: task.question.clone(),
        prediction: None,
        normalized_prediction: None,
        gold_answer: task.gold_answer.clone(),
        score_branch: None,
        normalized_gold: None,
        raw_prediction: None,
        raw_prediction_correct: None,
        samples: Vec::new(),
        vote_size: None,
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
    let approval = match WorkspaceApproval::new(&workspace, skills_root) {
        Ok(approval) => approval,
        Err(error) => return task_error(base(), error),
    };
    let session_id = format!("gaia-{}-s{sample_index}", task.task_id);
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
    let gaia_persona = answer::gaia_persona();
    let stable_prefix = build_stable_prefix_for_profile(
        ITERATION_ONE_TOOLS,
        &skill_descriptors,
        &capabilities,
        DEFAULT_MAX_PARALLEL_TOOL_CALLS,
        Some(&gaia_persona),
        model_profile,
        false,
    );
    let attachment_instruction = attachment
        .as_ref()
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .map(|name| format!("\nThe task attachment is available at the relative path `{name}`."))
        .unwrap_or_default();
    let mut question = format!(
        "{}{}\nReturn only the final answer required by the question, without explanation.",
        task.question, attachment_instruction
    );
    if plan_hints_enabled {
        if let Some(hints) = answer::plan_hints(client, &task.question, &cancellation).await {
            question.push_str(&format!(
                "\n\nAnalysis hints (verify against sources; the output-format constraints are binding):\n{hints}"
            ));
        }
    }
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
            reasoning,
            sampling: &SamplingOverrides::default(),
            mcp: None,
            disabled_tools: &std::collections::BTreeSet::new(),
            auto_approve_mcp: true,
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
    // Reserve part of the task budget so a timed-out run can still be forced
    // into a scored best guess instead of an unanswered Timeout.
    let reserve = (timeout / 4).min(Duration::from_secs(60)).max(Duration::from_secs(1));
    let inner_timeout = timeout.saturating_sub(reserve);
    let run_result = tokio::time::timeout(inner_timeout, future).await;
    let duration_ms = started.elapsed().as_millis();

    // Fill a scored result from the capture; used by every terminal path.
    let scored = |prediction: String, capture: &TaskCapture, duration_ms: u128| {
        let mut result = GaiaTaskResult::prediction(
            task.task_id.clone(),
            task.level,
            task.question.clone(),
            prediction,
            task.gold_answer.clone(),
        );
        result.raw_prediction_correct = capture
            .reply
            .as_deref()
            .map(|raw| score_answer(raw, &task.gold_answer));
        result.raw_prediction = capture.reply.clone();
        result.terminal_reason = capture.terminal_reason.clone();
        result.step_count = capture.step_count;
        result.tool_trace = capture.tool_trace.clone();
        result.duration_ms = duration_ms;
        result.error = capture.error.clone();
        result
    };

    match run_result {
        Err(_) => {
            cancellation.cancel();
            // The run's token is cancelled; the forced guess gets a fresh one.
            let fresh = CancellationToken::new();
            let forced = tokio::time::timeout(
                reserve,
                answer::reformulate(
                    client,
                    &question,
                    &capture.tool_trace,
                    capture.reply.as_deref(),
                    &fresh,
                ),
            )
            .await;
            match forced {
                Ok(Ok(prediction)) => {
                    let mut result = scored(prediction, &capture, started.elapsed().as_millis());
                    result.terminal_reason = Some("timeout".into());
                    result.error = Some(format!(
                        "Task timed out after {inner_timeout:?}; answer forced from the partial trace"
                    ));
                    result
                }
                _ => {
                    let mut result = base();
                    result.status = GaiaTaskStatus::Timeout;
                    result.terminal_reason = Some("timeout".into());
                    result.step_count = capture.step_count;
                    result.tool_trace = capture.tool_trace;
                    result.duration_ms = duration_ms;
                    result.error = Some(format!("Task timed out after {inner_timeout:?}"));
                    result
                }
            }
        }
        Ok(Err(error)) => {
            if capture.tool_trace.is_empty() && capture.reply.is_none() {
                let mut result = task_error(base(), error);
                result.terminal_reason = capture.terminal_reason;
                result.step_count = capture.step_count;
                result.tool_trace = capture.tool_trace;
                result.duration_ms = duration_ms;
                return result;
            }
            // Evidence exists: force a best guess rather than submitting nothing.
            match answer::reformulate(
                client,
                &question,
                &capture.tool_trace,
                capture.reply.as_deref(),
                &cancellation,
            )
            .await
            {
                Ok(prediction) => {
                    let mut result = scored(prediction, &capture, started.elapsed().as_millis());
                    result.error = Some(format!("{error}; answer forced from the partial trace"));
                    result
                }
                Err(_) => {
                    let mut result = task_error(base(), error);
                    result.terminal_reason = capture.terminal_reason;
                    result.step_count = capture.step_count;
                    result.tool_trace = capture.tool_trace;
                    result.duration_ms = duration_ms;
                    result
                }
            }
        }
        Ok(Ok(())) => {
            // A max_steps apology is a guaranteed-wrong draft; withhold it so
            // the reformulator answers purely from the trace.
            let draft = capture
                .reply
                .as_deref()
                .filter(|_| capture.terminal_reason.as_deref() != Some("max_steps"));
            let prediction = match answer::reformulate(
                client,
                &question,
                &capture.tool_trace,
                draft,
                &cancellation,
            )
            .await
            {
                Ok(prediction) => Some(prediction),
                Err(_) => draft.map(answer::postprocess),
            };
            let Some(prediction) = prediction else {
                let mut result =
                    task_error(base(), "Agent returned no scoreable final reply".into());
                result.terminal_reason = capture.terminal_reason;
                result.step_count = capture.step_count;
                result.tool_trace = capture.tool_trace;
                result.duration_ms = duration_ms;
                return result;
            };
            scored(prediction, &capture, started.elapsed().as_millis())
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
            AgentEvent::TurnFinished { reason, step_count, .. } => {
                self.terminal_reason = Some(reason);
                self.step_count = step_count;
            }
            _ => {}
        }
    }
}

fn load_skills(skills_root: &Path) -> Result<SkillRegistry, String> {
    SkillRegistry::load(
        skills_root.to_path_buf(),
        &BTreeSet::new(),
        &available_tool_names(),
    )
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
    if args.samples == 0 {
        return Err("GAIA_SAMPLES must be greater than zero".into());
    }
    parse_reasoning(&args.reasoning)?;
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

    fn sample(prediction: Option<&str>, gold: &str) -> GaiaTaskResult {
        match prediction {
            Some(prediction) => GaiaTaskResult::prediction(
                "task".into(),
                1,
                "Q".into(),
                prediction.into(),
                gold.into(),
            ),
            None => {
                let mut result =
                    GaiaTaskResult::prediction("task".into(), 1, "Q".into(), String::new(), gold.into());
                result.prediction = None;
                result
            }
        }
    }

    #[test]
    fn vote_keys_collapse_number_formats_and_normalize_strings() {
        // Comma-free number formats collapse.
        assert_eq!(vote_key("89706"), vote_key("89706.00"));
        assert_eq!(vote_key("$89706"), vote_key("89706"));
        assert_eq!(vote_key("Saint Petersburg"), vote_key("saint petersburg"));
        assert_ne!(vote_key("42"), vote_key("41"));
        assert_ne!(vote_key("Paris"), vote_key("London"));
        // A comma is the list branch, matching the scorer: `1,2` (two-element
        // list) must NOT co-vote with `12` (number).
        assert_ne!(vote_key("1,2"), vote_key("12"));
        assert_eq!(vote_key("green, white"), vote_key("green,white"));
        assert_ne!(vote_key("green, white"), vote_key("white, green"));
    }

    #[test]
    fn majority_vote_picks_the_most_common_normalized_answer() {
        let voted = vote_on_samples(vec![
            sample(Some("42"), "42"),
            sample(Some("41"), "42"),
            sample(Some("42.0"), "42"),
        ]);
        assert_eq!(voted.prediction.as_deref(), Some("42"));
        assert!(voted.correct);
        assert_eq!(voted.vote_size, Some(3));
        assert_eq!(voted.samples.len(), 3);
        assert_eq!(voted.samples[1].prediction.as_deref(), Some("41"));
    }

    #[test]
    fn vote_ties_break_to_the_earliest_sample_and_skip_missing_predictions() {
        let voted = vote_on_samples(vec![
            sample(None, "x"),
            sample(Some("B"), "x"),
            sample(Some("C"), "x"),
        ]);
        assert_eq!(voted.prediction.as_deref(), Some("B"));

        let all_missing = vote_on_samples(vec![sample(None, "x"), sample(None, "x")]);
        assert!(all_missing.prediction.is_none());
        assert_eq!(all_missing.vote_size, Some(2));
    }

    #[test]
    fn reasoning_levels_parse_to_budgets() {
        assert_eq!(parse_reasoning("unset").unwrap(), AgentReasoning::Unset);
        assert_eq!(parse_reasoning("off").unwrap(), AgentReasoning::Off);
        assert_eq!(
            parse_reasoning("medium").unwrap(),
            AgentReasoning::On {
                budget_tokens: Some(1_024),
                effort_value: None
            }
        );
        assert!(parse_reasoning("extreme").is_err());
    }

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
            usage: None,
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
