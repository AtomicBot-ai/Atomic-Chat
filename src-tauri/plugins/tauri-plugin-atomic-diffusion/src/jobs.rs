//! Image jobs: validate, submit to `sd-server`, poll, save, and the cancel
//! path. Shared by the `generate` command and the OpenAI facade on the API
//! server, so both get the same validation, events, gallery and idle timer.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Serialize;
use tokio::sync::mpsc::{self, UnboundedReceiver};

use crate::args::{build_img_gen_request, cpu_backend_extra_args, is_ggml_unsupported_op_abort};
use crate::error::{DiffusionError, DiffusionErrorCode, DiffusionResult};
use crate::events::{
    emit, emit_error, DiffusionEmitter, JobPayload, ProgressPayload, SharedEmitter, EVENT_JOB,
    EVENT_PROGRESS,
};
use crate::gallery;
use crate::process;
use crate::progress::{classify_exit, diagnostic_tail, parse_step_line};
use crate::session;
use crate::state::{
    now_ms, tail_lines, DiffusionState, GalleryImageItem, ImageGenerateRequest, ImageJob,
    ImageJobPhase, ImageJobProgress, ImageJobState, ImageRecipe, ImageWorkflow, JobRecord,
    RecipeEngine, RecipeModel, ServerSpec, MAX_BATCH,
};

