use serde::{Deserialize, Serialize};

fn default_parallel() -> i32 {
    1
}

fn default_concurrent_slots() -> i32 {
    8
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlamacppConfig {
    pub version_backend: String,
    pub auto_unload: bool,
    pub timeout: i32,
    pub llamacpp_env: String,
    pub fit: bool,
    pub fit_target: String,
    pub fit_ctx: String,
    pub chat_template: String,
    pub n_gpu_layers: i32,
    pub offload_mmproj: bool,
    pub cpu_moe: bool,
    pub n_cpu_moe: i32,
    pub override_tensor_buffer_t: String,
    pub ctx_size: i32,
    pub threads: i32,
    pub threads_batch: i32,
    pub n_predict: i32,
    pub batch_size: i32,
    pub ubatch_size: i32,
    pub device: String,
    pub split_mode: String,
    pub main_gpu: i32,
    pub flash_attn: String,
    pub cont_batching: bool,
    pub no_mmap: bool,
    pub mlock: bool,
    pub no_kv_offload: bool,
    pub cache_type_k: String,
    pub cache_type_v: String,
    pub defrag_thold: f32,
    pub rope_scaling: String,
    pub rope_scale: f32,
    pub rope_freq_base: f32,
    pub rope_freq_scale: f32,
    pub ctx_shift: bool,
    #[serde(default = "default_parallel")]
    pub parallel: i32,
    /// Master toggle: run llama-server in concurrent multi-slot mode.
    /// Overrides `parallel` and `cont_batching`, and exposes Prometheus
    /// `/metrics` by forcing `expose_metrics` on.
    #[serde(default)]
    pub concurrent_mode: bool,
    /// Number of parallel decoding slots when `concurrent_mode` is on.
    #[serde(default = "default_concurrent_slots")]
    pub concurrent_slots: i32,
    /// Pass `--metrics` to llama-server so `/metrics` is exposed.
    /// Independent switch; also implicitly enabled by `concurrent_mode`.
    #[serde(default)]
    pub expose_metrics: bool,
    /// Enable Multi-Token Prediction speculative decoding via the model's
    /// built-in MTP head (upstream PR #22673, `--spec-type draft-mtp`).
    /// Only meaningful for MTP-capable GGUFs (e.g. Qwen3.6-*-MTP-GGUF) and
    /// only honored on backend builds >= `MTP_MIN_BUILD`.
    #[serde(default)]
    pub mtp: bool,
    /// Absolute path to a SEPARATE MTP draft head GGUF (Gemma 4 31B / 26B-A4B,
    /// upstream PR #23398). When non-empty (and `mtp` is on), the backend is
    /// launched with `--model-draft <path> --spec-type draft-mtp`, gated on
    /// builds >= `GEMMA_MTP_MIN_BUILD`. Empty for Qwen-style built-in MTP
    /// (head inside the same GGUF), which keeps using the `MTP_MIN_BUILD` gate.
    #[serde(default)]
    pub mtp_draft_path: String,
    /// Enable DFlash multi-layer draft speculative decoding. Kept for config
    /// compatibility; the extension probes the installed binary before load.
    #[serde(default)]
    pub dflash: bool,
    /// True only when the installed llama-server advertises
    /// `--spec-type draft-dflash` in its help output.
    #[serde(default)]
    pub dflash_spec_supported: bool,
    /// Absolute path to a DFlash draft GGUF, resolved+downloaded by the TS
    /// extension (mirrors `mtp_draft_path`).
    #[serde(default)]
    pub dflash_draft_path: String,
    /// `--spec-draft-n-max` value, computed by TS from the user's block-size
    /// setting (n_max = block_size - 1). 0 means "use the Rust default".
    #[serde(default)]
    pub dflash_n_max: u32,
    /// Preserve supported reasoning traces across conversation turns.
    #[serde(default)]
    pub reasoning_preserve: bool,
    /// Additional llama-server arguments entered by the user.
    #[serde(default)]
    pub extra_args: String,
}

/// Minimum llama.cpp build number that changed --flash-attn from a boolean
/// flag to a string argument accepting auto|on|off (upstream PR #15434).
const FLASH_ATTN_STRING_ARG_MIN_BUILD: u32 = 6325;

/// Minimum upstream build number that contains the MTP speculative-decoding
/// merge (PR #22673, commit 2555826, merged 2026-05-16, first tagged release
/// b9180). On earlier builds the toggle is silently ignored.
const MTP_MIN_BUILD: u32 = 9180;

/// Minimum upstream build number that contains the Gemma 4 MTP merge
/// (PR #23398, commit 04eb4c4, first tagged release b9553). Gemma 4 uses a
/// SEPARATE draft head passed via `--model-draft`, distinct from Qwen's
/// built-in MTP head; it needs a newer backend than `MTP_MIN_BUILD`.
const GEMMA_MTP_MIN_BUILD: u32 = 9553;

/// First upstream release containing `--reasoning-preserve` (PR #25105).
const REASONING_PRESERVE_MIN_BUILD: u32 = 9837;

pub struct ArgumentBuilder {
    args: Vec<String>,
    config: LlamacppConfig,
    version: String,
    backend: String,
    is_embedding: bool,
}

impl ArgumentBuilder {
    pub fn new(mut config: LlamacppConfig, is_embedding: bool) -> Result<Self, String> {
        config.version_backend = config.version_backend.replace('\u{FEFF}', "");
        let mut parts = config.version_backend.splitn(2, '/');
        let version = parts
            .next()
            .ok_or("Invalid version_backend format")?
            .trim()
            .to_string();
        let backend = parts
            .next()
            .ok_or("Invalid version_backend format")?
            .trim()
            .to_string();

        Ok(Self {
            args: Vec::new(),
            config,
            version,
            backend,
            is_embedding,
        })
    }

    /// Parse the upstream llama.cpp build number out of a version string.
    /// Handles plain upstream tags ("b6325") and the unified TurboQuant tag
    /// shape ("b10018-1.3.0") a mislabeled backend may carry.
    fn parse_build_number(&self) -> Option<u32> {
        let rest = self.version.strip_prefix('b')?;
        let build = rest.split('-').next()?;
        build.parse::<u32>().ok()
    }

    /// Whether the installed backend came from the TurboQuant fork's release
    /// train, in either the legacy (`turboquant-<id>-<sha>`) or unified
    /// (`b<build>-<fork-semver>`) tag shape.
    ///
    /// This gates *argument serialization* only (the fork is always rebased
    /// past the `--flash-attn` string-argument change). It must never gate a
    /// capability: `sanitize_cache_type` below deliberately ignores it, so
    /// fork-only `turbo*` types can never leak into this provider even when a
    /// fork-tagged backend is installed under it.
    fn is_turboquant(&self) -> bool {
        let version = &self.version;
        if version.starts_with("turboquant-") {
            return true;
        }
        let Some(rest) = version.strip_prefix('b') else {
            return false;
        };
        let Some((build, fork_semver)) = rest.split_once('-') else {
            return false;
        };
        let is_number = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
        if !is_number(build) {
            return false;
        }
        let mut parts = fork_semver.split('.');
        let semver_ok = (0..3).all(|_| parts.next().is_some_and(is_number));
        semver_ok && parts.next().is_none()
    }

    /// Cache types supported by the pinned upstream llama.cpp provider.
    const STANDARD_CACHE_TYPES: &'static [&'static str] = &[
        "f32", "f16", "bf16", "q8_0", "q4_0", "q4_1", "iq4_nl", "q5_0", "q5_1",
    ];

    fn sanitize_cache_type(&self, value: &str) -> String {
        // Provider capability, not release identity: this provider ships stock
        // ggml-org builds, so only upstream cache types are ever emitted.
        if Self::STANDARD_CACHE_TYPES.contains(&value) {
            return value.to_string();
        }
        log::warn!(
            "Cache type '{}' is not supported by non-turboquant backend {}/{}; falling back to q8_0",
            value, self.version, self.backend
        );
        "q8_0".to_string()
    }

    /// Returns true when the backend id indicates a Vulkan build
    /// (e.g. `linux-vulkan-x64`, `windows-x64-vulkan`, `ubuntu-vulkan-x64`).
    fn is_vulkan_backend(&self) -> bool {
        self.backend.contains("vulkan")
    }

    /// Apply safety overrides for Vulkan backends before any argument is
    /// emitted.
    ///
    /// Flash attention set to "auto" is known to trigger GPU device-lost
    /// crashes on the first decode batch on some Vulkan driver/model
    /// combinations (ATO-244). Downgrade "auto" → "off" so the default
    /// is stable; users who have explicitly set "on" keep their choice.
    fn apply_vulkan_safety_overrides(&mut self) {
        if !self.is_vulkan_backend() {
            return;
        }
        if self.config.flash_attn == "auto" {
            log::info!(
                "Vulkan backend ({}): overriding flash_attn auto→off for stability (ATO-244). \
                 Re-enable in Settings → Provider → Flash Attention if needed.",
                self.backend
            );
            self.config.flash_attn = "off".to_string();
        }
    }

    /// Build all arguments based on configuration
    pub fn build(
        mut self,
        model_id: &str,
        model_path: &str,
        port: u16,
        mmproj_path: Option<String>,
    ) -> Vec<String> {
        // Apply Concurrent Mode overrides before emitting any flags so that
        // `add_parallel_settings` / `add_boolean_flags` pick up the overridden
        // values without duplicating flag emission logic.
        self.apply_concurrent_mode_overrides();
        // Apply Vulkan-specific safety defaults (ATO-244: flash_attn auto→off).
        self.apply_vulkan_safety_overrides();

        // Disable llama-server webui for non-ik backends
        if !self.backend.starts_with("ik") {
            self.args.push("--no-webui".to_string());
        }

        // Jinja template support
        self.args.push("--jinja".to_string());

        // Model path (required)
        self.args.push("-m".to_string());
        self.args.push(model_path.to_string());

        // CPU MOE settings
        self.add_cpu_moe_args();

        // Tensor buffer override
        self.add_tensor_buffer_override();

        // Multimodal projector settings
        self.add_mmproj_args(mmproj_path);

        // Model alias and port
        self.args.push("-a".to_string());
        self.args.push(model_id.to_string());
        self.args.push("--port".to_string());
        self.args.push(port.to_string());

        // Chat template
        self.add_chat_template();

        // GPU layers
        self.add_gpu_layers();

        // Thread settings
        self.add_thread_settings();

        // Batch settings
        self.add_batch_settings();

        // Device and split mode
        self.add_device_settings();

        // Flash attention
        self.add_flash_attention();

        // Boolean flags
        self.add_boolean_flags();

        // Parallel sequences
        self.add_parallel_settings();

        // MTP / DFlash speculative decoding (must come before embedding/text
        // branch so the toggle is honored uniformly; each method skips
        // embedding). Mutual exclusivity: the UI enforces a mutex, but as
        // defense-in-depth we prefer DFlash (the newer, more general
        // mechanism) and skip MTP when both are somehow enabled.
        if self.config.dflash && self.config.mtp {
            log::warn!(
                "Both MTP and DFlash are enabled; applying DFlash only and skipping MTP (DFlash takes precedence)"
            );
            self.add_dflash_args();
        } else {
            self.add_mtp_args();
            self.add_dflash_args();
        }

        // Prometheus /metrics endpoint
        self.add_metrics_flag();

        // Preserve supported reasoning traces across turns.
        self.add_reasoning_preserve_flag();

        // Embedding vs text generation specific args
        if self.is_embedding {
            self.add_embedding_args();
        } else {
            self.add_text_generation_args();
        }
        // llama fit
        // forks like ik is not supported
        if !self.backend.starts_with("ik") {
            self.add_fit_settings();
        }

        // User-supplied arguments come last so advanced users can override
        // an earlier llama-server option when its parser permits it.
        self.add_extra_args();

        self.args
    }

    fn add_cpu_moe_args(&mut self) {
        if self.config.cpu_moe {
            self.args.push("--cpu-moe".to_string());
        }

        if self.config.n_cpu_moe > 0 {
            self.args.push("--n-cpu-moe".to_string());
            self.args.push(self.config.n_cpu_moe.to_string());
        }
    }

    fn add_tensor_buffer_override(&mut self) {
        if !self.config.override_tensor_buffer_t.is_empty() {
            self.args.push("--override-tensor".to_string());
            self.args.push(self.config.override_tensor_buffer_t.clone());
        }
    }

    fn add_mmproj_args(&mut self, mmproj_path: Option<String>) {
        if let Some(path) = mmproj_path.filter(|p| !p.is_empty()) {
            self.args.push("--mmproj".to_string());
            self.args.push(path);
        }
    }

    fn add_chat_template(&mut self) {
        if !self.config.chat_template.is_empty() {
            self.args.push("--chat-template".to_string());
            self.args.push(self.config.chat_template.clone());
        }
    }

    fn add_gpu_layers(&mut self) {
        let gpu_layers = if self.config.n_gpu_layers >= 0 && self.config.n_gpu_layers != 100 {
            // 100 means load all layers
            self.config.n_gpu_layers
        } else {
            -1
        };
        self.args.push("-ngl".to_string());
        self.args.push(gpu_layers.to_string());
    }

    fn add_thread_settings(&mut self) {
        if self.config.threads > 0 {
            self.args.push("--threads".to_string());
            self.args.push(self.config.threads.to_string());
        }

        if self.config.threads_batch > 0 {
            self.args.push("--threads-batch".to_string());
            self.args.push(self.config.threads_batch.to_string());
        }
    }

    fn add_batch_settings(&mut self) {
        if self.config.batch_size > 0 && self.config.batch_size != 2048 {
            self.args.push("--batch-size".to_string());
            self.args.push(self.config.batch_size.to_string());
        }

        if self.config.ubatch_size > 0 && self.config.ubatch_size != 512 {
            self.args.push("--ubatch-size".to_string());
            self.args.push(self.config.ubatch_size.to_string());
        }
    }

    fn add_device_settings(&mut self) {
        if !self.config.device.is_empty() {
            self.args.push("--device".to_string());
            self.args.push(self.config.device.clone());
        }

        if !self.config.split_mode.is_empty() && self.config.split_mode != "layer" {
            self.args.push("--split-mode".to_string());
            self.args.push(self.config.split_mode.clone());
        }

        if self.config.main_gpu != 0 {
            self.args.push("--main-gpu".to_string());
            self.args.push(self.config.main_gpu.to_string());
        }
    }

    fn add_flash_attention(&mut self) {
        if self.backend.starts_with("ik") {
            // ik fork uses old -fa flag
            if self.config.flash_attn == "on" {
                self.args.push("-fa".to_string());
            }
            return;
        }

        // Mirror the turboquant plugin: any non-`b<N>` version that carries
        // the turboquant-style prefix is on a recent llama.cpp and must use
        // the string-arg form. Upstream `b<N>` releases keep the original
        // build-number gate.
        let supports_string_arg = self.is_turboquant()
            || self
                .parse_build_number()
                .is_some_and(|b| b >= FLASH_ATTN_STRING_ARG_MIN_BUILD);

        if supports_string_arg {
            // b6325+: --flash-attn accepts auto|on|off as a value
            match self.config.flash_attn.as_str() {
                "auto" | "on" | "off" => {
                    self.args.push("--flash-attn".to_string());
                    self.args.push(self.config.flash_attn.clone());
                }
                _ => {} // unknown value → don't pass
            }
        } else {
            // Older versions: --flash-attn is a boolean flag (no value)
            if self.config.flash_attn == "on" {
                self.args.push("--flash-attn".to_string());
            }
            // "auto" and "off" → don't pass --flash-attn
        }
    }

    fn add_boolean_flags(&mut self) {
        if self.config.ctx_shift {
            self.args.push("--context-shift".to_string());
        }

        if self.config.cont_batching {
            self.args.push("--cont-batching".to_string());
        }

        if self.config.no_mmap {
            self.args.push("--no-mmap".to_string());
        }

        if self.config.mlock {
            self.args.push("--mlock".to_string());
        }

        if self.config.no_kv_offload {
            self.args.push("--no-kv-offload".to_string());
        }
    }

    fn add_parallel_settings(&mut self) {
        if self.config.parallel > 0 {
            self.args.push("--parallel".to_string());
            self.args.push(self.config.parallel.to_string());
            if self.config.parallel == 1 {
                // https://github.com/ggml-org/llama.cpp/issues/17450
                self.args.push("-kvu".to_string());
            }
        }
    }

    /// Emits MTP speculative-decoding flags when the user enabled the
    /// provider-level toggle AND the backend build is recent enough.
    ///
    /// Two distinct shapes share the `mtp` toggle:
    /// * **Qwen built-in MTP** (head inside the same GGUF, `mtp_draft_path`
    ///   empty): emits `--spec-type draft-mtp --spec-draft-n-max 2`, gated on
    ///   `MTP_MIN_BUILD` (PR #22673, ~83% acceptance on Qwen3.6).
    /// * **Gemma 4 MTP** (separate draft head, `mtp_draft_path` set): also
    ///   emits `--model-draft <path>` and a larger `--spec-draft-n-max 4`,
    ///   gated on the newer `GEMMA_MTP_MIN_BUILD` (PR #23398, 31B / 26B-A4B).
    ///
    /// Skipped for embedding servers (speculative decoding is a text-gen
    /// concept) and for backend builds older than the relevant gate (we warn
    /// once instead of letting llama-server reject the flag).
    fn add_mtp_args(&mut self) {
        if !self.config.mtp {
            return;
        }
        if self.is_embedding {
            return;
        }

        let build = self.parse_build_number();
        let has_draft = !self.config.mtp_draft_path.is_empty();

        if has_draft {
            // Gemma 4: separate draft head via --model-draft.
            if !build.is_some_and(|b| b >= GEMMA_MTP_MIN_BUILD) {
                log::warn!(
                    "Gemma 4 MTP requested but backend build {}/{} predates the Gemma MTP merge (b{}); skipping --model-draft / --spec-type draft-mtp",
                    self.version,
                    self.backend,
                    GEMMA_MTP_MIN_BUILD
                );
                return;
            }
            // Some configs (q8_0 KV) + Vulkan regress to acceptance≈0 with
            // Gemma MTP (PR #23398 review). Warn so the symptom is diagnosable;
            // we don't override the user's KV choice.
            let k = self.config.cache_type_k.as_str();
            let v = self.config.cache_type_v.as_str();
            let k_quantized = !k.is_empty() && k != "f16";
            let v_quantized = !v.is_empty() && v != "f16";
            if k_quantized || v_quantized {
                log::warn!(
                    "Gemma 4 MTP is enabled with quantized KV cache (k={}, v={}); on some backends (notably Vulkan) this can drop draft acceptance to ~0 and slow generation. Consider f16 KV if MTP underperforms.",
                    if k.is_empty() { "f16" } else { k },
                    if v.is_empty() { "f16" } else { v }
                );
            }

            self.args.push("--model-draft".to_string());
            self.args.push(self.config.mtp_draft_path.clone());
            self.args.push("--spec-type".to_string());
            self.args.push("draft-mtp".to_string());
            self.args.push("--spec-draft-n-max".to_string());
            self.args.push("4".to_string());
            return;
        }

        // Qwen built-in MTP (head inside the same GGUF).
        if !build.is_some_and(|b| b >= MTP_MIN_BUILD) {
            log::warn!(
                "MTP requested but backend build {}/{} predates upstream MTP merge (b{}); skipping --spec-type draft-mtp",
                self.version,
                self.backend,
                MTP_MIN_BUILD
            );
            return;
        }
        self.args.push("--spec-type".to_string());
        self.args.push("draft-mtp".to_string());
        self.args.push("--spec-draft-n-max".to_string());
        self.args.push("2".to_string());
    }

    /// DFlash is emitted only after the extension probes the installed
    /// llama-server binary and confirms that `draft-dflash` is accepted.
    fn add_dflash_args(&mut self) {
        if !self.config.dflash {
            return;
        }
        if self.is_embedding {
            return;
        }
        if self.config.dflash_draft_path.is_empty() {
            log::warn!(
                "DFlash requested but no draft GGUF path is set; skipping --model-draft / --spec-type draft-dflash"
            );
            return;
        }
        if !self.config.dflash_spec_supported {
            log::warn!(
                "DFlash requested for backend {}/{} but this llama.cpp build does not advertise --spec-type draft-dflash; loading without DFlash",
                self.version,
                self.backend
            );
            return;
        }

        self.args.push("--model-draft".to_string());
        self.args.push(self.config.dflash_draft_path.clone());
        self.args.push("--spec-type".to_string());
        self.args.push("draft-dflash".to_string());
        self.args.push("--spec-draft-n-max".to_string());
        self.args.push(
            if self.config.dflash_n_max > 0 {
                self.config.dflash_n_max
            } else {
                15
            }
            .to_string(),
        );
    }

    /// Emits `--metrics` when the user explicitly requested Prometheus
    /// metrics (directly or via Concurrent Mode).
    fn add_metrics_flag(&mut self) {
        if self.config.expose_metrics {
            self.args.push("--metrics".to_string());
        }
    }

    fn add_reasoning_preserve_flag(&mut self) {
        if !self.config.reasoning_preserve || self.is_embedding {
            return;
        }

        if !self
            .parse_build_number()
            .is_some_and(|build| build >= REASONING_PRESERVE_MIN_BUILD)
        {
            log::warn!(
                "Reasoning preservation requested but backend build {}/{} predates upstream support (b{}); skipping --reasoning-preserve",
                self.version,
                self.backend,
                REASONING_PRESERVE_MIN_BUILD
            );
            return;
        }

        self.args.push("--reasoning-preserve".to_string());
    }

    fn parse_extra_args(value: &str) -> Result<Vec<String>, String> {
        let mut args = Vec::new();
        let mut current = String::new();
        let mut chars = value.chars().peekable();
        let mut quote = None;
        let mut started = false;

        while let Some(ch) = chars.next() {
            if let Some(delimiter) = quote {
                if ch == delimiter {
                    quote = None;
                } else if ch == '\\'
                    && chars
                        .peek()
                        .is_some_and(|next| *next == delimiter || *next == '\\')
                {
                    current.push(chars.next().expect("peeked character must exist"));
                } else {
                    current.push(ch);
                }
                continue;
            }

            match ch {
                '\'' | '"' => {
                    quote = Some(ch);
                    started = true;
                }
                '\\' if chars.peek().is_some_and(|next| {
                    next.is_whitespace() || *next == '\'' || *next == '"' || *next == '\\'
                }) =>
                {
                    current.push(chars.next().expect("peeked character must exist"));
                    started = true;
                }
                ch if ch.is_whitespace() => {
                    if started {
                        args.push(std::mem::take(&mut current));
                        started = false;
                    }
                }
                _ => {
                    current.push(ch);
                    started = true;
                }
            }
        }

        if let Some(delimiter) = quote {
            return Err(format!("unterminated {delimiter} quote"));
        }
        if started {
            args.push(current);
        }
        Ok(args)
    }

    fn add_extra_args(&mut self) {
        match Self::parse_extra_args(&self.config.extra_args) {
            Ok(args) => self.args.extend(args),
            Err(error) => log::warn!(
                "Ignoring invalid extra llama-server arguments: {}",
                error
            ),
        }
    }

    /// Apply "Concurrent Mode" overrides to `self.config` so the rest of the
    /// argument-emitting pipeline renders the expected multi-slot server
    /// configuration.
    ///
    /// Concurrent Mode guarantees:
    /// * `--parallel N`  with `N = max(concurrent_slots, 2)` (minimum 2 — a
    ///   single-slot server defeats the purpose of the toggle).
    /// * `--cont-batching` always on (required for meaningful multi-slot
    ///   throughput).
    /// * `--metrics` always exposed so the local API server can proxy
    ///   `/v1/metrics` for dashboards.
    fn apply_concurrent_mode_overrides(&mut self) {
        if !self.config.concurrent_mode {
            return;
        }

        let slots = self.config.concurrent_slots.max(2);
        self.config.parallel = slots;
        self.config.cont_batching = true;
        self.config.expose_metrics = true;
    }

    fn add_embedding_args(&mut self) {
        self.args.push("--embedding".to_string());
        self.args.push("--pooling".to_string());
        self.args.push("mean".to_string());
    }

    fn add_text_generation_args(&mut self) {
        if self.config.ctx_size > 0 && !self.config.fit {
            self.args.push("--ctx-size".to_string());
            self.args.push(self.config.ctx_size.to_string());
        }

        if self.config.n_predict > 0 {
            self.args.push("--n-predict".to_string());
            self.args.push(self.config.n_predict.to_string());
        }

        if !self.config.cache_type_k.is_empty() && self.config.cache_type_k != "f16" {
            let safe_k = self.sanitize_cache_type(&self.config.cache_type_k);
            if safe_k != "f16" {
                self.args.push("--cache-type-k".to_string());
                self.args.push(safe_k);
            }
        }

        if self.config.flash_attn != "off"
            && !self.config.cache_type_v.is_empty()
            && self.config.cache_type_v != "f16"
            && self.config.cache_type_v != "f32"
        {
            let safe_v = self.sanitize_cache_type(&self.config.cache_type_v);
            if safe_v != "f16" && safe_v != "f32" {
                self.args.push("--cache-type-v".to_string());
                self.args.push(safe_v);
            }
        }

        if (self.config.defrag_thold - 0.1).abs() > f32::EPSILON {
            self.args.push("--defrag-thold".to_string());
            self.args.push(self.config.defrag_thold.to_string());
        }

        self.add_rope_settings();
    }

    fn add_rope_settings(&mut self) {
        if !self.config.rope_scaling.is_empty() && self.config.rope_scaling != "none" {
            self.args.push("--rope-scaling".to_string());
            self.args.push(self.config.rope_scaling.clone());
        }

        if (self.config.rope_scale - 1.0).abs() > f32::EPSILON {
            self.args.push("--rope-scale".to_string());
            self.args.push(self.config.rope_scale.to_string());
        }

        if self.config.rope_freq_base != 0.0 {
            self.args.push("--rope-freq-base".to_string());
            self.args.push(self.config.rope_freq_base.to_string());
        }

        if (self.config.rope_freq_scale - 1.0).abs() > f32::EPSILON {
            self.args.push("--rope-freq-scale".to_string());
            self.args.push(self.config.rope_freq_scale.to_string());
        }
    }

    fn add_fit_settings(&mut self) {
        // Handle fit on/off
        if !self.config.fit {
            self.args.push("--fit".to_string());
            self.args.push("off".to_string());
        } else if self.config.fit {
            self.args.push("--fit".to_string());
            self.args.push("on".to_string());
        }
        if self.config.fit {
            if !self.config.fit_ctx.is_empty() && self.config.fit_ctx != "4096" {
                self.args.push("--fit-ctx".to_string());
                self.args.push(self.config.fit_ctx.clone());
            }

            if !self.config.fit_target.is_empty() && self.config.fit_target != "1024" {
                self.args.push("--fit-target".to_string());
                self.args.push(self.config.fit_target.clone());
            }
        }
    }
}
// -- Tests
#[cfg(test)]
mod tests {
    use super::*;

