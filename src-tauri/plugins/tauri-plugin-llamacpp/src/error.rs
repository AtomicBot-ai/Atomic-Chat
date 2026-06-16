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

    // --- Environment / backend-build incompatibility ---
    // The bundled backend build is incompatible with this machine's OS or CPU.
    // Split out of the generic LlamaCppProcessError bucket (ATO-183) so the
    // distinct failure modes are diagnosable in telemetry instead of being
    // buried under one opaque code.
    /// Old macOS missing a Metal symbol the backend links against (e.g.
    /// `MTLResidencySetDescriptor` on Catalina).
    BackendOsTooOld,
    /// CPU lacks SIMD instructions (e.g. AVX2) the backend binary requires
    /// (illegal-instruction / SIGILL on launch).
    CpuFeatureUnsupported,

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

        if lower_stderr.contains("error loading model architecture") {
            return Self::new(
                ErrorCode::ModelArchNotSupported,
                "The model's architecture is not supported by this version of the backend.".into(),
                Some(stderr.into()),
            );
        }

        // The multimodal projector (mmproj) declares a projector type the
        // bundled (TurboQuant) llama.cpp/libmtmd build cannot build a graph
        // for (e.g. the Gemma 4 unified `gemma4uv` / `gemma4ua` projectors,
        // which exist upstream but not yet in our fork). libmtmd reports
        // "unknown projector type" during clip warmup and `llama-server`
        // exits before reporting ready. Surface this as an actionable,
        // recoverable error so the caller can retry the load text-only
        // (without --mmproj).
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

        // Old macOS (e.g. Catalina 10.15) is missing newer Metal symbols the
        // bundled backend links against (e.g. `MTLResidencySetDescriptor`), so
        // dyld aborts at process start with "symbol not found" before
        // `llama-server` reports ready. Split out of the generic process-error
        // bucket (ATO-183) so it is diagnosable and the user gets an actionable
        // "update macOS" message.
        if lower_stderr.contains("mtlresidencysetdescriptor")
            || (lower_stderr.contains("symbol not found") && lower_stderr.contains("metal"))
        {
            return Self::new(
                ErrorCode::BackendOsTooOld,
                "This backend build requires a newer version of macOS (a required Metal symbol is missing). Update macOS to run local models on this backend.".into(),
                Some(stderr.into()),
            );
        }

        // The CPU lacks SIMD instructions (typically AVX2) the bundled binary was
        // compiled with, so it dies with an illegal-instruction fault. The SIGILL
        // exit (often with empty stderr) is also classified in `from_exit_status`.
        if lower_stderr.contains("illegal instruction") {
            return Self::new(
                ErrorCode::CpuFeatureUnsupported,
                "This backend build needs CPU instructions (e.g. AVX2) that this processor doesn't support.".into(),
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
        // A specific stderr cause (OOM, arch, projector, corrupt, metal-symbol,
        // illegal-instruction) always wins; only refine the opaque generic bucket.
        if !matches!(base.code, ErrorCode::LlamaCppProcessError) {
            return base;
        }
        // A SIGILL / illegal-instruction exit (often with empty stderr) means the
        // CPU is missing instructions the binary requires — typically AVX2 on
        // older x86 hardware (ATO-183).
        if is_illegal_instruction_exit(status) {
            return Self::new(
                ErrorCode::CpuFeatureUnsupported,
                "This backend build needs CPU instructions (e.g. AVX2) that this processor doesn't support.".into(),
                Some(stderr.into()),
            );
        }
        if !is_crash_exit(status) {
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
}

/// Whether a process exit status is an illegal-instruction fault — typically a
/// binary compiled with SIMD instructions (e.g. AVX2) the host CPU lacks.
fn is_illegal_instruction_exit(status: &std::process::ExitStatus) -> bool {
    #[cfg(windows)]
    {
        matches!(status.code(), Some(code) if {
            let c = code as u32;
            // STATUS_ILLEGAL_INSTRUCTION / STATUS_PRIVILEGED_INSTRUCTION
            c == 0xC000_001D || c == 0xC000_0096
        })
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        // SIGILL = 4
        matches!(status.signal(), Some(4))
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = status;
        false
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

#[cfg(test)]
mod tests {
    use super::*;

    // ATO-183: the generic LLAMA_CPP_PROCESS_ERROR bucket is split into specific
    // sub-codes by stderr signature so distinct failure modes are diagnosable.
    #[test]
    fn classifies_old_macos_metal_symbol() {
        let stderr =
            "dyld: Symbol not found: _OBJC_CLASS_$_MTLResidencySetDescriptor\nReferenced from: ...Metal.framework";
        assert!(matches!(
            LlamacppError::from_stderr(stderr).code,
            ErrorCode::BackendOsTooOld
        ));
        // Generic "symbol not found" without Metal context stays generic.
        let stderr2 = "dyld: Symbol not found: _some_other_symbol";
        assert!(matches!(
            LlamacppError::from_stderr(stderr2).code,
            ErrorCode::LlamaCppProcessError
        ));
    }

    #[test]
    fn classifies_illegal_instruction() {
        assert!(matches!(
            LlamacppError::from_stderr("Illegal instruction (core dumped)").code,
            ErrorCode::CpuFeatureUnsupported
        ));
    }

    #[test]
    fn specific_causes_still_win_over_new_codes() {
        assert!(matches!(
            LlamacppError::from_stderr("ggml_backend: out of memory").code,
            ErrorCode::OutOfMemory
        ));
        assert!(matches!(
            LlamacppError::from_stderr("error loading model architecture: 'lfm2moe'").code,
            ErrorCode::ModelArchNotSupported
        ));
    }

    #[test]
    fn unknown_stderr_stays_generic() {
        assert!(matches!(
            LlamacppError::from_stderr("something unexpected happened").code,
            ErrorCode::LlamaCppProcessError
        ));
    }
}
