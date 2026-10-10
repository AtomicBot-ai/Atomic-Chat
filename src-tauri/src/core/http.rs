use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;

/// Fallback when the caller passes no (or a nonsensical) timeout, matching the
/// llama.cpp extension's `timeout` setting default.
const DEFAULT_TIMEOUT_SECS: u64 = 600;

/// Floor for the streaming inactivity budget (30 min), mirroring the
/// model-load readiness floor from ATO-188. Reasoning models can sit silent
/// for a long stretch before the first token — notably while llama.cpp
/// processes a large prompt — so the shared `timeout` setting (default 600s)
/// is too tight to double as a liveness signal for the stream. A larger
/// user-configured value still wins.
const STREAM_IDLE_TIMEOUT_FLOOR_SECS: u64 = 1800;

/// Effective inactivity budget for a streaming response: never below
/// `STREAM_IDLE_TIMEOUT_FLOOR_SECS`, honors a larger configured value.
fn stream_idle_timeout_secs(configured_secs: u64) -> u64 {
    let base = if configured_secs == 0 {
        DEFAULT_TIMEOUT_SECS
    } else {
        configured_secs
    };
    base.max(STREAM_IDLE_TIMEOUT_FLOOR_SECS)
}

/// Streaming clients are keyed by their timeout so connection pooling still
/// works, instead of rebuilding a client (and dropping the pool) per request.
fn shared_stream_client(timeout_secs: u64) -> reqwest::Client {
    static CLIENTS: OnceLock<Mutex<HashMap<u64, reqwest::Client>>> = OnceLock::new();
    let clients = CLIENTS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut clients = clients.lock().expect("stream client cache poisoned");
    clients
        .entry(timeout_secs)
        .or_insert_with(|| {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(timeout_secs))
                // Deliberately no `.timeout()`: that caps the *whole* request
                // including the body read, which kills long generations mid
                // stream even while tokens are still arriving. The read loop
                // enforces an inactivity timeout instead.
                .pool_max_idle_per_host(10)
                .pool_idle_timeout(Duration::from_secs(30))
                .tcp_keepalive(Some(Duration::from_secs(30)))
                .no_proxy()
                .build()
                .expect("stream HTTP client")
        })
        .clone()
}

fn shared_post_client(timeout_secs: u64) -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(timeout_secs))
        .timeout(Duration::from_secs(timeout_secs))
        .pool_max_idle_per_host(10)
        .pool_idle_timeout(Duration::from_secs(30))
        .tcp_keepalive(Some(Duration::from_secs(30)))
        .no_proxy()
        .build()
        .expect("post HTTP client")
}

#[derive(serde::Serialize, Clone)]
pub struct HttpStreamChunk {
    pub data: String,
    /// Set on the one message sent after the last chunk. The end of the stream has to travel on
    /// the channel itself: the command's own return reaches the webview by another route and can
    /// overtake chunks still on their way, and a reader that took the return for the end closed a
    /// short reply — a tool call is two chunks — before any of it had arrived.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub done: bool,
}

/// The longest prefix of `pending` that is whole UTF-8, as text; what is left in `pending` is the
/// start of a character whose remaining bytes are in the next network chunk. Decoding each chunk
/// by itself turned every character cut by a chunk boundary into two replacement characters —
/// routine for Cyrillic, CJK or emoji in a streamed reply. Bytes that are not UTF-8 at all still
/// become replacement characters.
fn take_complete_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(text) => {
            let text = text.to_owned();
            pending.clear();
            text
        }
        Err(error) if error.error_len().is_none() => {
            let rest = pending.split_off(error.valid_up_to());
            let text = String::from_utf8_lossy(pending).into_owned();
            *pending = rest;
            text
        }
        Err(_) => {
            let text = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            text
        }
    }
}

/// Simple non-streaming HTTP POST that returns the full response body as text.
/// Bypasses tauri_plugin_http's fetch interception which may not properly
/// deliver response bodies to the webview.
#[tauri::command]
pub async fn post_local_http(
    url: String,
    headers: HashMap<String, String>,
    body: String,
    timeout_secs: u64,
) -> Result<String, String> {
    let client = shared_post_client(timeout_secs);

    let mut req = client.post(&url);
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }
    req = req.body(body);

    let response = req
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Body read failed: {e}"))?;

    if status >= 400 {
        return Err(format!("HTTP {status}: {text}"));
    }

    Ok(text)
}