    fn default_config() -> LlamacppConfig {
        LlamacppConfig {
            version_backend: "v1.0/standard".to_string(),
            auto_unload: false,
            timeout: 120,
            llamacpp_env: String::new(),
            fit: false,
            fit_ctx: String::new(),
            fit_target: String::new(),
            chat_template: String::new(),
            n_gpu_layers: 100,
            offload_mmproj: true,
            cpu_moe: false,
            n_cpu_moe: 0,
            override_tensor_buffer_t: String::new(),
            ctx_size: 2048,
            threads: 0,
            threads_batch: 0,
            n_predict: 0,
            batch_size: 0,
            ubatch_size: 0,
            device: String::new(),
            split_mode: "layer".to_string(),
            main_gpu: 0,
            flash_attn: "auto".to_string(),
            cont_batching: false,
            no_mmap: false,
            mlock: false,
            no_kv_offload: false,
            cache_type_k: "f16".to_string(),
            cache_type_v: "f16".to_string(),
            defrag_thold: 0.1,
            rope_scaling: "none".to_string(),
            rope_scale: 1.0,
            rope_freq_base: 0.0,
            rope_freq_scale: 1.0,
            ctx_shift: false,
            parallel: 1,
            concurrent_mode: false,
            concurrent_slots: 8,
            expose_metrics: false,
            mtp: false,
            mtp_draft_path: String::new(),
            dflash: false,
            dflash_spec_supported: false,
            dflash_draft_path: String::new(),
            dflash_n_max: 0,
            reasoning_preserve: false,
            extra_args: String::new(),
        }
    }

