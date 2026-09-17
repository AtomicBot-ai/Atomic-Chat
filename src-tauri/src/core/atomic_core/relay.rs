//! Relaying the core's event stream into the app as Tauri events.
//!
//! The core publishes everything it does — sessions starting and dying,
//! downloads progressing, settings changing — on one SSE stream, and the app
//! re-emits each event as `atomic-core://<name>` (PLAN.md §3.5). The relay adds
//! nothing and drops nothing: a renamed or reshaped event here would be a
//! second contract to keep in sync with the core's.
//!
//! What it does own is continuity. Every frame carries `id: <instance>:<seq>`,
//! and reconnecting with that cursor replays what was missed from the core's
//! ring of 1000. When the core cannot replay — the ring has moved past us, or
//! the id belongs to an instance that no longer exists — it says `resync`, and
//! the relay throws away the mirror and re-reads the snapshot instead of
//! carrying a hole forward.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Value};

use super::client::CoreError;
use super::supervisor::{Attached, Supervisor};

/// Prefix for every event the app re-emits from the core.
pub const EVENT_PREFIX: &str = "atomic-core://";

/// Emitted when the mirror must be rebuilt: the payload carries a fresh
/// snapshot and the generation it belongs to.
pub const SNAPSHOT_EVENT: &str = "atomic-core://snapshot";

/// Emitted when the attachment is gone, so listeners stop trusting what they
/// have. Sent before any reattach, never merged with the snapshot that follows.
pub const DETACHED_EVENT: &str = "atomic-core://detached";

/// How long to wait before reopening a stream that ended. Short, because the
/// usual cause is a reattach that already succeeded; a core that is really gone
/// is rate-limited by the supervisor's restart policy, not here.
const RECONNECT_DELAY: Duration = Duration::from_millis(500);

/// Where relayed events go. A trait so the relay can be tested without a Tauri
/// app handle — the production implementation is one line in `commands.rs`.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, name: &str, payload: Value);
}

/// One `event:`/`data:`/`id:` record from the stream.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SseFrame {
    pub id: Option<String>,
    pub event: Option<String>,
    pub data: String,
}

impl SseFrame {
    /// The payload as JSON, or a string wrapper when the core sent something
    /// that is not JSON. Never fails: a malformed payload must not stop the
    /// stream, because the next event may be the one that matters.
    pub fn payload(&self) -> Value {
        serde_json::from_str(&self.data).unwrap_or_else(|_| json!({ "raw": self.data }))
    }

    pub fn is_resync(&self) -> bool {
        self.event.as_deref() == Some("resync")
    }
}

/// Incremental SSE reader. Chunks arrive at arbitrary boundaries — mid-line,
/// mid-frame — so the parser keeps a buffer and only yields whole frames.
#[derive(Default)]
pub struct SseParser {
    buffer: Vec<u8>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<SseFrame>, CoreError> {
        self.buffer.extend_from_slice(chunk);
        let mut frames = Vec::new();
        // Frame delimiters are ASCII and cannot occur inside a UTF-8 codepoint,
        // so byte buffering preserves a multi-byte character split across
        // arbitrary network chunks. Decode only once a whole frame exists.
        loop {
            let Some((end, next)) = split_frame(&self.buffer) else {
                break;
            };
            let raw = self.buffer[..end].to_vec();
            self.buffer.drain(..next);
            let raw = std::str::from_utf8(&raw).map_err(|error| {
                CoreError::new(
                    "CORE_UNREACHABLE",
                    "The core's event stream was not valid UTF-8.",
                    Some(error.to_string()),
                )
            })?;
            if let Some(frame) = parse_frame(raw) {
                frames.push(frame);
            }
        }
        Ok(frames)
    }
}

