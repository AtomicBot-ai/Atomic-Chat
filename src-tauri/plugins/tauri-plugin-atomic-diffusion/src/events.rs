//! Event names and payloads. The `type` discriminant of `DiffusionEvent` in
//! `types.ts` is added by the TypeScript seam from the event name; the
//! payload is the rest of the object.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use crate::error::DiffusionErrorCode;
use crate::state::{DiffusionStatus, ImageJob, ImageJobProgress};

/// Tauri v2 rejects `.` in event names but accepts `:` and `/`.
pub const EVENT_STATE: &str = "atomic-diffusion://state";
pub const EVENT_PROGRESS: &str = "atomic-diffusion://progress";
pub const EVENT_JOB: &str = "atomic-diffusion://job";
pub const EVENT_ERROR: &str = "atomic-diffusion://error";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatePayload {
    pub status: DiffusionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub job_id: String,
    pub progress: ImageJobProgress,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobPayload {
    pub job: ImageJob,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    pub code: DiffusionErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

/// The one thing the job runner and the idle task need from Tauri. Abstracted
/// so `jobs.rs` runs against an in-process stub in tests and from the API
/// server's proxy without a webview.
pub trait DiffusionEmitter: Send + Sync {
    fn emit_json(&self, event: &str, payload: serde_json::Value);
}

impl<R: Runtime> DiffusionEmitter for AppHandle<R> {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        if let Err(err) = self.emit(event, payload) {
            log::warn!("[atomic-diffusion] failed to emit {event}: {err}");
        }
    }
}

pub type SharedEmitter = Arc<dyn DiffusionEmitter>;

pub fn emit<P: Serialize>(emitter: &dyn DiffusionEmitter, event: &str, payload: P) {
    match serde_json::to_value(payload) {
        Ok(value) => emitter.emit_json(event, value),
        Err(err) => log::warn!("[atomic-diffusion] failed to serialise {event}: {err}"),
    }
}

pub fn emit_error(
    emitter: &dyn DiffusionEmitter,
    job_id: Option<&str>,
    err: &crate::error::DiffusionError,
) {
    emit(
        emitter,
        EVENT_ERROR,
        ErrorPayload {
            job_id: job_id.map(|s| s.to_string()),
            code: err.code,
            message: err.message.clone(),
            details: err.details.clone(),
        },
    );
}

/// Records every emitted event; for tests.
#[derive(Default)]
pub struct RecordingEmitter {
    pub events: std::sync::Mutex<Vec<(String, serde_json::Value)>>,
}

impl DiffusionEmitter for RecordingEmitter {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        if let Ok(mut events) = self.events.lock() {
            events.push((event.to_string(), payload));
        }
    }
}

impl RecordingEmitter {
    pub fn of(&self, event: &str) -> Vec<serde_json::Value> {
        self.events
            .lock()
            .map(|events| {
                events
                    .iter()
                    .filter(|(name, _)| name == event)
                    .map(|(_, payload)| payload.clone())
                    .collect()
            })
            .unwrap_or_default()
    }
}