    fn assert_arg_pair(args: &[String], flag: &str, value: &str) {
        let pos = args
            .iter()
            .position(|arg| arg == flag)
            .unwrap_or_else(|| panic!("Flag '{}' not found in args: {:?}", flag, args));
        assert_eq!(
            args.get(pos + 1).unwrap(),
            value,
            "Expected '{}' after flag '{}', but got '{:?}'",
            value,
            flag,
            args.get(pos + 1)
        );
    }

    fn assert_has_flag(args: &[String], flag: &str) {
        assert!(
            args.contains(&flag.to_string()),
            "Flag '{}' not found in args: {:?}",
            flag,
            args
        );
    }

    fn assert_no_flag(args: &[String], flag: &str) {
        assert!(
            !args.contains(&flag.to_string()),
            "Flag '{}' should not be present in args: {:?}",
            flag,
            args
        );
    }

    #[test]
    fn test_basic_required_arguments() {
        let config = default_config();
        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test-model", "/path/to/model", 8080, None);

        assert_has_flag(&args, "--no-webui");
        assert_has_flag(&args, "--jinja");
        assert_arg_pair(&args, "-m", "/path/to/model");
        assert_arg_pair(&args, "-a", "test-model");
        assert_arg_pair(&args, "--port", "8080");
    }

