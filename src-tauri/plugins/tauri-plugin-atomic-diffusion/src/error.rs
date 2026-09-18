use serde::{Deserialize, Serialize};

/// Error codes surfaced to the frontend, both as a rejected command and as an
/// `atomic-diffusion://error` event payload. Must match
/// `NativeDiffusionErrorCode` in `web-app/src/services/diffusion/types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiffusionErrorCode {
    EngineMissing,
    EngineInstallFailed,
    EngineCrashed,
    ModelMissing,
    SideFileMissing,
    ModelLoadFailed,
    ModelIncompatible,
    ModelNotLoaded,
    OutOfMemory,
    UnsupportedBackend,
    UnsupportedWorkflow,
    InvalidDimensions,
    InvalidRequest,
    JobBusy,
    JobNotFound,
    QueueFull,
    Cancelled,
    DiskFull,
    BackendInUse,
    NotConfigured,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("DiffusionError {{ code: {code:?}, message: \"{message}\" }}")]
pub struct DiffusionError {
    pub code: DiffusionErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl DiffusionError {
    pub fn new(code: DiffusionErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(
        code: DiffusionErrorCode,
        message: impl Into<String>,
        details: impl Into<String>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            details: Some(details.into()),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(DiffusionErrorCode::Internal, message)
    }

    pub fn not_configured() -> Self {
        Self::new(
            DiffusionErrorCode::NotConfigured,
            "Image generation has not been configured yet.",
        )
    }

    /// Map an I/O failure onto the closest code: a full disk is actionable,
    /// everything else is internal.
    pub fn io(context: &str, err: &std::io::Error) -> Self {
        if is_disk_full(err) {
            Self::with_details(
                DiffusionErrorCode::DiskFull,
                "The disk is full.",
                format!("{context}: {err}"),
            )
        } else {
            Self::with_details(
                DiffusionErrorCode::Internal,
                context.to_string(),
                err.to_string(),
            )
        }
    }
}

/// `ErrorKind::StorageFull` needs a newer toolchain than `rust-version`
/// promises, so check the raw OS code.
fn is_disk_full(err: &std::io::Error) -> bool {
    match err.raw_os_error() {
        #[cfg(unix)]
        Some(code) => code == 28, // ENOSPC
        #[cfg(windows)]
        Some(code) => code == 112 || code == 39, // ERROR_DISK_FULL / ERROR_HANDLE_DISK_FULL
        #[cfg(not(any(unix, windows)))]
        Some(_) => false,
        None => false,
    }
}

pub type DiffusionResult<T> = Result<T, DiffusionError>;
