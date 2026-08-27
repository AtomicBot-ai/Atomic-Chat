//! Live per-request telemetry for the Local API Server dashboard.
//!
//! The proxy already aggregates coarse observations into a three-minute
//! PostHog window (`api_request_analytics`). That path is untouched here and
//! must stay that way. This module is the *other* consumer: a bounded,
//! in-memory view of individual requests that the in-app API screen renders.
//!
//! # Privacy (ATO-113)
//!
//! `prompt_preview` and `reply_preview` carry user prompt text. They may
//! travel **only** on the `api-inspector://` Tauri channels and live **only**
//! in this module's in-memory ring buffer. They must never be written to the
//! file log, never persisted to disk, and never included in a PostHog payload.
//! Three structural guards enforce that:
//!
//!   * the channel constants deliberately avoid the `analytics://` namespace
//!     that `AnalyticProvider.tsx` forwards to PostHog verbatim;
//!   * the record types are `Serialize` only, never `Deserialize`, and never
//!     go near `state_file.rs`, so the previews never reach disk and never
//!     outlive the process;
//!   * `Debug` is implemented by hand and redacts both previews, so a
//!     `log::debug!("{record:?}")` added later cannot leak them. Do not
//!     replace those impls with `#[derive(Debug)]`.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use hyper::body::Bytes;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

/// Emitted once per request, as soon as the endpoint and model are known.
pub(crate) const API_INSPECTOR_STARTED: &str = "api-inspector://request-started";
/// Emitted at most once per second per in-flight streaming request.
pub(crate) const API_INSPECTOR_PROGRESS: &str = "api-inspector://request-progress";
/// Emitted exactly once per request, when the exchange is fully done.
pub(crate) const API_INSPECTOR_FINISHED: &str = "api-inspector://request-finished";

/// Cap on both the stored and the emitted prompt/reply previews.
pub(crate) const PREVIEW_MAX_CHARS: usize = 1000;

/// How many finished requests the ring buffer keeps.
pub(crate) const LOG_CAPACITY: usize = 200;

/// Above this many concurrent requests, progress events are suppressed
/// entirely — the dashboard is already saturated and the IPC is not.
const PROGRESS_INFLIGHT_CEILING: u32 = 64;

/// Minimum gap between progress events for one request.
const PROGRESS_INTERVAL_MS: u64 = 1000;

/// Type-erased event sink.
///
/// Erasing `R: Runtime` here is what lets `EmitState` in `proxy.rs` stay
/// non-generic while still carrying an inspector handle — making it generic
/// would ripple through ~15 function signatures. It also lets tests collect
/// events into a `Vec` without constructing an `AppHandle`, which the test
/// harness cannot do.
pub(crate) type InspectorSink = Arc<dyn Fn(&'static str, serde_json::Value) + Send + Sync>;

pub(crate) fn tauri_sink<R: Runtime>(app: AppHandle<R>) -> InspectorSink {
    Arc::new(move |channel, payload| {
        if let Err(e) = app.emit(channel, payload) {
            log::debug!("api-inspector emit failed on {channel}: {e}");
        }
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn redacted(value: &Option<String>) -> &'static str {
    match value {
        Some(_) => "<redacted>",
        None => "None",
    }
}

// ---------------------------------------------------------------------------
// Record shapes
// ---------------------------------------------------------------------------

/// Everything known about a request by the time its body has been parsed.
///
/// Deliberately carries no `backend` / `provider`: those are resolved after the
/// body parse, so at announce time they would always be a placeholder, and a
/// confidently-wrong value is worse than an absent one.
#[derive(Clone, Serialize)]
pub struct StartedFields {
    pub endpoint: &'static str,
    pub method: String,
    pub model_id: Option<String>,
    pub stream: bool,
    pub message_count: Option<u32>,
    /// PRIVACY: user prompt text. See the module docs.
    pub prompt_preview: Option<String>,
    /// Length of the untruncated prompt, in characters.
    pub prompt_chars: Option<u64>,
    pub has_non_text_parts: bool,
    pub client_max_tokens: Option<u64>,
}

impl std::fmt::Debug for StartedFields {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StartedFields")
            .field("endpoint", &self.endpoint)
            .field("method", &self.method)
            .field("model_id", &self.model_id)
            .field("stream", &self.stream)
            .field("prompt_preview", &redacted(&self.prompt_preview))
            .finish_non_exhaustive()
    }
}

/// Everything learned once the exchange completes.
#[derive(Clone, Default, Serialize)]
pub struct FinishFields {
    pub status: Option<u16>,
    pub error_kind: Option<&'static str>,
    /// The client hung up, or the upstream stalled, before the stream ended.
    pub aborted: bool,
    /// Time to upstream response headers.
    pub headers_ms: Option<u64>,
    /// Time to the first non-empty content delta.
    pub ttft_ms: Option<u64>,
    /// Whole exchange, including the streamed body.
    pub duration_ms: Option<u64>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    /// True when `completion_tokens` was counted from streamed deltas rather
    /// than reported by the upstream. The UI renders these as `~1234`.
    pub tokens_estimated: bool,
    /// Forwarded only when the upstream itself reported it (llama.cpp
    /// `timings`), which sees queue time our proxy-side clock cannot.
    pub prompt_per_second: Option<f64>,
    pub predicted_per_second: Option<f64>,
    pub finish_reason: Option<String>,
    /// PRIVACY: model output text. See the module docs.
    pub reply_preview: Option<String>,
    pub reply_chars: Option<u64>,
}

impl std::fmt::Debug for FinishFields {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FinishFields")
            .field("status", &self.status)
            .field("error_kind", &self.error_kind)
            .field("duration_ms", &self.duration_ms)
            .field("completion_tokens", &self.completion_tokens)
            .field("finish_reason", &self.finish_reason)
            .field("reply_preview", &redacted(&self.reply_preview))
            .finish_non_exhaustive()
    }
}

impl FinishFields {
    /// Fills this value's empty slots from `other`. Used to merge telemetry
    /// stashed by a response-body inspection into the fields the request
    /// wrapper knows (status, timings).
    pub(crate) fn fill_from(&mut self, other: FinishFields) {
        macro_rules! fill {
            ($($field:ident),+ $(,)?) => {$(
                if self.$field.is_none() {
                    self.$field = other.$field;
                }
            )+};
        }
        fill!(
            status,
            error_kind,
            headers_ms,
            ttft_ms,
            duration_ms,
            prompt_tokens,
            completion_tokens,
            total_tokens,
            prompt_per_second,
            predicted_per_second,
            finish_reason,
            reply_preview,
            reply_chars,
        );
        self.aborted |= other.aborted;
        self.tokens_estimated |= other.tokens_estimated;
    }
}

/// One request as the inspector sees it. Serialises to the same flat shape
/// that the started and finished events use, so the frontend has one type.
#[derive(Clone, Serialize)]
pub struct ApiRequestRecord {
    pub id: String,
    /// Monotonic within a process run. Lets the UI order and detect gaps.
    pub seq: u64,
    pub started_at_ms: u64,
    #[serde(flatten)]
    pub started: StartedFields,
    pub done: bool,
    pub finished_at_ms: Option<u64>,
    #[serde(flatten)]
    pub finish: FinishFields,
}

impl std::fmt::Debug for ApiRequestRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApiRequestRecord")
            .field("id", &self.id)
            .field("seq", &self.seq)
            .field("started", &self.started)
            .field("done", &self.done)
            .field("finish", &self.finish)
            .finish()
    }
}

