use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::ipc::Channel;

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

/// Streams an HTTP POST response back to the frontend via a Tauri IPC Channel.
/// Bypasses tauri_plugin_http's fetch interception, which may not properly
/// bridge ReadableStream for SSE responses in the webview.
///
/// `timeout_secs` is an *inactivity* budget, not a wall-clock cap on the whole
/// generation: it bounds the wait for response headers and the wait between
/// consecutive chunks. A model that keeps emitting tokens can stream for as
/// long as it likes; one that goes silent past the budget errors out. The
/// budget is floored at `STREAM_IDLE_TIMEOUT_FLOOR_SECS`.
#[tauri::command]
pub async fn stream_local_http(
    url: String,
    headers: HashMap<String, String>,
    body: String,
    timeout_secs: u64,
    on_chunk: Channel<HttpStreamChunk>,
) -> Result<u16, String> {
    let _in_flight = StreamInFlight::enter();
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

    let response = match tokio::time::timeout(idle_timeout, req.send()).await {
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
        let next = match tokio::time::timeout(idle_timeout, stream.next()).await {
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
