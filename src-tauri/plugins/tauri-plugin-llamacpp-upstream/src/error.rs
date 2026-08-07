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
    ModelQuantizationNotSupported,
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

/// Human-readable names for ggml tensor types that are known to be CPU-only
/// on some GPU backends (e.g., Metal has no matmul kernel for TQ1_0/TQ2_0).
fn ggml_quant_type_name(type_id: u32) -> Option<&'static str> {
    match type_id {
        34 => Some("TQ1_0"),
        35 => Some("TQ2_0"),
        _ => None,
    }
}

/// Format a tensor type id for an error message, e.g. "TQ2_0 (type 35)".
fn format_quantization_type(type_id: Option<u32>) -> String {
    match type_id {
        Some(id) => ggml_quant_type_name(id)
            .map(|name| format!("{} (type {})", name, id))
            .unwrap_or_else(|| format!("type {}", id)),
        None => "an unsupported".to_string(),
    }
}

/// Detect the deliberate `ggml_abort` that happens when a GPU backend has no
/// kernel for one of the model's quantization types. The log usually contains
/// either "Asserting on type 35" (stderr) or "ggml-<backend>.cpp:NNN: not
/// implemented" (stdout).
fn detect_unsupported_quantization(output: &str) -> Option<LlamacppError> {
    let lower = output.to_lowercase();
    let backend_known = lower.contains("ggml-metal")
        || lower.contains("ggml-cuda")
        || lower.contains("ggml-vulkan")
        || lower.contains("ggml-hip");
    let backend_not_impl = lower.contains("not implemented") && backend_known;
    let asserting_type = lower.contains("asserting on type");

    if !backend_not_impl && !(asserting_type && backend_known) {
        return None;
    }

    // Try to extract a "type <n>" token from the abort line.
    let type_id = lower
        .split("asserting on type")
        .nth(1)
        .and_then(|s| s.trim().split_whitespace().next())
        .and_then(|n| n.parse::<u32>().ok())
        .or_else(|| {
            // Fallback for lines like "...Asserting on type 35..." elsewhere.
            lower.split("type ").nth(1).and_then(|s| {
                s.split(|c: char| !c.is_ascii_digit())
                    .next()
                    .and_then(|n| n.parse::<u32>().ok())
            })
        });

    let backend = if lower.contains("ggml-metal") {
        "Metal"
    } else if lower.contains("ggml-cuda") {
        "CUDA"
    } else if lower.contains("ggml-vulkan") {
        "Vulkan"
    } else if lower.contains("ggml-hip") {
        "HIP"
    } else {
        "this GPU"
    };

    let message = format!(
        "The model uses quantization type {} that is not supported by the {} backend. \
         This is a deliberate engine abort, not a segfault or an unsupported \
         speculative-decoding (MTP) configuration. To load this model, set GPU layers to 0 \
         or move the offending tensor to CPU with --override-tensor.",
        format_quantization_type(type_id),
        backend
    );

    Some(LlamacppError::new(
        ErrorCode::ModelQuantizationNotSupported,
        message,
        Some(output.into()),
    ))
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

        // A deliberate `ggml_abort` because the GPU backend has no kernel for
        // one of the model's quantization types (e.g. TQ2_0 on Metal). This is
        // not a segfault or an MTP misconfiguration.
        if let Some(err) = detect_unsupported_quantization(stderr) {
            return err;
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

        // For deliberate GPU-backend aborts, the type id often appears in stderr
        // while the backend name (e.g. "ggml-metal") appears in stdout. Combine
        // both streams so we can produce a single, specific message.
        if is_crash_exit(status) {
            if let Some(err) = detect_unsupported_quantization(&format!("{}\n{}", stderr, stdout)) {
                return err;
            }
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

    fn signal_exit(signal: i32) -> std::process::ExitStatus {
        std::process::ExitStatus::from_raw(signal)
    }

    #[test]
    fn classifies_metal_tq2_0_abort_from_stderr() {
        let stderr = "0.00.769.844 E Asserting on type 35\n";
        let stdout = "cmd_child_to_router:error:/Users/runner/work/llama.cpp/llama.cpp/ggml/src/ggml-metal/ggml-metal-device.cpp:988: not implemented\n";
        let error = LlamacppError::from_process_output(&signal_exit(6), stderr, stdout);

        assert!(matches!(error.code, ErrorCode::ModelQuantizationNotSupported));
        assert!(error.message.contains("TQ2_0"));
        assert!(error.message.contains("Metal"));
        assert!(error.message.contains("not a segfault"));
    }

    #[test]
    fn classifies_metal_tq2_0_abort_from_stdout_only() {
        let stdout = "ggml/src/ggml-metal/ggml-metal-device.cpp:988: not implemented\nAsserting on type 35\n";
        let error = LlamacppError::from_process_output(&signal_exit(6), "", stdout);

        assert!(matches!(error.code, ErrorCode::ModelQuantizationNotSupported));
        assert!(error.message.contains("TQ2_0"));
    }
}
