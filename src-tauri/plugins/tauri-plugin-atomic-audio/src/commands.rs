//! Command surface and session orchestration.
//!
//! Threading, end to end:
//!
//! ```text
//! start_dictation
//!  ├─ capture thread  : cpal stream -> Box<[f32]> over a bounded sync_channel
//!  ├─ worker thread   : downmix/resample -> 20 ms frames -> VAD -> WAV -> segment
//!  └─ async task      : one segment at a time -> POST /v1/audio/transcriptions
//! ```
//!
//! Serialising the POSTs matters: the voice model runs with `--parallel 1`, and
//! a single consumer means transcript events arrive in the order the phrases
//! were spoken without the frontend having to reorder them.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Runtime, State};

use crate::capture::{self, AudioInputDevice, ControlMsg, PCM_QUEUE_DEPTH};
use crate::dsp::{Resampler, TARGET_SAMPLE_RATE};
use crate::error::{AudioError, AudioErrorCode, AudioResult};
use crate::events::*;
use crate::permission::{self, MicPermission};
use crate::state::{ActiveSession, AudioState, DictationStatus, SessionStats};
use crate::transcribe::{self, TranscriptionTarget};
use crate::vad::{Vad, VadParams};
use crate::wav;

/// Retry delay after a transient transcription failure.
const RETRY_DELAY: Duration = Duration::from_millis(250);

/// Consecutive failures on *distinct* segments before we call the endpoint
/// broken and stop. This is the detection surface for llama.cpp transcription
/// regressions, where a healthy-looking server 500s on every segment.
const FAILURE_LIMIT: u64 = 2;

const DEFAULT_TIMEOUT_SECS: u64 = 60;

fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT_SECS
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationOptions {
    /// e.g. `http://127.0.0.1:8123/v1`. Omit all three transcription fields to
    /// run a monitor-only session: the microphone opens and level events flow,
    /// but nothing is transcribed. That is what the settings page's "test
    /// microphone" uses, so picking a device does not require the 3 GB voice
    /// model to be installed and loaded first.
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    /// llama-server alias, which is our model id.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    /// `cpal::DeviceId` string, or a device name. Empty/None = system default.
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub vad: VadParams,
    #[serde(default = "default_timeout")]
    pub request_timeout_secs: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationSession {
    pub session_id: String,
    pub device_id: Option<String>,
    pub device_name: String,
    pub sample_rate: u32,
    pub resampled: bool,
    pub fell_back_to_default: bool,
}

struct SegmentJob {
    index: u32,
    wav: Vec<u8>,
    duration_ms: u64,
}

/// What the worker sends the transcription consumer.
///
/// `End` is the last message of every session. The consumer — not the worker —
/// emits `stopped` when it gets there, so the event can never overtake a phrase
/// that is still being transcribed. Without that ordering the frontend tears
/// the session down while the tail phrase is still in flight, and the last
/// thing the user said is lost every single time.
enum Job {
    Segment(SegmentJob),
    End { reason: Option<String> },
}

fn new_session_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("dictation-{nanos:x}-{seq:x}")
}

fn emit<R: Runtime, P: serde::Serialize + Clone>(app: &AppHandle<R>, event: &str, payload: P) {
    if let Err(err) = app.emit(event, payload) {
        log::warn!("[atomic-audio] failed to emit {event}: {err}");
    }
}

fn emit_error<R: Runtime>(app: &AppHandle<R>, session_id: Option<&str>, err: &AudioError) {
    emit(
        app,
        EVENT_ERROR,
        ErrorPayload {
            session_id: session_id.map(|s| s.to_string()),
            code: err.code,
            message: err.message.clone(),
            details: err.details.clone(),
        },
    );
}

// ---------------------------------------------------------------------------
// Devices and permission
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_input_devices() -> AudioResult<Vec<AudioInputDevice>> {
    // ALSA enumeration can take hundreds of milliseconds; keep it off the
    // command executor's critical path.
    tauri::async_runtime::spawn_blocking(capture::list_devices)
        .await
        .map_err(|e| {
            AudioError::with_details(
                AudioErrorCode::Internal,
                "Listing microphones failed.",
                e.to_string(),
            )
        })?
}

#[tauri::command]
pub async fn get_microphone_permission() -> AudioResult<MicPermission> {
    Ok(permission::status())
}

