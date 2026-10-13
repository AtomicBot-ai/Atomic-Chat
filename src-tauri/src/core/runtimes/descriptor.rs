//! What Radium knows about an inference runtime before it touches one.
//!
//! A descriptor is static: where the runtime runs, how Radium integrates it,
//! what it can serve, which formats it reads, where its telemetry comes from
//! and under which licence it ships. Everything that changes at run time (the
//! endpoint, the loaded model, the GPU it landed on) belongs to an instance,
//! not here.

use serde::Serialize;

/// The catalog section a runtime is listed under.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Group {
    LocalDesktop,
    ThroughputServer,
    ModelLibrary,
    ImageVideoSpeech,
    BrowserMobileEdge,
}

/// When the runtime is scheduled to be integrated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    /// Phase 1: native Windows engines.
    P0,
    /// Phase 1b/2: Python engines and library backends.
    P1,
    /// Phase 3: WSL-hosted throughput servers and second-line engines.
    P2,
    /// Phase 4: wrappers and low-value-on-this-hardware runtimes.
    P3,
    /// Recorded, re-checked periodically, not built.
    Deferred,
    /// Recorded with the reason; never built for this hardware.
    OutOfScope,
}

/// How Radium runs or reaches the runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Radium ships or downloads a pinned native binary and runs it as a
    /// private child process on 127.0.0.1.
    Bundled,
    /// Radium builds an isolated environment (a Python venv) on demand from a
    /// pinned lockfile, then runs the runtime's server from it.
    ManagedInstall,
    /// The user runs it; Radium connects to its API and never starts or stops it.
    Attach,
    /// Linked into Radium's own process or its web view.
    InProcess,
    /// Runs in a Radium-owned WSL2 distribution because it has no native
    /// Windows build.
    WslHosted,
    /// Not built for this hardware; the descriptor records why.
    OutOfScope,
}

/// Whether the runtime does the inference itself or hands it to another one.
/// Tokens are counted only at the engine layer, so a request that passes
/// through a wrapper is never counted twice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Layer {
    Engine,
    Wrapper,
    /// A library or framework other runtimes are built on; never an endpoint.
    Library,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Chat,
    Completion,
    Embeddings,
    Rerank,
    Vision,
    ImageGen,
    VideoGen,
    SpeechToText,
    TextToSpeech,
}

/// Model file formats, as named in the runtime catalog's format key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Format {
    Gguf,
    Safetensors,
    PytorchBin,
    Gptq,
    Awq,
    Fp8,
    Exl2,
    Exl3,
    Onnx,
    OpenvinoIr,
    TensorrtEngine,
    Mlx,
    Mlc,
    Ct2,
    GgmlBin,
    CoreMl,
    Tflite,
    Pte,
    Ncnn,
    Mnn,
    Paddle,
    Ckpt,
    DiffusersFolder,
    TfSavedModel,
    Orbax,
    OllamaPackage,
}

/// The API a runtime exposes that Radium would talk to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiSurface {
    /// `/v1/chat/completions` and friends.
    OpenAiCompatible,
    /// The runtime's own HTTP API.
    NativeHttp,
    /// KServe v2 inference protocol (`/v2/...`).
    KserveV2,
    /// AUTOMATIC1111-style `/sdapi/v1/*`.
    SdApi,
    Cli,
    PythonLibrary,
    CLibrary,
    JavaScript,
}

/// How a runtime can use more than one GPU on one machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MultiGpu {
    /// One GPU per process; two cards means two instances.
    PerProcess,
    /// Layers spread across cards: more capacity, not more speed.
    LayerSplit,
    /// Tensor parallelism across cards.
    TensorParallel,
    /// Both layer split and tensor parallelism are available.
    LayerOrTensor,
    /// Inherits whatever the engine underneath does.
    FromBackend,
    NotApplicable,
}

/// Where Helix gets numbers from for this runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TelemetrySource {
    /// Prometheus text exposition at `path`; `prefix` is the metric namespace.
    Prometheus {
        path: &'static str,
        prefix: &'static str,
        /// Off unless the runtime is started with a flag.
        needs_flag: Option<&'static str>,
    },
    /// OpenAI `usage` object on each response.
    ResponseUsage,
    /// Per-response timing fields (llama.cpp `timings`, Ollama `*_duration`).
    ResponseTimings,
    /// A runtime-specific status endpoint.
    StatusEndpoint { path: &'static str },
    /// Progress/execution events over a WebSocket.
    WebSocketEvents { path: &'static str },
    /// Timings measured by Radium's own worker around the call.
    WorkerMeasured,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Granularity {
    PerRequest,
    Aggregate,
    Both,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LicenseClass {
    /// MIT, Apache-2.0, BSD: may be bundled with notices.
    Permissive,
    /// GPL/AGPL: downloaded on the user's action and run as a separate
    /// process, never bundled into or linked with Radium.
    Copyleft,
    /// Closed or EULA-governed: attach only, or redistribute strictly per EULA.
    Proprietary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub struct License {
    pub spdx: &'static str,
    pub class: LicenseClass,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Maintenance {
    Active,
    LowActivity,
    MaintenanceMode,
    Archived,
}

/// How the runtime runs on one operating system.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Support {
    Native,
    /// Windows only: through WSL2 (or a Linux container on it).
    Wsl,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub struct Platforms {
    pub windows: Support,
    pub linux: Support,
    pub macos: Support,
}

/// One runtime in the catalog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct RuntimeDescriptor {
    /// Stable identifier: lowercase, digits and hyphens.
    pub id: &'static str,
    pub name: &'static str,
    pub group: Group,
    pub tier: Tier,
    pub mode: Mode,
    pub layer: Layer,
    /// For a wrapper: the catalog ids of engines it can run underneath.
    pub wraps: &'static [&'static str],
    pub capabilities: &'static [Capability],
    pub formats: &'static [Format],
    pub apis: &'static [ApiSurface],
    /// The port the runtime listens on unless told otherwise.
    pub default_port: Option<u16>,
    pub platforms: Platforms,
    pub multi_gpu: MultiGpu,
    pub telemetry: &'static [TelemetrySource],
    pub granularity: Granularity,
    pub license: License,
    pub maintenance: Maintenance,
    /// Why it is deferred or out of scope, or the one caveat that matters most.
    pub note: &'static str,
    /// True when the status facts were checked against the project's own
    /// repository or documentation on `verified_on`.
    pub verified: bool,
    pub verified_on: &'static str,
    pub source_url: &'static str,
}