fn split_frame(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf = buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|i| (i, i + 2));
    let crlf = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|i| (i, i + 4));
    let (end, next) = match (lf, crlf) {
        (Some(a), Some(b)) => {
            if a.0 <= b.0 {
                a
            } else {
                b
            }
        }
        (Some(a), None) => a,
        (None, Some(b)) => b,
        (None, None) => return None,
    };
    Some((end, next))
}

fn parse_frame(raw: &str) -> Option<SseFrame> {
    let mut frame = SseFrame::default();
    let mut data_lines: Vec<&str> = Vec::new();
    let mut any = false;
    for line in raw.lines() {
        let line = line.trim_end_matches('\r');
        // A line starting with ':' is a comment — used as a keep-alive.
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        any = true;
        match field {
            "id" => frame.id = Some(value.to_string()),
            "event" => frame.event = Some(value.to_string()),
            "data" => data_lines.push(value),
            _ => {}
        }
    }
    if !any {
        return None;
    }
    frame.data = data_lines.join("\n");
    Some(frame)
}

/// Cursor bookkeeping for one instance. A cursor from another instance is
/// worthless — sequence numbers restart — so it is dropped rather than sent.
#[derive(Debug, Default)]
struct Cursor {
    instance_id: String,
    generation: u64,
    value: Option<String>,
}

impl Cursor {
    fn for_attachment(&self, instance_id: &str, generation: u64) -> Option<&str> {
        if self.instance_id == instance_id && self.generation == generation {
            self.value.as_deref()
        } else {
            None
        }
    }

    fn record(&mut self, instance_id: &str, generation: u64, id: Option<&str>) {
        if self.instance_id != instance_id || self.generation != generation {
            self.instance_id = instance_id.to_string();
            self.generation = generation;
            self.value = None;
        }
        if let Some(id) = id {
            self.value = Some(id.to_string());
        }
    }
}

/// A snapshot is the base state for every subsequent delta. Its cursor must
/// belong to the attachment that produced it and have the documented numeric
/// sequence suffix; otherwise accepting it would join two core generations.
pub(crate) fn snapshot_cursor(snapshot: &Value, instance_id: &str) -> Result<String, CoreError> {
    let snapshot_instance = snapshot.get("instance_id").and_then(Value::as_str);
    let cursor = snapshot.get("cursor").and_then(Value::as_str);
    let Some(cursor) = cursor else {
        return Err(CoreError::unreachable(
            "The core snapshot had no cursor.",
            "snapshot.cursor must be a string",
        ));
    };
    if snapshot_instance != Some(instance_id) {
        return Err(CoreError::unreachable(
            "The core snapshot belongs to another instance.",
            format!("expected {instance_id}, got {snapshot_instance:?}"),
        ));
    }
    let Some((cursor_instance, seq)) = cursor.rsplit_once(':') else {
        return Err(CoreError::unreachable(
            "The core snapshot cursor was malformed.",
            cursor,
        ));
    };
    if cursor_instance != instance_id || seq.parse::<u64>().is_err() {
        return Err(CoreError::unreachable(
            "The core snapshot cursor was malformed.",
            cursor,
        ));
    }
    Ok(cursor.to_string())
}

fn install_snapshot<S: EventSink>(
    attached: &Attached,
    sink: &S,
    cursor: &mut Cursor,
    snapshot: Value,
) -> Result<(), CoreError> {
    let next = snapshot_cursor(&snapshot, &attached.instance_id)?;
    cursor.record(&attached.instance_id, attached.generation, Some(&next));
    sink.emit(
        SNAPSHOT_EVENT,
        json!({ "generation": attached.generation, "snapshot": snapshot }),
    );
    Ok(())
}