#[tauri::command]
pub async fn request_microphone_permission() -> AudioResult<MicPermission> {
    // The macOS prompt blocks until the user answers, so this must not run on
    // the async executor's worker.
    tauri::async_runtime::spawn_blocking(permission::request)
        .await
        .map_err(|e| {
            AudioError::with_details(
                AudioErrorCode::Internal,
                "Requesting microphone access failed.",
                e.to_string(),
            )
        })
}

// ---------------------------------------------------------------------------
// Dictation lifecycle
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn start_dictation<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AudioState>,
    options: DictationOptions,
) -> AudioResult<DictationSession> {
    {
        let guard = state
            .session
            .lock()
            .map_err(|_| AudioError::internal("Audio state is poisoned."))?;
        if guard.is_some() {
            return Err(AudioError::new(
                AudioErrorCode::AlreadyActive,
                "Voice input is already running.",
            ));
        }
    }

    // Refuse up front rather than recording silence: on macOS a denied
    // microphone yields silence, not an error.
    let permission = permission::status();
    if permission == MicPermission::Denied {
        return Err(AudioError::new(
            AudioErrorCode::PermissionDenied,
            "Atomic Chat can't use the microphone.",
        ));
    }

    let session_id = new_session_id();
    let stats = Arc::new(SessionStats::default());
    let discard = Arc::new(AtomicBool::new(false));

    let (pcm_tx, pcm_rx) = std::sync::mpsc::sync_channel::<Box<[f32]>>(PCM_QUEUE_DEPTH);
    let (control_tx, control_rx) = std::sync::mpsc::channel::<ControlMsg>();
    let err_slot = Arc::new(Mutex::new(None));

    emit(
        &app,
        EVENT_STATE,
        StatePayload {
            session_id: session_id.clone(),
            state: SessionState::Starting,
            reason: None,
        },
    );

    let dropped = Arc::new(AtomicU64::new(0));
    let (info, capture_join) = capture::spawn_capture(
        options.device_id.clone(),
        pcm_tx,
        control_rx,
        Arc::clone(&dropped),
        Arc::clone(&err_slot),
    )?;

    let target = match (&options.base_url, &options.api_key, &options.model) {
        (Some(base_url), Some(api_key), Some(model)) => {
            Some(Arc::new(RwLock::new(TranscriptionTarget {
                base_url: base_url.clone(),
                api_key: api_key.clone(),
                model: model.clone(),
                language: options.language.clone(),
                prompt: options.prompt.clone(),
                timeout_secs: options.request_timeout_secs,
            })))
        }
        _ => None,
    };

    // Monitor-only sessions skip the whole transcription half: no HTTP client,
    // no consumer task, and the worker does not even encode WAV.
    let seg_tx = match &target {
        Some(target) => {
            let (seg_tx, seg_rx) = tokio::sync::mpsc::channel::<Job>(8);

            let client = reqwest::Client::builder()
                .no_proxy()
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(options.request_timeout_secs))
                .build()
                .map_err(|e| {
                    AudioError::with_details(
                        AudioErrorCode::Internal,
                        "The transcription client could not be created.",
                        e.to_string(),
                    )
                })?;

            // Async consumer: one request at a time, in order.
            tauri::async_runtime::spawn(transcribe_loop(
                app.clone(),
                session_id.clone(),
                seg_rx,
                Arc::clone(target),
                Arc::clone(&stats),
                client,
            ));
            Some(seg_tx)
        }
        None => None,
    };

    // Worker: DSP + VAD, feeding the async consumer.
    let worker_join = spawn_worker(
        app.clone(),
        session_id.clone(),
        pcm_rx,
        info.sample_rate,
        info.channels,
        options.vad,
        Arc::clone(&discard),
        Arc::clone(&stats),
        Arc::clone(&dropped),
        Arc::clone(&err_slot),
        seg_tx,
    )?;

    {
        let mut guard = state
            .session
            .lock()
            .map_err(|_| AudioError::internal("Audio state is poisoned."))?;
        *guard = Some(ActiveSession {
            id: session_id.clone(),
            device_name: info.device_name.clone(),
            control_tx,
            discard,
            capture_join: Some(capture_join),
            worker_join: Some(worker_join),
            target,
            stats,
            started_at: Instant::now(),
        });
    }

    emit(
        &app,
        EVENT_STATE,
        StatePayload {
            session_id: session_id.clone(),
            state: SessionState::Recording,
            reason: info
                .fell_back_to_default
                .then(|| "device_fallback".to_string()),
        },
    );

    Ok(DictationSession {
        session_id,
        device_id: info.device_id,
        device_name: info.device_name,
        sample_rate: info.sample_rate,
        resampled: info.resampled,
        fell_back_to_default: info.fell_back_to_default,
    })
}

