//! Golden HTTP fixtures for the Local API Server, captured from the real proxy
//! (PLAN.md §4 stage 4b).
//!
//! Every case starts the actual `proxy::start_server` against a scriptable stub
//! upstream, sends one raw HTTP request over a socket and records two things:
//! what the client got back, and what the upstream was asked. The core's public
//! server replays the same requests against the same stubs.
//!
//! Raw sockets rather than an HTTP client on the request side, so the headers a
//! case sends are exactly the headers the proxy sees — including a request with
//! no `Host` at all, which no client library will produce.
//!
//! The auto-increase-ctx handshake is answered by a scripted responder on the
//! mock app, the way the llama.cpp extension answers it in the product, so the
//! context-overflow retry paths are captured instead of waiting out the 60 s
//! timeout.
//!
//! Run: `cargo test --lib -- --ignored server::proxy::http_fixture_dump --test-threads=1`.

use std::collections::{BTreeMap, HashMap};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Request, Response, Server};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Listener};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;

use super::*;
use crate::core::server::request_inspector::RequestInspector;
use crate::core::sessions::mirror::CoreSessions;
use crate::core::sessions::resolver::SessionResolver;
use crate::core::state::{AutoIncreaseState, ProviderConfig, ProviderCustomHeader, ServerHandle};

const LOCAL_MODEL: &str = "local.model-7b";
const EMBED_MODEL: &str = "embed-model";
const REMOTE_MODEL: &str = "cloud-model";
const REMOTE_PROVIDER: &str = "cloudprov";
const SESSION_KEY: &str = "session-key";
const REMOTE_KEY: &str = "sk-remote";
const LARGE_BODY_BYTES: usize = 64 * 1024;

/// Request headers the upstream saw that carry meaning. Everything else is
/// whatever the HTTP client library adds on its own, and would differ between
/// reqwest and any other client without anything being wrong.
const UPSTREAM_HEADERS: &[&str] = &[
    "authorization",
    "x-api-key",
    "content-type",
    "x-custom",
    "x-client-trace",
    "anthropic-version",
    "openai-beta",
    "origin",
];

/// Messages that end in a transport error's own text; that text is replaced by a placeholder.
const TRANSPORT_ERROR_LEADS: &[&str] = &[
    "The model backend is not reachable: ",
    "Proxy request to model failed: ",
    "Failed to fetch metrics from llama-server: ",
];

/// Response headers the client got that carry meaning (see above).
const RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "allow",
    "vary",
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-max-age",
    "x-upstream-trace",
];

// ── stub upstream ────────────────────────────────────────────────────────────

#[derive(Clone)]
struct Reply {
    status: u16,
    content_type: &'static str,
    body: String,
}

fn reply(status: u16, content_type: &'static str, body: impl Into<String>) -> Reply {
    Reply {
        status,
        content_type,
        body: body.into(),
    }
}

fn json_reply(status: u16, body: Value) -> Reply {
    reply(status, "application/json", body.to_string())
}

/// Successive answers for one upstream path; the last repeats.
#[derive(Clone)]
struct Rule {
    path: &'static str,
    replies: Vec<Reply>,
}

fn rule(path: &'static str, replies: Vec<Reply>) -> Rule {
    Rule { path, replies }
}

type Calls = Arc<StdMutex<Vec<Value>>>;

async fn spawn_stub(rules: Vec<Rule>, calls: Calls) -> u16 {
    let counters: Arc<StdMutex<HashMap<&'static str, usize>>> = Arc::default();
    let rules = Arc::new(rules);
    let make_svc = make_service_fn(move |_| {
        let rules = rules.clone();
        let calls = calls.clone();
        let counters = counters.clone();
        async move {
            Ok::<_, Infallible>(service_fn(move |req: Request<Body>| {
                let rules = rules.clone();
                let calls = calls.clone();
                let counters = counters.clone();
                async move {
                    let method = req.method().to_string();
                    let path = req
                        .uri()
                        .path_and_query()
                        .map(|p| p.as_str().to_string())
                        .unwrap_or_default();
                    let mut headers = BTreeMap::new();
                    for (name, value) in req.headers() {
                        if UPSTREAM_HEADERS.contains(&name.as_str()) {
                            headers.insert(
                                name.as_str().to_string(),
                                value.to_str().unwrap_or("<non-utf8>").to_string(),
                            );
                        }
                    }
                    let bytes = hyper::body::to_bytes(req.into_body())
                        .await
                        .unwrap_or_default();
                    let body = serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| {
                        Value::String(String::from_utf8_lossy(&bytes).to_string())
                    });
                    calls.lock().unwrap().push(json!({
                        "method": method,
                        "path": path,
                        "headers": headers,
                        "body": body,
                    }));
                    let plain_path = path.split('?').next().unwrap_or("").to_string();
                    let found = rules.iter().find(|r| r.path == plain_path).cloned();
                    let answer = match found {
                        Some(rule) => {
                            let mut counters = counters.lock().unwrap();
                            let n = counters.entry(rule.path).or_insert(0);
                            let pick = rule.replies[(*n).min(rule.replies.len() - 1)].clone();
                            *n += 1;
                            pick
                        }
                        None => reply(404, "text/plain", "stub: no rule for this path"),
                    };
                    Ok::<_, Infallible>(
                        Response::builder()
                            .status(answer.status)
                            .header("content-type", answer.content_type)
                            .header("x-upstream-trace", "stub")
                            .body(Body::from(answer.body))
                            .unwrap(),
                    )
                }
            }))
        }
    });
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = Server::from_tcp(listener).unwrap().serve(make_svc).await;
    });
    port
}

