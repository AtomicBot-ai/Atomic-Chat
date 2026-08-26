//! End-to-end tests for the live request inspector.
//!
//! These drive the real proxy — a real `hyper` listener, a real reqwest client
//! and a stub llama.cpp upstream — because the risk in this feature is the
//! wiring, not the pure helpers (those are covered in `request_inspector`).
//! What is asserted here is exactly what the API dashboard depends on:
//! a started/finished pair per request, real token counts on a stream, and a
//! client-visible byte stream that is unchanged by our own instrumentation.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Request, Response, Server};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::core::server::proxy;
use crate::core::server::request_inspector::{RequestInspector, API_INSPECTOR_FINISHED,
    API_INSPECTOR_STARTED};
use crate::core::state::{AutoIncreaseState, ServerHandle};

type Captured = Arc<StdMutex<Vec<(&'static str, Value)>>>;

/// Body the stub upstream received, so tests can assert what we sent it.
type SeenBody = Arc<StdMutex<Option<Value>>>;

/// The content chunks every reply carries.
const SSE_CONTENT: &str = concat!(
    "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"},\"finish_reason\":null}]}\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\" world\"},\"finish_reason\":\"stop\"}]}\n\n",
);

/// Faithful to a real OpenAI-compatible server: with `include_usage` on, every
/// content chunk grows a `"usage": null` and a usage-only trailer is appended.
const SSE_CONTENT_WITH_USAGE: &str = concat!(
    "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"},\"finish_reason\":null}],\"usage\":null}\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\" world\"},\"finish_reason\":\"stop\"}],\"usage\":null}\n\n",
    "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":2,\"total_tokens\":13}}\n\n",
);

const SSE_DONE: &str = "data: [DONE]\n\n";

/// Minimal stand-in for llama-server. Returns the stub's port.
async fn spawn_stub_upstream(seen: SeenBody) -> u16 {
    let make_svc = make_service_fn(move |_conn| {
        let seen = seen.clone();
        async move {
            Ok::<_, Infallible>(service_fn(move |req: Request<Body>| {
                let seen = seen.clone();
                async move {
                    let bytes = hyper::body::to_bytes(req.into_body()).await.unwrap_or_default();
                    let mut include_usage = false;
                    if let Ok(json) = serde_json::from_slice::<Value>(&bytes) {
                        include_usage = json
                            .pointer("/stream_options/include_usage")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        *seen.lock().unwrap() = Some(json);
                    }
                    let body = if include_usage {
                        format!("{SSE_CONTENT_WITH_USAGE}{SSE_DONE}")
                    } else {
                        format!("{SSE_CONTENT}{SSE_DONE}")
                    };
                    Ok::<_, Infallible>(
                        Response::builder()
                            .status(200)
                            .header("content-type", "text/event-stream")
                            .body(Body::from(body))
                            .unwrap(),
                    )
                }
            }))
        }
    });

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    tokio::spawn(async move {
        let _ = Server::from_tcp(listener).unwrap().serve(make_svc).await;
    });
    port
}

/// A llamacpp session entry pointing at the stub. The `Child` is a real but
/// inert process; the proxy only ever reads `info`.
async fn session_map_with_stub(
    model_id: &str,
    port: u16,
) -> Arc<Mutex<HashMap<i32, tauri_plugin_llamacpp::LLamaBackendSession>>> {
    let child = tokio::process::Command::new("sleep")
        .arg("120")
        .spawn()
        .expect("spawn placeholder child");
    let session = tauri_plugin_llamacpp::LLamaBackendSession {
        child,
        info: tauri_plugin_llamacpp::state::SessionInfo {
            pid: 1,
            port: port as i32,
            model_id: model_id.to_string(),
            model_path: "/tmp/model.gguf".to_string(),
            is_embedding: false,
            api_key: "session-key".to_string(),
            mmproj_path: None,
            runtime_device: None,
        },
        runtime_device: tauri_plugin_llamacpp::runtime_device::new_shared(),
    };
    Arc::new(Mutex::new(HashMap::from([(1, session)])))
}

struct Harness {
    proxy_port: u16,
    captured: Captured,
    seen_upstream_body: SeenBody,
    server_handle: Arc<Mutex<Option<ServerHandle>>>,
}

