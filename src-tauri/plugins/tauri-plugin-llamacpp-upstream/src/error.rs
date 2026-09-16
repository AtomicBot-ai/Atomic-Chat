use serde::{Deserialize, Serialize};
use thiserror;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    BinaryNotFound,
    ModelFileNotFound,
    ModelFileCorrupt,
    LibraryPathInvalid,

    // --- Model Loading Errors ---
    ModelLoadFailed,
    DraftModelLoadFailed,
    MultimodalProjectorLoadFailed,
    ModelArchNotSupported,
    ModelLoadTimedOut,
    LlamaCppProcessError,

    // --- System / Runtime Compatibility Errors ---
    OsVersionUnsupported,

    // --- Memory Errors ---
    OutOfMemory,

    // --- Configuration Errors ---
    InvalidArgument,

    // --- Internal Application Errors ---
    DeviceListParseFailed,
    IoError,
    InternalError,
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("LlamacppError {{ code: {code:?}, message: \"{message}\" }}")]
pub struct LlamacppError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl LlamacppError {
    pub fn new(code: ErrorCode, message: String, details: Option<String>) -> Self {
        Self {
            code,
            message,
            details,
        }
    }

    /// Parses stderr from llama.cpp and creates a specific LlamacppError.
    pub fn from_stderr(stderr: &str) -> Self {
        let lower_stderr = stderr.to_lowercase();

        // The bundled macOS `llama-server` is built against a recent macOS SDK
        // and links Metal symbols (e.g. the Objective-C class
        // `MTLResidencySetDescriptor`) that only exist on newer macOS runtimes.
        // On an older macOS (e.g. 10.15.7 Catalina) the dynamic linker cannot
        // resolve the symbol and aborts the process at load time
        // (`dyld[...]: Symbol not found: _OBJC_CLASS_$_MTLResidencySetDescriptor`),
        // before any model load argument is read — so a CPU fallback within the
        // same binary is impossible. Classify this as an unsupported-OS error so
        // the caller can show an actionable "update macOS" message instead of an
        // opaque "unexpected error", and so the auto-start loop stops retrying a
        // permanently-failing load.
        if lower_stderr.contains("dyld") && lower_stderr.contains("symbol not found") {
            return Self::new(
                ErrorCode::OsVersionUnsupported,
                "The model engine couldn't start because it requires a newer version of macOS than the one on this Mac.".into(),
                Some(stderr.into()),
            );
        }

        // TODO: add others
        let is_out_of_memory = lower_stderr.contains("out of memory")
            || lower_stderr.contains("failed to allocate")
            || lower_stderr.contains("insufficient memory")
            || lower_stderr.contains("erroroutofdevicememory") // vulkan specific
            || lower_stderr.contains("kiogpucommandbuffercallbackerroroutofmemory") // Metal-specific error code
            || lower_stderr.contains("cuda_error_out_of_memory"); // CUDA-specific

        if is_out_of_memory {
            return Self::new(
                ErrorCode::OutOfMemory,
                "Out of memory. The model requires more RAM or VRAM than available.".into(),
                Some(stderr.into()),
            );
        }

        // A model this build can't load because its architecture or metadata
        // layout is unknown to the engine. Two shapes show up:
        //   1. "error loading model architecture: unknown model architecture:
        //      'X'" — the arch enum is missing entirely.
        //   2. "error loading model hyperparameters: key not found in model:
        //      qwen3vl.rope.dimension_sections" — the arch is recognised but the
        //      GGUF uses a newer metadata layout than this build understands
        //      (e.g. a Qwen3-VL model pulled through a newer Ollama).
        // Both mean "this engine version can't run this model", so surface an
        // actionable arch-not-supported error instead of dumping raw stderr.
        if lower_stderr.contains("error loading model architecture")
            || lower_stderr.contains("unknown model architecture")
            || lower_stderr.contains("error loading model hyperparameters")
            || lower_stderr.contains("key not found in model")
        {
            return Self::new(
                ErrorCode::ModelArchNotSupported,
                "The model's architecture or format is not supported by this version of the backend.".into(),
                Some(stderr.into()),
            );
        }

        // The multimodal projector (mmproj) declares a projector type the
        // bundled llama.cpp/libmtmd build cannot build a graph for (e.g. the
        // brand-new Gemma 4 `gemma4a` audio projector). libmtmd calls
        // `ggml_abort` during clip warmup ("clip.cpp:NNNN: Unknown projector
        // type"), taking down the whole llama-server with SIGABRT before the
        // server reports ready. Surface this as an actionable, recoverable
        // error so the caller can retry the load text-only (without --mmproj).
        if lower_stderr.contains("unknown projector type") {
            return Self::new(
                ErrorCode::MultimodalProjectorLoadFailed,
                "This model's multimodal projector isn't supported by the current llama.cpp backend. Vision/audio is unavailable for this model on this backend.".into(),
                Some(stderr.into()),
            );
        }

        // A truncated or corrupt GGUF (interrupted download, bad disk write).
        // llama.cpp's loader emits these when tensor data runs past the file
        // bounds, the header magic is wrong, or the tensor count mismatches.
        // Point the user at a re-download instead of the opaque generic error.
        if lower_stderr.contains("corrupted or incomplete")
            || lower_stderr.contains("invalid magic")
            || lower_stderr.contains("wrong number of tensors")
            || lower_stderr.contains("unexpectedly reached end of file")
            || lower_stderr.contains("failed to read tensor")
        {
            return Self::new(
                ErrorCode::ModelFileCorrupt,
                "The model file appears to be incomplete or corrupted. Try deleting and re-downloading the model.".into(),
                Some(stderr.into()),
            );
        }

        Self::new(
            ErrorCode::LlamaCppProcessError,
            "The model process encountered an unexpected error.".into(),
            Some(stderr.into()),
        )
    }