/// Simple non-streaming HTTP GET that returns the full response body as text.
/// Bypasses tauri_plugin_http's fetch interception, which has been observed to
/// hang while reading response bodies from some local servers (e.g. Ollama's
/// OpenAI-compatible `/v1/models`).
#[tauri::command]
pub async fn get_local_http(
    url: String,
    headers: HashMap<String, String>,
    timeout_secs: u64,
) -> Result<String, String> {
    let client = shared_post_client(timeout_secs);

    let mut req = client.get(&url);
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Body read failed: {e}"))?;

    if status >= 400 {
        return Err(format!("HTTP {status}: {text}"));
    }

    Ok(text)
}

/// Streams currently waiting on or reading a local response. A local server
/// answers as many requests as it has slots and queues the rest, so a count
/// well above one when a stream stalls means the wait was spent behind other
/// requests rather than on a slow model.
static STREAMS_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// Counts one stream for as long as it is alive.
struct StreamInFlight;

impl StreamInFlight {
    fn enter() -> Self {
        STREAMS_IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for StreamInFlight {
    fn drop(&mut self) {
        STREAMS_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A stream that stays silent for the whole inactivity budget leaves the user
/// with a turn that just stops, and was reported nowhere: the error only
/// travelled back to the webview as a string. `log::error!` makes it a Sentry
/// event carrying the app log tail; the message stays fixed so every stall
/// groups into one issue, and the in-flight count goes out just before it as a
/// breadcrumb.
fn report_stalled_stream(message: &str) {
    log::warn!(
        "[stream] {} local streams in flight (this one included) when it stalled",
        STREAMS_IN_FLIGHT.load(Ordering::SeqCst)
    );
    log::error!("{message}");
}

/// A cancel for a stream that has not registered yet, kept for the stream to find; one nobody
/// claims within this long (the stream had already ended) is dropped by the next cancel.
const UNCLAIMED_CANCEL_TTL: Duration = Duration::from_secs(60);

struct StreamCancel {
    token: CancellationToken,
    /// When a cancel arrived before its stream: the stream never came if this grows old.
    unclaimed_since: Option<Instant>,
}

/// The cancel tokens of the streams a caller can still abort, by the request id it chose.
fn stream_cancels() -> &'static Mutex<HashMap<String, StreamCancel>> {
    static CANCELS: OnceLock<Mutex<HashMap<String, StreamCancel>>> = OnceLock::new();
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One stream's cancel token, registered under its request id for as long as the stream lives.
struct CancelRegistration {
    id: Option<String>,
    token: CancellationToken,
}

impl CancelRegistration {
    fn register(id: Option<String>) -> Self {
        let token = match &id {
            Some(id) => {
                let mut cancels = stream_cancels().lock().expect("stream cancels poisoned");
                let entry = cancels.entry(id.clone()).or_insert_with(|| StreamCancel {
                    token: CancellationToken::new(),
                    unclaimed_since: None,
                });
                entry.unclaimed_since = None;
                entry.token.clone()
            }
            None => CancellationToken::new(),
        };
        Self { id, token }
    }
}

impl Drop for CancelRegistration {
    fn drop(&mut self) {
        if let Some(id) = &self.id {
            stream_cancels()
                .lock()
                .expect("stream cancels poisoned")
                .remove(id);
        }
    }
}

/// Abort a `stream_local_http` call by the `request_id` it was given (ATO-550). Ending the JS
/// stream alone left the Rust read loop draining the response: the connection stayed open, so
/// llama-server — one slot — went on generating the abandoned answer and the next message
/// queued behind it for minutes. Dropping the response here closes the socket, which is how
/// llama-server learns to cancel the task. A cancel that overtakes its stream's start is kept
/// for the stream to pick up.
#[tauri::command]
pub fn cancel_local_stream(request_id: String) {
    let mut cancels = stream_cancels().lock().expect("stream cancels poisoned");
    let now = Instant::now();
    cancels.retain(|_, cancel| {
        cancel
            .unclaimed_since
            .is_none_or(|since| now.duration_since(since) < UNCLAIMED_CANCEL_TTL)
    });
    cancels
        .entry(request_id)
        .or_insert_with(|| StreamCancel {
            token: CancellationToken::new(),
            unclaimed_since: Some(now),
        })
        .token
        .cancel();
}

/// Streams an HTTP POST response back to the frontend via a Tauri IPC Channel.
/// Bypasses tauri_plugin_http's fetch interception, which may not properly
/// bridge ReadableStream for SSE responses in the webview.
///
/// `timeout_secs` is an *inactivity* budget, not a wall-clock cap on the whole
/// generation: it bounds the wait for response headers and the wait between
/// consecutive chunks. A model that keeps emitting tokens can stream for as
/// long as it likes; one that goes silent past the budget errors out. The
/// budget is floored at `STREAM_IDLE_TIMEOUT_FLOOR_SECS`.
///
/// `request_id`, when given, lets `cancel_local_stream` abort the call: the response is dropped,
/// the connection closes, and the call answers `Request aborted`.
#[tauri::command]
pub async fn stream_local_http(
    url: String,
    headers: HashMap<String, String>,
    body: String,
    timeout_secs: u64,
    request_id: Option<String>,
    on_chunk: Channel<HttpStreamChunk>,
) -> Result<u16, String> {
    let _in_flight = StreamInFlight::enter();
    let cancel = CancelRegistration::register(request_id);
    let configured_secs = timeout_secs;
    let timeout_secs = stream_idle_timeout_secs(timeout_secs);
    // The Settings UI shows the raw configured value, so log both — otherwise
    // there is no way to tell from a log whether the floor actually applied.
    log::info!(
        "[stream] idle timeout {timeout_secs}s (configured {configured_secs}s, floor {STREAM_IDLE_TIMEOUT_FLOOR_SECS}s)"
    );
    let idle_timeout = Duration::from_secs(timeout_secs);
    let client = shared_stream_client(timeout_secs);

    let mut req = client.post(&url);
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }
    req = req.body(body);

    let sent = tokio::select! {
        biased;
        _ = cancel.token.cancelled() => return Err(aborted()),
        sent = tokio::time::timeout(idle_timeout, req.send()) => sent,
    };
    let response = match sent {
        Ok(sent) => sent.map_err(|e| format!("Request failed: {e}"))?,
        Err(_) => {
            let message = format!("Request failed: no response headers within {timeout_secs}s");
            report_stalled_stream(&message);
            return Err(message);
        }
    };
    let status = response.status().as_u16();

    if !response.status().is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {text}"));
    }

    let mut stream = response.bytes_stream();
    let mut pending: Vec<u8> = Vec::new();
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.token.cancelled() => return Err(aborted()),
            next = tokio::time::timeout(idle_timeout, stream.next()) => next,
        };
        let next = match next {
            Ok(next) => next,
            Err(_) => {
                let message = format!("Stream error: no data received for {timeout_secs}s");
                report_stalled_stream(&message);
                return Err(message);
            }
        };
        let Some(chunk_result) = next else { break };
        match chunk_result {
            Ok(bytes) => {
                pending.extend_from_slice(&bytes);
                let text = take_complete_utf8(&mut pending);
                if text.is_empty() {
                    continue;
                }
                if let Err(e) = on_chunk.send(HttpStreamChunk { data: text, done: false }) {
                    log::debug!("Channel closed by receiver: {e}");
                    break;
                }
            }
            Err(e) => {
                return Err(format!("Stream error: {e}"));
            }
        }
    }

