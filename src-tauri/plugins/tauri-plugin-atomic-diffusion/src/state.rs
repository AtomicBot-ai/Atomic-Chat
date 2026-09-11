//! Plugin state and the wire types shared with `types.ts`.
//!
//! Exactly one `sd-server` can be resident: image models are multi-gigabyte
//! and the GPU is shared with chat, so the session is an `Option`, not a map.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::process::Child;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex as AsyncMutex;

use crate::error::DiffusionError;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EngineKind {
    SdCpp,
    Diffusers,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffusionBackend {
    Cpu,
    Metal,
    Cuda,
    Vulkan,
    Rocm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OffloadPolicy {
    None,
    Group,
    Model,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Modality {
    Image,
    Video,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelState {
    Unloaded,
    Loading,
    Loaded,
    Unloading,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageWorkflow {
    Create,
    Transform,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageJobState {
    Queued,
    Generating,
    Completed,
    Failed,
    Cancelled,
}

impl ImageJobState {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageJobPhase {
    Queued,
    Encoding,
    Sampling,
    Decoding,
    Saving,
}

// ---------------------------------------------------------------------------
// Load request
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFiles {
    pub diffusion_model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vae: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vae_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip_l: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub t5xxl: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qwen2vl: Option<String>,
}

impl ModelFiles {
    /// Every file with its human label, the transformer first.
    pub fn entries(&self) -> Vec<(&'static str, &str)> {
        let mut out = vec![("diffusionModel", self.diffusion_model.as_str())];
        for (label, value) in [
            ("vae", &self.vae),
            ("clipL", &self.clip_l),
            ("t5xxl", &self.t5xxl),
            ("llm", &self.llm),
            ("qwen2vl", &self.qwen2vl),
        ] {
            if let Some(value) = value {
                out.push((label, value.as_str()));
            }
        }
        out
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyDefaults {
    pub steps: u32,
    pub cfg_scale: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guidance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sampling_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow_shift: Option<f64>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyRanges {
    pub steps: (u32, u32),
    /// Inclusive min/max for both width and height.
    pub dims: (u32, u32),
    pub dim_multiple: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadModelRequest {
    pub model_id: String,
    pub family: String,
    pub modality: Modality,
    pub display_name: String,
    pub files: ModelFiles,
    pub defaults: FamilyDefaults,
    pub ranges: FamilyRanges,
    pub offload: OffloadPolicy,
    #[serde(default)]
    pub engine: Option<EngineKind>,
    #[serde(default)]
    pub threads: Option<u32>,
    #[serde(default)]
    pub startup_timeout_secs: Option<u64>,
}

pub const DEFAULT_STARTUP_TIMEOUT_SECS: u64 = 600;
pub const DEFAULT_IDLE_UNLOAD_SECS: u64 = 600;
pub const MAX_BATCH: u32 = 4;

// ---------------------------------------------------------------------------
// Install / status
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum EngineInstall {
    NotInstalled,
    #[serde(rename_all = "camelCase")]
    Installed {
        engine: EngineKind,
        backend: DiffusionBackend,
        tag: String,
        backend_id: String,
        dir: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendInstallRecord {
    pub tag: String,
    pub backend_id: String,
    pub backend: DiffusionBackend,
    pub engine: EngineKind,
    pub sha256: Option<String>,
    pub installed_at_ms: u64,
    pub dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedModel {
    pub model_id: String,
    pub family: String,
    pub modality: Modality,
    pub display_name: String,
    pub engine: EngineKind,
    pub backend: DiffusionBackend,
    pub offload: OffloadPolicy,
    pub cpu_fallback: bool,
    pub port: u16,
    pub pid: u32,
    pub loaded_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub state: ModelState,
    pub loaded: Option<LoadedModel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<DiffusionError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffusionStatus {
    pub configured: bool,
    pub install: EngineInstall,
    pub model: ModelStatus,
    pub active_job: Option<ImageJob>,
    pub output_dir: String,
    pub idle_unload_secs: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCapabilities {
    pub workflows: Vec<ImageWorkflow>,
    pub min_dim: u32,
    pub max_dim: u32,
    pub dim_multiple: u32,
    pub supports_negative_prompt: bool,
    pub supports_guidance: bool,
    pub cancel_generating: bool,
    pub max_batch: u32,
    pub defaults: FamilyDefaults,
    pub ranges: FamilyRanges,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffusionConfig {
    pub data_folder: String,
    #[serde(default)]
    pub output_dir: Option<String>,
    #[serde(default)]
    pub idle_unload_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFile {
    pub path: String,
    pub relative_path: String,
    pub bytes: u64,
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenerateRequest {
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub negative_prompt: Option<String>,
    pub width: u32,
    pub height: u32,
    pub steps: u32,
    pub cfg_scale: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guidance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<i64>,
    pub batch_size: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sampling_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow_shift: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow: Option<ImageWorkflow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub init_image_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strength: Option<f64>,
}

impl ImageGenerateRequest {
    pub fn workflow(&self) -> ImageWorkflow {
        self.workflow.unwrap_or(ImageWorkflow::Create)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageJobProgress {
    pub phase: ImageJobPhase,
    pub step: u32,
    pub total_steps: u32,
    pub fraction: f64,
    pub eta_seconds: Option<f64>,
    pub batch_index: u32,
    pub batch_size: u32,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageJob {
    pub id: String,
    pub state: ImageJobState,
    pub model_id: String,
    pub request: ImageGenerateRequest,
    pub created_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at_ms: Option<u64>,
    pub progress: Option<ImageJobProgress>,
    pub outputs: Vec<GalleryImageItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<DiffusionError>,
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeModel {
    pub model_id: String,
    pub family: String,
    pub display_name: String,
    pub filename: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeEngine {
    pub kind: EngineKind,
    pub backend: DiffusionBackend,
    pub tag: String,
    pub offload: OffloadPolicy,
    pub cpu_fallback: bool,
}

/// Embedded verbatim in the PNG (`tEXt` keyword `atomic`). Exactly the
/// `ImageRecipe` shape from `types.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRecipe {
    pub job_id: String,
    pub index: u32,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub width: u32,
    pub height: u32,
    pub steps: u32,
    pub cfg_scale: f64,
    pub guidance: Option<f64>,
    pub seed: i64,
    pub batch_seed: i64,
    pub batch_size: u32,
    pub sampling_method: Option<String>,
    pub flow_shift: Option<f64>,
    pub workflow: ImageWorkflow,
    pub strength: Option<f64>,
    pub model: RecipeModel,
    pub engine: RecipeEngine,
    pub created_at_ms: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryImageItem {
    pub id: String,
    pub path: String,
    pub thumbnail_path: Option<String>,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u64,
    pub created_at_ms: u64,
    pub pinned: bool,
    pub archived: bool,
    pub recipe: ImageRecipe,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryPage {
    pub items: Vec<GalleryImageItem>,
    pub has_more: bool,
    pub total: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryListOptions {
    pub offset: usize,
    pub limit: usize,
    #[serde(default)]
    pub include_archived: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GalleryFlags {
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default)]
    pub archived: Option<bool>,
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/// Everything needed to (re)spawn the server: kept after a cancel kills the
/// process so the next `generate` can bring it back without the frontend
/// repeating the load request.
#[derive(Debug, Clone)]
pub struct ServerSpec {
    pub binary_dir: PathBuf,
    pub engine: EngineKind,
    pub backend: DiffusionBackend,
    pub backend_id: String,
    pub tag: String,
    pub model_id: String,
    pub family: String,
    pub modality: Modality,
    pub display_name: String,
    pub files: ModelFiles,
    pub defaults: FamilyDefaults,
    pub ranges: FamilyRanges,
    pub offload: OffloadPolicy,
    pub threads: Option<u32>,
    pub extra_args: Vec<String>,
    pub startup_timeout: Duration,
    pub cpu_fallback: bool,
}

/// What `GET /sdcpp/v1/capabilities` told us after the server came up.
#[derive(Debug, Clone, Default)]
pub struct ServerCapabilities {
    pub cancel_generating: bool,
    pub img_gen_defaults: Option<serde_json::Value>,
}

pub type SharedTail = Arc<Mutex<VecDeque<String>>>;
pub type StepListener = Arc<Mutex<Option<UnboundedSender<String>>>>;

pub const TAIL_CAPACITY: usize = 200;

pub fn new_tail() -> SharedTail {
    Arc::new(Mutex::new(VecDeque::with_capacity(TAIL_CAPACITY)))
}

pub fn push_tail(tail: &SharedTail, line: String) {
    if let Ok(mut guard) = tail.lock() {
        if guard.len() >= TAIL_CAPACITY {
            guard.pop_front();
        }
        guard.push_back(line);
    }
}

pub fn tail_lines(tail: &SharedTail) -> Vec<String> {
    tail.lock()
        .map(|guard| guard.iter().cloned().collect())
        .unwrap_or_default()
}

pub struct DiffusionSession {
    pub child: Child,
    pub info: LoadedModel,
    pub spec: ServerSpec,
    pub tail: SharedTail,
    pub step_listener: StepListener,
    pub capabilities: ServerCapabilities,
    pub drain_tasks: Vec<tokio::task::JoinHandle<()>>,
    pub client: reqwest::Client,
    exit_status: Option<std::process::ExitStatus>,
}

impl DiffusionSession {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        child: Child,
        info: LoadedModel,
        spec: ServerSpec,
        tail: SharedTail,
        step_listener: StepListener,
        capabilities: ServerCapabilities,
        drain_tasks: Vec<tokio::task::JoinHandle<()>>,
        client: reqwest::Client,
    ) -> Self {
        Self {
            child,
            info,
            spec,
            tail,
            step_listener,
            capabilities,
            drain_tasks,
            client,
            exit_status: None,
        }
    }

    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.info.port)
    }

    /// Non-blocking liveness check; the exit status is cached once seen.
    pub fn exit_status(&mut self) -> Option<std::process::ExitStatus> {
        if self.exit_status.is_none() {
            if let Ok(Some(status)) = self.child.try_wait() {
                self.exit_status = Some(status);
            }
        }
        self.exit_status
    }

    pub fn is_alive(&mut self) -> bool {
        self.exit_status().is_none()
    }

    pub fn set_step_listener(&self, sender: Option<UnboundedSender<String>>) {
        if let Ok(mut guard) = self.step_listener.lock() {
            *guard = sender;
        }
    }
}

// ---------------------------------------------------------------------------
// Job records
// ---------------------------------------------------------------------------

pub struct JobRecord {
    pub job: ImageJob,
    pub cancel_requested: Arc<AtomicBool>,
    /// The server-side job id once submitted; `None` while queued locally.
    pub server_job_id: Option<String>,
}

/// Jobs kept in memory for `get_job`; the gallery is the durable record.
pub const JOB_HISTORY: usize = 50;

// ---------------------------------------------------------------------------
// Plugin state
// ---------------------------------------------------------------------------

/// Cheap to clone: everything lives behind one `Arc`, so a command can hand a
/// `'static` handle to the job runner or the idle task.
#[derive(Clone, Default)]
pub struct DiffusionState {
    inner: Arc<DiffusionStateInner>,
}

impl std::ops::Deref for DiffusionState {
    type Target = DiffusionStateInner;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

impl DiffusionState {
    pub fn new() -> Self {
        Self::default()
    }
}

pub struct DiffusionStateInner {
    pub config: Mutex<Option<DiffusionConfig>>,
    pub session: Arc<AsyncMutex<Option<DiffusionSession>>>,
    /// The last spec that loaded successfully; the respawn source after a
    /// cancel or crash. Cleared only by an explicit unload.
    pub spec: Mutex<Option<ServerSpec>>,
    pub model: Mutex<(ModelState, Option<DiffusionError>)>,
    pub load_lock: AsyncMutex<()>,
    pub jobs: Arc<Mutex<HashMap<String, JobRecord>>>,
    pub job_order: Mutex<VecDeque<String>>,
    pub active_job: Arc<Mutex<Option<String>>>,
    pub idle_deadline: Mutex<Option<Instant>>,
    pub flags_lock: AsyncMutex<()>,
}

impl Default for ModelStatus {
    fn default() -> Self {
        Self {
            state: ModelState::Unloaded,
            loaded: None,
            error: None,
        }
    }
}

impl Default for DiffusionStateInner {
    fn default() -> Self {
        Self {
            config: Mutex::new(None),
            session: Arc::new(AsyncMutex::new(None)),
            spec: Mutex::new(None),
            model: Mutex::new((ModelState::Unloaded, None)),
            load_lock: AsyncMutex::new(()),
            jobs: Arc::new(Mutex::new(HashMap::new())),
            job_order: Mutex::new(VecDeque::new()),
            active_job: Arc::new(Mutex::new(None)),
            idle_deadline: Mutex::new(None),
            flags_lock: AsyncMutex::new(()),
        }
    }
}

impl DiffusionStateInner {
    pub fn data_folder(&self) -> Option<PathBuf> {
        self.config
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|c| PathBuf::from(&c.data_folder)))
    }

    pub fn require_data_folder(&self) -> Result<PathBuf, DiffusionError> {
        self.data_folder()
            .ok_or_else(DiffusionError::not_configured)
    }

    pub fn diffusion_root(&self) -> Result<PathBuf, DiffusionError> {
        Ok(self.require_data_folder()?.join("diffusion"))
    }

    pub fn backends_root(&self) -> Result<PathBuf, DiffusionError> {
        Ok(self.diffusion_root()?.join("backends"))
    }

    pub fn models_root(&self) -> Result<PathBuf, DiffusionError> {
        Ok(self.diffusion_root()?.join("models"))
    }

    pub fn scratch_dir(&self) -> Result<PathBuf, DiffusionError> {
        Ok(self.diffusion_root()?.join("scratch"))
    }

    pub fn output_dir(&self) -> Result<PathBuf, DiffusionError> {
        let guard = self
            .config
            .lock()
            .map_err(|_| DiffusionError::internal("Diffusion config is poisoned."))?;
        let config = guard.as_ref().ok_or_else(DiffusionError::not_configured)?;
        Ok(match &config.output_dir {
            Some(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
            _ => Path::new(&config.data_folder).join("images"),
        })
    }

    pub fn idle_unload_secs(&self) -> u64 {
        self.config
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().and_then(|c| c.idle_unload_secs))
            .unwrap_or(DEFAULT_IDLE_UNLOAD_SECS)
    }

    pub fn set_model_state(&self, state: ModelState, error: Option<DiffusionError>) {
        if let Ok(mut guard) = self.model.lock() {
            *guard = (state, error);
        }
    }

    pub fn model_state(&self) -> (ModelState, Option<DiffusionError>) {
        self.model
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or((ModelState::Unloaded, None))
    }

    pub fn spec(&self) -> Option<ServerSpec> {
        self.spec.lock().ok().and_then(|guard| guard.clone())
    }

    pub fn set_spec(&self, spec: Option<ServerSpec>) {
        if let Ok(mut guard) = self.spec.lock() {
            *guard = spec;
        }
    }

    pub fn active_job_id(&self) -> Option<String> {
        self.active_job.lock().ok().and_then(|guard| guard.clone())
    }

    /// Reset the idle-unload deadline; `None` disables it (0 = never).
    pub fn touch_idle(&self) {
        let secs = self.idle_unload_secs();
        if let Ok(mut guard) = self.idle_deadline.lock() {
            *guard = if secs == 0 {
                None
            } else {
                Some(Instant::now() + Duration::from_secs(secs))
            };
        }
    }

    pub fn clear_idle(&self) {
        if let Ok(mut guard) = self.idle_deadline.lock() {
            *guard = None;
        }
    }

    pub fn idle_expired(&self) -> bool {
        self.idle_deadline
            .lock()
            .ok()
            .and_then(|guard| guard.map(|deadline| Instant::now() >= deadline))
            .unwrap_or(false)
    }

    pub fn job(&self, id: &str) -> Option<ImageJob> {
        self.jobs
            .lock()
            .ok()
            .and_then(|guard| guard.get(id).map(|record| record.job.clone()))
    }

    pub fn active_job(&self) -> Option<ImageJob> {
        let id = self.active_job_id()?;
        self.job(&id)
            .filter(|job| matches!(job.state, ImageJobState::Queued | ImageJobState::Generating))
    }

    pub fn insert_job(&self, record: JobRecord) {
        let id = record.job.id.clone();
        let evicted: Vec<String> = match self.job_order.lock() {
            Ok(mut order) => {
                order.push_back(id.clone());
                let mut evicted = Vec::new();
                while order.len() > JOB_HISTORY {
                    if let Some(old) = order.pop_front() {
                        evicted.push(old);
                    }
                }
                evicted
            }
            Err(_) => Vec::new(),
        };
        if let Ok(mut jobs) = self.jobs.lock() {
            for old in evicted {
                jobs.remove(&old);
            }
            jobs.insert(id, record);
        }
    }

    pub fn update_job<F: FnOnce(&mut JobRecord)>(&self, id: &str, f: F) -> Option<ImageJob> {
        let mut jobs = self.jobs.lock().ok()?;
        let record = jobs.get_mut(id)?;
        f(record);
        Some(record.job.clone())
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