// ── setup ────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq)]
enum Sessions {
    /// A text model and an embedding model on llama.cpp upstream, both served by the stub.
    Loaded,
    /// Nothing loaded anywhere.
    None,
    /// The text model is registered, but its port has nothing listening.
    Unreachable,
}

#[derive(Clone)]
struct Setup {
    prefix: &'static str,
    api_key: &'static str,
    trusted_hosts: Vec<&'static str>,
    sessions: Sessions,
    remote: bool,
    /// How the scripted llama.cpp extension answers an auto-increase request.
    ctx_responder: Option<Value>,
}

impl Default for Setup {
    fn default() -> Self {
        Self {
            prefix: "/v1",
            api_key: "",
            trusted_hosts: vec![],
            sessions: Sessions::Loaded,
            remote: true,
            ctx_responder: None,
        }
    }
}

fn session_map(entries: Vec<(&str, u16, bool)>) -> Arc<CoreSessions> {
    let sessions: Vec<Value> = entries
        .into_iter()
        .enumerate()
        .map(|(i, (model_id, port, is_embedding))| {
            json!({
                "pid": i as i32 + 1,
                "port": port,
                "model_id": model_id,
                "model_path": format!("/models/{model_id}.gguf"),
                "is_embedding": is_embedding,
                "api_key": SESSION_KEY,
                "provider": "llamacpp-upstream",
            })
        })
        .collect();
    let mirror = Arc::new(CoreSessions::new());
    mirror.apply_snapshot(1, "fixture", &json!({ "sessions": sessions }));
    mirror
}

fn closed_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

// ── cases ────────────────────────────────────────────────────────────────────

struct Case {
    name: &'static str,
    setup: Setup,
    method: &'static str,
    path: &'static str,
    /// `{host}` is replaced by the proxy's own `127.0.0.1:<port>`. A case that
    /// sends no `Host` header at all lists `("Host", "")`.
    headers: Vec<(&'static str, &'static str)>,
    body: Option<String>,
    upstream: Vec<Rule>,
}

fn case(name: &'static str, method: &'static str, path: &'static str) -> Case {
    Case {
        name,
        setup: Setup::default(),
        method,
        path,
        headers: vec![],
        body: None,
        upstream: vec![],
    }
}

impl Case {
    fn setup(mut self, f: impl FnOnce(&mut Setup)) -> Self {
        f(&mut self.setup);
        self
    }
    fn header(mut self, name: &'static str, value: &'static str) -> Self {
        self.headers.push((name, value));
        self
    }
    fn json(mut self, body: Value) -> Self {
        self.body = Some(body.to_string());
        self
    }
    fn raw_body(mut self, body: &'static str) -> Self {
        self.body = Some(body.to_string());
        self
    }
    fn upstream(mut self, rule: Rule) -> Self {
        self.upstream.push(rule);
        self
    }
}

fn chat_ok(model: &str, content: &str, finish: &str) -> Value {
    json!({
        "id": "chatcmpl-1", "object": "chat.completion", "created": 1, "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": finish}],
        "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4}
    })
}

