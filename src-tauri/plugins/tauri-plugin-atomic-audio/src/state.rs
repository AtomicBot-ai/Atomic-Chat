//! Session state.
//!
//! Exactly one dictation session can be live at a time — the composer's mic is
//! a toggle, and two concurrent captures would interleave transcripts. The
//! guard is a plain `std::sync::Mutex`: every critical section is a handful of
//! field reads, and the worker threads are not async.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, RwLock};
use std::thread::JoinHandle;
use std::time::Instant;

use serde::Serialize;

use crate::capture::ControlMsg;
use crate::transcribe::TranscriptionTarget;

#[derive(Debug, Default)]
pub struct SessionStats {
    pub segments_closed: AtomicU64,
    pub segments_transcribed: AtomicU64,
    /// Capture buffers the worker could not keep up with.
    pub dropped_frames: AtomicU64,
    pub failures: AtomicU64,
}

pub struct ActiveSession {
    pub id: String,
    pub device_name: String,
    pub control_tx: Sender<ControlMsg>,
    /// Set before stopping to tell the worker to bin the tail rather than
    /// transcribe it. This is the whole difference between stop and cancel.
    pub discard: Arc<AtomicBool>,
    pub capture_join: Option<JoinHandle<()>>,
    pub worker_join: Option<JoinHandle<()>>,
    pub target: Arc<RwLock<TranscriptionTarget>>,
    pub stats: Arc<SessionStats>,
    pub started_at: Instant,
}

impl ActiveSession {
    /// Signal both threads to wind down. Does not block on the join handles:
    /// the capture thread can take up to a poll interval to notice, and the
    /// caller is usually a UI click.
    pub fn signal_stop(&self, discard: bool) {
        self.discard.store(discard, Ordering::SeqCst);
        let _ = self.control_tx.send(ControlMsg::Stop);
    }

    pub fn join(&mut self) {
        if let Some(handle) = self.capture_join.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.worker_join.take() {
            let _ = handle.join();
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    pub active: bool,
    pub session_id: Option<String>,
    pub device_name: Option<String>,
    pub elapsed_ms: u64,
    pub segments_closed: u64,
    pub segments_transcribed: u64,
    pub dropped_frames: u64,
}

#[derive(Default)]
pub struct AudioState {
    pub session: Mutex<Option<ActiveSession>>,
}

impl AudioState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn status(&self) -> DictationStatus {
        let guard = match self.session.lock() {
            Ok(guard) => guard,
            // A poisoned lock means a worker panicked. Report "not recording"
            // rather than propagating — the UI can always start a new session.
            Err(poisoned) => poisoned.into_inner(),
        };

        match guard.as_ref() {
            Some(session) => DictationStatus {
                active: true,
                session_id: Some(session.id.clone()),
                device_name: Some(session.device_name.clone()),
                elapsed_ms: session.started_at.elapsed().as_millis() as u64,
                segments_closed: session.stats.segments_closed.load(Ordering::Relaxed),
                segments_transcribed: session.stats.segments_transcribed.load(Ordering::Relaxed),
                dropped_frames: session.stats.dropped_frames.load(Ordering::Relaxed),
            },
            None => DictationStatus {
                active: false,
                session_id: None,
                device_name: None,
                elapsed_ms: 0,
                segments_closed: 0,
                segments_transcribed: 0,
                dropped_frames: 0,
            },
        }
    }

    /// Stop whatever is running, if anything. Used by `cancel`, by a new
    /// session claiming the device, and by app exit.
    pub fn stop_active(&self, discard: bool) -> Option<String> {
        let mut guard = match self.session.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut session = guard.take()?;
        session.signal_stop(discard);
        session.join();
        Some(session.id)
    }
}