/// Follow the core's events for as long as the app runs.
///
/// Returns only when `cancel` resolves; every other outcome — the core dying,
/// the stream ending, a resync — is handled by reconnecting, because an app
/// that silently stops receiving events looks exactly like an app where nothing
/// is happening.
pub async fn run<S: EventSink>(
    supervisor: Arc<Supervisor>,
    sink: Arc<S>,
    mut cancel: tokio::sync::oneshot::Receiver<()>,
) {
    let mut cursor = Cursor::default();
    loop {
        if cancel.try_recv().is_ok() {
            return;
        }
        let step = follow_once(&supervisor, sink.as_ref(), &mut cursor);
        tokio::select! {
            _ = step => {}
            _ = &mut cancel => return,
        }
        tokio::select! {
            _ = tokio::time::sleep(RECONNECT_DELAY) => {}
            _ = &mut cancel => return,
        }
    }
}

/// One attachment's worth of supervision: establish the snapshot base, relay
/// events and heartbeat the same registration. Any failure ends this attempt;
/// the outer loop reattaches (and may launch a replacement core).
async fn follow_once<S: EventSink>(supervisor: &Arc<Supervisor>, sink: &S, cursor: &mut Cursor) {
    let attached = match supervisor.ensure_attached(true).await {
        Ok(attached) => attached,
        Err(e) => {
            log::info!("[atomic-core] could not attach or launch: {e}");
            return;
        }
    };

    if cursor
        .for_attachment(&attached.instance_id, attached.generation)
        .is_none()
    {
        if let Err(error) = install_snapshot(&attached, sink, cursor, attached.snapshot.clone()) {
            log::info!("[atomic-core] registration snapshot was invalid: {error}");
            supervisor.invalidate(attached.generation).await;
            sink.emit(DETACHED_EVENT, json!({ "generation": attached.generation }));
            return;
        }
    }

    let resume_from = cursor.for_attachment(&attached.instance_id, attached.generation);
    let response = match attached.client.open_events(resume_from).await {
        Ok(response) => response,
        Err(e) => {
            log::info!("[atomic-core] event stream would not open: {e}");
            supervisor.invalidate(attached.generation).await;
            sink.emit(DETACHED_EVENT, json!({ "generation": attached.generation }));
            return;
        }
    };

    let mut parser = SseParser::new();
    let mut stream = response.bytes_stream();
    let mut heartbeat = tokio::time::interval(attached.heartbeat_interval);
    heartbeat.tick().await;
    loop {
        tokio::select! {
            chunk = stream.next() => {
                let Some(chunk) = chunk else {
                    log::info!("[atomic-core] event stream ended");
                    break;
                };
                let chunk = match chunk {
                    Ok(chunk) => chunk,
                    Err(e) => {
                        log::info!("[atomic-core] event stream broke: {e}");
                        break;
                    }
                };
                let frames = match parser.push(&chunk) {
                    Ok(frames) => frames,
                    Err(error) => {
                        log::info!("[atomic-core] event stream could not be decoded: {error}");
                        sink.emit(DETACHED_EVENT, json!({ "generation": attached.generation }));
                        match attached.client.snapshot().await {
                            Ok(snapshot) => {
                                if let Err(error) = install_snapshot(&attached, sink, cursor, snapshot) {
                                    log::info!("[atomic-core] UTF-8 recovery snapshot was invalid: {error}");
                                }
                            }
                            Err(error) => log::info!("[atomic-core] UTF-8 recovery could not read a snapshot: {error}"),
                        }
                        return;
                    }
                };
                for frame in frames {
                    if frame.is_resync() {
                        // Do not accept the resync frame's cursor: events may
                        // arrive while the snapshot request is in flight. The
                        // snapshot's own cursor is the only consistent base.
                        sink.emit(DETACHED_EVENT, json!({ "generation": attached.generation }));
                        match attached.client.snapshot().await {
                            Ok(snapshot) => {
                                if let Err(error) = install_snapshot(&attached, sink, cursor, snapshot) {
                                    log::info!("[atomic-core] resync snapshot was invalid: {error}");
                                }
                            }
                            Err(error) => log::info!("[atomic-core] resync could not read a snapshot: {error}"),
                        }
                        // Discard this stream. Reopening from snapshot.cursor
                        // replays only deltas that happened after the snapshot.
                        return;
                    }
                    cursor.record(
                        &attached.instance_id,
                        attached.generation,
                        frame.id.as_deref(),
                    );
                    let Some(name) = frame.event.as_deref() else {
                        continue;
                    };
                    sink.emit(&format!("{EVENT_PREFIX}{name}"), frame.payload());
                }
            }
            _ = heartbeat.tick() => {
                match attached.client.heartbeat(&attached.client_id).await {
                    Ok(true) => {}
                    Ok(false) => {
                        log::info!("[atomic-core] client registration expired; reattaching");
                        break;
                    }
                    Err(error) => {
                        log::info!("[atomic-core] heartbeat failed: {error}");
                        break;
                    }
                }
            }
        }
    }

    // The stream ended: either the core died or it closed our connection. The
    // attachment cannot be trusted either way.
    supervisor.invalidate(attached.generation).await;
    sink.emit(DETACHED_EVENT, json!({ "generation": attached.generation }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::atomic_core::test_support::FakeCore;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<(String, Value)>>,
    }

    impl EventSink for Recorder {
        fn emit(&self, name: &str, payload: Value) {
            self.events
                .lock()
                .unwrap()
                .push((name.to_string(), payload));
        }
    }

    impl Recorder {
        fn names(&self) -> Vec<String> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .map(|(name, _)| name.clone())
                .collect()
        }

        fn payload_of(&self, name: &str) -> Option<Value> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, payload)| payload.clone())
        }
    }

    #[test]
    fn reads_a_whole_frame_out_of_arbitrary_chunk_boundaries() {
        let mut parser = SseParser::new();

        assert!(parser.push(b"id: i:1\nev").unwrap().is_empty());
        assert!(parser
            .push(b"ent: session:started\ndata: {\"a\"")
            .unwrap()
            .is_empty());
        let frames = parser.push(b":1}\n\n").unwrap();

        assert_eq!(
            frames,
            vec![SseFrame {
                id: Some("i:1".into()),
                event: Some("session:started".into()),
                data: "{\"a\":1}".into(),
            }]
        );
    }

    #[test]
    fn reads_several_frames_from_one_chunk_and_keeps_the_partial_tail() {
        let mut parser = SseParser::new();

        let frames = parser
            .push(b"event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\n")
            .unwrap();

        assert_eq!(
            frames.iter().map(|f| f.event.clone()).collect::<Vec<_>>(),
            vec![Some("a".into()), Some("b".into())]
        );
        assert_eq!(parser.push(b"data: 3\n\n").unwrap()[0].data, "3");
    }

    #[test]
    fn preserves_a_unicode_codepoint_split_between_network_chunks() {
        let mut parser = SseParser::new();
        let frame = "event: session:started\ndata: {\"model_id\":\"модель\"}\n\n".as_bytes();
        let split = frame
            .windows("м".len())
            .position(|window| window == "м".as_bytes())
            .unwrap()
            + 1;

        assert!(parser.push(&frame[..split]).unwrap().is_empty());
        let frames = parser.push(&frame[split..]).unwrap();

        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].payload()["model_id"], "модель");
    }

    #[test]
    fn rejects_invalid_utf8_in_a_complete_frame() {
        let mut parser = SseParser::new();

        let error = parser.push(b"event: x\ndata: \xff\n\n").unwrap_err();

        assert_eq!(error.code, "CORE_UNREACHABLE");
    }

    #[test]
    fn joins_multi_line_data_and_ignores_comments_and_crlf() {
        let mut parser = SseParser::new();

        let frames = parser
            .push(b": keep-alive\r\n\r\nevent: x\r\ndata: a\r\ndata: b\r\n\r\n")
            .unwrap();

        assert_eq!(frames.len(), 1, "a comment-only frame carries nothing");
        assert_eq!(frames[0].data, "a\nb");
    }

    #[test]
    fn a_payload_that_is_not_json_is_still_delivered() {
        let frame = SseFrame {
            id: None,
            event: Some("core:log".into()),
            data: "plain text".into(),
        };

        assert_eq!(frame.payload(), json!({ "raw": "plain text" }));
    }

    #[test]
    fn a_cursor_belongs_to_the_attachment_generation_that_issued_it() {
        let mut cursor = Cursor::default();
        cursor.record("instance-a", 4, Some("instance-a:7"));

        assert_eq!(cursor.for_attachment("instance-a", 4), Some("instance-a:7"));
        assert_eq!(
            cursor.for_attachment("instance-b", 4),
            None,
            "sequence numbers restart with a new core, so its cursor means nothing here"
        );
        assert_eq!(
            cursor.for_attachment("instance-a", 5),
            None,
            "a detached generation needs a new snapshot even if the core instance survived"
        );

        cursor.record("instance-b", 5, None);
        assert_eq!(cursor.for_attachment("instance-a", 4), None);
    }

    #[test]
    fn an_invalid_snapshot_does_not_advance_the_cursor_or_publish_a_base() {
        let attached = Attached {
            client: super::super::client::ControlClient::new("http://127.0.0.1:9", "unused")
                .unwrap(),
            instance_id: "instance-a".into(),
            client_id: "client-1".into(),
            version: "test".into(),
            pid: 1,
            generation: 4,
            heartbeat_interval: Duration::from_secs(15),
            snapshot: Value::Null,
        };
        let mut cursor = Cursor::default();
        cursor.record("instance-a", 4, Some("instance-a:7"));
        let sink = Recorder::default();

        let error = install_snapshot(
            &attached,
            &sink,
            &mut cursor,
            json!({ "instance_id": "instance-b", "cursor": "instance-b:8" }),
        )
        .unwrap_err();

        assert_eq!(error.code, "CORE_UNREACHABLE");
        assert_eq!(cursor.for_attachment("instance-a", 4), Some("instance-a:7"));
        assert!(sink.names().is_empty());
    }

    #[tokio::test]
    async fn relays_core_events_under_the_app_prefix() {
        let core = FakeCore::start().await;
        // Anything at or before the registration snapshot cursor is already
        // represented by that snapshot and must not be replayed as a delta.
        core.emit("session:old", json!({})).await;
        let dir = tempfile::tempdir().unwrap();
        core.publish_lock(dir.path());
        let supervisor = Arc::new(Supervisor::new(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            None,
        ));
        let sink = Arc::new(Recorder::default());
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(run(Arc::clone(&supervisor), Arc::clone(&sink), cancel_rx));

        wait_for(|| async { core.open_stream_count().await == 1 }).await;
        assert_eq!(
            core.event_cursors().first().and_then(Option::as_deref),
            Some("instance-a:1")
        );
        core.emit("session:started", json!({ "model_id": "m" }))
            .await;
        wait_for(|| {
            let sink = Arc::clone(&sink);
            async move {
                sink.names()
                    .iter()
                    .any(|n| n == "atomic-core://session:started")
            }
        })
        .await;

        assert_eq!(
            sink.payload_of("atomic-core://session:started").unwrap()["model_id"],
            "m"
        );

        let _ = cancel_tx.send(());
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
    }

    #[tokio::test]
    async fn a_resync_invalidates_the_mirror_and_hands_out_a_fresh_snapshot() {
        let core = FakeCore::start().await;
        let dir = tempfile::tempdir().unwrap();
        core.publish_lock(dir.path());
        core.set_sessions(json!([{ "model_id": "from-snapshot" }]));
        core.demand_resync(true);
        let supervisor = Arc::new(Supervisor::new(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            None,
        ));
        let sink = Arc::new(Recorder::default());
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(run(Arc::clone(&supervisor), Arc::clone(&sink), cancel_rx));

        // Registration first installs its consistent snapshot, then the fake
        // core forces the SSE recovery path to install another one.
        wait_for(|| {
            let sink = Arc::clone(&sink);
            async move { count(&sink, SNAPSHOT_EVENT) >= 2 }
        })
        .await;

        let names = sink.names();
        let detached = names.iter().position(|n| n == DETACHED_EVENT).unwrap();
        let snapshot = names.iter().rposition(|n| n == SNAPSHOT_EVENT).unwrap();
        assert!(
            detached < snapshot,
            "listeners must be told to drop the old mirror before the new one arrives"
        );
        assert_eq!(
            sink.payload_of(SNAPSHOT_EVENT).unwrap()["snapshot"]["sessions"][0]["model_id"],
            "from-snapshot"
        );

        let _ = cancel_tx.send(());
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
    }

    #[tokio::test]
    async fn reconnects_with_the_cursor_of_the_last_event_it_saw() {
        let core = FakeCore::start().await;
        let dir = tempfile::tempdir().unwrap();
        core.publish_lock(dir.path());
        let supervisor = Arc::new(Supervisor::new(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            None,
        ));
        let sink = Arc::new(Recorder::default());
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(run(Arc::clone(&supervisor), Arc::clone(&sink), cancel_rx));

        wait_for(|| async { core.open_stream_count().await == 1 }).await;
        core.emit("session:started", json!({})).await;
        wait_for(|| {
            let sink = Arc::clone(&sink);
            async move { !sink.names().is_empty() }
        })
        .await;

        // Drop the stream; the relay must come back asking to resume after the
        // event it already delivered, not from the beginning.
        core.drop_streams().await;
        wait_for(|| async { core.event_cursors().len() >= 2 }).await;
        wait_for(|| {
            let sink = Arc::clone(&sink);
            async move { count(&sink, SNAPSHOT_EVENT) >= 2 }
        })
        .await;

        assert_eq!(
            core.event_cursors().last().unwrap().as_deref(),
            Some("instance-a:1")
        );

        let _ = cancel_tx.send(());
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
    }

    #[tokio::test]
    async fn a_core_that_cannot_replay_our_cursor_makes_the_app_resnapshot() {
        // What happens when more than the core's ring of 1000 events went by
        // while the app was away, or the sequence restarted under a new owner.
        let core = FakeCore::start().await;
        let dir = tempfile::tempdir().unwrap();
        core.publish_lock(dir.path());
        let supervisor = Arc::new(Supervisor::new(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            None,
        ));
        let sink = Arc::new(Recorder::default());
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(run(Arc::clone(&supervisor), Arc::clone(&sink), cancel_rx));

        wait_for(|| async { core.open_stream_count().await == 1 }).await;
        core.emit("session:started", json!({})).await;
        wait_for(|| {
            let sink = Arc::clone(&sink);
            async move {
                sink.names()
                    .iter()
                    .any(|n| n == "atomic-core://session:started")
            }
        })
        .await;
        let snapshots_before = count(&sink, SNAPSHOT_EVENT);

        // The relay will reconnect with a cursor, and this core refuses it.
        core.demand_resync(true);
        core.set_sessions(json!([{ "model_id": "rebuilt" }]));
        core.drop_streams().await;

        wait_for(|| {
            let sink = Arc::clone(&sink);
            async move { count(&sink, SNAPSHOT_EVENT) > snapshots_before }
        })
        .await;

        assert_eq!(
            core.event_cursors().last().unwrap().as_deref(),
            Some("instance-a:1"),
            "it asked to resume, and was told it could not"
        );
        let snapshot = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|(name, _)| name == SNAPSHOT_EVENT)
            .map(|(_, payload)| payload.clone())
            .unwrap();
        assert_eq!(snapshot["snapshot"]["sessions"][0]["model_id"], "rebuilt");

        let _ = cancel_tx.send(());
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
    }

    fn count(sink: &Recorder, name: &str) -> usize {
        sink.names().iter().filter(|n| *n == name).count()
    }

    #[tokio::test]
    async fn a_stream_that_ends_detaches_so_nothing_keeps_reading_a_dead_mirror() {
        let mut core = FakeCore::start().await;
        let dir = tempfile::tempdir().unwrap();
        core.publish_lock(dir.path());
        let supervisor = Arc::new(Supervisor::new(
            dir.path().to_path_buf(),
            dir.path().to_path_buf(),
            None,
        ));
        let sink = Arc::new(Recorder::default());
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(run(Arc::clone(&supervisor), Arc::clone(&sink), cancel_rx));

        wait_for(|| async { core.open_stream_count().await == 1 }).await;
        core.stop().await;

        wait_for(|| {
            let supervisor = Arc::clone(&supervisor);
            async move { supervisor.current().await.is_none() }
        })
        .await;
        assert!(sink.names().iter().any(|n| n == DETACHED_EVENT));

        let _ = cancel_tx.send(());
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
    }

    /// Poll a condition instead of sleeping a fixed time: these tests turn on
    /// several tasks reaching a state, and a fixed sleep is either flaky or slow.
    async fn wait_for<F, Fut>(mut condition: F)
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = bool>,
    {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if condition().await {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "condition never became true"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

/// The event name and payload an existing app listener expects for a core event, if any.
///
/// The app has listened to `download-<task id>` since before the core existed — the download
/// extension subscribes to it by name, and so does every progress bar built on top. Renaming that
/// would mean touching each of them, so instead the relay emits the legacy name *as well as* the
/// core's own (PLAN.md §4 stage 3c: "listeners (…) do not change").
///
/// Returns `None` for events with no legacy counterpart, which is most of them.
pub fn legacy_event_for(name: &str, payload: &Value) -> Option<(String, Value)> {
    let event = name.strip_prefix(EVENT_PREFIX)?;
    let task_id = payload.get("taskId").and_then(Value::as_str)?;
    if task_id.is_empty() {
        return None;
    }
    match event {
        // The payload the download extension reads: two numbers, nothing else. Extra fields would
        // be harmless, but this is a contract older than the core and worth keeping exact.
        "download:progress" => Some((
            format!("download-{task_id}"),
            json!({
                "transferred": payload.get("transferred").cloned().unwrap_or(json!(0)),
                "total": payload.get("total").cloned().unwrap_or(json!(0)),
            }),
        )),
        _ => None,
    }
}

#[cfg(test)]
mod legacy_events {
    use super::*;

    #[test]
    fn download_progress_is_also_emitted_under_the_name_the_app_already_listens_to() {
        let (name, payload) = legacy_event_for(
            "atomic-core://download:progress",
            &json!({ "taskId": "backend-b6325", "transferred": 100, "total": 400, "percent": 25 }),
        )
        .expect("mapped");

        assert_eq!(name, "download-backend-b6325");
        assert_eq!(payload, json!({ "transferred": 100, "total": 400 }));
    }

    #[test]
    fn a_progress_event_with_no_task_has_no_legacy_name_to_go_under() {
        assert!(legacy_event_for("atomic-core://download:progress", &json!({})).is_none());
        assert!(
            legacy_event_for("atomic-core://download:progress", &json!({ "taskId": "" })).is_none()
        );
    }

    #[test]
    fn events_the_app_never_listened_for_by_task_are_not_remapped() {
        assert!(legacy_event_for(
            "atomic-core://session:started",
            &json!({ "taskId": "t", "model_id": "m" })
        )
        .is_none());
        assert!(legacy_event_for("download:progress", &json!({ "taskId": "t" })).is_none());
    }

    #[test]
    fn missing_numbers_become_zero_rather_than_breaking_the_listener() {
        // A bar that reads `undefined` renders NaN; zero is the honest "nothing yet".
        let (_, payload) =
            legacy_event_for("atomic-core://download:progress", &json!({ "taskId": "t" })).unwrap();

        assert_eq!(payload, json!({ "transferred": 0, "total": 0 }));
    }
}