pub const IMG_GEN_PATH: &str = "/sdcpp/v1/img_gen";
pub const JOBS_PATH: &str = "/sdcpp/v1/jobs";
const POLL_INTERVAL: Duration = Duration::from_millis(400);
const SUBMIT_TIMEOUT: Duration = Duration::from_secs(60);
const STATUS_TIMEOUT: Duration = Duration::from_secs(10);
/// The native engine exists for slow CPU hosts; this only stops a wedged
/// process from holding the slot forever.
pub const GENERATION_CEILING: Duration = Duration::from_secs(6 * 60 * 60);
/// How long a native cancel gets to show in the job status before the
/// server is stopped instead.
pub const CANCEL_GRACE: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub struct JobOutcome {
    pub job: ImageJob,
    /// The final PNG bytes (recipe included), in batch order.
    pub images: Vec<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CancelResult {
    pub cancelled: bool,
    pub server_stopped: bool,
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

pub fn validate_request(request: &ImageGenerateRequest, spec: &ServerSpec) -> DiffusionResult<()> {
    if request.prompt.trim().is_empty() {
        return Err(DiffusionError::new(
            DiffusionErrorCode::InvalidRequest,
            "Enter a prompt.",
        ));
    }
    let (min_dim, max_dim) = spec.ranges.dims;
    let multiple = spec.ranges.dim_multiple.max(1);
    for (label, value) in [("width", request.width), ("height", request.height)] {
        if value < min_dim || value > max_dim {
            return Err(DiffusionError::with_details(
                DiffusionErrorCode::InvalidDimensions,
                format!("{label} must be between {min_dim} and {max_dim}."),
                format!("{label}={value}"),
            ));
        }
        if value % multiple != 0 {
            return Err(DiffusionError::with_details(
                DiffusionErrorCode::InvalidDimensions,
                format!("{label} must be a multiple of {multiple}."),
                format!("{label}={value}"),
            ));
        }
    }
    let (min_steps, max_steps) = spec.ranges.steps;
    if request.steps < min_steps || request.steps > max_steps {
        return Err(DiffusionError::with_details(
            DiffusionErrorCode::InvalidRequest,
            format!("Steps must be between {min_steps} and {max_steps}."),
            format!("steps={}", request.steps),
        ));
    }
    if request.batch_size < 1 || request.batch_size > MAX_BATCH {
        return Err(DiffusionError::with_details(
            DiffusionErrorCode::InvalidRequest,
            format!("Batch size must be between 1 and {MAX_BATCH}."),
            format!("batchSize={}", request.batch_size),
        ));
    }
    if !request.cfg_scale.is_finite() || request.cfg_scale < 0.0 {
        return Err(DiffusionError::new(
            DiffusionErrorCode::InvalidRequest,
            "CFG scale must be a non-negative number.",
        ));
    }
    if let Some(strength) = request.strength {
        if !(0.0..=1.0).contains(&strength) {
            return Err(DiffusionError::new(
                DiffusionErrorCode::InvalidRequest,
                "Strength must be between 0 and 1.",
            ));
        }
    }
    if request.workflow() == ImageWorkflow::Transform {
        if !session::workflows_for_family(&spec.family).contains(&ImageWorkflow::Transform) {
            return Err(DiffusionError::with_details(
                DiffusionErrorCode::UnsupportedWorkflow,
                "This model cannot transform images.",
                spec.family.clone(),
            ));
        }
        let exists = request
            .init_image_path
            .as_deref()
            .map(|p| std::path::Path::new(p).is_file())
            .unwrap_or(false);
        if !exists {
            return Err(DiffusionError::new(
                DiffusionErrorCode::InvalidRequest,
                "Transform needs a source image.",
            ));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

struct ProgressTracker {
    steps: u32,
    batch: u32,
    batch_index: u32,
    step: u32,
    phase: ImageJobPhase,
    started: Instant,
    first_step_at: Option<Instant>,
    first_step_done: u32,
    dirty: bool,
}

impl ProgressTracker {
    fn new(steps: u32, batch: u32) -> Self {
        Self {
            steps: steps.max(1),
            batch: batch.max(1),
            batch_index: 0,
            step: 0,
            phase: ImageJobPhase::Queued,
            started: Instant::now(),
            first_step_at: None,
            first_step_done: 0,
            dirty: true,
        }
    }

    fn set_phase(&mut self, phase: ImageJobPhase) {
        if self.phase != phase {
            self.phase = phase;
            self.dirty = true;
        }
    }

    /// Feed one stdout line. Only a denominator equal to the requested step
    /// count is trusted, so a loader's `1/100` cannot move the bar.
    fn on_line(&mut self, line: &str) {
        let Some((step, total)) = parse_step_line(line) else {
            return;
        };
        if total != self.steps || step == 0 || step > total {
            return;
        }
        if step < self.step && self.batch_index + 1 < self.batch {
            self.batch_index += 1;
        } else if step < self.step {
            // A wrap past the last image: a later phase reusing the count.
            return;
        }
        if step == self.step && self.phase == ImageJobPhase::Sampling {
            return;
        }
        self.step = step;
        self.phase = ImageJobPhase::Sampling;
        if self.first_step_at.is_none() {
            self.first_step_at = Some(Instant::now());
            self.first_step_done = self.done();
        }
        if self.step == self.steps && self.batch_index + 1 == self.batch {
            self.phase = ImageJobPhase::Decoding;
        }
        self.dirty = true;
    }

    fn done(&self) -> u32 {
        self.batch_index * self.steps + self.step
    }

    fn snapshot(&self) -> ImageJobProgress {
        let total = self.batch * self.steps;
        let done = self.done();
        let fraction = match self.phase {
            ImageJobPhase::Queued => 0.0,
            ImageJobPhase::Encoding => 0.02,
            ImageJobPhase::Sampling => (done as f64 / total as f64).clamp(0.0, 0.97),
            ImageJobPhase::Decoding => 0.98,
            ImageJobPhase::Saving => 0.99,
        };
        let eta_seconds = match (self.first_step_at, self.phase) {
            (Some(first), ImageJobPhase::Sampling) if done > self.first_step_done => {
                let measured = done - self.first_step_done;
                let per_step = first.elapsed().as_secs_f64() / measured as f64;
                Some(per_step * total.saturating_sub(done) as f64)
            }
            _ => None,
        };
        ImageJobProgress {
            phase: self.phase,
            step: self.step,
            total_steps: self.steps,
            fraction,
            eta_seconds,
            batch_index: self.batch_index,
            batch_size: self.batch,
            elapsed_ms: self.started.elapsed().as_millis() as u64,
        }
    }

    fn take_dirty(&mut self) -> bool {
        std::mem::replace(&mut self.dirty, false)
    }
}

// ---------------------------------------------------------------------------
// Job bookkeeping
// ---------------------------------------------------------------------------

fn emit_job(state: &DiffusionState, emitter: &dyn DiffusionEmitter, id: &str) {
    if let Some(job) = state.job(id) {
        emit(emitter, EVENT_JOB, JobPayload { job });
    }
}

fn set_job_state(
    state: &DiffusionState,
    emitter: &dyn DiffusionEmitter,
    id: &str,
    new_state: ImageJobState,
) {
    let mut changed = false;
    state.update_job(id, |record| {
        if record.job.state != new_state && !record.job.state.is_terminal() {
            record.job.state = new_state;
            if new_state == ImageJobState::Generating && record.job.started_at_ms.is_none() {
                record.job.started_at_ms = Some(now_ms());
            }
            changed = true;
        }
    });
    if changed {
        emit_job(state, emitter, id);
    }
}

fn set_progress(
    state: &DiffusionState,
    emitter: &dyn DiffusionEmitter,
    id: &str,
    progress: ImageJobProgress,
) {
    state.update_job(id, |record| record.job.progress = Some(progress.clone()));
    emit(
        emitter,
        EVENT_PROGRESS,
        ProgressPayload {
            job_id: id.to_string(),
            progress,
        },
    );
}

/// Move a job to a terminal state exactly once. Returns whether this call
/// made the transition.
pub(crate) fn finish_job(
    state: &DiffusionState,
    emitter: &dyn DiffusionEmitter,
    id: &str,
    result: Result<Vec<GalleryImageItem>, DiffusionError>,
) -> bool {
    let mut transitioned = false;
    state.update_job(id, |record| {
        if record.job.state.is_terminal() {
            return;
        }
        transitioned = true;
        record.job.finished_at_ms = Some(now_ms());
        match result {
            Ok(outputs) => {
                record.job.state = ImageJobState::Completed;
                record.job.outputs = outputs;
                record.job.error = None;
            }
            Err(err) => {
                record.job.state = if err.code == DiffusionErrorCode::Cancelled {
                    ImageJobState::Cancelled
                } else {
                    ImageJobState::Failed
                };
                record.job.error = Some(err);
            }
        }
    });
    if transitioned {
        if let Ok(mut active) = state.active_job.lock() {
            if active.as_deref() == Some(id) {
                *active = None;
            }
        }
        emit_job(state, emitter, id);
    }
    transitioned
}

fn cancelled() -> DiffusionError {
    DiffusionError::new(DiffusionErrorCode::Cancelled, "Generation was cancelled.")
}

fn draw_seed() -> i64 {
    rand::random::<u32>() as i64
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/// Validate, register and start a job. Returns the id and the runner handle.
pub fn start_image_job(
    state: DiffusionState,
    emitter: SharedEmitter,
    request: ImageGenerateRequest,
) -> DiffusionResult<(String, tokio::task::JoinHandle<DiffusionResult<JobOutcome>>)> {
    let spec = state.spec().ok_or_else(|| {
        DiffusionError::new(
            DiffusionErrorCode::ModelNotLoaded,
            "Load an image model first.",
        )
    })?;
    validate_request(&request, &spec)?;

    let id = uuid::Uuid::new_v4().simple().to_string();
    {
        let mut active = state
            .active_job
            .lock()
            .map_err(|_| DiffusionError::internal("Job state is poisoned."))?;
        if let Some(current) = active.as_ref() {
            return Err(DiffusionError::with_details(
                DiffusionErrorCode::JobBusy,
                "An image is already being generated.",
                current.clone(),
            ));
        }
        *active = Some(id.clone());
    }
    state.clear_idle();

    let job = ImageJob {
        id: id.clone(),
        state: ImageJobState::Queued,
        model_id: spec.model_id.clone(),
        request: request.clone(),
        created_at_ms: now_ms(),
        started_at_ms: None,
        finished_at_ms: None,
        progress: None,
        outputs: Vec::new(),
        error: None,
    };
    state.insert_job(JobRecord {
        job,
        cancel_requested: Arc::new(AtomicBool::new(false)),
        server_job_id: None,
    });
    emit_job(&state, emitter.as_ref(), &id);

    let runner_id = id.clone();
    let handle = tokio::spawn(async move {
        let result = execute(&state, emitter.as_ref(), &runner_id, request).await;
        let finished = match &result {
            Ok(outcome) => Ok(outcome.job.outputs.clone()),
            Err(err) => Err(err.clone()),
        };
        finish_job(&state, emitter.as_ref(), &runner_id, finished);
        if let Ok(mut active) = state.active_job.lock() {
            if active.as_deref() == Some(runner_id.as_str()) {
                *active = None;
            }
        }
        state.touch_idle();
        match result {
            Ok(mut outcome) => {
                if let Some(job) = state.job(&runner_id) {
                    outcome.job = job;
                }
                Ok(outcome)
            }
            Err(err) => {
                if err.code != DiffusionErrorCode::Cancelled {
                    emit_error(emitter.as_ref(), Some(&runner_id), &err);
                }
                // The record is authoritative: a cancel that raced the runner
                // may already have marked it.
                let recorded = state
                    .job(&runner_id)
                    .and_then(|job| job.error)
                    .unwrap_or(err);
                Err(recorded)
            }
        }
    });
    Ok((id, handle))
}

/// Run one job to completion. Used by the OpenAI facade.
pub async fn run_image_job(
    state: DiffusionState,
    emitter: SharedEmitter,
    request: ImageGenerateRequest,
) -> DiffusionResult<JobOutcome> {
    let (_, handle) = start_image_job(state, emitter, request)?;
    handle.await.map_err(|e| {
        DiffusionError::with_details(
            DiffusionErrorCode::Internal,
            "The job task panicked.",
            e.to_string(),
        )
    })?
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

struct SessionView {
    base_url: String,
    client: reqwest::Client,
    spec: ServerSpec,
    tag: String,
}

/// The resident session, respawned from `spec` when a cancel or crash took
/// the server down.
async fn ensure_session(
    state: &DiffusionState,
    emitter: &dyn DiffusionEmitter,
    cancel: &AtomicBool,
) -> DiffusionResult<SessionView> {
    {
        let mut guard = state.session.lock().await;
        if let Some(session) = guard.as_mut() {
            if session.is_alive() {
                return Ok(SessionView {
                    base_url: session.base_url(),
                    client: session.client.clone(),
                    spec: session.spec.clone(),
                    tag: session.spec.tag.clone(),
                });
            }
        }
    }
    if cancel.load(Ordering::SeqCst) {
        return Err(cancelled());
    }
    let spec = state.spec().ok_or_else(|| {
        DiffusionError::new(
            DiffusionErrorCode::ModelNotLoaded,
            "Load an image model first.",
        )
    })?;
    let _load = state.load_lock.lock().await;
    session::take_down_session(state).await;
    session::load_from_spec(state, emitter, spec, "respawn").await?;
    let guard = state.session.lock().await;
    let session = guard.as_ref().ok_or_else(|| {
        DiffusionError::new(
            DiffusionErrorCode::EngineCrashed,
            "sd-server went away right after starting.",
        )
    })?;
    Ok(SessionView {
        base_url: session.base_url(),
        client: session.client.clone(),
        spec: session.spec.clone(),
        tag: session.spec.tag.clone(),
    })
}

async fn attach_step_listener(state: &DiffusionState) -> UnboundedReceiver<String> {
    let (tx, rx) = mpsc::unbounded_channel();
    if let Some(session) = state.session.lock().await.as_ref() {
        session.set_step_listener(Some(tx));
    }
    rx
}

async fn detach_step_listener(state: &DiffusionState) {
    if let Some(session) = state.session.lock().await.as_ref() {
        session.set_step_listener(None);
    }
}

enum Liveness {
    Alive,
    Gone,
    Exited(std::process::ExitStatus, Vec<String>),
}

async fn liveness(state: &DiffusionState) -> Liveness {
    let mut guard = state.session.lock().await;
    match guard.as_mut() {
        None => Liveness::Gone,
        Some(session) => match session.exit_status() {
            None => Liveness::Alive,
            Some(status) => Liveness::Exited(status, tail_lines(&session.tail)),
        },
    }
}

enum Attempt {
    Done(Box<JobOutcome>),
    RetryOnCpu,
}

async fn execute(
    state: &DiffusionState,
    emitter: &dyn DiffusionEmitter,
    id: &str,
    request: ImageGenerateRequest,
) -> DiffusionResult<JobOutcome> {
    let cancel = state
        .jobs
        .lock()
        .ok()
        .and_then(|jobs| jobs.get(id).map(|r| r.cancel_requested.clone()))
        .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));

    let batch_seed = request.seed.filter(|s| *s >= 0).unwrap_or_else(draw_seed);
    let init_image_b64 = match (request.workflow(), request.init_image_path.as_deref()) {
        (ImageWorkflow::Transform, Some(path)) => {
            let bytes = std::fs::read(path).map_err(|e| {
                DiffusionError::with_details(
                    DiffusionErrorCode::InvalidRequest,
                    "The source image could not be read.",
                    e.to_string(),
                )
            })?;
            Some(base64::engine::general_purpose::STANDARD.encode(bytes))
        }
        _ => None,
    };

    let started = Instant::now();
    let mut attempts = 0u8;
    loop {
        attempts += 1;
        let view = ensure_session(state, emitter, &cancel).await?;
        let body = build_img_gen_request(
            &request,
            &view.spec.defaults,
            batch_seed,
            init_image_b64.as_deref(),
        );
        let outcome = run_attempt(
            state, emitter, id, &request, &view, body, batch_seed, &cancel, started,
        )
        .await;
        match outcome {
            Ok(Attempt::Done(outcome)) => return Ok(*outcome),
            Ok(Attempt::RetryOnCpu) if attempts == 1 => {
                log::warn!("[atomic-diffusion] ggml abort on the device backend; restarting sd-server on the CPU backend");
                let mut spec = view.spec.clone();
                spec.extra_args = cpu_backend_extra_args(&spec.extra_args);
                spec.cpu_fallback = true;
                let _load = state.load_lock.lock().await;
                session::take_down_session(state).await;
                session::load_from_spec(state, emitter, spec, "cpu-fallback").await?;
                continue;
            }
            Ok(Attempt::RetryOnCpu) => {
                return Err(DiffusionError::new(
                    DiffusionErrorCode::EngineCrashed,
                    "sd-server crashed again on the CPU backend.",
                ))
            }
            Err(err) => return Err(err),
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_attempt(
    state: &DiffusionState,
    emitter: &dyn DiffusionEmitter,
    id: &str,
    request: &ImageGenerateRequest,
    view: &SessionView,
    body: serde_json::Value,
    batch_seed: i64,
    cancel: &AtomicBool,
    started: Instant,
) -> DiffusionResult<Attempt> {
    if cancel.load(Ordering::SeqCst) {
        return Err(cancelled());
    }
    let mut rx = attach_step_listener(state).await;
    let result = poll_job(
        state, emitter, id, request, view, body, batch_seed, cancel, started, &mut rx,
    )
    .await;
    detach_step_listener(state).await;
    result
}

#[allow(clippy::too_many_arguments)]
async fn poll_job(
    state: &DiffusionState,
    emitter: &dyn DiffusionEmitter,
    id: &str,
    request: &ImageGenerateRequest,
    view: &SessionView,
    body: serde_json::Value,
    batch_seed: i64,
    cancel: &AtomicBool,
    started: Instant,
    rx: &mut UnboundedReceiver<String>,
) -> DiffusionResult<Attempt> {
    let submit = view
        .client
        .post(format!("{}{IMG_GEN_PATH}", view.base_url))
        .json(&body)
        .timeout(SUBMIT_TIMEOUT)
        .send()
        .await;
    let response = match submit {
        Ok(response) => response,
        Err(err) => return Err(after_transport_error(state, cancel, "submit", &err).await),
    };
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    match status {
        200 | 202 => {}
        429 => {
            return Err(DiffusionError::new(
                DiffusionErrorCode::QueueFull,
                "The image server's queue is full. Try again in a moment.",
            ))
        }
        400 => {
            return Err(DiffusionError::with_details(
                DiffusionErrorCode::InvalidRequest,
                "The image server rejected the request.",
                text.chars().take(500).collect::<String>(),
            ))
        }
        other => {
            return Err(DiffusionError::with_details(
                DiffusionErrorCode::Internal,
                format!("The image server answered {other} on submit."),
                text.chars().take(500).collect::<String>(),
            ))
        }
    }
    let submitted: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        DiffusionError::with_details(
            DiffusionErrorCode::Internal,
            "sd-server returned a non-JSON submit response.",
            e.to_string(),
        )
    })?;
    let server_job_id = submitted
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            DiffusionError::new(
                DiffusionErrorCode::Internal,
                "sd-server returned no job id.",
            )
        })?;
    state.update_job(id, |record| {
        record.server_job_id = Some(server_job_id.clone())
    });

    let mut tracker = ProgressTracker::new(request.steps, request.batch_size);
    let job_url = format!("{}{JOBS_PATH}/{server_job_id}", view.base_url);
    let deadline = started + GENERATION_CEILING;

    loop {
        while let Ok(line) = rx.try_recv() {
            tracker.on_line(&line);
        }
        if tracker.take_dirty() {
            set_progress(state, emitter, id, tracker.snapshot());
        }

        match liveness(state).await {
            Liveness::Alive => {}
            Liveness::Gone => {
                return Err(if cancel.load(Ordering::SeqCst) {
                    cancelled()
                } else {
                    DiffusionError::new(
                        DiffusionErrorCode::EngineCrashed,
                        "sd-server was stopped during generation.",
                    )
                });
            }
            Liveness::Exited(status, tail) => {
                if cancel.load(Ordering::SeqCst) {
                    return Err(cancelled());
                }
                let tail_text = diagnostic_tail(&tail, 20, 1500);
                if is_ggml_unsupported_op_abort(&tail_text) && !view.spec.cpu_fallback {
                    return Ok(Attempt::RetryOnCpu);
                }
                let code = classify_exit(
                    &tail_text,
                    status
                        .code()
                        .or(process::exit_signal(status).map(|s| 128 + s)),
                );
                let err = DiffusionError::with_details(
                    code,
                    match code {
                        DiffusionErrorCode::OutOfMemory => {
                            "sd-server ran out of memory while generating.".to_string()
                        }
                        _ => format!("sd-server exited during generation ({status})."),
                    },
                    tail_text,
                );
                session::stop_keeping_spec(state, emitter, "crashed", Some(err.clone())).await;
                return Err(err);
            }
        }

        if Instant::now() > deadline {
            let _ = view
                .client
                .post(format!("{job_url}/cancel"))
                .timeout(Duration::from_secs(5))
                .send()
                .await;
            let err = DiffusionError::new(
                DiffusionErrorCode::Internal,
                format!(
                    "Generation exceeded {} hours and was stopped.",
                    GENERATION_CEILING.as_secs() / 3600
                ),
            );
            session::stop_keeping_spec(state, emitter, "timeout", Some(err.clone())).await;
            return Err(err);
        }

        let response = match view
            .client
            .get(&job_url)
            .timeout(STATUS_TIMEOUT)
            .send()
            .await
        {
            Ok(response) => response,
            Err(err) => {
                if cancel.load(Ordering::SeqCst) {
                    return Err(cancelled());
                }
                log::debug!("[atomic-diffusion] job poll failed: {err}");
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
        };
        match response.status().as_u16() {
            200 => {}
            404 | 410 => {
                return Err(DiffusionError::new(
                    DiffusionErrorCode::JobNotFound,
                    "The image server forgot the job.",
                ))
            }
            _ => {
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
        }
        let job: serde_json::Value = match response.json().await {
            Ok(job) => job,
            Err(_) => {
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
        };
        match job.get("status").and_then(|s| s.as_str()).unwrap_or("") {
            "queued" => {
                tracker.set_phase(ImageJobPhase::Queued);
            }
            "generating" => {
                set_job_state(state, emitter, id, ImageJobState::Generating);
                if tracker.phase == ImageJobPhase::Queued {
                    tracker.set_phase(ImageJobPhase::Encoding);
                }
            }
            "completed" => {
                set_job_state(state, emitter, id, ImageJobState::Generating);
                tracker.set_phase(ImageJobPhase::Saving);
                set_progress(state, emitter, id, tracker.snapshot());
                let pngs = decode_images(&job)?;
                let outputs =
                    save_outputs(state, id, request, view, batch_seed, started, &pngs).await?;
                let job = state
                    .job(id)
                    .ok_or_else(|| DiffusionError::internal("job record vanished"))?;
                return Ok(Attempt::Done(Box::new(JobOutcome {
                    job: ImageJob {
                        outputs: outputs.0,
                        ..job
                    },
                    images: outputs.1,
                })));
            }
            "failed" => {
                let code = job
                    .pointer("/error/code")
                    .and_then(|c| c.as_str())
                    .unwrap_or("error");
                let message = job
                    .pointer("/error/message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("");
                let classified = classify_exit(message, None);
                return Err(DiffusionError::with_details(
                    if classified == DiffusionErrorCode::OutOfMemory {
                        DiffusionErrorCode::OutOfMemory
                    } else {
                        DiffusionErrorCode::Internal
                    },
                    "The image server failed to generate.",
                    format!("{code}: {message}"),
                ));
            }
            "cancelled" => return Err(cancelled()),
            _ => {}
        }
        if tracker.take_dirty() {
            set_progress(state, emitter, id, tracker.snapshot());
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn after_transport_error(
    state: &DiffusionState,
    cancel: &AtomicBool,
    what: &str,
    err: &reqwest::Error,
) -> DiffusionError {
    if cancel.load(Ordering::SeqCst) {
        return cancelled();
    }
    match liveness(state).await {
        Liveness::Exited(status, tail) => {
            let tail_text = diagnostic_tail(&tail, 20, 1500);
            let code = classify_exit(&tail_text, status.code());
            DiffusionError::with_details(code, format!("sd-server died during {what}."), tail_text)
        }
        Liveness::Gone => {
            DiffusionError::new(DiffusionErrorCode::EngineCrashed, "sd-server was stopped.")
        }
        Liveness::Alive => DiffusionError::with_details(
            DiffusionErrorCode::Internal,
            format!("The image server did not accept the {what}."),
            err.to_string(),
        ),
    }
}

fn decode_images(job: &serde_json::Value) -> DiffusionResult<Vec<Vec<u8>>> {
    let mut items: Vec<(u64, &str)> = job
        .pointer("/result/images")
        .and_then(|v| v.as_array())
        .map(|images| {
            images
                .iter()
                .filter_map(|image| {
                    let b64 = image.get("b64_json")?.as_str()?;
                    let index = image.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                    Some((index, b64))
                })
                .collect()
        })
        .unwrap_or_default();
    items.sort_by_key(|(index, _)| *index);
    let mut out = Vec::with_capacity(items.len());
    for (_, b64) in items {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .map_err(|e| {
                DiffusionError::with_details(
                    DiffusionErrorCode::Internal,
                    "sd-server returned an undecodable image.",
                    e.to_string(),
                )
            })?;
        out.push(bytes);
    }
    if out.is_empty() {
        return Err(DiffusionError::new(
            DiffusionErrorCode::Internal,
            "The image server completed the job but returned no images.",
        ));
    }
    Ok(out)
}

async fn save_outputs(
    state: &DiffusionState,
    id: &str,
    request: &ImageGenerateRequest,
    view: &SessionView,
    batch_seed: i64,
    started: Instant,
    pngs: &[Vec<u8>],
) -> DiffusionResult<(Vec<GalleryImageItem>, Vec<Vec<u8>>)> {
    let output_dir = state.output_dir()?;
    let spec = &view.spec;
    let filename = std::path::Path::new(&spec.files.diffusion_model)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let created_at_ms = now_ms();
    let duration_ms = started.elapsed().as_millis() as u64;
    let _flags_guard = state.flags_lock.lock().await;
    let flags = gallery::read_flags(&output_dir);
    let mut items = Vec::with_capacity(pngs.len());
    let mut bytes = Vec::with_capacity(pngs.len());
    for (index, png) in pngs.iter().enumerate() {
        let recipe = ImageRecipe {
            job_id: id.to_string(),
            index: index as u32,
            prompt: request.prompt.clone(),
            negative_prompt: request.negative_prompt.clone().filter(|n| !n.is_empty()),
            width: request.width,
            height: request.height,
            steps: request.steps,
            cfg_scale: request.cfg_scale,
            guidance: request.guidance.or(spec.defaults.guidance),
            seed: batch_seed + index as i64,
            batch_seed,
            batch_size: request.batch_size,
            sampling_method: request
                .sampling_method
                .clone()
                .or_else(|| spec.defaults.sampling_method.clone()),
            flow_shift: request.flow_shift.or(spec.defaults.flow_shift),
            workflow: request.workflow(),
            strength: if request.workflow() == ImageWorkflow::Transform {
                request.strength
            } else {
                None
            },
            model: RecipeModel {
                model_id: spec.model_id.clone(),
                family: spec.family.clone(),
                display_name: spec.display_name.clone(),
                filename: filename.clone(),
            },
            engine: RecipeEngine {
                kind: spec.engine,
                backend: spec.backend,
                tag: view.tag.clone(),
                offload: spec.offload,
                cpu_fallback: spec.cpu_fallback,
            },
            created_at_ms,
            duration_ms,
        };
        let (item, final_bytes) = gallery::save(&output_dir, &recipe, png, &flags)?;
        state.update_job(id, |record| record.job.outputs.push(item.clone()));
        items.push(item);
        bytes.push(final_bytes);
    }
    Ok((items, bytes))
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

pub async fn cancel_job(
    state: &DiffusionState,
    emitter: &dyn DiffusionEmitter,
    id: &str,
) -> DiffusionResult<CancelResult> {
    cancel_job_with_grace(state, emitter, id, CANCEL_GRACE).await
}

async fn wait_terminal(state: &DiffusionState, id: &str, grace: Duration) -> Option<ImageJobState> {
    let deadline = Instant::now() + grace;
    loop {
        let job_state = state.job(id)?.state;
        if job_state.is_terminal() {
            return Some(job_state);
        }
        if Instant::now() >= deadline {
            return Some(job_state);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

pub async fn cancel_job_with_grace(
    state: &DiffusionState,
    emitter: &dyn DiffusionEmitter,
    id: &str,
    grace: Duration,
) -> DiffusionResult<CancelResult> {
    let (job_state, cancel_flag, server_job_id) = {
        let jobs = state
            .jobs
            .lock()
            .map_err(|_| DiffusionError::internal("Job state is poisoned."))?;
        let record = jobs.get(id).ok_or_else(|| {
            DiffusionError::new(
                DiffusionErrorCode::JobNotFound,
                "That job no longer exists.",
            )
        })?;
        (
            record.job.state,
            record.cancel_requested.clone(),
            record.server_job_id.clone(),
        )
    };
    if job_state.is_terminal() {
        return Ok(CancelResult {
            cancelled: job_state == ImageJobState::Cancelled,
            server_stopped: false,
        });
    }
    cancel_flag.store(true, Ordering::SeqCst);

    let (client, base_url, cancel_generating) = {
        let guard = state.session.lock().await;
        match guard.as_ref() {
            Some(session) => (
                Some(session.client.clone()),
                session.base_url(),
                session.capabilities.cancel_generating,
            ),
            None => (None, String::new(), false),
        }
    };
    if let (Some(client), Some(server_id)) = (client.as_ref(), server_job_id.as_deref()) {
        let _ = client
            .post(format!("{base_url}{JOBS_PATH}/{server_id}/cancel"))
            .timeout(Duration::from_secs(5))
            .send()
            .await;
    }

    if let Some(final_state) = wait_terminal(state, id, grace).await {
        if final_state.is_terminal() {
            return Ok(CancelResult {
                cancelled: final_state == ImageJobState::Cancelled,
                server_stopped: false,
            });
        }
    }
    if cancel_generating {
        // The engine promised a soft cancel; give it one more grace period.
        if let Some(final_state) = wait_terminal(state, id, grace).await {
            if final_state.is_terminal() {
                return Ok(CancelResult {
                    cancelled: final_state == ImageJobState::Cancelled,
                    server_stopped: false,
                });
            }
        }
    }

    // sd-server will not interrupt a running generation: stop the process.
    // The spec stays, so the next generate respawns it.
    log::warn!("[atomic-diffusion] cancel not honoured within {grace:?}; stopping sd-server");
    session::stop_keeping_spec(state, emitter, "cancelled", None).await;
    finish_job(state, emitter, id, Err(cancelled()));
    Ok(CancelResult {
        cancelled: true,
        server_stopped: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::RecordingEmitter;
    use crate::state::{
        DiffusionBackend, DiffusionConfig, DiffusionSession, EngineKind, FamilyDefaults,
        FamilyRanges, Modality, ModelFiles, ModelState, OffloadPolicy, ServerCapabilities,
    };
    use std::collections::HashMap;
    use std::io::Cursor;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    // -- a minimal HTTP/1.1 stub speaking /sdcpp/v1/* ------------------------

    type Handler = Arc<dyn Fn(&str, &str, &[u8]) -> (u16, String) + Send + Sync>;

    async fn stub(handler: Handler) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let handler = handler.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let (method, path, body) = loop {
                        let n = match socket.read(&mut tmp).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => n,
                        };
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            let head = String::from_utf8_lossy(&buf[..pos]).to_string();
                            let mut lines = head.lines();
                            let request_line = lines.next().unwrap_or_default().to_string();
                            let mut parts = request_line.split_whitespace();
                            let method = parts.next().unwrap_or("").to_string();
                            let path = parts.next().unwrap_or("").to_string();
                            let content_length = lines
                                .filter_map(|l| l.split_once(':'))
                                .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                                .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                                .unwrap_or(0);
                            let mut body = buf[pos + 4..].to_vec();
                            while body.len() < content_length {
                                let n = match socket.read(&mut tmp).await {
                                    Ok(0) | Err(_) => return,
                                    Ok(n) => n,
                                };
                                body.extend_from_slice(&tmp[..n]);
                            }
                            break (method, path, body);
                        }
                    };
                    let (status, json) = handler(&method, &path, &body);
                    let response = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{json}",
                        json.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        port
    }

    fn png_b64() -> String {
        let img = image::RgbaImage::from_pixel(16, 16, image::Rgba([1, 2, 3, 255]));
        let mut buf = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        base64::engine::general_purpose::STANDARD.encode(buf.into_inner())
    }

    fn spec() -> ServerSpec {
        ServerSpec {
            binary_dir: std::path::PathBuf::from("/nonexistent"),
            engine: EngineKind::SdCpp,
            backend: DiffusionBackend::Cpu,
            backend_id: "test-cpu".into(),
            tag: "test-tag".into(),
            model_id: "z-image:q4_k_m".into(),
            family: "z-image".into(),
            modality: Modality::Image,
            display_name: "Z-Image Turbo".into(),
            files: ModelFiles {
                diffusion_model: "/models/z-image/z-image-turbo-Q4_K_M.gguf".into(),
                ..Default::default()
            },
            defaults: FamilyDefaults {
                steps: 4,
                cfg_scale: 1.0,
                guidance: None,
                sampling_method: Some("euler".into()),
                flow_shift: None,
                width: 512,
                height: 512,
            },
            ranges: FamilyRanges {
                steps: (1, 50),
                dims: (256, 2048),
                dim_multiple: 16,
            },
            offload: OffloadPolicy::None,
            threads: None,
            extra_args: Vec::new(),
            startup_timeout: Duration::from_secs(5),
            cpu_fallback: false,
        }
    }

    fn request() -> ImageGenerateRequest {
        ImageGenerateRequest {
            prompt: "a cat".into(),
            negative_prompt: None,
            width: 512,
            height: 512,
            steps: 4,
            cfg_scale: 1.0,
            guidance: None,
            seed: Some(1234),
            batch_size: 2,
            sampling_method: None,
            flow_shift: None,
            workflow: None,
            init_image_path: None,
            strength: None,
        }
    }

    #[cfg(unix)]
    async fn sleeper() -> tokio::process::Child {
        let mut cmd = tokio::process::Command::new("sleep");
        cmd.arg("600").kill_on_drop(true);
        cmd.spawn().unwrap()
    }

    #[cfg(unix)]
    async fn state_with_session(
        port: u16,
        cancel_generating: bool,
    ) -> (DiffusionState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let state = DiffusionState::new();
        *state.config.lock().unwrap() = Some(DiffusionConfig {
            data_folder: dir.path().to_string_lossy().to_string(),
            output_dir: None,
            idle_unload_secs: Some(600),
        });
        let child = sleeper().await;
        let pid = child.id().unwrap();
        let info = crate::state::LoadedModel {
            model_id: "z-image:q4_k_m".into(),
            family: "z-image".into(),
            modality: Modality::Image,
            display_name: "Z-Image Turbo".into(),
            engine: EngineKind::SdCpp,
            backend: DiffusionBackend::Cpu,
            offload: OffloadPolicy::None,
            cpu_fallback: false,
            port,
            pid,
            loaded_at_ms: 1,
        };
        let session = DiffusionSession::new(
            child,
            info,
            spec(),
            crate::state::new_tail(),
            Arc::new(Mutex::new(None)),
            ServerCapabilities {
                cancel_generating,
                img_gen_defaults: None,
            },
            Vec::new(),
            reqwest::Client::new(),
        );
        *state.session.lock().await = Some(session);
        state.set_spec(Some(spec()));
        state.set_model_state(ModelState::Loaded, None);
        (state, dir)
    }

    fn job_states(emitter: &RecordingEmitter) -> Vec<String> {
        emitter
            .of(EVENT_JOB)
            .iter()
            .map(|p| p["job"]["state"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn validation_covers_every_range() {
        let s = spec();
        let ok = request();
        assert!(validate_request(&ok, &s).is_ok());

        let mut r = ok.clone();
        r.prompt = "   ".into();
        assert_eq!(
            validate_request(&r, &s).unwrap_err().code,
            DiffusionErrorCode::InvalidRequest
        );

        let mut r = ok.clone();
        r.width = 520;
        assert_eq!(
            validate_request(&r, &s).unwrap_err().code,
            DiffusionErrorCode::InvalidDimensions
        );
        let mut r = ok.clone();
        r.height = 4096;
        assert_eq!(
            validate_request(&r, &s).unwrap_err().code,
            DiffusionErrorCode::InvalidDimensions
        );
        let mut r = ok.clone();
        r.width = 128;
        assert_eq!(
            validate_request(&r, &s).unwrap_err().code,
            DiffusionErrorCode::InvalidDimensions
        );

        let mut r = ok.clone();
        r.steps = 51;
        assert_eq!(
            validate_request(&r, &s).unwrap_err().code,
            DiffusionErrorCode::InvalidRequest
        );
        let mut r = ok.clone();
        r.batch_size = 5;
        assert_eq!(
            validate_request(&r, &s).unwrap_err().code,
            DiffusionErrorCode::InvalidRequest
        );
        let mut r = ok.clone();
        r.batch_size = 0;
        assert_eq!(
            validate_request(&r, &s).unwrap_err().code,
            DiffusionErrorCode::InvalidRequest
        );

        let mut r = ok.clone();
        r.workflow = Some(ImageWorkflow::Transform);
        assert_eq!(
            validate_request(&r, &s).unwrap_err().code,
            DiffusionErrorCode::UnsupportedWorkflow
        );

        let mut klein = s.clone();
        klein.family = "flux.2-klein".into();
        assert_eq!(
            validate_request(&r, &klein).unwrap_err().code,
            DiffusionErrorCode::InvalidRequest
        );
        let file = tempfile::NamedTempFile::new().unwrap();
        r.init_image_path = Some(file.path().to_string_lossy().to_string());
        r.strength = Some(1.5);
        assert_eq!(
            validate_request(&r, &klein).unwrap_err().code,
            DiffusionErrorCode::InvalidRequest
        );
        r.strength = Some(0.6);
        assert!(validate_request(&r, &klein).is_ok());
    }

    #[test]
    fn progress_tracks_batches_phases_and_eta() {
        let mut t = ProgressTracker::new(4, 2);
        t.set_phase(ImageJobPhase::Encoding);
        assert_eq!(t.snapshot().fraction, 0.02);
        t.on_line("loading 1/100");
        assert_eq!(t.snapshot().step, 0, "foreign denominators are ignored");
        t.on_line("|=>   | 1/4 - 1.0s/it");
        t.on_line("|==>  | 2/4 - 1.0s/it");
        let p = t.snapshot();
        assert_eq!(
            (p.step, p.total_steps, p.batch_index, p.batch_size),
            (2, 4, 0, 2)
        );
        assert_eq!(p.phase, ImageJobPhase::Sampling);
        assert!((p.fraction - 0.25).abs() < 1e-9);
        assert!(p.eta_seconds.is_some());
        t.on_line("4/4");
        t.on_line("1/4");
        let p = t.snapshot();
        assert_eq!((p.step, p.batch_index), (1, 1));
        assert!((p.fraction - 0.625).abs() < 1e-9);
        t.on_line("4/4");
        assert_eq!(t.snapshot().phase, ImageJobPhase::Decoding);
        assert!((t.snapshot().fraction - 0.98).abs() < 1e-9);
        // A later phase reusing the count does not roll the batch over.
        t.on_line("1/4");
        assert_eq!(t.snapshot().batch_index, 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn completed_job_saves_outputs_and_reports_transitions() {
        let polls = Arc::new(Mutex::new(0u32));
        let polls_h = polls.clone();
        let b64 = png_b64();
        let handler: Handler = Arc::new(move |method, path, body| match (method, path) {
            ("POST", IMG_GEN_PATH) => {
                let v: serde_json::Value = serde_json::from_slice(body).unwrap();
                assert_eq!(v["batch_count"], 2);
                assert_eq!(v["seed"], 1234);
                assert_eq!(v["sample_params"]["sample_method"], "euler");
                (202, r#"{"id":"job_1","kind":"img_gen","status":"queued","poll_url":"/sdcpp/v1/jobs/job_1"}"#.into())
            }
            ("GET", "/sdcpp/v1/jobs/job_1") => {
                let mut n = polls_h.lock().unwrap();
                *n += 1;
                if *n < 3 {
                    (
                        200,
                        r#"{"id":"job_1","status":"generating","result":null,"error":null}"#.into(),
                    )
                } else {
                    (
                        200,
                        serde_json::json!({
                            "id": "job_1", "status": "completed",
                            "result": {"images": [
                                {"index": 1, "b64_json": b64},
                                {"index": 0, "b64_json": b64}
                            ]},
                            "error": null
                        })
                        .to_string(),
                    )
                }
            }
            _ => (404, "{}".into()),
        });
        let port = stub(handler).await;
        let (state, dir) = state_with_session(port, false).await;
        let emitter = Arc::new(RecordingEmitter::default());

        let (id, handle) = start_image_job(state.clone(), emitter.clone(), request()).unwrap();
        assert_eq!(state.active_job_id().as_deref(), Some(id.as_str()));
        assert!(
            state.active_job().is_some(),
            "status must expose the running job"
        );
        // A second submission is refused while the first runs.
        let busy = start_image_job(state.clone(), emitter.clone(), request()).unwrap_err();
        assert_eq!(busy.code, DiffusionErrorCode::JobBusy);

        // Feed step lines through the listener the runner attached.
        tokio::time::sleep(Duration::from_millis(150)).await;
        {
            let guard = state.session.lock().await;
            let session = guard.as_ref().unwrap();
            let sender = session
                .step_listener
                .lock()
                .unwrap()
                .clone()
                .expect("listener attached");
            sender.send("|==>  | 2/4 - 1.0s/it".into()).unwrap();
        }

        let outcome = handle.await.unwrap().unwrap();
        assert_eq!(outcome.job.state, ImageJobState::Completed);
        assert_eq!(outcome.job.outputs.len(), 2);
        assert_eq!(outcome.images.len(), 2);
        assert_eq!(outcome.job.outputs[0].recipe.seed, 1234);
        assert_eq!(outcome.job.outputs[1].recipe.seed, 1235);
        assert_eq!(outcome.job.outputs[1].recipe.batch_seed, 1234);
        assert_eq!(
            outcome.job.outputs[0].recipe.sampling_method.as_deref(),
            Some("euler")
        );
        assert_eq!(outcome.job.outputs[0].recipe.engine.tag, "test-tag");
        let expected_dir = dir.path().join("images");
        assert!(std::path::Path::new(&outcome.job.outputs[0].path).starts_with(&expected_dir));
        assert!(std::path::Path::new(&outcome.job.outputs[0].path).is_file());
        assert!(outcome.images[0].starts_with(&[0x89, b'P', b'N', b'G']));
        assert!(state.active_job_id().is_none());
        assert_eq!(state.job(&id).unwrap().state, ImageJobState::Completed);

        assert_eq!(
            job_states(&emitter),
            vec!["queued", "generating", "completed"]
        );
        let progress = emitter.of(EVENT_PROGRESS);
        assert!(progress
            .iter()
            .any(|p| p["progress"]["step"] == 2 && p["progress"]["phase"] == "sampling"));
        assert!(progress.iter().any(|p| p["progress"]["phase"] == "saving"));
        assert!(!state.idle_expired());
        assert!(emitter.of(crate::events::EVENT_ERROR).is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_job_reports_the_server_error() {
        let handler: Handler = Arc::new(|method, path, _| {
            match (method, path) {
            ("POST", IMG_GEN_PATH) => (202, r#"{"id":"job_2","status":"queued"}"#.into()),
            ("GET", "/sdcpp/v1/jobs/job_2") => (
                200,
                r#"{"id":"job_2","status":"failed","result":null,"error":{"code":"generation_failed","message":"generate_image returned empty results"}}"#.into(),
            ),
            _ => (404, "{}".into()),
        }
        });
        let port = stub(handler).await;
        let (state, _dir) = state_with_session(port, false).await;
        let emitter = Arc::new(RecordingEmitter::default());
        let err = run_image_job(state.clone(), emitter.clone(), request())
            .await
            .unwrap_err();
        assert_eq!(err.code, DiffusionErrorCode::Internal);
        assert!(err.details.unwrap().contains("generation_failed"));
        assert_eq!(job_states(&emitter).last().unwrap(), "failed");
        assert_eq!(emitter.of(crate::events::EVENT_ERROR).len(), 1);
        assert!(state.active_job_id().is_none());
        assert!(
            state.session.lock().await.is_some(),
            "a failed job keeps the server"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn full_queue_is_queue_full() {
        let handler: Handler = Arc::new(|method, path, _| match (method, path) {
            ("POST", IMG_GEN_PATH) => (429, r#"{"error":"queue full"}"#.into()),
            _ => (404, "{}".into()),
        });
        let port = stub(handler).await;
        let (state, _dir) = state_with_session(port, false).await;
        let emitter = Arc::new(RecordingEmitter::default());
        let err = run_image_job(state.clone(), emitter, request())
            .await
            .unwrap_err();
        assert_eq!(err.code, DiffusionErrorCode::QueueFull);
        assert_eq!(
            state
                .job(&state.job_order.lock().unwrap()[0])
                .unwrap()
                .state,
            ImageJobState::Failed
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancel_past_the_grace_period_stops_the_server_and_keeps_the_spec() {
        let cancels = Arc::new(Mutex::new(0u32));
        let cancels_h = cancels.clone();
        let handler: Handler = Arc::new(move |method, path, _| match (method, path) {
            ("POST", IMG_GEN_PATH) => (202, r#"{"id":"job_3","status":"queued"}"#.into()),
            ("GET", "/sdcpp/v1/jobs/job_3") => {
                (200, r#"{"id":"job_3","status":"generating"}"#.into())
            }
            ("POST", "/sdcpp/v1/jobs/job_3/cancel") => {
                *cancels_h.lock().unwrap() += 1;
                (200, r#"{"id":"job_3","status":"generating"}"#.into())
            }
            _ => (404, "{}".into()),
        });
        let port = stub(handler).await;
        let (state, _dir) = state_with_session(port, false).await;
        let pid = state.session.lock().await.as_ref().unwrap().info.pid as i32;
        let emitter = Arc::new(RecordingEmitter::default());
        let (id, handle) = start_image_job(state.clone(), emitter.clone(), request()).unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(state.job(&id).unwrap().state, ImageJobState::Generating);

        let result =
            cancel_job_with_grace(&state, emitter.as_ref(), &id, Duration::from_millis(400))
                .await
                .unwrap();
        assert_eq!(
            result,
            CancelResult {
                cancelled: true,
                server_stopped: true
            }
        );
        assert_eq!(
            *cancels.lock().unwrap(),
            1,
            "the native cancel was attempted first"
        );
        assert!(state.session.lock().await.is_none());
        assert!(state.spec().is_some(), "the spec survives for the respawn");
        assert_eq!(state.model_state().0, ModelState::Unloaded);
        let alive = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok();
        assert!(!alive, "sd-server must be dead");

        let err = handle.await.unwrap().unwrap_err();
        assert_eq!(err.code, DiffusionErrorCode::Cancelled);
        assert_eq!(state.job(&id).unwrap().state, ImageJobState::Cancelled);
        assert!(state.active_job_id().is_none());
        assert_eq!(job_states(&emitter).last().unwrap(), "cancelled");
        assert!(emitter
            .of(crate::events::EVENT_STATE)
            .iter()
            .any(|p| p["reason"] == "cancelled"));
        assert!(
            emitter.of(crate::events::EVENT_ERROR).is_empty(),
            "a cancel is not an error"
        );

        // Cancelling again is a no-op that reports the terminal state.
        let again = cancel_job(&state, emitter.as_ref(), &id).await.unwrap();
        assert_eq!(
            again,
            CancelResult {
                cancelled: true,
                server_stopped: false
            }
        );
        assert_eq!(
            cancel_job(&state, emitter.as_ref(), "missing")
                .await
                .unwrap_err()
                .code,
            DiffusionErrorCode::JobNotFound
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn native_cancel_that_lands_in_time_keeps_the_server() {
        let cancelled_flag = Arc::new(Mutex::new(false));
        let flag_h = cancelled_flag.clone();
        let handler: Handler = Arc::new(move |method, path, _| match (method, path) {
            ("POST", IMG_GEN_PATH) => (202, r#"{"id":"job_4","status":"queued"}"#.into()),
            ("GET", "/sdcpp/v1/jobs/job_4") => {
                if *flag_h.lock().unwrap() {
                    (200, r#"{"id":"job_4","status":"cancelled","error":{"code":"cancelled","message":"job cancelled by client"}}"#.into())
                } else {
                    (200, r#"{"id":"job_4","status":"queued"}"#.into())
                }
            }
            ("POST", "/sdcpp/v1/jobs/job_4/cancel") => {
                *flag_h.lock().unwrap() = true;
                (200, "{}".into())
            }
            _ => (404, "{}".into()),
        });
        let port = stub(handler).await;
        let (state, _dir) = state_with_session(port, false).await;
        let emitter = Arc::new(RecordingEmitter::default());
        let (id, handle) = start_image_job(state.clone(), emitter.clone(), request()).unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let result = cancel_job(&state, emitter.as_ref(), &id).await.unwrap();
        assert_eq!(
            result,
            CancelResult {
                cancelled: true,
                server_stopped: false
            }
        );
        assert!(state.session.lock().await.is_some());
        assert_eq!(
            handle.await.unwrap().unwrap_err().code,
            DiffusionErrorCode::Cancelled
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_server_that_dies_mid_job_is_engine_crashed() {
        let handler: Handler = Arc::new(|method, path, _| match (method, path) {
            ("POST", IMG_GEN_PATH) => (202, r#"{"id":"job_5","status":"queued"}"#.into()),
            ("GET", "/sdcpp/v1/jobs/job_5") => {
                (200, r#"{"id":"job_5","status":"generating"}"#.into())
            }
            _ => (404, "{}".into()),
        });
        let port = stub(handler).await;
        let (state, _dir) = state_with_session(port, false).await;
        let emitter = Arc::new(RecordingEmitter::default());
        let (id, handle) = start_image_job(state.clone(), emitter.clone(), request()).unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        {
            let guard = state.session.lock().await;
            let session = guard.as_ref().unwrap();
            crate::state::push_tail(&session.tail, "CUDA error: out of memory".into());
            nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(session.info.pid as i32),
                nix::sys::signal::Signal::SIGKILL,
            )
            .unwrap();
        }
        let err = handle.await.unwrap().unwrap_err();
        assert_eq!(err.code, DiffusionErrorCode::OutOfMemory);
        assert!(err.details.unwrap().contains("out of memory"));
        assert_eq!(state.job(&id).unwrap().state, ImageJobState::Failed);
        assert_eq!(state.model_state().0, ModelState::Failed);
        assert!(state.session.lock().await.is_none());
        assert!(state.spec().is_some());
        assert!(emitter
            .of(crate::events::EVENT_STATE)
            .iter()
            .any(|p| p["reason"] == "crashed"));
    }

    #[tokio::test]
    async fn generate_without_a_model_is_model_not_loaded() {
        let state = DiffusionState::new();
        let emitter = Arc::new(RecordingEmitter::default());
        let err = start_image_job(state, emitter, request()).unwrap_err();
        assert_eq!(err.code, DiffusionErrorCode::ModelNotLoaded);
    }

    #[test]
    fn decode_orders_by_index_and_rejects_empty_results() {
        let b64 = png_b64();
        let job = serde_json::json!({"result": {"images": [
            {"index": 1, "b64_json": "AQ=="},
            {"index": 0, "b64_json": b64}
        ]}});
        let images = decode_images(&job).unwrap();
        assert_eq!(images.len(), 2);
        assert!(images[0].starts_with(&[0x89, b'P']));
        assert_eq!(images[1], vec![1u8]);
        assert!(decode_images(&serde_json::json!({"result": {"images": []}})).is_err());
        let _unused: HashMap<String, String> = HashMap::new();
    }
}