fn chat_sse(model: &str) -> String {
    format!(
        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        json!({"id": "c", "object": "chat.completion.chunk", "model": model,
               "choices": [{"index": 0, "delta": {"role": "assistant", "content": "hi"}, "finish_reason": null}]}),
        json!({"id": "c", "object": "chat.completion.chunk", "model": model,
               "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}),
    )
}

fn chat_body(model: &str) -> Value {
    json!({"model": model, "messages": [{"role": "user", "content": "hi"}]})
}

fn cases() -> Vec<Case> {
    let ok_chat = || {
        rule(
            "/v1/chat/completions",
            vec![json_reply(200, chat_ok(LOCAL_MODEL, "hi", "stop"))],
        )
    };
    let ctx_error = || {
        json_reply(
            400,
            json!({"error": {"code": 400, "message": "the request exceeds the available context size, try increasing it", "type": "exceed_context_size_error"}}),
        )
    };

    vec![
        // ── host gate ─────────────────────────────────────────────────────
        case("host_loopback_default_allowed", "GET", "/v1/models"),
        case("host_localhost_uppercase_allowed", "GET", "/v1/models").header("Host", "LOCALHOST:1337"),
        case("host_zero_address_allowed", "GET", "/v1/models").header("Host", "0.0.0.0:1337"),
        case("host_docker_internal_allowed", "GET", "/v1/models").header("Host", "host.docker.internal"),
        case("host_ipv6_loopback_not_trusted_by_default", "GET", "/v1/models").header("Host", "[::1]:1337"),
        case("host_untrusted_forbidden", "GET", "/v1/models").header("Host", "evil.example"),
        case("host_trusted_list_ignores_port", "GET", "/v1/models")
            .setup(|s| s.trusted_hosts = vec!["lan.example:9999"])
            .header("Host", "lan.example:1337"),
        case("host_star_trusts_everything", "GET", "/v1/models")
            .setup(|s| s.trusted_hosts = vec!["*"])
            .header("Host", "anything.example"),
        case("host_missing_is_bad_request", "GET", "/v1/models").header("Host", ""),
        case("host_whitelisted_docs_root_skips_host_check", "GET", "/").header("Host", "evil.example"),
        // ── api key gate ──────────────────────────────────────────────────
        case("auth_missing_key_unauthorized", "GET", "/v1/models").setup(|s| s.api_key = "secret"),
        case("auth_bearer_accepted", "GET", "/v1/models")
            .setup(|s| s.api_key = "secret")
            .header("Authorization", "Bearer secret"),
        case("auth_x_api_key_accepted", "GET", "/v1/models")
            .setup(|s| s.api_key = "secret")
            .header("X-Api-Key", "secret"),
        case("auth_wrong_bearer_unauthorized", "GET", "/v1/models")
            .setup(|s| s.api_key = "secret")
            .header("Authorization", "Bearer nope"),
        case("auth_lowercase_bearer_prefix_unauthorized", "GET", "/v1/models")
            .setup(|s| s.api_key = "secret")
            .header("Authorization", "bearer secret"),
        case("auth_whitelisted_openapi_skips_key", "GET", "/openapi.json").setup(|s| s.api_key = "secret"),
        case("auth_checked_after_host", "GET", "/v1/models")
            .setup(|s| s.api_key = "secret")
            .header("Host", "evil.example"),
        // ── CORS ──────────────────────────────────────────────────────────
        case("cors_trusted_origin_reflected_on_response", "GET", "/v1/models")
            .header("Origin", "http://localhost:3000"),
        case("cors_untrusted_origin_not_reflected", "GET", "/v1/models")
            .header("Origin", "https://evil.example"),
        case("preflight_allowed", "OPTIONS", "/v1/chat/completions")
            .header("Origin", "http://localhost:3000")
            .header("Access-Control-Request-Method", "POST")
            .header("Access-Control-Request-Headers", "content-type, authorization, x-stainless-os"),
        case("preflight_method_not_allowed", "OPTIONS", "/v1/chat/completions")
            .header("Access-Control-Request-Method", "TRACE"),
        case("preflight_header_not_allowed", "OPTIONS", "/v1/chat/completions")
            .header("Access-Control-Request-Method", "POST")
            .header("Access-Control-Request-Headers", "content-type, x-secret"),
        case("preflight_untrusted_host_forbidden", "OPTIONS", "/v1/chat/completions")
            .header("Host", "evil.example")
            .header("Access-Control-Request-Method", "POST"),
        case("preflight_whitelisted_path_skips_host_check", "OPTIONS", "/openapi.json")
            .header("Host", "evil.example"),
        case("preflight_ignores_api_key", "OPTIONS", "/v1/models").setup(|s| s.api_key = "secret"),
        // ── static and hidden routes ──────────────────────────────────────
        case("openapi_servers_rewritten", "GET", "/openapi.json"),
        case("docs_css_served", "GET", "/docs/swagger-ui.css"),
        case("docs_bundle_served", "GET", "/docs/swagger-ui-bundle.js"),
        case("docs_standalone_preset_whitelisted_but_not_served", "GET", "/docs/swagger-ui-standalone-preset.js"),
        case("configs_path_hidden", "GET", "/v1/configs/anything"),
        case("unknown_path_not_found", "GET", "/v1/nope"),
        case("known_path_wrong_method", "GET", "/v1/chat/completions"),
        case("models_wrong_method", "POST", "/v1/models").json(json!({})),
        // ── prefix handling ───────────────────────────────────────────────
        case("path_without_prefix_still_routed", "GET", "/models"),
        case("prefix_matched_without_slash_boundary", "GET", "/v1models"),
        case("empty_prefix", "GET", "/models").setup(|s| s.prefix = ""),
        // ── model listings ────────────────────────────────────────────────
        case("models_lists_local_and_remote", "GET", "/v1/models"),
        case("models_empty_when_nothing_loaded", "GET", "/v1/models").setup(|s| {
            s.sessions = Sessions::None;
            s.remote = false;
        }),
        case("muse_code_catalog", "GET", "/v1/muse-code/models"),
        // ── chat completions routing ──────────────────────────────────────
        case("chat_local_non_stream_forwards_with_session_key", "POST", "/v1/chat/completions")
            .header("Authorization", "Bearer client-key-is-not-forwarded")
            .header("X-Client-Trace", "t-1")
            .json(chat_body(LOCAL_MODEL))
            .upstream(ok_chat()),
        case("chat_local_stream_passthrough", "POST", "/v1/chat/completions")
            .json(json!({"model": LOCAL_MODEL, "stream": true, "messages": [{"role": "user", "content": "hi"}]}))
            .upstream(rule("/v1/chat/completions", vec![reply(200, "text/event-stream", chat_sse(LOCAL_MODEL))])),
        case("chat_dot_underscore_model_alias", "POST", "/v1/chat/completions")
            .json(chat_body("local_model-7b"))
            .upstream(ok_chat()),
        case("chat_remote_by_model_list_injects_provider_key_and_headers", "POST", "/v1/chat/completions")
            .header("Authorization", "Bearer client-key")
            .json(chat_body(REMOTE_MODEL))
            .upstream(rule("/v1/chat/completions", vec![json_reply(200, chat_ok(REMOTE_MODEL, "cloud", "stop"))])),
        case("chat_remote_by_provider_prefix", "POST", "/v1/chat/completions")
            .json(chat_body("cloudprov/some-other-model"))
            .upstream(rule("/v1/chat/completions", vec![json_reply(200, chat_ok("some-other-model", "cloud", "stop"))])),
        case("chat_unknown_model_not_found", "POST", "/v1/chat/completions").json(chat_body("ghost")),
        case("chat_nothing_loaded_service_unavailable", "POST", "/v1/chat/completions")
            .setup(|s| {
                s.sessions = Sessions::None;
                s.remote = false;
            })
            .json(chat_body(LOCAL_MODEL)),
        case("chat_missing_model_bad_request", "POST", "/v1/chat/completions").json(json!({"messages": []})),
        case("chat_invalid_json_bad_request", "POST", "/v1/chat/completions").raw_body("{not json"),
        case("chat_upstream_unreachable", "POST", "/v1/chat/completions")
            .setup(|s| s.sessions = Sessions::Unreachable)
            .json(chat_body(LOCAL_MODEL)),
        // ── other forwarded endpoints ─────────────────────────────────────
        case("completions_local", "POST", "/v1/completions")
            .json(json!({"model": LOCAL_MODEL, "prompt": "hi"}))
            .upstream(rule("/v1/completions", vec![json_reply(200, json!({"id": "cmpl-1", "object": "text_completion", "choices": [{"text": "yo", "index": 0, "finish_reason": "stop"}]}))])),
        case("embeddings_local", "POST", "/v1/embeddings")
            .json(json!({"model": EMBED_MODEL, "input": "hi"}))
            .upstream(rule("/v1/embeddings", vec![json_reply(200, json!({"object": "list", "data": [{"object": "embedding", "index": 0, "embedding": [0.5, 0.25]}], "model": EMBED_MODEL}))])),
        case("count_tokens_local", "POST", "/v1/messages/count_tokens")
            .json(json!({"model": LOCAL_MODEL, "messages": [{"role": "user", "content": "hi"}]}))
            .upstream(rule("/v1/messages/count_tokens", vec![json_reply(200, json!({"input_tokens": 3}))])),
        // ── metrics ───────────────────────────────────────────────────────
        case("metrics_local_root_path_with_session_key", "GET", "/v1/metrics?model=local.model-7b")
            .upstream(rule("/metrics", vec![reply(200, "text/plain; version=0.0.4", "llamacpp:prompt_tokens_total 5\n")])),
        case("metrics_missing_model_bad_request", "GET", "/v1/metrics"),
        case("metrics_unknown_model_not_found", "GET", "/v1/metrics?model=ghost"),
        case("metrics_remote_model_not_found", "GET", "/v1/metrics?model=cloud-model"),
        // ── errors from the upstream ──────────────────────────────────────
        case("chat_local_plaintext_error_structured", "POST", "/v1/chat/completions")
            .json(chat_body(LOCAL_MODEL))
            .upstream(rule("/v1/chat/completions", vec![reply(500, "text/plain", "backend exploded")])),
        case("chat_local_structured_error_forwarded_unchanged", "POST", "/v1/chat/completions")
            .json(chat_body(LOCAL_MODEL))
            .upstream(rule("/v1/chat/completions", vec![json_reply(500, json!({"error": {"message": "already structured", "type": "server_error"}}))])),
        case("chat_remote_error_passthrough", "POST", "/v1/chat/completions")
            .json(chat_body(REMOTE_MODEL))
            .upstream(rule("/v1/chat/completions", vec![json_reply(429, json!({"error": {"message": "rate limited"}}))])),
        case("chat_local_ctx_overflow_increase_declined", "POST", "/v1/chat/completions")
            .setup(|s| s.ctx_responder = Some(json!({"ok": false, "reason": "at_max"})))
            .json(chat_body(LOCAL_MODEL))
            .upstream(rule("/v1/chat/completions", vec![ctx_error()])),
        case("chat_local_ctx_overflow_increase_then_retry_succeeds", "POST", "/v1/chat/completions")
            .setup(|s| s.ctx_responder = Some(json!({"ok": true, "new_ctx_len": 32768})))
            .json(chat_body(LOCAL_MODEL))
            .upstream(rule("/v1/chat/completions", vec![ctx_error(), json_reply(200, chat_ok(LOCAL_MODEL, "after retry", "stop"))])),
        case("chat_remote_ctx_overflow_not_retried", "POST", "/v1/chat/completions")
            .setup(|s| s.ctx_responder = Some(json!({"ok": true, "new_ctx_len": 32768})))
            .json(chat_body(REMOTE_MODEL))
            .upstream(rule("/v1/chat/completions", vec![ctx_error()])),
        case("chat_local_compute_error_declined_reload", "POST", "/v1/chat/completions")
            .setup(|s| s.ctx_responder = Some(json!({"ok": false, "reason": "at_max"})))
            .json(chat_body(LOCAL_MODEL))
            .upstream(rule("/v1/chat/completions", vec![json_reply(500, json!({"error": {"code": 500, "message": "Compute error.", "type": "server_error"}}))])),
        case("chat_local_finish_length_without_client_cap_retried", "POST", "/v1/chat/completions")
            .setup(|s| s.ctx_responder = Some(json!({"ok": true, "new_ctx_len": 32768})))
            .json(chat_body(LOCAL_MODEL))
            .upstream(rule("/v1/chat/completions", vec![json_reply(200, chat_ok(LOCAL_MODEL, "cut", "length")), json_reply(200, chat_ok(LOCAL_MODEL, "whole", "stop"))])),
        case("chat_local_finish_length_with_client_cap_not_retried", "POST", "/v1/chat/completions")
            .setup(|s| s.ctx_responder = Some(json!({"ok": true, "new_ctx_len": 32768})))
            .json(json!({"model": LOCAL_MODEL, "max_tokens": 1, "messages": [{"role": "user", "content": "hi"}]}))
            .upstream(rule("/v1/chat/completions", vec![json_reply(200, chat_ok(LOCAL_MODEL, "c", "length"))])),
        // ── Anthropic /messages ───────────────────────────────────────────
        case("messages_local_native_success", "POST", "/v1/messages")
            .header("anthropic-version", "2023-06-01")
            .json(json!({"model": LOCAL_MODEL, "max_tokens": 16, "messages": [{"role": "user", "content": "hi"}]}))
            .upstream(rule("/v1/messages", vec![json_reply(200, json!({"id": "msg_1", "type": "message", "role": "assistant", "content": [{"type": "text", "text": "native"}], "stop_reason": "end_turn"}))])),
        case("messages_local_fallback_to_chat_non_stream", "POST", "/v1/messages")
            .json(json!({"model": LOCAL_MODEL, "system": "be terse", "max_tokens": 16, "messages": [{"role": "user", "content": "hi"}]}))
            .upstream(rule("/v1/messages", vec![reply(404, "text/plain", "not found")]))
            .upstream(ok_chat()),
        case("messages_local_fallback_to_chat_stream", "POST", "/v1/messages")
            .json(json!({"model": LOCAL_MODEL, "stream": true, "max_tokens": 16, "messages": [{"role": "user", "content": "hi"}]}))
            .upstream(rule("/v1/messages", vec![reply(404, "text/plain", "not found")]))
            .upstream(rule("/v1/chat/completions", vec![reply(200, "text/event-stream", chat_sse(LOCAL_MODEL))])),
        case("messages_fallback_also_fails", "POST", "/v1/messages")
            .json(json!({"model": LOCAL_MODEL, "max_tokens": 16, "messages": [{"role": "user", "content": "hi"}]}))
            .upstream(rule("/v1/messages", vec![reply(404, "text/plain", "no messages route")]))
            .upstream(rule("/v1/chat/completions", vec![reply(500, "text/plain", "chat also broke")])),
        case("messages_remote_native", "POST", "/v1/messages")
            .json(json!({"model": REMOTE_MODEL, "max_tokens": 16, "messages": [{"role": "user", "content": "hi"}]}))
            .upstream(rule("/v1/messages", vec![json_reply(200, json!({"id": "msg_r", "type": "message", "content": []}))])),
        case("messages_unknown_model_not_found", "POST", "/v1/messages")
            .json(json!({"model": "ghost", "messages": []})),
        case("messages_missing_model_bad_request", "POST", "/v1/messages").json(json!({"messages": []})),
        case("messages_invalid_json_bad_request", "POST", "/v1/messages").raw_body("nope"),
        // ── Responses API ─────────────────────────────────────────────────
        case("responses_local_non_stream_translated", "POST", "/v1/responses")
            .json(json!({"model": LOCAL_MODEL, "input": "hi", "instructions": "be terse", "stream": false}))
            .upstream(ok_chat()),
        case("responses_local_stream_translated", "POST", "/v1/responses")
            .json(json!({"model": LOCAL_MODEL, "input": "hi", "stream": true}))
            .upstream(rule("/v1/chat/completions", vec![reply(200, "text/event-stream", chat_sse(LOCAL_MODEL))])),
        case("responses_remote_passthrough", "POST", "/v1/responses")
            .json(json!({"model": REMOTE_MODEL, "input": "hi"}))
            .upstream(rule("/v1/responses", vec![json_reply(200, json!({"id": "resp_remote", "object": "response", "output": []}))])),
        case("responses_unknown_model", "POST", "/v1/responses").json(json!({"model": "ghost", "input": "hi"})),
        case("responses_invalid_json", "POST", "/v1/responses").raw_body("{"),
    ]
}

// ── raw HTTP ─────────────────────────────────────────────────────────────────

struct RawResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

async fn send_raw(port: u16, case: &Case) -> RawResponse {
    let mut request = format!("{} {} HTTP/1.1\r\n", case.method, case.path);
    let host_override = case
        .headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case("host"));
    match host_override {
        Some((_, "")) => {}
        Some((_, value)) => request.push_str(&format!("Host: {value}\r\n")),
        None => request.push_str(&format!("Host: 127.0.0.1:{port}\r\n")),
    }
    for (name, value) in &case.headers {
        if !name.eq_ignore_ascii_case("host") {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    if let Some(body) = &case.body {
        request.push_str("Content-Type: application/json\r\n");
        request.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    request.push_str("Connection: close\r\n\r\n");
    if let Some(body) = &case.body {
        request.push_str(body);
    }

    let mut stream = TcpStream::connect(SocketAddr::from(([127, 0, 0, 1], port)))
        .await
        .expect("connect to proxy");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(90), stream.read_to_end(&mut raw))
        .await
        .expect("proxy answered in time")
        .unwrap();
    parse_raw(&raw)
}

fn parse_raw(raw: &[u8]) -> RawResponse {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("header terminator");
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let mut lines = head.split("\r\n");
    let status: u16 = lines
        .next()
        .and_then(|l| l.split(' ').nth(1))
        .and_then(|s| s.parse().ok())
        .expect("status line");
    let mut headers = BTreeMap::new();
    let mut chunked = false;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_lowercase();
            let value = value.trim().to_string();
            if name == "transfer-encoding" && value.eq_ignore_ascii_case("chunked") {
                chunked = true;
            }
            if RESPONSE_HEADERS.contains(&name.as_str()) {
                headers.insert(name, value);
            }
        }
    }
    let rest = &raw[split + 4..];
    let body = if chunked {
        dechunk(rest)
    } else {
        rest.to_vec()
    };
    RawResponse {
        status,
        headers,
        body,
    }
}

fn dechunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let Some(line_end) = data.windows(2).position(|w| w == b"\r\n") else {
            break;
        };
        let size_text = String::from_utf8_lossy(&data[..line_end]);
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("0").trim(), 16)
            .unwrap_or(0);
        data = &data[line_end + 2..];
        if size == 0 || data.len() < size {
            break;
        }
        out.extend_from_slice(&data[..size]);
        data = &data[(size + 2).min(data.len())..];
    }
    out
}