#[tauri::command]
pub async fn stop_dictation<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AudioState>,
    session_id: String,
) -> AudioResult<()> {
    finish(&app, &state, &session_id, false)
}

#[tauri::command]
pub async fn cancel_dictation<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AudioState>,
    session_id: String,
) -> AudioResult<()> {
    finish(&app, &state, &session_id, true)
}

fn finish<R: Runtime>(
    app: &AppHandle<R>,
    state: &State<'_, AudioState>,
    session_id: &str,
    discard: bool,
) -> AudioResult<()> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| AudioError::internal("Audio state is poisoned."))?;

    let Some(session) = guard.as_ref() else {
        // Already stopped. Idempotent by design: the UI can race a device
        // disconnect that tore the session down a moment earlier.
        return Ok(());
    };
    if session.id != session_id {
        return Err(AudioError::new(
            AudioErrorCode::SessionNotFound,
            "That voice session is no longer running.",
        ));
    }

    emit(
        app,
        EVENT_STATE,
        StatePayload {
            session_id: session_id.to_string(),
            state: SessionState::Stopping,
            reason: discard.then(|| "cancelled".to_string()),
        },
    );

    let mut session = guard.take().expect("checked above");
    session.signal_stop(discard);
    // Release the lock before joining: the worker emits events and must not be
    // able to deadlock against a concurrent `get_dictation_status`.
    drop(guard);
    session.join();

    Ok(())
}

#[tauri::command]
pub async fn get_dictation_status(state: State<'_, AudioState>) -> AudioResult<DictationStatus> {
    Ok(state.status())
}

#[tauri::command]
pub async fn set_transcription_target(
    state: State<'_, AudioState>,
    session_id: String,
    base_url: String,
    api_key: String,
    model: String,
) -> AudioResult<()> {
    let guard = state
        .session
        .lock()
        .map_err(|_| AudioError::internal("Audio state is poisoned."))?;

    let Some(session) = guard.as_ref() else {
        return Err(AudioError::new(
            AudioErrorCode::SessionNotFound,
            "No voice session is running.",
        ));
    };
    if session.id != session_id {
        return Err(AudioError::new(
            AudioErrorCode::SessionNotFound,
            "That voice session is no longer running.",
        ));
    }

    let Some(session_target) = session.target.as_ref() else {
        return Err(AudioError::new(
            AudioErrorCode::SessionNotFound,
            "That voice session does not transcribe.",
        ))
    };
    let mut target = session_target
        .write()
        .map_err(|_| AudioError::internal("Transcription target is poisoned."))?;
    target.base_url = base_url;
    target.api_key = api_key;
    target.model = model;

    Ok(())
}

/// One-shot transcription of a WAV file already on disk.
#[tauri::command]
pub async fn transcribe_wav(
    base_url: String,
    api_key: String,
    model: String,
    wav_path: String,
    language: Option<String>,
    prompt: Option<String>,
    timeout_secs: Option<u64>,
) -> AudioResult<String> {
    let bytes = std::fs::read(&wav_path).map_err(|e| {
        AudioError::with_details(
            AudioErrorCode::Internal,
            "That audio file couldn't be read.",
            e.to_string(),
        )
    })?;

    let timeout = timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS);
    let target = TranscriptionTarget {
        base_url,
        api_key,
        model,
        language,
        prompt,
        timeout_secs: timeout,
    };

    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(timeout))
        .build()
        .map_err(|e| {
            AudioError::with_details(
                AudioErrorCode::Internal,
                "The transcription client could not be created.",
                e.to_string(),
            )
        })?;

    transcribe::transcribe(&client, &target, &bytes, 0).await
}

// ---------------------------------------------------------------------------
// Worker: DSP + VAD
// ---------------------------------------------------------------------------