#[derive(Serialize)]
struct StartedEvent<'a> {
    id: &'a str,
    seq: u64,
    started_at_ms: u64,
    #[serde(flatten)]
    fields: &'a StartedFields,
}

#[derive(Serialize)]
struct FinishedEvent<'a> {
    id: &'a str,
    seq: u64,
    done: bool,
    finished_at_ms: u64,
    #[serde(flatten)]
    fields: &'a FinishFields,
}

#[derive(Serialize)]
struct ProgressEvent<'a> {
    id: &'a str,
    seq: u64,
    ttft_ms: Option<u64>,
    completion_tokens: Option<u64>,
    reply_chars: u64,
    elapsed_ms: u64,
}

/// What `get_api_request_log` hands the frontend on mount.
#[derive(Serialize)]
pub struct ApiRequestLogSnapshot {
    pub enabled: bool,
    pub in_flight: u32,
    pub next_seq: u64,
    /// Events the sink could not deliver, so a stalled UI can tell.
    pub dropped_events: u64,
    /// Oldest first.
    pub records: Vec<ApiRequestRecord>,
}

// ---------------------------------------------------------------------------
// The inspector
// ---------------------------------------------------------------------------

/// Bounded, opt-in recorder of live proxy traffic.
///
/// Lives in `AppState` rather than inside the running server so that the log
/// survives a server restart and so the read commands work while the server
/// is stopped.
#[derive(Default)]
pub struct RequestInspector {
    /// Refcount rather than a flag: several webviews can watch at once.
    subscribers: AtomicI32,
    seq: AtomicU64,
    in_flight: AtomicU32,
    dropped_events: AtomicU64,
    sink: OnceLock<InspectorSink>,
    log: Mutex<VecDeque<ApiRequestRecord>>,
}