/// The body as the fixture records it: JSON when it parses, an ordered list of
/// SSE frames for an event stream, a digest for large static files, text otherwise.
fn describe_body(content_type: Option<&String>, bytes: &[u8]) -> Value {
    if bytes.len() > LARGE_BODY_BYTES {
        return json!({"sha256": hex::encode(Sha256::digest(bytes)), "bytes": bytes.len()});
    }
    let text = String::from_utf8_lossy(bytes).to_string();
    let is_sse = content_type.is_some_and(|c| c.contains("event-stream"));
    if is_sse {
        let frames: Vec<Value> = text
            .split("\n\n")
            .filter(|f| !f.trim().is_empty())
            .map(|frame| {
                let mut event = Value::Null;
                let mut data = Value::Null;
                for line in frame.lines() {
                    if let Some(rest) = line.strip_prefix("event:") {
                        event = Value::String(rest.trim().to_string());
                    } else if let Some(rest) = line.strip_prefix("data:") {
                        let rest = rest.trim();
                        data = serde_json::from_str(rest)
                            .unwrap_or_else(|_| Value::String(rest.to_string()));
                    }
                }
                json!({"event": event, "data": data})
            })
            .collect();
        return json!({"sse": frames});
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(mut v) if !text.trim().is_empty() => {
            // Model listings come out of hash maps in whatever order they iterate. Sorting here keeps
            // the fixture files — and the checksum both repos share — stable between dumps; the
            // replay compares the list as a set anyway.
            if let Some(items) = v.get_mut("data").and_then(Value::as_array_mut) {
                items.sort_by(|a, b| {
                    let key = |x: &Value| {
                        x.get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string()
                    };
                    key(a).cmp(&key(b))
                });
            }
            json!({"json": v})
        }
        _ => {
            // serde_json's wording for a parse failure is an implementation detail of the JSON
            // library, not of the API; any port will phrase it differently.
            let text = match text.split_once("Invalid JSON body: ") {
                Some((head, _)) => format!("{head}Invalid JSON body: <parse error>"),
                None => text,
            };
            json!({"text": text})
        }
    }
}