/// One VAD outcome: emit the level, and hand any finished segment to the
/// transcription consumer. Split out of the worker loop so the `seg_tx` sender
/// stays owned by the loop and can be dropped to close the consumer.
#[allow(clippy::too_many_arguments)]
fn handle_outcome<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    outcome: crate::vad::VadOutcome,
    elapsed_ms: u64,
    stats: &SessionStats,
    seg_tx: Option<&tokio::sync::mpsc::Sender<Job>>,
    segment_index: &mut u32,
    frames_since_level: &mut u32,
    level_every: u32,
) {
    *frames_since_level += 1;
    if *frames_since_level >= level_every {
        *frames_since_level = 0;
        emit(
            app,
            EVENT_LEVEL,
            LevelPayload {
                session_id: session_id.to_string(),
                rms: outcome.rms,
                db: outcome.db,
                speaking: outcome.speaking,
                elapsed_ms,
            },
        );
    }

    let Some(segment) = outcome.segment else {
        return;
    };
    // Monitor-only session: the phrase was detected, which is all the level
    // meter needs. Skip the WAV encode entirely.
    let Some(seg_tx) = seg_tx else {
        return;
    };

    let duration_ms = segment.duration_ms();
    let index = *segment_index;
    *segment_index += 1;

    stats.segments_closed.fetch_add(1, Ordering::Relaxed);
    emit(
        app,
        EVENT_SEGMENT,
        SegmentPayload {
            session_id: session_id.to_string(),
            index,
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            duration_ms,
        },
    );

    let encoded = wav::encode_pcm16_mono(&segment.samples, TARGET_SAMPLE_RATE);
    if seg_tx
        .blocking_send(Job::Segment(SegmentJob {
            index,
            wav: encoded,
            duration_ms,
        }))
        .is_err()
    {
        log::warn!("[atomic-audio] transcription consumer is gone");
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_worker<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    pcm_rx: Receiver<Box<[f32]>>,
    src_rate: u32,
    channels: u16,
    vad_params: VadParams,
    discard: Arc<AtomicBool>,
    stats: Arc<SessionStats>,
    dropped: Arc<AtomicU64>,
    err_slot: Arc<Mutex<Option<cpal::Error>>>,
    seg_tx: Option<tokio::sync::mpsc::Sender<Job>>,
) -> AudioResult<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("atomic-audio-vad".into())
        .spawn(move || {
            let mut resampler = Resampler::new(src_rate, channels);
            let mut vad = Vad::new(vad_params, TARGET_SAMPLE_RATE);
            let frame_len = vad.frame_len().max(1);
            // One level event per 50 ms, whatever the frame size.
            let level_every = (1000 / vad_params.frame_ms.max(1) / 20).max(1);

            let mut pending: Vec<f32> = Vec::with_capacity(frame_len * 4);
            let mut resampled: Vec<f32> = Vec::with_capacity(frame_len * 4);
            let mut frame: Vec<f32> = vec![0.0; frame_len];
            let mut segment_index: u32 = 0;
            let mut frames_since_level: u32 = 0;

            for chunk in pcm_rx.iter() {
                resampled.clear();
                resampler.push(&chunk, &mut resampled);
                pending.extend_from_slice(&resampled);

                while pending.len() >= frame_len {
                    frame.copy_from_slice(&pending[..frame_len]);
                    pending.drain(0..frame_len);
                    let outcome = vad.push_frame(&frame);
                    handle_outcome(
                        &app,
                        &session_id,
                        outcome,
                        vad.elapsed_ms(),
                        &stats,
                        seg_tx.as_ref(),
                        &mut segment_index,
                        &mut frames_since_level,
                        level_every,
                    );
                }
            }

            // The capture stream closed. Flush the tail phrase, or bin it when
            // the user cancelled.
            let cancelled = discard.load(Ordering::SeqCst);
            let outcome = if cancelled { vad.abort() } else { vad.flush() };
            let elapsed = vad.elapsed_ms();
            handle_outcome(
                &app,
                &session_id,
                outcome,
                elapsed,
                &stats,
                seg_tx.as_ref(),
                &mut segment_index,
                &mut frames_since_level,
                // Force the final level event so the meter lands at rest.
                1,
            );

            stats
                .dropped_frames
                .store(dropped.load(Ordering::Relaxed), Ordering::Relaxed);

            let device_error = err_slot
                .lock()
                .ok()
                .and_then(|mut slot| slot.take())
                .map(|e| capture::map_cpal_error(&e));

            if let Some(err) = &device_error {
                emit_error(&app, Some(&session_id), err);
            }

            let reason = if device_error.is_some() {
                Some("device_disconnected".to_string())
            } else if cancelled {
                Some("cancelled".to_string())
            } else if segment_index == 0 {
                Some("no_speech".to_string())
            } else {
                None
            };

            // Hand the end of the session to the consumer so it lands *after*
            // the phrases still queued ahead of it, then close the channel.
            // A monitor-only session (or a consumer that has already died) has
            // nothing to order against, so emit it here instead.
            let handed_over = match seg_tx {
                Some(tx) => {
                    let sent = tx.blocking_send(Job::End {
                        reason: reason.clone(),
                    });
                    sent.is_ok()
                }
                None => false,
            };

            if !handed_over {
                emit(
                    &app,
                    EVENT_STATE,
                    StatePayload {
                        session_id: session_id.clone(),
                        state: SessionState::Stopped,
                        reason,
                    },
                );
            }
        })
        .map_err(|e| {
            AudioError::with_details(
                AudioErrorCode::Internal,
                "The audio worker could not be started.",
                e.to_string(),
            )
        })
}

