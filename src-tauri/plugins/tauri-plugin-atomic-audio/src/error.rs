use serde::{Deserialize, Serialize};

/// Error codes surfaced to the frontend, both as a rejected command and as an
/// `atomic-audio://error` event payload. Mirrors the shape of
/// `tauri-plugin-llamacpp-upstream`'s `ErrorCode` so the web app can classify
/// both with the same machinery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AudioErrorCode {
    /// The OS refused microphone access, or the user has never been asked.
    PermissionDenied,
    /// No input device exists at all.
    NoInputDevice,
    /// A device exists but could not be opened (in use, wrong format, …).
    DeviceUnavailable,
    /// The device vanished mid-session (unplugged, driver reset).
    DeviceDisconnected,
    /// A dictation session is already running.
    AlreadyActive,
    /// The referenced session id is not the live one.
    SessionNotFound,
    /// The transcription server did not answer.
    ServerUnreachable,
    /// The server answered, but could not transcribe this segment.
    TranscriptionFailed,
    /// The loaded model has no audio encoder — a terminal condition.
    TranscriptionUnsupported,
    /// The request outlived its timeout.
    TranscriptionTimeout,
    /// A bug on our side.
    Internal,
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("AudioError {{ code: {code:?}, message: \"{message}\" }}")]
pub struct AudioError {
    pub code: AudioErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl AudioError {
    pub fn new(code: AudioErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(
        code: AudioErrorCode,
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
        Self::new(AudioErrorCode::Internal, message)
    }
}

pub type AudioResult<T> = Result<T, AudioError>;