/// Replace every run-specific port and id with a placeholder.
fn normalise(mut value: Value, ports: &[(u16, &str)]) -> Value {
    fn walk(v: &mut Value, ports: &[(u16, &str)]) {
        match v {
            Value::String(s) => {
                for (port, name) in ports {
                    *s = s.replace(&format!(":{port}"), &format!(":<{name}>"));
                }
                // How a transport failure is worded belongs to the HTTP client library (reqwest
                // here), not to the API; the lead-in before it is the contract.
                for lead in TRANSPORT_ERROR_LEADS {
                    if let Some(at) = s.find(lead) {
                        s.truncate(at + lead.len());
                        s.push_str("<transport error>");
                    }
                }
                // Ids minted by the Responses shim per request.
                let re_like = |prefix: &str, s: &str| {
                    s.strip_prefix(prefix)
                        .is_some_and(|r| r.len() == 32 && r.bytes().all(|b| b.is_ascii_hexdigit()))
                };
                if re_like("resp_", s) {
                    *s = "<resp_id>".into();
                } else if re_like("msg_", s) {
                    *s = "<msg_id>".into();
                } else if re_like("fc_", s) {
                    *s = "<fc_id>".into();
                }
            }
            Value::Array(items) => items.iter_mut().for_each(|x| walk(x, ports)),
            Value::Object(map) => map.values_mut().for_each(|x| walk(x, ports)),
            _ => {}
        }
    }
    walk(&mut value, ports);
    value
}