// ---------------------------------------------------------------------------
// Async consumer: one POST at a time
// ---------------------------------------------------------------------------

async fn transcribe_loop<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    mut rx: tokio::sync::mpsc::Receiver<Job>,
    target: Arc<RwLock<TranscriptionTarget>>,
    stats: Arc<SessionStats>,
    client: reqwest::Client,
) {
    let mut consecutive_failures: u64 = 0;
    // Set once the endpoint has proved itself broken. The queue is still
    // drained afterwards rather than abandoned, because the `End` marker sits
    // behind it and the session cannot report that it stopped without it.
    let mut give_up = false;

    while let Some(job) = rx.recv().await {
        let job = match job {
            Job::End { reason } => {
                emit(
                    &app,
                    EVENT_STATE,
                    StatePayload {
                        session_id: session_id.clone(),
                        state: SessionState::Stopped,
                        reason,
                    },
                );
                continue;
            }
            Job::Segment(job) => job,
        };
        if give_up {
            continue;
        }

        let snapshot = match target.read() {
            Ok(guard) => guard.clone(),
            Err(_) => {
                // Keep draining so the `End` marker behind this job still
                // reaches the frontend and the session can end.
                log::error!("[atomic-audio] transcription target is poisoned");
                give_up = true;
                continue;
            }
        };

        let started = Instant::now();
        let mut result = transcribe::transcribe(&client, &snapshot, &job.wav, job.index as u64).await;

        // One retry for the transient classes. A cold server that has just been
        // spawned routinely refuses the first connection.
        if matches!(
            result.as_ref().err().map(|e| e.code),
            Some(AudioErrorCode::TranscriptionFailed) | Some(AudioErrorCode::ServerUnreachable)
        ) {
            tokio::time::sleep(RETRY_DELAY).await;
            result =
                transcribe::transcribe(&client, &snapshot, &job.wav, job.index as u64 + 1).await;
        }

        match result {
            Ok(text) => {
                consecutive_failures = 0;
                stats.segments_transcribed.fetch_add(1, Ordering::Relaxed);
                // An empty transcript is the "no speech in this segment" case.
                // Silently dropping it keeps the composer clean.
                //
                // So is an answer the model invented because the segment held
                // nothing it could read: the endpoint is a chat completion
                // underneath, and silence makes an instruct model helpful
                // rather than quiet.
                if text.is_empty() {
                    // Nothing was said. Nothing to insert.
                } else if !transcribe::is_plausible_transcript(&text, job.duration_ms) {
                    log::warn!(
                        "[atomic-audio] discarded a {} character answer for a {} ms segment",
                        text.chars().count(),
                        job.duration_ms
                    );
                } else {
                    emit(
                        &app,
                        EVENT_TRANSCRIPT,
                        TranscriptPayload {
                            session_id: session_id.clone(),
                            index: job.index,
                            text,
                            duration_ms: job.duration_ms,
                            latency_ms: started.elapsed().as_millis() as u64,
                        },
                    );
                }
            }
            Err(err) => {
                stats.failures.fetch_add(1, Ordering::Relaxed);
                emit_error(&app, Some(&session_id), &err);

                if err.code == AudioErrorCode::TranscriptionUnsupported {
                    // Terminal: no point transcribing any further.
                    give_up = true;
                    continue;
                }

                consecutive_failures += 1;
                if consecutive_failures >= FAILURE_LIMIT {
                    // Distinct segments failing back to back means the endpoint
                    // is broken rather than the audio being hard.
                    emit_error(
                        &app,
                        Some(&session_id),
                        &AudioError::with_details(
                            AudioErrorCode::TranscriptionFailed,
                            "Voice input isn't working with this llama.cpp build.",
                            format!(
                                "{} consecutive transcription failures; last error: {}",
                                consecutive_failures, err.message
                            ),
                        ),
                    );
                    give_up = true;
                }
            }
        }
    }
}

/// Tear down any live session. Called on app exit so a CoreAudio/WASAPI stream
/// is never left running past the process.
pub fn shutdown(state: &AudioState) {
    if let Some(id) = state.stop_active(true) {
        log::info!("[atomic-audio] stopped session {id} on shutdown");
    }
}