    // Whatever is left is a character the server never finished.
    let tail = String::from_utf8_lossy(&pending).into_owned();
    if let Err(e) = on_chunk.send(HttpStreamChunk { data: tail, done: true }) {
        log::debug!("Channel closed by receiver: {e}");
    }

    Ok(status)
}

/// What a cancelled stream answers; the log line marks where the connection was dropped.
fn aborted() -> String {
    log::info!("[stream] cancelled by the client; closing the connection");
    "Request aborted".to_string()
}

#[cfg(test)]
mod utf8_tests {
    use super::take_complete_utf8;

    #[test]
    fn a_character_cut_by_a_chunk_boundary_is_held_until_it_is_whole() {
        let bytes = "привет 🙂".as_bytes();
        for cut in 1..bytes.len() {
            let mut pending = bytes[..cut].to_vec();
            let mut text = take_complete_utf8(&mut pending);
            pending.extend_from_slice(&bytes[cut..]);
            text.push_str(&take_complete_utf8(&mut pending));
            assert_eq!(text, "привет 🙂", "cut at byte {cut}");
            assert!(pending.is_empty());
        }
    }

    #[test]
    fn bytes_that_are_not_utf8_do_not_stall_the_stream() {
        let mut pending = vec![b'a', 0xff, b'b'];
        assert_eq!(take_complete_utf8(&mut pending), "a\u{fffd}b");
        assert!(pending.is_empty());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_idle_timeout_floors_at_thirty_minutes() {
        // The shared `timeout` setting defaults to 600s, which is too tight to
        // double as a stream-liveness signal — a reasoning model can sit quiet
        // through a long prompt-processing stretch before the first token.
        assert_eq!(
            stream_idle_timeout_secs(600),
            STREAM_IDLE_TIMEOUT_FLOOR_SECS
        );
        assert_eq!(stream_idle_timeout_secs(1), STREAM_IDLE_TIMEOUT_FLOOR_SECS);
    }

    #[test]
    fn stream_idle_timeout_honors_larger_configured_value() {
        assert_eq!(stream_idle_timeout_secs(3600), 3600);
    }

    #[test]
    fn stream_idle_timeout_treats_zero_as_unset() {
        assert_eq!(stream_idle_timeout_secs(0), STREAM_IDLE_TIMEOUT_FLOOR_SECS);
    }

    #[test]
    fn a_stream_is_counted_only_while_it_is_alive() {
        // The count is what tells a stall behind a queue of requests apart
        // from a slow model, so a stream that ends must stop being counted.
        let before = STREAMS_IN_FLIGHT.load(Ordering::SeqCst);
        let first = StreamInFlight::enter();
        let second = StreamInFlight::enter();
        assert_eq!(STREAMS_IN_FLIGHT.load(Ordering::SeqCst), before + 2);
        drop(first);
        drop(second);
        assert_eq!(STREAMS_IN_FLIGHT.load(Ordering::SeqCst), before);
    }
}

#[cfg(test)]
mod cancel_tests {
    use super::*;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::{oneshot, Notify};