// ── one case ─────────────────────────────────────────────────────────────────

async fn run_case(case: &Case) -> Value {
    let calls: Calls = Arc::default();
    let stub_port = spawn_stub(case.upstream.clone(), calls.clone()).await;

    let session_port = match case.setup.sessions {
        Sessions::Unreachable => closed_port(),
        _ => stub_port,
    };
    let upstream_sessions = match case.setup.sessions {
        Sessions::None => session_map(vec![]),
        _ => session_map(vec![
            (LOCAL_MODEL, session_port, false),
            (EMBED_MODEL, stub_port, true),
        ]),
    };
    let resolver = Arc::new(SessionResolver::new(upstream_sessions));

    let mut providers = HashMap::new();
    if case.setup.remote {
        providers.insert(
            REMOTE_PROVIDER.to_string(),
            ProviderConfig {
                provider: REMOTE_PROVIDER.to_string(),
                api_key: Some(REMOTE_KEY.to_string()),
                base_url: Some(format!("http://127.0.0.1:{stub_port}/v1")),
                custom_headers: vec![ProviderCustomHeader {
                    header: "X-Custom".to_string(),
                    value: "from-provider".to_string(),
                }],
                models: vec![REMOTE_MODEL.to_string()],
            },
        );
    }

    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    if let Some(answer) = case.setup.ctx_responder.clone() {
        let responder = handle.clone();
        handle.listen_any("local_backend://auto_increase_ctx", move |event| {
            let request: Value = serde_json::from_str(event.payload()).unwrap_or(Value::Null);
            if let Some(id) = request.get("request_id").and_then(Value::as_str) {
                let _ = responder.emit(
                    &format!("local_backend://auto_increase_ctx_done/{id}"),
                    answer.clone(),
                );
            }
        });
    }

    let server_handle: Arc<Mutex<Option<ServerHandle>>> = Arc::new(Mutex::new(None));
    let trusted: Vec<Vec<String>> = vec![case
        .setup
        .trusted_hosts
        .iter()
        .map(|h| h.to_string())
        .collect()];
    let proxy_port = start_server(
        handle.clone(),
        server_handle.clone(),
        resolver,
        "127.0.0.1".to_string(),
        0,
        case.setup.prefix.to_string(),
        case.setup.api_key.to_string(),
        trusted,
        30,
        Arc::new(Mutex::new(providers)),
        Arc::new(AutoIncreaseState::default()),
        Arc::new(RequestInspector::new()),
    )
    .await
    .expect("proxy binds")
    .port();

    let response = send_raw(proxy_port, case).await;
    let _ = stop_server(server_handle).await;
    drop(app);

    let body = describe_body(response.headers.get("content-type"), &response.body);
    let recorded_calls = calls.lock().unwrap().clone();
    let ports = [
        (stub_port, "upstream_port"),
        (session_port, "session_port"),
        (proxy_port, "proxy_port"),
    ];
    normalise(
        json!({
            "response": {"status": response.status, "headers": response.headers, "body": body},
            "upstream_calls": recorded_calls,
        }),
        &ports,
    )
}