impl Harness {
    async fn start(model_id: &str, inspector_enabled: bool) -> Self {
        let captured: Captured = Arc::new(StdMutex::new(Vec::new()));
        let sink_target = captured.clone();
        let inspector = Arc::new(RequestInspector::new());
        inspector.attach_sink(Arc::new(move |channel, payload| {
            sink_target.lock().unwrap().push((channel, payload));
        }));
        if inspector_enabled {
            inspector.set_enabled(true);
        }

        let seen_upstream_body: SeenBody = Arc::new(StdMutex::new(None));
        let upstream_port = spawn_stub_upstream(seen_upstream_body.clone()).await;
        let sessions = session_map_with_stub(model_id, upstream_port).await;
        let server_handle = Arc::new(Mutex::new(None));

        let proxy_port = proxy::start_server(
            tauri::test::mock_app().handle().clone(),
            server_handle.clone(),
            sessions,
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(Mutex::new(HashMap::new())),
            "127.0.0.1".to_string(),
            0,
            "/v1".to_string(),
            String::new(),
            vec![vec![]],
            30,
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(AutoIncreaseState::default()),
            inspector,
        )
        .await
        .expect("proxy should bind");

        Self {
            proxy_port,
            captured,
            seen_upstream_body,
            server_handle,
        }
    }

    async fn post_chat(&self, body: Value) -> String {
        let client = reqwest::Client::new();
        let response = client
            .post(format!(
                "http://127.0.0.1:{}/v1/chat/completions",
                self.proxy_port
            ))
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .expect("proxy should respond");
        assert_eq!(response.status(), 200);
        response.text().await.expect("client body")
    }