    /// An SSE endpoint that never ends: a chunk every 20 ms until the client goes away, which it
    /// reports — the moment llama-server would cancel the task.
    async fn endless_server() -> (String, oneshot::Receiver<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let (gone_tx, gone_rx) = oneshot::channel();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            let _ = socket.read(&mut request).await;
            let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n";
            socket.write_all(head.as_bytes()).await.unwrap();
            let event = "data: {\"x\":1}\n\n";
            let chunk = format!("{:x}\r\n{event}\r\n", event.len());
            loop {
                if socket.write_all(chunk.as_bytes()).await.is_err() {
                    let _ = gone_tx.send(());
                    return;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        });
        (url, gone_rx)
    }

    fn counting_channel(first: Arc<Notify>) -> Channel<HttpStreamChunk> {
        Channel::new(move |_| {
            first.notify_one();
            Ok(())
        })
    }

    #[tokio::test]
    async fn a_cancel_drops_the_connection_and_the_call_answers_aborted() {
        let (url, gone) = endless_server().await;
        let first = Arc::new(Notify::new());
        let id = "ato-550-mid-stream".to_string();
        let call = tokio::spawn(stream_local_http(
            url,
            HashMap::new(),
            "{}".into(),
            5,
            Some(id.clone()),
            counting_channel(first.clone()),
        ));
        first.notified().await;

        cancel_local_stream(id.clone());

        let answer = tokio::time::timeout(Duration::from_secs(2), call)
            .await
            .expect("the call ends promptly")
            .unwrap();
        assert_eq!(answer, Err("Request aborted".to_string()));
        tokio::time::timeout(Duration::from_secs(2), gone)
            .await
            .expect("the server sees the connection close")
            .unwrap();
        assert!(!stream_cancels().lock().unwrap().contains_key(&id));
    }

    #[tokio::test]
    async fn a_cancel_that_overtakes_the_start_still_stops_the_stream() {
        let (url, _gone) = endless_server().await;
        let id = "ato-550-early".to_string();
        cancel_local_stream(id.clone());
        let answer = tokio::time::timeout(
            Duration::from_secs(2),
            stream_local_http(
                url,
                HashMap::new(),
                "{}".into(),
                5,
                Some(id.clone()),
                counting_channel(Arc::new(Notify::new())),
            ),
        )
        .await
        .expect("the call ends promptly");
        assert_eq!(answer, Err("Request aborted".to_string()));
        assert!(!stream_cancels().lock().unwrap().contains_key(&id));
    }

    #[test]
    fn an_unclaimed_cancel_is_dropped_once_it_is_old() {
        let stale = "ato-550-stale".to_string();
        stream_cancels().lock().unwrap().insert(
            stale.clone(),
            StreamCancel {
                token: CancellationToken::new(),
                unclaimed_since: Instant::now().checked_sub(UNCLAIMED_CANCEL_TTL * 2),
            },
        );
        cancel_local_stream("ato-550-fresh".to_string());
        let cancels = stream_cancels().lock().unwrap();
        assert!(!cancels.contains_key(&stale));
        assert!(cancels.contains_key("ato-550-fresh"));
    }
}