fn repo_root() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .canonicalize()
        .unwrap()
}

fn git_head(root: &std::path::Path) -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(root)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn dump_fixtures() {
    let root = repo_root();
    let out = root.join("tests/fixtures/core-contracts/proxy-http");
    std::fs::create_dir_all(&out).unwrap();
    let commit = git_head(&root);
    let source = "src-tauri/src/core/server/proxy.rs";

    let mut names = Vec::new();
    for c in cases() {
        let expected = run_case(&c).await;
        let trusted: Vec<&str> = c.setup.trusted_hosts.clone();
        let doc = json!({
            "name": c.name,
            "source": {"file": source, "commit": commit},
            "comparator": "http-exchange",
            "placeholders": ["<upstream_port>", "<session_port>", "<proxy_port>", "<resp_id>", "<msg_id>", "<fc_id>"],
            "input": {
                "setup": {
                    "prefix": c.setup.prefix,
                    "api_key": c.setup.api_key,
                    "trusted_hosts": trusted,
                    "sessions": match c.setup.sessions { Sessions::Loaded => "loaded", Sessions::None => "none", Sessions::Unreachable => "unreachable" },
                    "remote_provider": c.setup.remote,
                    "ctx_responder": c.setup.ctx_responder,
                },
                "request": {
                    "method": c.method,
                    "path": c.path,
                    "headers": c.headers.iter().map(|(n, v)| json!([n, v])).collect::<Vec<_>>(),
                    "body": c.body,
                },
                "upstream": c.upstream.iter().map(|r| json!({
                    "path": r.path,
                    "replies": r.replies.iter().map(|x| json!({"status": x.status, "content_type": x.content_type, "body": x.body})).collect::<Vec<_>>(),
                })).collect::<Vec<_>>(),
            },
            "expected": expected,
        });
        std::fs::write(
            out.join(format!("{}.json", c.name)),
            serde_json::to_string_pretty(&doc).unwrap() + "\n",
        )
        .unwrap();
        names.push(c.name);
    }

    let index = json!({
        "source": {"file": source, "commit": commit},
        "comparators": ["http-exchange"],
        "comparator_notes": {
            "http-exchange": "Start the public server with input.setup, a stub upstream answering input.upstream (per path, successive replies, the last repeating; unknown paths answer 404 text/plain 'stub: no rule for this path'; every reply carries `x-upstream-trace: stub`), and send input.request as raw HTTP/1.1 with `Connection: close`. `Host` defaults to `127.0.0.1:<proxy_port>`; a header pair [\"Host\", \"\"] means no Host header at all. A request with a body also sends `Content-Type: application/json`.",
            "setup": "sessions=loaded: llamacpp-upstream sessions `local.model-7b` (text) and `embed-model` (embedding), both on the stub, api key `session-key`. unreachable: `local.model-7b` points at a port with nothing listening. none: no sessions. remote_provider=true: provider `cloudprov` with base_url `http://127.0.0.1:<upstream_port>/v1`, api key `sk-remote`, custom header `X-Custom: from-provider`, models [`cloud-model`]. ctx_responder: how the llama.cpp extension answers `local_backend://auto_increase_ctx`; in the core this is the runtime's own increaseCtx outcome ({ok:false, reason} or {ok:true, new_ctx_len}); null means no auto-increase can happen.",
            "compare": "expected.response.status exactly; expected.response.headers: only the listed names (content-type, allow, vary, access-control-*, x-upstream-trace) — header values exactly; body: {json} deep-equal, {sse} ordered frame list of {event, data}, {text} exact, {sha256, bytes} digest of the served file; expected.upstream_calls: ordered list of {method, path incl. query, headers limited to authorization/x-api-key/content-type/accept/x-custom/x-client-trace/anthropic-version/openai-beta/origin, body JSON or text}. Other headers are HTTP-client noise and are not part of the contract.",
            "placeholders": "Ports become <upstream_port>, <session_port>, <proxy_port>. Per-request ids minted by the Responses shim (resp_/msg_/fc_ + 32 hex) become <resp_id>/<msg_id>/<fc_id>. The HTTP client's own wording of a transport failure, after `The model backend is not reachable: `, `Proxy request to model failed: ` or `Failed to fetch metrics from llama-server: `, becomes <transport error>.",
            "ordering": "models listings iterate hash maps in Rust; compare `data` as a set keyed by id.",
            "known_divergence": "Every call to the remote provider (the upstream calls carrying `authorization: Bearer sk-remote`) records a Rust gap: a provider's configured custom headers are stored (remote_provider_commands.rs) but never applied by the proxy, so those calls carry no `x-custom`. The port applies them; those calls are expected to show `x-custom: from-provider` and to match otherwise. chat_remote_by_model_list_injects_provider_key_and_headers is the case named for it."
        },
        "cases": names,
    });
    std::fs::write(
        out.join("index.json"),
        serde_json::to_string_pretty(&index).unwrap() + "\n",
    )
    .unwrap();
    eprintln!(
        "wrote {} proxy-http fixtures to {}",
        names.len(),
        out.display()
    );
}