    /// Classify a non-success process exit. Native crashes (Windows access
    /// violation `0xC0000005`, stack overflow / buffer overrun; Unix `SIGSEGV` /
    /// `SIGABRT`) usually leave empty stderr, so `from_stderr` alone would only
    /// yield the opaque generic process error. When stderr already pins a
    /// specific cause (OOM, arch, projector) we keep it; otherwise, for a
    /// recognised crash we surface an actionable hint.
    pub fn from_exit_status(status: &std::process::ExitStatus, stderr: &str) -> Self {
        let base = Self::from_stderr(stderr);
        if !matches!(base.code, ErrorCode::LlamaCppProcessError) || !is_crash_exit(status) {
            return base;
        }
        Self::new(
            ErrorCode::LlamaCppProcessError,
            "The model process crashed unexpectedly (access violation / segfault). \
This usually means the model is incompatible with this backend, or its \
speculative-decoding (MTP) configuration is unsupported here."
                .into(),
            Some(stderr.into()),
        )
    }

    /// Classify a non-success exit from both captured streams.
    ///
    /// llama.cpp routes its loader diagnostics to stdout in several builds, so
    /// a plain `exit(1)` can leave stderr empty while stdout holds the real
    /// cause (`unknown model architecture`, an allocation failure, a corrupt
    /// GGUF). Classifying from stderr alone reduces all of those to the opaque
    /// generic process error.
    pub fn from_process_output(
        status: &std::process::ExitStatus,
        stderr: &str,
        stdout: &str,
    ) -> Self {
        let base = Self::from_exit_status(status, stderr);
        if !matches!(base.code, ErrorCode::LlamaCppProcessError) {
            return base;
        }

        let from_stdout = Self::from_stderr(stdout);
        if !matches!(from_stdout.code, ErrorCode::LlamaCppProcessError) {
            return from_stdout;
        }

        // Still unclassified: keep the exit-status message but hand the caller
        // the output that does exist instead of an empty `details`.
        if stderr.trim().is_empty() && !stdout.trim().is_empty() {
            return Self::new(base.code, base.message, Some(stdout.into()));
        }
        base
    }
}