    #[test]
    fn test_gpu_layers_default_100() {
        let config = default_config();
        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "-ngl", "-1");
    }

    #[test]
    fn test_gpu_layers_custom_value() {
        let mut config = default_config();
        config.n_gpu_layers = 32;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "-ngl", "32");
    }

    #[test]
    fn test_gpu_layers_negative_value() {
        let mut config = default_config();
        config.n_gpu_layers = -1;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "-ngl", "-1");
    }

    #[test]
    fn test_embedding_mode_arguments() {
        let config = default_config();
        let builder = ArgumentBuilder::new(config, true).unwrap();
        let args = builder.build("embed-model", "/path/to/model", 8080, None);

        assert_has_flag(&args, "--embedding");
        assert_arg_pair(&args, "--pooling", "mean");
    }

    #[test]
    fn test_text_generation_mode_no_embedding_flags() {
        let config = default_config();
        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--embedding");
        assert_no_flag(&args, "--pooling");
    }

    #[test]
    fn test_thread_settings() {
        let mut config = default_config();
        config.threads = 8;
        config.threads_batch = 4;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--threads", "8");
        assert_arg_pair(&args, "--threads-batch", "4");
    }

    #[test]
    fn test_thread_settings_zero_not_added() {
        let config = default_config();
        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--threads");
        assert_no_flag(&args, "--threads-batch");
    }

    #[test]
    fn test_batch_settings_default_values_not_added() {
        let mut config = default_config();
        config.batch_size = 2048;
        config.ubatch_size = 512;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--batch-size");
        assert_no_flag(&args, "--ubatch-size");
    }

    #[test]
    fn test_batch_settings_custom_values() {
        let mut config = default_config();
        config.batch_size = 1024;
        config.ubatch_size = 256;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--batch-size", "1024");
        assert_arg_pair(&args, "--ubatch-size", "256");
    }

    #[test]
    fn test_ik_backend_no_webui_flag() {
        let mut config = default_config();
        config.version_backend = "v1.0/ik-backend".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--no-webui");
    }

    #[test]
    fn test_standard_backend_flash_attention() {
        let mut config = default_config();
        config.flash_attn = "on".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_has_flag(&args, "--flash-attn");
        assert_no_flag(&args, "-fa");
    }

    #[test]
    fn test_old_version_flash_attention_off_not_added() {
        let mut config = default_config();
        config.version_backend = "b6000/standard".to_string();
        config.flash_attn = "off".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--flash-attn");
        assert_no_flag(&args, "-fa");
    }

    #[test]
    fn test_new_version_flash_attention_off_sends_value() {
        let mut config = default_config();
        config.version_backend = "b6325/standard".to_string();
        config.flash_attn = "off".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--flash-attn", "off");
        assert_no_flag(&args, "-fa");
    }

    #[test]
    fn test_ik_backend_flash_attention() {
        let mut config = default_config();
        config.version_backend = "v1.0/ik-backend".to_string();
        config.flash_attn = "on".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_has_flag(&args, "-fa");
        assert_no_flag(&args, "--flash-attn");
    }

    #[test]
    fn test_flash_attention_auto_not_added() {
        let config = default_config();
        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--flash-attn");
    }

    // A fork-tagged backend can end up installed under this provider (manual
    // copy, migrated folder). Its tag may unlock the modern `--flash-attn`
    // spelling, but never a fork-only cache type: this provider ships stock
    // ggml-org builds that cannot parse `turbo*`.
    #[test]
    fn test_unified_fork_tag_never_unlocks_fork_cache_types() {
        let mut config = default_config();
        config.version_backend = "b10018-1.3.0/win-cuda-13.3-x64".to_string();
        config.cache_type_k = "turbo3".to_string();
        config.cache_type_v = "turbo3".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        assert!(builder.is_turboquant());
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--cache-type-k", "q8_0");
        assert_arg_pair(&args, "--cache-type-v", "q8_0");
    }

    #[test]
    fn test_unified_fork_tag_still_yields_the_upstream_build_number() {
        let mut config = default_config();
        config.version_backend = "b10018-1.3.0/linux-vulkan-x64".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();

        assert_eq!(builder.parse_build_number(), Some(10018));
    }

    // --- Vulkan safety-override tests (ATO-244) ---

    #[test]
    fn test_vulkan_backend_flash_attn_auto_forced_off() {
        // flash_attn="auto" on a Vulkan backend must be downgraded to "off"
        // to prevent GPU device-lost crashes during the first decode batch.
        let mut config = default_config();
        config.version_backend = "b9691/linux-vulkan-x64".to_string();
        config.flash_attn = "auto".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--flash-attn", "off");
    }

    #[test]
    fn test_vulkan_backend_flash_attn_explicit_on_preserved() {
        // An explicit user choice of "on" is NOT overridden.
        let mut config = default_config();
        config.version_backend = "b9691/linux-vulkan-x64".to_string();
        config.flash_attn = "on".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--flash-attn", "on");
    }

    #[test]
    fn test_vulkan_backend_flash_attn_explicit_off_preserved() {
        let mut config = default_config();
        config.version_backend = "b9691/linux-vulkan-x64".to_string();
        config.flash_attn = "off".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--flash-attn", "off");
    }

    #[test]
    fn test_non_vulkan_backend_flash_attn_auto_unaffected() {
        // Non-Vulkan backends must NOT get the override.
        let mut config = default_config();
        config.version_backend = "b9691/linux-cpu-x64".to_string();
        config.flash_attn = "auto".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        // auto is sent as-is on non-Vulkan (it's a recognised value for b6325+)
        assert_arg_pair(&args, "--flash-attn", "auto");
    }

    #[test]
    fn test_turboquant_windows_vulkan_backend_flash_attn_auto_forced_off() {
        // Turboquant-format Windows Vulkan backend: is_turboquant() → true →
        // supports_string_arg → true → --flash-attn off is emitted.
        let mut config = default_config();
        config.version_backend =
            "turboquant-windows-x64-vulkan-d86eb0b/windows-x64-vulkan".to_string();
        config.flash_attn = "auto".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--flash-attn", "off");
    }

    // Mirror of the turboquant-plugin regression test: even though the
    // upstream plugin is normally driven by `b<N>` releases, the same
    // `is_turboquant()` branch must serialize the string form when the
    // user-installed backend happens to be a turboquant-named one.
    #[test]
    fn test_turboquant_flash_attention_on_uses_string_form() {
        let mut config = default_config();
        config.version_backend = "turboquant-macos-arm64-0a635dc/macos-arm64".to_string();
        config.flash_attn = "on".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--flash-attn", "on");
    }

    #[test]
    fn test_turboquant_flash_attention_off_uses_string_form() {
        let mut config = default_config();
        config.version_backend = "turboquant-macos-arm64-0a635dc/macos-arm64".to_string();
        config.flash_attn = "off".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--flash-attn", "off");
    }

    #[test]
    fn test_turboquant_flash_attention_auto_uses_string_form() {
        let mut config = default_config();
        config.version_backend = "turboquant-macos-arm64-0a635dc/macos-arm64".to_string();
        config.flash_attn = "auto".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--flash-attn", "auto");
    }

    #[test]
    fn test_cpu_moe_flags() {
        let mut config = default_config();
        config.cpu_moe = true;
        config.n_cpu_moe = 4;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_has_flag(&args, "--cpu-moe");
        assert_arg_pair(&args, "--n-cpu-moe", "4");
    }

    #[test]
    fn test_cpu_moe_zero_not_added() {
        let mut config = default_config();
        config.cpu_moe = false;
        config.n_cpu_moe = 0;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--cpu-moe");
        assert_no_flag(&args, "--n-cpu-moe");
    }

    #[test]
    fn test_mmproj_path_provided() {
        let config = default_config();
        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, Some("/path/to/mmproj".to_string()));

        assert_arg_pair(&args, "--mmproj", "/path/to/mmproj");
    }

    #[test]
    fn test_mmproj_path_empty_not_added() {
        let config = default_config();
        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, Some(String::new()));

        assert_no_flag(&args, "--mmproj");
    }

    #[test]
    fn test_chat_template() {
        let mut config = default_config();
        config.chat_template = "custom-template".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--chat-template", "custom-template");
    }

    #[test]
    fn test_empty_chat_template_not_added() {
        let config = default_config();
        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--chat-template");
    }

    #[test]
    fn test_device_settings() {
        let mut config = default_config();
        config.device = "cuda:0".to_string();
        config.split_mode = "row".to_string();
        config.main_gpu = 1;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--device", "cuda:0");
        assert_arg_pair(&args, "--split-mode", "row");
        assert_arg_pair(&args, "--main-gpu", "1");
    }

    #[test]
    fn test_split_mode_layer_default_not_added() {
        let config = default_config();
        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--split-mode");
    }

    #[test]
    fn test_main_gpu_zero_not_added() {
        let config = default_config();
        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--main-gpu");
    }

    #[test]
    fn test_boolean_flags_enabled() {
        let mut config = default_config();
        config.ctx_shift = true;
        config.cont_batching = true;
        config.no_mmap = true;
        config.mlock = true;
        config.no_kv_offload = true;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_has_flag(&args, "--context-shift");
        assert_has_flag(&args, "--cont-batching");
        assert_has_flag(&args, "--no-mmap");
        assert_has_flag(&args, "--mlock");
        assert_has_flag(&args, "--no-kv-offload");
    }

    #[test]
    fn test_boolean_flags_disabled() {
        let config = default_config();
        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--context-shift");
        assert_no_flag(&args, "--cont-batching");
        assert_no_flag(&args, "--no-mmap");
        assert_no_flag(&args, "--mlock");
        assert_no_flag(&args, "--no-kv-offload");
    }

    #[test]
    fn test_ctx_size_custom_value() {
        let mut config = default_config();
        config.ctx_size = 4096;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--ctx-size", "4096");
    }

    #[test]
    fn test_n_predict() {
        let mut config = default_config();
        config.n_predict = 512;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--n-predict", "512");
    }

    #[test]
    fn test_cache_type_k_default_not_added() {
        let config = default_config();
        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--cache-type-k");
    }

    #[test]
    fn test_cache_type_k_custom_value() {
        let mut config = default_config();
        config.cache_type_k = "q8_0".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--cache-type-k", "q8_0");
    }

    #[test]
    fn test_cache_type_v_with_flash_attn() {
        let mut config = default_config();
        config.flash_attn = "on".to_string();
        config.cache_type_v = "q8_0".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--cache-type-v", "q8_0");
    }

    #[test]
    fn test_cache_type_v_without_flash_attn_not_added() {
        let mut config = default_config();
        config.flash_attn = "off".to_string();
        config.cache_type_v = "q8_0".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--cache-type-v");
    }

    #[test]
    fn test_cache_type_v_with_auto_flash_attn() {
        // "auto" != "off", so cache_type_v should be included (changed from requiring "on")
        let mut config = default_config(); // flash_attn defaults to "auto"
        config.cache_type_v = "q8_0".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--cache-type-v", "q8_0");
    }

    #[test]
    fn test_cache_type_v_f16_not_added() {
        let mut config = default_config();
        config.flash_attn = "on".to_string();
        config.cache_type_v = "f16".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--cache-type-v");
    }

    #[test]
    fn test_cache_type_turbo3_falls_back_on_non_turboquant() {
        let mut config = default_config();
        config.version_backend = "b8149/macos-arm64".to_string();
        config.cache_type_k = "turbo3".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--cache-type-k", "q8_0");
    }

    #[test]
    fn test_cache_type_turbo3_cannot_leak_through_mislabeled_upstream_version() {
        let mut config = default_config();
        config.version_backend = "turboquant-macos-arm64-abc123/macos-arm64".to_string();
        config.cache_type_k = "turbo3".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--cache-type-k", "q8_0");
    }

    #[test]
    fn test_cache_type_v_turbo3_falls_back_on_non_turboquant() {
        let mut config = default_config();
        config.version_backend = "b8149/macos-arm64".to_string();
        config.flash_attn = "on".to_string();
        config.cache_type_v = "turbo3".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--cache-type-v", "q8_0");
    }

    #[test]
    fn test_defrag_thold_default_not_added() {
        let config = default_config();
        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--defrag-thold");
    }

    #[test]
    fn test_defrag_thold_custom_value() {
        let mut config = default_config();
        config.defrag_thold = 0.5;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--defrag-thold", "0.5");
    }

    #[test]
    fn test_rope_scaling_none_not_added() {
        let config = default_config();
        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--rope-scaling");
    }

    #[test]
    fn test_rope_scaling_custom_value() {
        let mut config = default_config();
        config.rope_scaling = "linear".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--rope-scaling", "linear");
    }

    #[test]
    fn test_rope_scale_default_not_added() {
        let config = default_config();
        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--rope-scale");
    }

    #[test]
    fn test_rope_scale_custom_value() {
        let mut config = default_config();
        config.rope_scale = 2.0;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--rope-scale", "2");
    }

    #[test]
    fn test_rope_freq_base_zero_not_added() {
        let config = default_config();
        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--rope-freq-base");
    }

    #[test]
    fn test_rope_freq_base_custom_value() {
        let mut config = default_config();
        config.rope_freq_base = 10000.0;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--rope-freq-base", "10000");
    }

    #[test]
    fn test_rope_freq_scale_default_not_added() {
        let config = default_config();
        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--rope-freq-scale");
    }

    #[test]
    fn test_rope_freq_scale_custom_value() {
        let mut config = default_config();
        config.rope_freq_scale = 0.5;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--rope-freq-scale", "0.5");
    }

    #[test]
    fn test_tensor_buffer_override() {
        let mut config = default_config();
        config.override_tensor_buffer_t = "f32".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--override-tensor", "f32");
    }

    #[test]
    fn test_fit_off() {
        let mut config = default_config();
        config.fit = false;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--fit", "off");
        assert_no_flag(&args, "--fit-ctx");
        assert_no_flag(&args, "--fit-target");
    }

    #[test]
    fn test_fit_on_with_defaults() {
        let mut config = default_config();
        config.fit = true;
        config.fit_ctx = "4096".to_string();
        config.fit_target = "1024".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--fit", "on");
        assert_no_flag(&args, "--fit-ctx");
        assert_no_flag(&args, "--fit-target");
    }

    #[test]
    fn test_fit_on_with_custom_values() {
        let mut config = default_config();
        config.fit = true;
        config.fit_ctx = "8192".to_string();
        config.fit_target = "2048".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--fit", "on");
        assert_arg_pair(&args, "--fit-ctx", "8192");
        assert_arg_pair(&args, "--fit-target", "2048");
    }

    #[test]
    fn test_fit_not_added_for_ik_backend() {
        let mut config = default_config();
        config.version_backend = "v1.0/ik-backend".to_string();
        config.fit = true;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--fit");
        assert_no_flag(&args, "--fit-ctx");
        assert_no_flag(&args, "--fit-target");
    }

    #[test]
    fn test_invalid_version_backend_format() {
        let mut config = default_config();
        config.version_backend = "invalid-format".to_string();

        let result = ArgumentBuilder::new(config, false);
        assert!(result.is_err());
        if let Err(e) = result {
            assert_eq!(e, "Invalid version_backend format");
        }
    }

    #[test]
    fn test_complex_configuration() {
        let mut config = default_config();
        config.n_gpu_layers = 50;
        config.threads = 16;
        config.threads_batch = 8;
        config.batch_size = 1024;
        config.ctx_size = 4096;
        config.flash_attn = "on".to_string();
        config.cont_batching = true;
        config.rope_scaling = "linear".to_string();
        config.rope_scale = 2.0;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("complex-model", "/model/path", 9000, None);

        assert_arg_pair(&args, "-ngl", "50");
        assert_arg_pair(&args, "--threads", "16");
        assert_arg_pair(&args, "--threads-batch", "8");
        assert_arg_pair(&args, "--batch-size", "1024");
        assert_arg_pair(&args, "--ctx-size", "4096");
        assert_has_flag(&args, "--flash-attn");
        assert_has_flag(&args, "--cont-batching");
        assert_arg_pair(&args, "--rope-scaling", "linear");
        assert_arg_pair(&args, "--rope-scale", "2");
        assert_arg_pair(&args, "--port", "9000");
    }

    #[test]
    fn test_parallel_not_added_when_zero() {
        let mut config = default_config();
        config.parallel = 0;
        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--parallel");
        assert_no_flag(&args, "-kvu");
    }

    #[test]
    fn test_parallel_1_adds_parallel_and_kvu() {
        let config = default_config(); // default is 1

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--parallel", "1");
        assert_has_flag(&args, "-kvu");
    }

    #[test]
    fn test_parallel_greater_than_1_no_kvu() {
        let mut config = default_config();
        config.parallel = 4;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--parallel", "4");
        assert_no_flag(&args, "-kvu");
    }

    #[test]
    fn test_concurrent_mode_off_is_noop() {
        let config = default_config();
        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--metrics");
        assert_arg_pair(&args, "--parallel", "1");
        assert_no_flag(&args, "--cont-batching");
    }

    #[test]
    fn test_concurrent_mode_enforces_slots_cont_batching_and_metrics() {
        let mut config = default_config();
        config.concurrent_mode = true;
        config.concurrent_slots = 8;
        config.parallel = 1;
        config.cont_batching = false;
        config.expose_metrics = false;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--parallel", "8");
        assert_no_flag(&args, "-kvu");
        assert_has_flag(&args, "--cont-batching");
        assert_has_flag(&args, "--metrics");
    }

    #[test]
    fn test_concurrent_mode_enforces_minimum_two_slots() {
        let mut config = default_config();
        config.concurrent_mode = true;
        config.concurrent_slots = 1;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--parallel", "2");
        assert_no_flag(&args, "-kvu");
        assert_has_flag(&args, "--cont-batching");
        assert_has_flag(&args, "--metrics");
    }

    #[test]
    fn test_expose_metrics_without_concurrent_mode() {
        let mut config = default_config();
        config.expose_metrics = true;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_has_flag(&args, "--metrics");
        assert_arg_pair(&args, "--parallel", "1");
        assert_no_flag(&args, "--cont-batching");
    }

    #[test]
    fn test_mtp_off_no_spec_flags() {
        let mut config = default_config();
        config.version_backend = "b9180/standard".to_string();
        config.mtp = false;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--spec-type");
        assert_no_flag(&args, "--spec-draft-n-max");
    }

    #[test]
    fn test_mtp_on_emits_spec_flags() {
        let mut config = default_config();
        config.version_backend = "b9180/standard".to_string();
        config.mtp = true;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--spec-type", "draft-mtp");
        assert_arg_pair(&args, "--spec-draft-n-max", "2");
    }

    #[test]
    fn test_mtp_skipped_on_old_build() {
        let mut config = default_config();
        config.version_backend = "b9179/standard".to_string();
        config.mtp = true;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--spec-type");
        assert_no_flag(&args, "--spec-draft-n-max");
    }

    #[test]
    fn test_mtp_skipped_in_embedding_mode() {
        let mut config = default_config();
        config.version_backend = "b9180/standard".to_string();
        config.mtp = true;

        let builder = ArgumentBuilder::new(config, true).unwrap();
        let args = builder.build("test", "/path", 8080, None);

        assert_no_flag(&args, "--spec-type");
        assert_no_flag(&args, "--spec-draft-n-max");
    }

    #[test]
    fn test_gemma_mtp_emits_model_draft_and_spec_flags() {
        let mut config = default_config();
        config.version_backend = "b9553/standard".to_string();
        config.mtp = true;
        config.mtp_draft_path = "/path/to/mtp-draft.gguf".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("gemma-4-31b-it", "/path", 8080, None);

        assert_arg_pair(&args, "--model-draft", "/path/to/mtp-draft.gguf");
        assert_arg_pair(&args, "--spec-type", "draft-mtp");
        assert_arg_pair(&args, "--spec-draft-n-max", "4");
    }

    #[test]
    fn test_gemma_mtp_skipped_below_gemma_min_build() {
        // b9180 is new enough for Qwen built-in MTP but predates the Gemma
        // MTP merge (b9553): with a draft path it must be skipped entirely.
        let mut config = default_config();
        config.version_backend = "b9180/standard".to_string();
        config.mtp = true;
        config.mtp_draft_path = "/path/to/mtp-draft.gguf".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("gemma-4-31b-it", "/path", 8080, None);

        assert_no_flag(&args, "--model-draft");
        assert_no_flag(&args, "--spec-type");
        assert_no_flag(&args, "--spec-draft-n-max");
    }

    #[test]
    fn test_qwen_mtp_unaffected_by_gemma_gate() {
        // No draft path → Qwen path, gated on MTP_MIN_BUILD (b9180), no
        // --model-draft, n-max stays 2.
        let mut config = default_config();
        config.version_backend = "b9180/standard".to_string();
        config.mtp = true;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("qwen3.6-27b-mtp", "/path", 8080, None);

        assert_no_flag(&args, "--model-draft");
        assert_arg_pair(&args, "--spec-type", "draft-mtp");
        assert_arg_pair(&args, "--spec-draft-n-max", "2");
    }

    #[test]
    fn test_gemma_mtp_skipped_in_embedding_mode() {
        let mut config = default_config();
        config.version_backend = "b9553/standard".to_string();
        config.mtp = true;
        config.mtp_draft_path = "/path/to/mtp-draft.gguf".to_string();

        let builder = ArgumentBuilder::new(config, true).unwrap();
        let args = builder.build("gemma-4-31b-it", "/path", 8080, None);

        assert_no_flag(&args, "--model-draft");
        assert_no_flag(&args, "--spec-type");
    }

    #[test]
    fn test_dflash_off_no_spec_flags() {
        let mut config = default_config();
        config.version_backend = "b10205/standard".to_string();
        config.dflash = false;
        config.dflash_draft_path = "/path/to/dflash-draft.gguf".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("qwen3.6-27b", "/path", 8080, None);

        assert_no_flag(&args, "--model-draft");
        assert_no_flag(&args, "--spec-type");
        assert_no_flag(&args, "--spec-draft-n-max");
    }

    #[test]
    fn test_dflash_on_skips_unsupported_upstream_spec_type() {
        let mut config = default_config();
        config.version_backend = "b10205/standard".to_string();
        config.dflash = true;
        config.dflash_draft_path = "/path/to/dflash-draft.gguf".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("qwen3.6-27b", "/path", 8080, None);

        assert_no_flag(&args, "--model-draft");
        assert_no_flag(&args, "--spec-type");
        assert_no_flag(&args, "--spec-draft-n-max");
    }

    #[test]
    fn test_dflash_on_emits_spec_flags_when_probe_supports_it() {
        let mut config = default_config();
        config.version_backend = "b10205/standard".to_string();
        config.dflash = true;
        config.dflash_spec_supported = true;
        config.dflash_draft_path = "/path/to/dflash-draft.gguf".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("qwen3.6-27b", "/path", 8080, None);

        assert_arg_pair(&args, "--model-draft", "/path/to/dflash-draft.gguf");
        assert_arg_pair(&args, "--spec-type", "draft-dflash");
        assert_arg_pair(&args, "--spec-draft-n-max", "15");
    }

    #[test]
    fn test_dflash_custom_n_max_skipped_with_unsupported_upstream_spec_type() {
        let mut config = default_config();
        config.version_backend = "b10205/standard".to_string();
        config.dflash = true;
        config.dflash_draft_path = "/path/to/dflash-draft.gguf".to_string();
        config.dflash_n_max = 7;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("qwen3.6-27b", "/path", 8080, None);

        assert_no_flag(&args, "--model-draft");
        assert_no_flag(&args, "--spec-type");
        assert_no_flag(&args, "--spec-draft-n-max");
    }

    #[test]
    fn test_dflash_custom_n_max_emits_when_probe_supports_it() {
        let mut config = default_config();
        config.version_backend = "b10205/standard".to_string();
        config.dflash = true;
        config.dflash_spec_supported = true;
        config.dflash_draft_path = "/path/to/dflash-draft.gguf".to_string();
        config.dflash_n_max = 7;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("qwen3.6-27b", "/path", 8080, None);

        assert_arg_pair(&args, "--spec-draft-n-max", "7");
    }

    #[test]
    fn test_dflash_skipped_on_all_upstream_builds() {
        let mut config = default_config();
        config.version_backend = "b9830/standard".to_string();
        config.dflash = true;
        config.dflash_draft_path = "/path/to/dflash-draft.gguf".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("qwen3.6-27b", "/path", 8080, None);

        assert_no_flag(&args, "--model-draft");
        assert_no_flag(&args, "--spec-type");
        assert_no_flag(&args, "--spec-draft-n-max");
    }

    #[test]
    fn test_dflash_skipped_without_draft_path() {
        let mut config = default_config();
        config.version_backend = "b10205/standard".to_string();
        config.dflash = true;

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("qwen3.6-27b", "/path", 8080, None);

        assert_no_flag(&args, "--model-draft");
        assert_no_flag(&args, "--spec-type");
        assert_no_flag(&args, "--spec-draft-n-max");
    }

    #[test]
    fn test_dflash_skipped_in_embedding_mode() {
        let mut config = default_config();
        config.version_backend = "b10205/standard".to_string();
        config.dflash = true;
        config.dflash_draft_path = "/path/to/dflash-draft.gguf".to_string();

        let builder = ArgumentBuilder::new(config, true).unwrap();
        let args = builder.build("qwen3.6-27b", "/path", 8080, None);

        assert_no_flag(&args, "--model-draft");
        assert_no_flag(&args, "--spec-type");
    }

    #[test]
    fn test_dflash_takes_precedence_over_mtp() {
        // Defense-in-depth: when both toggles are somehow enabled and the
        // backend supports DFlash, emit only the DFlash speculative path.
        let mut config = default_config();
        config.version_backend = "b10205/standard".to_string();
        config.mtp = true;
        config.dflash = true;
        config.dflash_spec_supported = true;
        config.dflash_draft_path = "/path/to/dflash-draft.gguf".to_string();

        let builder = ArgumentBuilder::new(config, false).unwrap();
        let args = builder.build("qwen3.6-27b", "/path", 8080, None);

        assert_arg_pair(&args, "--model-draft", "/path/to/dflash-draft.gguf");
        assert_arg_pair(&args, "--spec-type", "draft-dflash");
        assert_arg_pair(&args, "--spec-draft-n-max", "15");
    }

    #[test]
    fn test_reasoning_preserve_emitted_for_supported_text_backend() {
        let mut config = default_config();
        config.version_backend = "b9837/standard".to_string();
        config.reasoning_preserve = true;

        let args = ArgumentBuilder::new(config, false)
            .unwrap()
            .build("test", "/path", 8080, None);

        assert_has_flag(&args, "--reasoning-preserve");
    }

    #[test]
    fn test_reasoning_preserve_skipped_for_old_or_embedding_backend() {
        let mut old_config = default_config();
        old_config.version_backend = "b9836/standard".to_string();
        old_config.reasoning_preserve = true;
        let old_args = ArgumentBuilder::new(old_config, false)
            .unwrap()
            .build("test", "/path", 8080, None);

        let mut embedding_config = default_config();
        embedding_config.version_backend = "b10205/standard".to_string();
        embedding_config.reasoning_preserve = true;
        let embedding_args = ArgumentBuilder::new(embedding_config, true)
            .unwrap()
            .build("test", "/path", 8080, None);

        assert_no_flag(&old_args, "--reasoning-preserve");
        assert_no_flag(&embedding_args, "--reasoning-preserve");
    }

    #[test]
    fn test_extra_args_support_quotes_windows_paths_and_empty_values() {
        let mut config = default_config();
        config.extra_args =
            r#"--reasoning-format "deep analysis" --media-path C:\Models\vision --api-prefix ''"#
                .to_string();

        let args = ArgumentBuilder::new(config, false)
            .unwrap()
            .build("test", "/path", 8080, None);

        assert_arg_pair(&args, "--reasoning-format", "deep analysis");
        assert_arg_pair(&args, "--media-path", r"C:\Models\vision");
        assert_arg_pair(&args, "--api-prefix", "");
    }

    #[test]
    fn test_invalid_extra_args_are_ignored() {
        let mut config = default_config();
        config.extra_args = "--reasoning-format 'unterminated".to_string();

        let args = ArgumentBuilder::new(config, false)
            .unwrap()
            .build("test", "/path", 8080, None);

        assert_no_flag(&args, "--reasoning-format");
    }
}
