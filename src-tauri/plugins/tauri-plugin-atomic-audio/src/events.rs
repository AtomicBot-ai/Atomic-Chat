use serde::Serialize;

/// Tauri v2 rejects `.` in event names but accepts `:` and `/`, which is why
/// the existing backend events look like `local_backend://…`. Same shape here.
pub const EVENT_STATE: &str = "atomic-audio://state";
pub const EVENT_LEVEL: &str = "atomic-audio://level";
pub const EVENT_SEGMENT: &str = "atomic-audio://segment";
pub const EVENT_TRANSCRIPT: &str = "atomic-audio://transcript";
pub const EVENT_ERROR: &str = "atomic-audio://error";

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Starting,
    Recording,
    Stopping,
    Stopped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatePayload {
    pub session_id: String,
    pub state: SessionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelPayload {
    pub session_id: String,
    /// Linear RMS in `0.0..=1.0`, for a meter.
    pub rms: f32,
    /// The same value in dBFS, for threshold display and debugging.
    pub db: f32,
    pub speaking: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentPayload {
    pub session_id: String,
    pub index: u32,
    pub start_ms: u64,
    pub end_ms: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPayload {
    pub session_id: String,
    pub index: u32,
    pub text: String,
    pub duration_ms: u64,
    pub latency_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub code: crate::error::AudioErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}