/// Whether a process exit status is a hard native crash (access violation /
/// segmentation fault) rather than a normal non-zero exit, so it can be given
/// an actionable message instead of an opaque "unexpected error".
fn is_crash_exit(status: &std::process::ExitStatus) -> bool {
    #[cfg(windows)]
    {
        matches!(status.code(), Some(code) if {
            let c = code as u32;
            // STATUS_ACCESS_VIOLATION / STATUS_STACK_OVERFLOW / STATUS_STACK_BUFFER_OVERRUN
            c == 0xC000_0005 || c == 0xC000_00FD || c == 0xC000_0409
        })
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        // SIGSEGV = 11, SIGABRT = 6
        matches!(status.signal(), Some(11 | 6))
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = status;
        false
    }
}

// Error type for server commands
#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error(transparent)]
    Llamacpp(#[from] LlamacppError),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Tauri error: {0}")]
    Tauri(#[from] tauri::Error),

    #[error("Invalid argument: {0}")]
    InvalidArgument(String),
}

// impl serialization for tauri
impl serde::Serialize for ServerError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let error_to_serialize: LlamacppError = match self {
            ServerError::Llamacpp(err) => err.clone(),
            ServerError::Io(e) => LlamacppError::new(
                ErrorCode::IoError,
                "An input/output error occurred.".into(),
                Some(e.to_string()),
            ),
            ServerError::Tauri(e) => LlamacppError::new(
                ErrorCode::InternalError,
                "An internal application error occurred.".into(),
                Some(e.to_string()),
            ),
            ServerError::InvalidArgument(msg) => LlamacppError::new(
                ErrorCode::InvalidArgument,
                "Invalid configuration argument provided.".into(),
                Some(msg.clone()),
            ),
        };
        error_to_serialize.serialize(serializer)
    }
}

pub type ServerResult<T> = Result<T, ServerError>;

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    fn exit_code(code: i32) -> std::process::ExitStatus {
        std::process::ExitStatus::from_raw(code << 8)
    }

    #[test]
    fn classifies_loader_failure_reported_on_stdout() {
        let stdout = "0.00.319.245 E llama_model_load: error loading model: unknown model architecture: 'dflash'\n";

        let error = LlamacppError::from_process_output(&exit_code(1), "", stdout);

        assert!(matches!(error.code, ErrorCode::ModelArchNotSupported));
    }

    #[test]
    fn keeps_stdout_as_details_when_exit_is_unclassified() {
        let stdout = "0.00.121.737 I cmn common_param: verbosity = 3\n";

        let error = LlamacppError::from_process_output(&exit_code(1), "", stdout);

        assert!(matches!(error.code, ErrorCode::LlamaCppProcessError));
        assert_eq!(error.details.as_deref(), Some(stdout));
    }

    #[test]
    fn stderr_classification_wins_over_stdout() {
        let error = LlamacppError::from_process_output(
            &exit_code(1),
            "ggml_backend_metal: out of memory\n",
            "unknown model architecture: 'dflash'\n",
        );

        assert!(matches!(error.code, ErrorCode::OutOfMemory));
    }
}

/// Contract-fixture emitter for `atomic-chat-core` (PLAN.md phase 0 there). Ignored by default:
///
/// ```text
/// cargo test -p tauri-plugin-llamacpp-upstream --lib -- --ignored dump_fixtures
/// ```
///
/// Writes `<repo>/tests/fixtures/core-contracts/errors/<case>.json` and `index.json`. Unix-only:
/// `ExitStatus` values are built from raw wait statuses; the Windows crash codes
/// (`0xC0000005`, `0xC00000FD`, `0xC0000409`) cannot be constructed here and are covered by the
/// port's own table (see `index.json`).
#[cfg(all(test, unix))]
mod fixture_dump {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::os::unix::process::ExitStatusExt;
    use std::path::PathBuf;