    /// Waits for the detached relay to emit its finish event.
    async fn wait_for_finish(&self) -> Value {
        for _ in 0..100 {
            if let Some(event) = self.event(API_INSPECTOR_FINISHED) {
                return event;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("no finish event within 2s: {:?}", self.channels());
    }

    fn event(&self, channel: &'static str) -> Option<Value> {
        self.captured
            .lock()
            .unwrap()
            .iter()
            .find(|(c, _)| *c == channel)
            .map(|(_, payload)| payload.clone())
    }

    fn channels(&self) -> Vec<&'static str> {
        self.captured.lock().unwrap().iter().map(|(c, _)| *c).collect()
    }

    async fn stop(self) {
        let _ = proxy::stop_server(self.server_handle).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_streamed_request_reports_tokens_previews_and_timings() {
    let harness = Harness::start("test-model", true).await;

    let client_body = harness
        .post_chat(serde_json::json!({
            "model": "test-model",
            "stream": true,
            "messages": [
                {"role": "system", "content": "be terse"},
                {"role": "user", "content": "Say hello"}
            ]
        }))
        .await;

    let started = harness
        .event(API_INSPECTOR_STARTED)
        .expect("started event");
    assert_eq!(started["endpoint"], "chat/completions");
    assert_eq!(started["method"], "POST");
    assert_eq!(started["model_id"], "test-model");
    assert_eq!(started["stream"], true);
    assert_eq!(started["message_count"], 2);
    // The last *user* message, not the last message overall.
    assert_eq!(started["prompt_preview"], "Say hello");

    let finished = harness.wait_for_finish().await;
    assert_eq!(finished["id"], started["id"]);
    assert_eq!(finished["done"], true);
    assert_eq!(finished["status"], 200);
    assert_eq!(finished["aborted"], false);
    assert_eq!(finished["prompt_tokens"], 11);
    assert_eq!(finished["completion_tokens"], 2);
    assert_eq!(finished["total_tokens"], 13);
    assert_eq!(finished["tokens_estimated"], false);
    assert_eq!(finished["finish_reason"], "stop");
    assert_eq!(finished["reply_preview"], "Hello world");
    assert!(finished["duration_ms"].as_u64().is_some());
    assert!(finished["ttft_ms"].as_u64().is_some());

    // The client asked for a plain stream and must get exactly that: no extra
    // usage-only chunk, whatever we asked the upstream for.
    assert!(
        !client_body.contains("\"choices\":[]"),
        "usage trailer leaked to the client: {client_body}"
    );
    assert!(client_body.contains("Hello"));
    assert!(client_body.contains(" world"));
    assert!(client_body.contains("[DONE]"));

    harness.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn include_usage_is_requested_from_the_upstream_only_while_watching() {
    let watching = Harness::start("test-model", true).await;
    watching
        .post_chat(serde_json::json!({
            "model": "test-model",
            "stream": true,
            "messages": [{"role": "user", "content": "hi"}]
        }))
        .await;
    let sent = watching.seen_upstream_body.lock().unwrap().clone().unwrap();
    assert_eq!(sent["stream_options"]["include_usage"], true);
    // The rest of the body must survive the rewrite untouched.
    assert_eq!(sent["model"], "test-model");
    assert_eq!(sent["messages"][0]["content"], "hi");
    watching.stop().await;

    let idle = Harness::start("test-model", false).await;
    idle.post_chat(serde_json::json!({
        "model": "test-model",
        "stream": true,
        "messages": [{"role": "user", "content": "hi"}]
    }))
    .await;
    let sent = idle.seen_upstream_body.lock().unwrap().clone().unwrap();
    assert!(
        sent.get("stream_options").is_none(),
        "no rewrite when the dashboard is closed: {sent}"
    );
    assert!(idle.channels().is_empty(), "no events when disabled");
    idle.stop().await;
}

/// Extracts the `data:` payloads a client received, in order.
fn data_lines(body: &str) -> Vec<String> {
    body.lines()
        .filter_map(|line| line.trim().strip_prefix("data:"))
        .map(|d| d.trim().to_string())
        .collect()
}

/// Opening the dashboard makes the proxy ask the upstream for token usage.
/// The upstream answers by decorating every chunk with `"usage": null` and
/// appending a usage-only trailer. The trailer is the dangerous part — a
/// client iterating `chunk.choices[0]` throws on it — so the proxy strips it
/// back out. What a client actually consumes must be unchanged: the same
/// number of events, the same deltas, the same stop reason, and no chunk with
/// an empty `choices` array.
#[tokio::test(flavor = "multi_thread")]
async fn instrumentation_never_adds_a_chunk_the_client_did_not_ask_for() {
    let request = serde_json::json!({
        "model": "test-model",
        "stream": true,
        "messages": [{"role": "user", "content": "hi"}]
    });

    let watching = Harness::start("test-model", true).await;
    let with_inspector = watching.post_chat(request.clone()).await;
    watching.wait_for_finish().await;
    watching.stop().await;

    let idle = Harness::start("test-model", false).await;
    let without_inspector = idle.post_chat(request).await;
    idle.stop().await;

    let watched = data_lines(&with_inspector);
    let unwatched = data_lines(&without_inspector);
    assert_eq!(
        watched.len(),
        unwatched.len(),
        "event count changed\n  watched: {watched:?}\nunwatched: {unwatched:?}"
    );
    assert!(
        !with_inspector.contains("\"choices\":[]"),
        "usage trailer leaked to the client: {with_inspector}"
    );

    // Same content, same terminator, in the same order.
    for (watched, unwatched) in watched.iter().zip(unwatched.iter()) {
        if watched == "[DONE]" || unwatched == "[DONE]" {
            assert_eq!(watched, unwatched);
            continue;
        }
        let a: Value = serde_json::from_str(watched).unwrap();
        let b: Value = serde_json::from_str(unwatched).unwrap();
        assert_eq!(a["choices"], b["choices"]);
        // The one permitted difference: a null `usage` field the upstream adds
        // to every chunk once `include_usage` is on. Additive and inert.
        assert!(a["usage"].is_null());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unroutable_model_is_still_reported_as_a_finished_request() {
    let harness = Harness::start("test-model", true).await;
    let client = reqwest::Client::new();
    let response = client
        .post(format!(
            "http://127.0.0.1:{}/v1/chat/completions",
            harness.proxy_port
        ))
        .json(&serde_json::json!({
            "model": "not-loaded",
            "stream": true,
            "messages": [{"role": "user", "content": "hi"}]
        }))
        .send()
        .await
        .unwrap();
    assert!(!response.status().is_success());

    let started = harness.event(API_INSPECTOR_STARTED).expect("started");
    assert_eq!(started["model_id"], "not-loaded");
    let finished = harness.wait_for_finish().await;
    assert_eq!(finished["id"], started["id"]);
    assert!(finished["status"].as_u64().unwrap() >= 400);

    harness.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn polling_endpoints_stay_out_of_the_dashboard() {
    let harness = Harness::start("test-model", true).await;
    let client = reqwest::Client::new();
    let response = client
        .get(format!("http://127.0.0.1:{}/v1/models", harness.proxy_port))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    // Give any stray event time to land before asserting its absence.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        harness.channels().is_empty(),
        "/models must not appear in the request log: {:?}",
        harness.channels()
    );
    assert_eq!(harness.captured.lock().unwrap().len(), 0);

    harness.stop().await;
}