impl RequestInspector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Binds the Tauri emitter. Idempotent; the first caller wins.
    pub fn attach<R: Runtime>(&self, app: AppHandle<R>) {
        let _ = self.sink.set(tauri_sink(app));
    }

    #[cfg(test)]
    pub(crate) fn attach_sink(&self, sink: InspectorSink) {
        let _ = self.sink.set(sink);
    }

    pub fn enabled(&self) -> bool {
        self.subscribers.load(Ordering::Relaxed) > 0
    }

    /// Adds or removes a watcher.
    ///
    /// The ring deliberately survives the last unsubscribe: navigating away
    /// from the API screen and back must not wipe the log. It is emptied by
    /// "Clear log", or by the app exiting — the buffer is memory-only and has
    /// no on-disk form, so a restart always starts clean.
    pub fn set_enabled(&self, enabled: bool) {
        if enabled {
            self.subscribers.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let previous = self.subscribers.fetch_sub(1, Ordering::Relaxed);
        if previous <= 1 {
            // Never let a stray unsubscribe drive the count negative.
            self.subscribers.store(0, Ordering::Relaxed);
        }
    }

    pub fn clear(&self) {
        if let Ok(mut log) = self.log.lock() {
            log.clear();
        }
    }

    pub fn snapshot(&self) -> ApiRequestLogSnapshot {
        let records = self
            .log
            .lock()
            .map(|log| log.iter().cloned().collect())
            .unwrap_or_default();
        ApiRequestLogSnapshot {
            enabled: self.enabled(),
            in_flight: self.in_flight.load(Ordering::Relaxed),
            next_seq: self.seq.load(Ordering::Relaxed),
            dropped_events: self.dropped_events.load(Ordering::Relaxed),
            records,
        }
    }

    /// Mints an id for a request that is about to be handled.
    ///
    /// Returns `None` when nobody is watching. That single check is the whole
    /// cost of this feature while the dashboard is closed: no uuid, no prompt
    /// extraction, and the streaming relay stays the opaque byte copy it has
    /// always been.
    pub(crate) fn begin(self: &Arc<Self>, start: Instant) -> Option<InspectorHandle> {
        if !self.enabled() {
            return None;
        }
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        // Counted from `begin`, not `announce`: a detached relay can finish
        // before the request wrapper gets around to its fallback announce, and
        // pairing the counter with `announce` would leak a slot in that race.
        self.in_flight.fetch_add(1, Ordering::Relaxed);
        Some(InspectorHandle(Arc::new(HandleInner {
            id: format!("apireq_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]),
            seq,
            start,
            started_at_ms: now_ms(),
            announced: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            deferred: AtomicBool::new(false),
            last_progress_ms: AtomicU64::new(0),
            stash: Mutex::new(None),
            inspector: Arc::clone(self),
        })))
    }

    fn emit(&self, channel: &'static str, payload: serde_json::Value) {
        match self.sink.get() {
            Some(sink) => sink(channel, payload),
            None => {
                self.dropped_events.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn push_record(&self, record: ApiRequestRecord) {
        if let Ok(mut log) = self.log.lock() {
            log.push_back(record);
            while log.len() > LOG_CAPACITY {
                log.pop_front();
            }
        }
    }

    fn patch_record(&self, id: &str, done: bool, finished_at_ms: u64, fields: &FinishFields) {
        if let Ok(mut log) = self.log.lock() {
            if let Some(record) = log.iter_mut().find(|r| r.id == id) {
                record.done = done;
                record.finished_at_ms = Some(finished_at_ms);
                record.finish = fields.clone();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Per-request handle
// ---------------------------------------------------------------------------

struct HandleInner {
    id: String,
    seq: u64,
    start: Instant,
    started_at_ms: u64,
    announced: AtomicBool,
    finished: AtomicBool,
    deferred: AtomicBool,
    last_progress_ms: AtomicU64,
    /// Telemetry captured while inspecting a response body, merged in at
    /// finish time by whichever code path closes the request.
    stash: Mutex<Option<FinishFields>>,
    inspector: Arc<RequestInspector>,
}

/// Cheap-to-clone handle to one in-flight request.
#[derive(Clone)]
pub(crate) struct InspectorHandle(Arc<HandleInner>);

impl InspectorHandle {
    pub(crate) fn elapsed_ms(&self) -> u64 {
        self.0.start.elapsed().as_millis() as u64
    }

    /// Emits `request-started` and registers the request as in flight.
    /// Idempotent: the body-parse site announces with full detail, and the
    /// request wrapper announces as a fallback for paths that never parse a
    /// body (GETs, 404s, auth failures).
    pub(crate) fn announce(&self, fields: StartedFields) {
        if self.0.announced.swap(true, Ordering::SeqCst) {
            return;
        }
        let payload = serde_json::to_value(StartedEvent {
            id: &self.0.id,
            seq: self.0.seq,
            started_at_ms: self.0.started_at_ms,
            fields: &fields,
        })
        .unwrap_or(serde_json::Value::Null);
        self.0.inspector.push_record(ApiRequestRecord {
            id: self.0.id.clone(),
            seq: self.0.seq,
            started_at_ms: self.0.started_at_ms,
            started: fields,
            done: false,
            finished_at_ms: None,
            finish: FinishFields::default(),
        });
        self.0.inspector.emit(API_INSPECTOR_STARTED, payload);
    }

    /// Marks that a detached task owns the finish event, so the synchronous
    /// request wrapper leaves the request open when it returns.
    pub(crate) fn defer_finish(&self) {
        self.0.deferred.store(true, Ordering::SeqCst);
    }

    pub(crate) fn is_deferred(&self) -> bool {
        self.0.deferred.load(Ordering::SeqCst)
    }

    /// Stashes telemetry gathered from a response body. Merged into whatever
    /// fields the closing code path supplies.
    pub(crate) fn stash(&self, fields: FinishFields) {
        if let Ok(mut slot) = self.0.stash.lock() {
            *slot = Some(fields);
        }
    }

    /// Emits a throttled progress tick for a long-running stream.
    pub(crate) fn progress(&self, tel: &StreamTelemetry) {
        if self.0.finished.load(Ordering::SeqCst) {
            return;
        }
        if self.0.inspector.in_flight.load(Ordering::Relaxed) > PROGRESS_INFLIGHT_CEILING {
            return;
        }
        let elapsed = self.elapsed_ms();
        let last = self.0.last_progress_ms.load(Ordering::Relaxed);
        if elapsed.saturating_sub(last) < PROGRESS_INTERVAL_MS {
            return;
        }
        self.0.last_progress_ms.store(elapsed, Ordering::Relaxed);
        let payload = serde_json::to_value(ProgressEvent {
            id: &self.0.id,
            seq: self.0.seq,
            ttft_ms: tel.ttft_ms(self.0.start),
            completion_tokens: tel.completion_tokens_or_estimate(),
            reply_chars: tel.reply_chars,
            elapsed_ms: elapsed,
        })
        .unwrap_or(serde_json::Value::Null);
        self.0.inspector.emit(API_INSPECTOR_PROGRESS, payload);
    }

    /// Emits `request-finished`, patches the ring record and releases the
    /// in-flight slot. Idempotent, so a duplicate call from a `FinishGuard`
    /// and an explicit call is a no-op rather than a double count.
    pub(crate) fn finish(&self, mut fields: FinishFields) {
        if self.0.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut slot) = self.0.stash.lock() {
            if let Some(stashed) = slot.take() {
                fields.fill_from(stashed);
            }
        }
        if fields.duration_ms.is_none() {
            fields.duration_ms = Some(self.elapsed_ms());
        }
        let _ = self.0.inspector.in_flight.fetch_update(
            Ordering::Relaxed,
            Ordering::Relaxed,
            |v| Some(v.saturating_sub(1)),
        );
        let finished_at_ms = now_ms();
        self.0
            .inspector
            .patch_record(&self.0.id, true, finished_at_ms, &fields);
        if !self.0.announced.load(Ordering::SeqCst) {
            // Never surfaced to the UI (CORS preflight, static docs, and other
            // `skip_emit` traffic). Releasing the slot above is enough.
            return;
        }
        let payload = serde_json::to_value(FinishedEvent {
            id: &self.0.id,
            seq: self.0.seq,
            done: true,
            finished_at_ms,
            fields: &fields,
        })
        .unwrap_or(serde_json::Value::Null);
        self.0.inspector.emit(API_INSPECTOR_FINISHED, payload);
    }
}

/// Emits the finish event when dropped.
///
/// The streaming relays have many early `break`/`return` paths; placing a
/// finish call on each by hand is how in-flight rows become zombies. Moving a
/// guard into the detached task closes the request no matter how it exits.
pub(crate) struct FinishGuard {
    handle: InspectorHandle,
    pub fields: FinishFields,
}

impl FinishGuard {
    pub(crate) fn new(handle: InspectorHandle, fields: FinishFields) -> Self {
        handle.defer_finish();
        Self { handle, fields }
    }

    pub(crate) fn handle(&self) -> &InspectorHandle {
        &self.handle
    }
}

impl Drop for FinishGuard {
    fn drop(&mut self) {
        self.handle.finish(std::mem::take(&mut self.fields));
    }
}

// ---------------------------------------------------------------------------
// Prompt preview
// ---------------------------------------------------------------------------

#[derive(Debug, Default, PartialEq)]
pub(crate) struct PromptPreview {
    pub text: Option<String>,
    /// Length before truncation, in characters.
    pub chars: Option<u64>,
    pub message_count: Option<u32>,
    pub has_non_text_parts: bool,
}

/// Extracts a short, human-readable preview of what the client asked for.
///
/// PRIVACY (ATO-113): the returned text is prompt content. It may travel only
/// on the `api-inspector://` channels and live only in the in-memory ring.
/// Never log it — the zero-PII rule for `tracing` still stands.
pub(crate) fn prompt_preview(json_body: &serde_json::Value, max_chars: usize) -> PromptPreview {
    let mut out = PromptPreview::default();

    // `/responses` uses `input`, which may be a bare string.
    if let Some(text) = json_body.get("input").and_then(|v| v.as_str()) {
        set_text(&mut out, text, max_chars);
        return out;
    }

    let messages = json_body
        .get("messages")
        .or_else(|| json_body.get("input"))
        .and_then(|v| v.as_array());
    let Some(messages) = messages else {
        return out;
    };
    out.message_count = Some(messages.len() as u32);

    let chosen = messages
        .iter()
        .rev()
        .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        .or_else(|| messages.last());
    let Some(chosen) = chosen else {
        return out;
    };

    let content = chosen.get("content");
    let mut text = String::new();
    match content {
        Some(serde_json::Value::String(s)) => text.push_str(s),
        Some(serde_json::Value::Array(parts)) => {
            for part in parts {
                match part.get("type").and_then(|t| t.as_str()) {
                    Some("text") | Some("input_text") | Some("output_text") => {
                        if let Some(s) = part.get("text").and_then(|t| t.as_str()) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(s);
                        }
                    }
                    // Images, audio and tool blocks are not previewable, but
                    // their presence is worth surfacing.
                    Some(_) => out.has_non_text_parts = true,
                    None => {}
                }
            }
        }
        _ => {}
    }

    if !text.is_empty() {
        set_text(&mut out, &text, max_chars);
    }
    out
}

fn set_text(out: &mut PromptPreview, text: &str, max_chars: usize) {
    let total = text.chars().count();
    out.chars = Some(total as u64);
    // Truncate on a character boundary: byte slicing panics on multi-byte
    // input, and prompts are routinely non-ASCII.
    out.text = Some(text.chars().take(max_chars).collect());
}

// ---------------------------------------------------------------------------
// Stream telemetry
// ---------------------------------------------------------------------------

/// Folds streamed frames into the numbers the inspector reports.
///
/// Understands OpenAI chat-completion chunks and complete responses, the
/// llama.cpp `timings` block, and the Anthropic `/messages` event shapes the
/// proxy passes through. The usage-vs-timings precedence mirrors
/// `mergeMetrics` in `web-app/src/lib/model-factory.ts` — keep the two in
/// sync if either changes.
#[derive(Default)]
pub(crate) struct StreamTelemetry {
    pub first_content_at: Option<Instant>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub prompt_per_second: Option<f64>,
    pub predicted_per_second: Option<f64>,
    pub finish_reason: Option<String>,
    /// Number of content deltas seen. llama.cpp emits one chunk per token, so
    /// this is exact there and a reasonable estimate elsewhere.
    pub delta_count: u64,
    reply: String,
    /// Kept apart from `reply` so a model that produced a real answer previews
    /// the answer, not the thinking that preceded it.
    reasoning: String,
    pub reply_chars: u64,
}

/// Pulls a chunk's reasoning text out, whichever spelling the server used.
///
/// There are three in the wild, and which one you get depends on who is
/// serving rather than on the model:
///   * `reasoning_content` — llama.cpp, DeepSeek, Qwen (the canonical one);
///   * `reasoning` — Ollama and newer vLLM;
///   * `reasoning_details` — OpenRouter, a list of `{ text }` parts.
///
/// (Matches the alias set Unsloth normalises in
/// `studio/backend/core/inference/sse_control_frames.py`.)
///
/// First match wins: a payload that carries two of them describes one stream of
/// thinking, and counting it twice would inflate the token estimate.
fn extract_reasoning(choice: &serde_json::Value) -> Option<String> {
    for field in ["reasoning_content", "reasoning"] {
        for parent in ["delta", "message"] {
            if let Some(text) = choice
                .pointer(&format!("/{parent}/{field}"))
                .and_then(|v| v.as_str())
            {
                if !text.is_empty() {
                    return Some(text.to_string());
                }
            }
        }
    }
    for parent in ["delta", "message"] {
        if let Some(parts) = choice
            .pointer(&format!("/{parent}/reasoning_details"))
            .and_then(|v| v.as_array())
        {
            let joined: String = parts
                .iter()
                .filter_map(|part| part.get("text").and_then(|t| t.as_str()))
                .collect();
            if !joined.is_empty() {
                return Some(joined);
            }
        }
    }
    None
}

/// Appends up to the preview cap, on a character boundary.
fn append_capped(buffer: &mut String, text: &str) {
    let room = PREVIEW_MAX_CHARS.saturating_sub(buffer.chars().count());
    if room > 0 {
        buffer.extend(text.chars().take(room));
    }
}

impl StreamTelemetry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn on_json(&mut self, v: &serde_json::Value, now: Instant) {
        // Anthropic passthrough events.
        match v.get("type").and_then(|t| t.as_str()) {
            Some("content_block_delta") => {
                if let Some(text) = v.pointer("/delta/text").and_then(|t| t.as_str()) {
                    self.on_content(text, now);
                }
                // Extended-thinking blocks are the Anthropic spelling of the
                // same thing `reasoning_content` carries elsewhere.
                if let Some(text) = v.pointer("/delta/thinking").and_then(|t| t.as_str()) {
                    self.on_reasoning(text, now);
                }
                return;
            }
            Some("message_start") => {
                self.prompt_tokens = v
                    .pointer("/message/usage/input_tokens")
                    .and_then(|t| t.as_u64())
                    .or(self.prompt_tokens);
                return;
            }
            Some("message_delta") => {
                if let Some(n) = v.pointer("/usage/output_tokens").and_then(|t| t.as_u64()) {
                    self.completion_tokens = Some(n);
                }
                if let Some(reason) = v.pointer("/delta/stop_reason").and_then(|t| t.as_str()) {
                    self.finish_reason = Some(reason.to_string());
                }
                return;
            }
            _ => {}
        }

        if let Some(choice) = v.pointer("/choices/0") {
            // Streaming delta, or a complete non-streaming message.
            for pointer in ["/delta/content", "/message/content"] {
                if let Some(text) = choice.pointer(pointer).and_then(|c| c.as_str()) {
                    self.on_content(text, now);
                }
            }
            // Reasoning models (Qwen3.5, DeepSeek-R1, ...) stream their tokens
            // as reasoning and leave `content` null until the think block
            // closes. Those are real emitted tokens: they set the
            // time-to-first-token, and when a reply is cut short before any
            // `content` arrives they are the only thing there is to preview.
            if let Some(text) = extract_reasoning(choice) {
                self.on_reasoning(&text, now);
            }
            if let Some(reason) = choice.get("finish_reason").and_then(|r| r.as_str()) {
                self.finish_reason = Some(reason.to_string());
            }
        }

        // With `include_usage`, OpenAI and llama.cpp put `"usage": null` on
        // every content chunk — a bare `is_some()` here would misread all of
        // them as the trailer.
        if let Some(usage) = v.get("usage").filter(|u| !u.is_null()) {
            if let Some(n) = usage.get("prompt_tokens").and_then(|t| t.as_u64()) {
                self.prompt_tokens = Some(n);
            }
            if let Some(n) = usage.get("completion_tokens").and_then(|t| t.as_u64()) {
                self.completion_tokens = Some(n);
            }
            if let Some(n) = usage.get("total_tokens").and_then(|t| t.as_u64()) {
                self.total_tokens = Some(n);
            }
        }

        if let Some(timings) = v.get("timings").filter(|t| t.is_object()) {
            if self.prompt_tokens.is_none() {
                self.prompt_tokens = timings.get("prompt_n").and_then(|t| t.as_u64());
            }
            if self.completion_tokens.is_none() {
                self.completion_tokens = timings.get("predicted_n").and_then(|t| t.as_u64());
            }
            // Rates: the upstream's own numbers win, they see queue time.
            if let Some(v) = timings.get("prompt_per_second").and_then(|t| t.as_f64()) {
                if v > 0.0 {
                    self.prompt_per_second = Some(v);
                }
            }
            if let Some(v) = timings.get("predicted_per_second").and_then(|t| t.as_f64()) {
                if v > 0.0 {
                    self.predicted_per_second = Some(v);
                }
            }
        }
    }

    fn on_content(&mut self, text: &str, now: Instant) {
        if text.is_empty() {
            return;
        }
        self.mark_token(now);
        self.reply_chars += text.chars().count() as u64;
        append_capped(&mut self.reply, text);
    }

    fn on_reasoning(&mut self, text: &str, now: Instant) {
        if text.is_empty() {
            return;
        }
        self.mark_token(now);
        self.reply_chars += text.chars().count() as u64;
        append_capped(&mut self.reasoning, text);
    }

    fn mark_token(&mut self, now: Instant) {
        if self.first_content_at.is_none() {
            self.first_content_at = Some(now);
        }
        self.delta_count += 1;
    }

    pub(crate) fn ttft_ms(&self, start: Instant) -> Option<u64> {
        self.first_content_at
            .map(|at| at.saturating_duration_since(start).as_millis() as u64)
    }

    fn completion_tokens_or_estimate(&self) -> Option<u64> {
        self.completion_tokens.or({
            if self.delta_count > 0 {
                Some(self.delta_count)
            } else {
                None
            }
        })
    }

    pub(crate) fn into_finish_fields(self, start: Instant) -> FinishFields {
        let ttft_ms = self.ttft_ms(start);
        let estimated = self.completion_tokens.is_none() && self.delta_count > 0;
        let completion_tokens = self.completion_tokens_or_estimate();
        let total_tokens = self.total_tokens.or_else(|| {
            match (self.prompt_tokens, completion_tokens) {
                // Only sum when the completion count is authoritative — a
                // total built from an estimate would read as exact.
                (Some(p), Some(c)) if !estimated => Some(p + c),
                _ => None,
            }
        });
        FinishFields {
            ttft_ms,
            prompt_tokens: self.prompt_tokens,
            completion_tokens,
            total_tokens,
            tokens_estimated: estimated,
            prompt_per_second: self.prompt_per_second,
            predicted_per_second: self.predicted_per_second,
            finish_reason: self.finish_reason,
            reply_preview: if self.reply.is_empty() {
                (!self.reasoning.is_empty()).then_some(self.reasoning)
            } else {
                Some(self.reply)
            },
            reply_chars: (self.reply_chars > 0).then_some(self.reply_chars),
            ..Default::default()
        }
    }
}

// ---------------------------------------------------------------------------
// Usage injection
// ---------------------------------------------------------------------------

/// Adds `stream_options: {include_usage: true}` to a buffered
/// `/chat/completions` body so the upstream reports real token counts.
///
/// Returns `None` when nothing changed — including when the client already
/// asked, in which case there is also nothing to strip back out.
pub(crate) fn maybe_inject_stream_usage(body: &Bytes) -> Option<Bytes> {
    let mut json: serde_json::Value = serde_json::from_slice(body).ok()?;
    let obj = json.as_object_mut()?;
    if obj.get("stream").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    match obj.get_mut("stream_options") {
        Some(serde_json::Value::Object(opts)) => {
            if opts.contains_key("include_usage") {
                return None; // The client's own choice wins.
            }
            opts.insert("include_usage".into(), serde_json::Value::Bool(true));
        }
        // Present but not an object: the upstream will reject it on its own
        // terms. Rewriting it would change the error the client sees.
        Some(_) => return None,
        None => {
            obj.insert(
                "stream_options".into(),
                serde_json::json!({ "include_usage": true }),
            );
        }
    }
    serde_json::to_vec(&json).ok().map(Bytes::from)
}

/// True for the usage-only trailer chunk that `include_usage` appends.
///
/// Both conditions matter: `usage` is present but **null** on every content
/// chunk once `include_usage` is on.
pub(crate) fn is_usage_only_chunk(v: &serde_json::Value) -> bool {
    let choices_empty = v
        .get("choices")
        .and_then(|c| c.as_array())
        .map(|c| c.is_empty())
        .unwrap_or(false);
    let has_usage = v.get("usage").map(|u| !u.is_null()).unwrap_or(false);
    choices_empty && has_usage
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    // -- prompt preview ----------------------------------------------------

    #[test]
    fn openai_string_content_uses_last_user_message() {
        let body = json!({"messages": [
            {"role": "system", "content": "be nice"},
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "hi"},
            {"role": "user", "content": "second"},
        ]});
        let p = prompt_preview(&body, PREVIEW_MAX_CHARS);
        assert_eq!(p.text.as_deref(), Some("second"));
        assert_eq!(p.message_count, Some(4));
        assert!(!p.has_non_text_parts);
    }

    #[test]
    fn openai_parts_content_joins_text_and_flags_images() {
        let body = json!({"messages": [{"role": "user", "content": [
            {"type": "text", "text": "what is this"},
            {"type": "image_url", "image_url": {"url": "data:..."}},
            {"type": "text", "text": "exactly"},
        ]}]});
        let p = prompt_preview(&body, PREVIEW_MAX_CHARS);
        assert_eq!(p.text.as_deref(), Some("what is this\nexactly"));
        assert!(p.has_non_text_parts);
    }

    #[test]
    fn anthropic_content_blocks_preview() {
        let body = json!({"model": "claude", "messages": [
            {"role": "user", "content": [{"type": "text", "text": "hello anthropic"}]}
        ]});
        assert_eq!(
            prompt_preview(&body, PREVIEW_MAX_CHARS).text.as_deref(),
            Some("hello anthropic")
        );
    }

    #[test]
    fn responses_input_string_and_array_shapes() {
        let as_string = json!({"input": "plain string input"});
        let p = prompt_preview(&as_string, PREVIEW_MAX_CHARS);
        assert_eq!(p.text.as_deref(), Some("plain string input"));
        assert_eq!(p.message_count, None);

        let as_array = json!({"input": [
            {"role": "user", "content": [{"type": "input_text", "text": "structured input"}]}
        ]});
        let p = prompt_preview(&as_array, PREVIEW_MAX_CHARS);
        assert_eq!(p.text.as_deref(), Some("structured input"));
        assert_eq!(p.message_count, Some(1));
    }

    #[test]
    fn preview_truncates_on_char_boundary_and_reports_full_length() {
        // A 4-byte emoji sits exactly on the cut; byte slicing would panic.
        let text = format!("{}🙂 tail", "a".repeat(9));
        let body = json!({"messages": [{"role": "user", "content": text}]});
        let p = prompt_preview(&body, 10);
        assert_eq!(p.text.as_deref(), Some("aaaaaaaaa🙂"));
        assert_eq!(p.chars, Some(15));
    }

    #[test]
    fn preview_is_none_when_messages_missing() {
        assert_eq!(
            prompt_preview(&json!({"model": "x"}), PREVIEW_MAX_CHARS),
            PromptPreview::default()
        );
    }

    #[test]
    fn system_only_conversation_falls_back_to_last_message() {
        let body = json!({"messages": [{"role": "system", "content": "only system"}]});
        assert_eq!(
            prompt_preview(&body, PREVIEW_MAX_CHARS).text.as_deref(),
            Some("only system")
        );
    }

    // -- usage injection / stripping ---------------------------------------

    fn body(v: serde_json::Value) -> Bytes {
        Bytes::from(serde_json::to_vec(&v).unwrap())
    }

    #[test]
    fn injects_include_usage_when_client_did_not_ask() {
        let out = maybe_inject_stream_usage(&body(json!({"model": "m", "stream": true})))
            .expect("should inject");
        let parsed: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(parsed.pointer("/stream_options/include_usage"), Some(&json!(true)));
    }

    #[test]
    fn returns_none_when_client_already_asked() {
        let b = body(json!({"stream": true, "stream_options": {"include_usage": false}}));
        assert!(maybe_inject_stream_usage(&b).is_none());
    }

    #[test]
    fn returns_none_for_non_stream_body() {
        assert!(maybe_inject_stream_usage(&body(json!({"stream": false}))).is_none());
        assert!(maybe_inject_stream_usage(&body(json!({"model": "m"}))).is_none());
    }

    #[test]
    fn returns_none_when_stream_options_is_not_an_object() {
        let b = body(json!({"stream": true, "stream_options": "nonsense"}));
        assert!(maybe_inject_stream_usage(&b).is_none());
    }

    #[test]
    fn injection_preserves_all_other_fields() {
        let original = json!({
            "model": "m", "stream": true, "temperature": 0.4,
            "messages": [{"role": "user", "content": "hi"}],
            "stream_options": {"other": 1}
        });
        let out = maybe_inject_stream_usage(&body(original.clone())).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(parsed["model"], original["model"]);
        assert_eq!(parsed["temperature"], original["temperature"]);
        assert_eq!(parsed["messages"], original["messages"]);
        assert_eq!(parsed["stream_options"]["other"], json!(1));
        assert_eq!(parsed["stream_options"]["include_usage"], json!(true));
    }

    #[test]
    fn is_usage_only_chunk_matches_trailer() {
        assert!(is_usage_only_chunk(
            &json!({"choices": [], "usage": {"prompt_tokens": 5}})
        ));
    }

    /// The `"usage": null`-on-every-chunk trap.
    #[test]
    fn is_usage_only_chunk_false_when_usage_is_null() {
        assert!(!is_usage_only_chunk(&json!({
            "choices": [{"delta": {"content": "hi"}}], "usage": null
        })));
        assert!(!is_usage_only_chunk(&json!({"choices": [], "usage": null})));
    }

    #[test]
    fn is_usage_only_chunk_false_for_a_normal_delta() {
        assert!(!is_usage_only_chunk(
            &json!({"choices": [{"delta": {"content": "hi"}}]})
        ));
    }

    // -- stream telemetry --------------------------------------------------

    fn delta(text: &str) -> serde_json::Value {
        json!({"choices": [{"delta": {"content": text}}]})
    }

    #[test]
    fn openai_deltas_accumulate_reply_preview_up_to_cap() {
        let mut tel = StreamTelemetry::new();
        let now = Instant::now();
        for _ in 0..(PREVIEW_MAX_CHARS + 50) {
            tel.on_json(&delta("x"), now);
        }
        let fields = tel.into_finish_fields(now);
        assert_eq!(
            fields.reply_preview.as_ref().map(|s| s.chars().count()),
            Some(PREVIEW_MAX_CHARS)
        );
        assert_eq!(fields.reply_chars, Some((PREVIEW_MAX_CHARS + 50) as u64));
    }

    #[test]
    fn openai_trailer_usage_sets_token_counts() {
        let mut tel = StreamTelemetry::new();
        let now = Instant::now();
        tel.on_json(&delta("hi"), now);
        tel.on_json(
            &json!({"choices": [], "usage": {"prompt_tokens": 11, "completion_tokens": 22, "total_tokens": 33}}),
            now,
        );
        let f = tel.into_finish_fields(now);
        assert_eq!(f.prompt_tokens, Some(11));
        assert_eq!(f.completion_tokens, Some(22));
        assert_eq!(f.total_tokens, Some(33));
        assert!(!f.tokens_estimated);
    }

    #[test]
    fn llamacpp_timings_sets_counts_and_speeds() {
        let mut tel = StreamTelemetry::new();
        let now = Instant::now();
        tel.on_json(
            &json!({"timings": {"prompt_n": 28, "predicted_n": 150,
                                "prompt_per_second": 37.1, "predicted_per_second": 54.9}}),
            now,
        );
        let f = tel.into_finish_fields(now);
        assert_eq!(f.prompt_tokens, Some(28));
        assert_eq!(f.completion_tokens, Some(150));
        assert_eq!(f.prompt_per_second, Some(37.1));
        assert_eq!(f.predicted_per_second, Some(54.9));
        assert_eq!(f.total_tokens, Some(178));
    }

    #[test]
    fn usage_wins_for_counts_timings_wins_for_rates() {
        let mut tel = StreamTelemetry::new();
        let now = Instant::now();
        tel.on_json(
            &json!({"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 6},
                    "timings": {"prompt_n": 99, "predicted_n": 99, "predicted_per_second": 12.5}}),
            now,
        );
        let f = tel.into_finish_fields(now);
        assert_eq!(f.prompt_tokens, Some(5));
        assert_eq!(f.completion_tokens, Some(6));
        assert_eq!(f.predicted_per_second, Some(12.5));
    }

    /// Qwen3.5 / DeepSeek-R1 stream into `reasoning_content` and leave
    /// `content` null. Missing that left the dashboard with no time-to-first-
    /// token and an empty reply for exactly the models people run locally.
    #[test]
    fn reasoning_deltas_count_as_tokens_and_preview_when_content_is_absent() {
        let mut tel = StreamTelemetry::new();
        let start = Instant::now();
        tel.on_json(&json!({"choices": [{"delta": {"content": null}}]}), start);
        assert!(tel.first_content_at.is_none(), "a null content is not a token");

        let later = start + Duration::from_millis(120);
        tel.on_json(
            &json!({"choices": [{"delta": {"reasoning_content": "Thinking"}}]}),
            later,
        );
        tel.on_json(
            &json!({"choices": [{"delta": {"reasoning_content": " hard"}}]}),
            start + Duration::from_millis(300),
        );
        assert_eq!(tel.ttft_ms(start), Some(120));

        let f = tel.into_finish_fields(start);
        assert_eq!(f.reply_preview.as_deref(), Some("Thinking hard"));
        assert_eq!(f.completion_tokens, Some(2));
        assert!(f.tokens_estimated);
    }

    /// Which spelling you get depends on who is serving, not on the model.
    #[test]
    fn every_reasoning_alias_is_understood() {
        for delta in [
            json!({"reasoning_content": "thought"}),          // llama.cpp, Qwen
            json!({"reasoning": "thought"}),                  // Ollama, vLLM
            json!({"reasoning_details": [{"text": "thou"}, {"text": "ght"}]}), // OpenRouter
        ] {
            let mut tel = StreamTelemetry::new();
            let now = Instant::now();
            tel.on_json(&json!({"choices": [{"delta": delta}]}), now);
            let f = tel.into_finish_fields(now);
            assert_eq!(f.reply_preview.as_deref(), Some("thought"), "{delta:?}");
            assert_eq!(f.completion_tokens, Some(1), "{delta:?}");
        }
    }

    #[test]
    fn a_chunk_carrying_two_reasoning_aliases_is_counted_once() {
        // Some servers emit the alias alongside the canonical field; both
        // describe the same stream of thinking.
        let mut tel = StreamTelemetry::new();
        let now = Instant::now();
        tel.on_json(
            &json!({"choices": [{"delta": {
                "reasoning_content": "thought",
                "reasoning": "thought"
            }}]}),
            now,
        );
        let f = tel.into_finish_fields(now);
        assert_eq!(f.reply_preview.as_deref(), Some("thought"));
        assert_eq!(f.completion_tokens, Some(1));
        assert_eq!(f.reply_chars, Some(7));
    }

    #[test]
    fn anthropic_thinking_deltas_count_as_reasoning() {
        let mut tel = StreamTelemetry::new();
        let now = Instant::now();
        tel.on_json(
            &json!({"type": "content_block_delta",
                    "delta": {"type": "thinking_delta", "thinking": "hmm"}}),
            now,
        );
        let f = tel.into_finish_fields(now);
        assert_eq!(f.reply_preview.as_deref(), Some("hmm"));
        assert_eq!(f.completion_tokens, Some(1));
    }

    #[test]
    fn a_real_answer_previews_the_answer_not_the_thinking() {
        let mut tel = StreamTelemetry::new();
        let now = Instant::now();
        tel.on_json(
            &json!({"choices": [{"delta": {"reasoning_content": "let me think"}}]}),
            now,
        );
        tel.on_json(&delta("The answer is 4."), now);
        let f = tel.into_finish_fields(now);
        assert_eq!(f.reply_preview.as_deref(), Some("The answer is 4."));
        // Both halves are emitted tokens, so both are counted.
        assert_eq!(f.completion_tokens, Some(2));
        assert_eq!(f.reply_chars, Some(28));
    }

    #[test]
    fn non_stream_reasoning_only_response_still_previews() {
        let mut tel = StreamTelemetry::new();
        let now = Instant::now();
        tel.on_json(
            &json!({"choices": [{"message": {"content": "", "reasoning_content": "Thinking Process:"},
                                 "finish_reason": "length"}],
                    "usage": {"prompt_tokens": 23, "completion_tokens": 40, "total_tokens": 63}}),
            now,
        );
        let f = tel.into_finish_fields(now);
        assert_eq!(f.reply_preview.as_deref(), Some("Thinking Process:"));
        assert_eq!(f.completion_tokens, Some(40));
        assert!(!f.tokens_estimated);
    }

    #[test]
    fn finish_reason_captured_from_last_choice() {
        let mut tel = StreamTelemetry::new();
        let now = Instant::now();
        tel.on_json(&delta("a"), now);
        tel.on_json(&json!({"choices": [{"delta": {}, "finish_reason": "length"}]}), now);
        assert_eq!(
            tel.into_finish_fields(now).finish_reason.as_deref(),
            Some("length")
        );
    }

    #[test]
    fn anthropic_events_set_tokens_stop_reason_and_text() {
        let mut tel = StreamTelemetry::new();
        let now = Instant::now();
        tel.on_json(
            &json!({"type": "message_start", "message": {"usage": {"input_tokens": 7}}}),
            now,
        );
        tel.on_json(
            &json!({"type": "content_block_delta", "delta": {"text": "hello"}}),
            now,
        );
        tel.on_json(
            &json!({"type": "message_delta", "usage": {"output_tokens": 3},
                    "delta": {"stop_reason": "end_turn"}}),
            now,
        );
        let f = tel.into_finish_fields(now);
        assert_eq!(f.prompt_tokens, Some(7));
        assert_eq!(f.completion_tokens, Some(3));
        assert_eq!(f.finish_reason.as_deref(), Some("end_turn"));
        assert_eq!(f.reply_preview.as_deref(), Some("hello"));
    }

    #[test]
    fn ttft_set_on_first_non_empty_content_delta() {
        let mut tel = StreamTelemetry::new();
        let start = Instant::now();
        tel.on_json(&delta(""), start);
        assert!(tel.first_content_at.is_none(), "empty delta must not set ttft");
        let later = start + Duration::from_millis(250);
        tel.on_json(&delta("x"), later);
        tel.on_json(&delta("y"), start + Duration::from_millis(900));
        assert_eq!(tel.ttft_ms(start), Some(250));
    }

    #[test]
    fn delta_count_estimate_used_when_usage_absent_and_marked_estimated() {
        let mut tel = StreamTelemetry::new();
        let now = Instant::now();
        for _ in 0..7 {
            tel.on_json(&delta("t"), now);
        }
        let f = tel.into_finish_fields(now);
        assert_eq!(f.completion_tokens, Some(7));
        assert!(f.tokens_estimated);
        // An estimate must not be laundered into an exact total.
        assert_eq!(f.total_tokens, None);
    }

    #[test]
    fn non_stream_response_yields_usage_and_finish_reason() {
        let mut tel = StreamTelemetry::new();
        let now = Instant::now();
        tel.on_json(
            &json!({"choices": [{"message": {"content": "4"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 12, "completion_tokens": 1, "total_tokens": 13}}),
            now,
        );
        let f = tel.into_finish_fields(now);
        assert_eq!(f.finish_reason.as_deref(), Some("stop"));
        assert_eq!(f.total_tokens, Some(13));
        assert_eq!(f.reply_preview.as_deref(), Some("4"));
    }

    // -- lifecycle / ring buffer -------------------------------------------

    type Captured = Arc<Mutex<Vec<(&'static str, serde_json::Value)>>>;

    fn inspector_with_sink() -> (Arc<RequestInspector>, Captured) {
        let captured: Captured = Arc::new(Mutex::new(Vec::new()));
        let sink_target = Arc::clone(&captured);
        let inspector = Arc::new(RequestInspector::new());
        inspector.attach_sink(Arc::new(move |channel, payload| {
            sink_target.lock().unwrap().push((channel, payload));
        }));
        inspector.set_enabled(true);
        (inspector, captured)
    }

    fn started_fields() -> StartedFields {
        StartedFields {
            endpoint: "chat/completions",
            method: "POST".into(),
            model_id: Some("m".into()),
            stream: true,
            message_count: Some(1),
            prompt_preview: Some("a secret prompt".into()),
            prompt_chars: Some(15),
            has_non_text_parts: false,
            client_max_tokens: None,
        }
    }

    fn channels(captured: &Captured) -> Vec<&'static str> {
        captured.lock().unwrap().iter().map(|(c, _)| *c).collect()
    }

    #[test]
    fn begin_returns_none_when_disabled() {
        let inspector = Arc::new(RequestInspector::new());
        assert!(inspector.begin(Instant::now()).is_none());
        inspector.set_enabled(true);
        assert!(inspector.begin(Instant::now()).is_some());
    }

    #[test]
    fn ring_evicts_oldest_past_capacity() {
        let (inspector, _) = inspector_with_sink();
        for _ in 0..(LOG_CAPACITY + 25) {
            let h = inspector.begin(Instant::now()).unwrap();
            h.announce(started_fields());
            h.finish(FinishFields::default());
        }
        let snapshot = inspector.snapshot();
        assert_eq!(snapshot.records.len(), LOG_CAPACITY);
        // Oldest first, and the first 25 are gone.
        assert_eq!(snapshot.records[0].seq, 25);
        assert_eq!(snapshot.in_flight, 0);
    }

    #[test]
    fn finish_is_idempotent_and_in_flight_never_underflows() {
        let (inspector, captured) = inspector_with_sink();
        let h = inspector.begin(Instant::now()).unwrap();
        assert_eq!(inspector.snapshot().in_flight, 1, "counted from begin");
        h.announce(started_fields());
        assert_eq!(inspector.snapshot().in_flight, 1);
        h.finish(FinishFields::default());
        h.finish(FinishFields::default());
        h.finish(FinishFields::default());
        assert_eq!(inspector.snapshot().in_flight, 0);
        assert_eq!(
            channels(&captured),
            vec![API_INSPECTOR_STARTED, API_INSPECTOR_FINISHED]
        );
    }

    #[test]
    fn drop_guard_emits_finish_on_early_return() {
        let (inspector, captured) = inspector_with_sink();
        let h = inspector.begin(Instant::now()).unwrap();
        h.announce(started_fields());

        // Simulate a detached relay that breaks out early.
        (|| {
            let mut guard = FinishGuard::new(h.clone(), FinishFields::default());
            guard.fields.aborted = true;
            #[allow(clippy::needless_return)]
            return;
        })();

        assert!(h.is_deferred());
        assert_eq!(inspector.snapshot().in_flight, 0);
        let events = captured.lock().unwrap();
        let (channel, payload) = events.last().unwrap();
        assert_eq!(*channel, API_INSPECTOR_FINISHED);
        assert_eq!(payload["aborted"], json!(true));
        assert_eq!(payload["done"], json!(true));
    }

    /// The relays build their guard *before* spawning, because the request
    /// wrapper checks `is_deferred()` the moment the handler returns. If the
    /// guard were constructed inside the task, the wrapper could win the race
    /// and close the request while its body was still streaming.
    #[test]
    fn finish_guard_marks_deferred_synchronously() {
        let (inspector, _) = inspector_with_sink();
        let h = inspector.begin(Instant::now()).unwrap();
        h.announce(started_fields());
        assert!(!h.is_deferred());
        let guard = FinishGuard::new(h.clone(), FinishFields::default());
        assert!(h.is_deferred());
        drop(guard);
    }

    #[test]
    fn announce_is_idempotent_across_parse_site_and_wrapper_fallback() {
        let (inspector, captured) = inspector_with_sink();
        let h = inspector.begin(Instant::now()).unwrap();
        h.announce(started_fields());
        let mut fallback = started_fields();
        fallback.endpoint = "other";
        h.announce(fallback);
        assert_eq!(channels(&captured), vec![API_INSPECTOR_STARTED]);
        assert_eq!(inspector.snapshot().records.len(), 1);
        assert_eq!(
            inspector.snapshot().records[0].started.endpoint,
            "chat/completions"
        );
    }

    #[test]
    fn stashed_telemetry_is_merged_into_the_finish_event() {
        let (inspector, _) = inspector_with_sink();
        let h = inspector.begin(Instant::now()).unwrap();
        h.announce(started_fields());
        h.stash(FinishFields {
            prompt_tokens: Some(28),
            completion_tokens: Some(150),
            finish_reason: Some("length".into()),
            ..Default::default()
        });
        h.finish(FinishFields {
            status: Some(200),
            ..Default::default()
        });
        let record = &inspector.snapshot().records[0];
        assert_eq!(record.finish.status, Some(200));
        assert_eq!(record.finish.prompt_tokens, Some(28));
        assert_eq!(record.finish.finish_reason.as_deref(), Some("length"));
        assert!(record.done);
    }

    /// Leaving the API screen must not wipe the log — the user expects it back
    /// when they return. Only "Clear log" and app exit empty it.
    #[test]
    fn the_log_survives_the_last_unsubscribe() {
        let (inspector, _) = inspector_with_sink();
        let h = inspector.begin(Instant::now()).unwrap();
        h.announce(started_fields());
        h.finish(FinishFields::default());
        assert_eq!(inspector.snapshot().records.len(), 1);

        inspector.set_enabled(false);
        assert!(!inspector.enabled());
        assert_eq!(inspector.snapshot().records.len(), 1);

        // Coming back sees the same history.
        inspector.set_enabled(true);
        assert!(inspector.enabled());
        assert_eq!(inspector.snapshot().records.len(), 1);

        inspector.clear();
        assert!(inspector.snapshot().records.is_empty());
    }

    #[test]
    fn a_stray_unsubscribe_does_not_drive_the_count_negative() {
        let (inspector, _) = inspector_with_sink();
        inspector.set_enabled(false);
        inspector.set_enabled(false);
        inspector.set_enabled(true);
        assert!(inspector.enabled());
    }

    /// The ATO-113 regression guard: no `Debug` output may carry prompt text.
    #[test]
    fn record_debug_impl_redacts_previews() {
        let record = ApiRequestRecord {
            id: "apireq_test".into(),
            seq: 0,
            started_at_ms: 0,
            started: started_fields(),
            done: true,
            finished_at_ms: Some(1),
            finish: FinishFields {
                reply_preview: Some("a secret reply".into()),
                ..Default::default()
            },
        };
        let rendered = format!("{record:?}");
        assert!(!rendered.contains("a secret prompt"), "{rendered}");
        assert!(!rendered.contains("a secret reply"), "{rendered}");
        assert!(rendered.contains("<redacted>"));
        // The same must hold for the halves on their own.
        assert!(!format!("{:?}", record.started).contains("a secret prompt"));
        assert!(!format!("{:?}", record.finish).contains("a secret reply"));
    }

    /// Mirrors the race the counter now sidesteps: a detached relay that
    /// finishes before the wrapper's fallback announce runs.
    #[test]
    fn in_flight_is_released_even_when_finish_beats_announce() {
        let (inspector, captured) = inspector_with_sink();
        let h = inspector.begin(Instant::now()).unwrap();
        h.finish(FinishFields::default());
        assert_eq!(inspector.snapshot().in_flight, 0);
        // An unannounced request was never shown, so no orphan finish event.
        assert!(captured.lock().unwrap().is_empty());
    }

    #[test]
    fn progress_throttled_to_one_per_second() {
        let (inspector, captured) = inspector_with_sink();
        let start = Instant::now() - Duration::from_millis(1500);
        let h = inspector.begin(start).unwrap();
        h.announce(started_fields());
        let tel = StreamTelemetry::new();
        h.progress(&tel);
        h.progress(&tel);
        let progress_count = channels(&captured)
            .iter()
            .filter(|c| **c == API_INSPECTOR_PROGRESS)
            .count();
        assert_eq!(progress_count, 1);
    }

    #[test]
    fn progress_is_silent_after_finish() {
        let (inspector, captured) = inspector_with_sink();
        let h = inspector
            .begin(Instant::now() - Duration::from_secs(5))
            .unwrap();
        h.announce(started_fields());
        h.finish(FinishFields::default());
        h.progress(&StreamTelemetry::new());
        assert!(!channels(&captured).contains(&API_INSPECTOR_PROGRESS));
    }

    /// Guards against someone "tidying" these into the analytics namespace,
    /// which `AnalyticProvider.tsx` forwards to PostHog verbatim — that would
    /// pipe prompt text straight into telemetry.
    #[test]
    fn inspector_channels_are_not_in_the_analytics_namespace() {
        for channel in [
            API_INSPECTOR_STARTED,
            API_INSPECTOR_PROGRESS,
            API_INSPECTOR_FINISHED,
        ] {
            assert!(!channel.starts_with("analytics://"), "{channel}");
            assert!(channel.starts_with("api-inspector://"), "{channel}");
        }
    }
}