    enum Exit {
        Code(i32),
        Signal(i32),
    }

    struct Case {
        name: &'static str,
        stderr: &'static str,
        stdout: &'static str,
        exit: Exit,
    }

    const fn c(name: &'static str, stderr: &'static str, stdout: &'static str, exit: Exit) -> Case {
        Case {
            name,
            stderr,
            stdout,
            exit,
        }
    }

    fn cases() -> Vec<Case> {
        use Exit::*;
        vec![
            // ── stderr cascade, one per substring (all exit 1) ─────────────
            c("os_version_dyld_symbol", "dyld[123]: Symbol not found: _OBJC_CLASS_$_MTLResidencySetDescriptor\n", "", Code(1)),
            c("os_version_dyld_alone_not_enough", "dyld[123]: Library not loaded\n", "", Code(1)),
            c("oom_out_of_memory", "ggml_backend_metal: out of memory\n", "", Code(1)),
            c("oom_failed_to_allocate", "ggml_gallocr_reserve_n: failed to allocate CUDA0 buffer of size 4096\n", "", Code(1)),
            c("oom_insufficient_memory", "llama_model_load: insufficient memory\n", "", Code(1)),
            c("oom_vulkan_device_memory", "vk::Device::allocateMemory: ErrorOutOfDeviceMemory\n", "", Code(1)),
            c("oom_metal_command_buffer", "kIOGPUCommandBufferCallbackErrorOutOfMemory\n", "", Code(1)),
            c("oom_cuda_error", "CUDA error: cudaErrorMemoryAllocation (cuda_error_out_of_memory)\n", "", Code(1)),
            c("arch_error_loading_architecture", "llama_model_load: error loading model: error loading model architecture: unknown model architecture: 'dflash'\n", "", Code(1)),
            c("arch_unknown_architecture", "unknown model architecture: 'gemma4'\n", "", Code(1)),
            c("arch_hyperparameters", "error loading model hyperparameters: key not found\n", "", Code(1)),
            c("arch_key_not_found", "llama_model_loader: key not found in model: gemma4.context_length\n", "", Code(1)),
            c("projector_unknown_type", "clip_init: unknown projector type: gemma4a\n", "", Code(1)),
            c("corrupt_corrupted_or_incomplete", "gguf_init_from_file: the file is corrupted or incomplete\n", "", Code(1)),
            c("corrupt_invalid_magic", "gguf_init_from_file: invalid magic characters 'ABCD'\n", "", Code(1)),
            c("corrupt_wrong_tensor_count", "llama_model_load: wrong number of tensors; expected 291, got 288\n", "", Code(1)),
            c("corrupt_unexpected_eof", "gguf_init_from_file: unexpectedly reached end of file\n", "", Code(1)),
            c("corrupt_failed_to_read_tensor", "llama_model_load: failed to read tensor data\n", "", Code(1)),
            c("generic_unclassified_stderr", "main: server terminated for no obvious reason\n", "", Code(1)),
            c("generic_empty_streams", "", "", Code(1)),
            // ── precedence within the cascade ───────────────────────────────
            c("precedence_oom_before_arch", "unknown model architecture: 'x'\nfailed to allocate buffer\n", "", Code(1)),
            c("precedence_dyld_before_oom", "out of memory\ndyld: symbol not found\n", "", Code(1)),
            c("precedence_arch_before_corrupt", "invalid magic\nkey not found in model\n", "", Code(1)),
            c("precedence_projector_before_corrupt", "unexpectedly reached end of file\nunknown projector type\n", "", Code(1)),
            c("case_insensitive_match", "GGML_BACKEND: OUT OF MEMORY\n", "", Code(1)),
            // ── stdout fallback (from_process_output) ───────────────────────
            c("stdout_classified_when_stderr_empty", "", "0.00.319.245 E llama_model_load: error loading model: unknown model architecture: 'dflash'\n", Code(1)),
            c("stdout_ignored_when_stderr_classified", "ggml_backend_metal: out of memory\n", "unknown model architecture: 'dflash'\n", Code(1)),
            c("stdout_classified_when_stderr_generic", "main: exiting\n", "gguf_init_from_file: invalid magic characters\n", Code(1)),
            c("stdout_becomes_details_when_unclassified", "", "0.00.121.737 I cmn common_param: verbosity = 3\n", Code(1)),
            c("stdout_not_details_when_stderr_present", "main: exiting\n", "0.00.121.737 I cmn common_param: verbosity = 3\n", Code(1)),
            c("whitespace_only_stderr_counts_as_empty", "  \n\t\n", "verbosity = 3\n", Code(1)),
            // ── exit status classification ──────────────────────────────────
            c("crash_sigsegv_empty_stderr", "", "", Signal(11)),
            c("crash_sigabrt_empty_stderr", "", "", Signal(6)),
            c("crash_sigsegv_with_generic_stderr", "main: exiting\n", "", Signal(11)),
            c("crash_sigsegv_keeps_specific_stderr", "ggml_backend_metal: out of memory\n", "", Signal(11)),
            c("crash_sigsegv_then_stdout_classified", "", "unknown model architecture: 'x'\n", Signal(11)),
            c("sigkill_is_not_a_crash", "", "", Signal(9)),
            c("sigterm_is_not_a_crash", "", "", Signal(15)),
            c("exit_code_139_is_not_a_signal", "", "", Code(139)),
            c("exit_code_0_with_generic_stderr", "main: exiting\n", "", Code(0)),
        ]
    }

    fn status(exit: &Exit) -> std::process::ExitStatus {
        match exit {
            Exit::Code(code) => std::process::ExitStatus::from_raw(code << 8),
            Exit::Signal(sig) => std::process::ExitStatus::from_raw(*sig),
        }
    }

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap()
    }

    fn git_head(root: &PathBuf) -> String {
        std::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(root)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    }

    #[test]
    #[ignore]
    fn dump_fixtures() {
        let root = repo_root();
        let out = root.join("tests/fixtures/core-contracts/errors");
        fs::create_dir_all(&out).unwrap();
        let commit = git_head(&root);
        let source = "src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/error.rs";

        let mut names = Vec::new();
        for case in cases() {
            let st = status(&case.exit);
            let error = LlamacppError::from_process_output(&st, case.stderr, case.stdout);
            let exit = match case.exit {
                Exit::Code(code) => json!({ "code": code, "signal": null }),
                Exit::Signal(sig) => json!({ "code": null, "signal": sig }),
            };
            let doc = json!({
                "name": case.name,
                "source": { "file": source, "commit": commit, "provider": "llamacpp-upstream" },
                "comparator": "error-exact",
                "input": { "stderr": case.stderr, "stdout": case.stdout, "exit": exit },
                "expected": serde_json::to_value(&error).unwrap(),
            });
            fs::write(
                out.join(format!("{}.json", case.name)),
                serde_json::to_string_pretty(&doc).unwrap() + "\n",
            )
            .unwrap();
            names.push(case.name);
        }
        let index = json!({
            "source": { "file": source, "commit": commit },
            "comparator": "error-exact",
            "note": "expected = serialised LlamacppError {code, message, details?}; compare all three exactly (details is omitted when None). exit.signal uses Unix signal numbers (11 SIGSEGV, 6 SIGABRT are crashes). Windows crash exit codes 0xC0000005 / 0xC00000FD / 0xC0000409 map to the same crash message and are NOT emitted here (emitter runs on Unix); the port pins them in its own unit table.",
            "cases": names,
        });
        fs::write(
            out.join("index.json"),
            serde_json::to_string_pretty(&index).unwrap() + "\n",
        )
        .unwrap();
        eprintln!("wrote {} error fixtures to {}", names.len(), out.display());
    }
}
