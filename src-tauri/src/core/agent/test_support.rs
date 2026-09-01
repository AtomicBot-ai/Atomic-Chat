use std::collections::{BTreeSet, VecDeque};
use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use hyper::body::to_bytes;
use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Method, Request, Response, Server, StatusCode};
use serde_json::Value;
use tokio::sync::oneshot;

use super::llm_client::{LlamaServerClient, LlamaSessionTarget};
use super::openai_client::{OpenAiCompatibleClient, OpenAiTarget, OpenAiTargetKind};
use super::skills::SkillRegistry;
use super::tools::{ApprovalHook, DesktopServices, FolderAccessHook};
use super::types::{AgentEvent, ApprovalDecision, ApprovalRequest, FolderAccessRequest};

pub(crate) struct TestWorkspace {
    path: PathBuf,
}

impl TestWorkspace {
    pub(crate) fn new() -> Self {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("agent-test-workspaces")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&path).expect("create agent test workspace");
        Self { path }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn write(&self, relative: &str, content: impl AsRef<[u8]>) {
        let path = self.path.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create fixture parent");
        }
        std::fs::write(path, content).expect("write fixture");
    }

    pub(crate) fn read(&self, relative: &str) -> Vec<u8> {
        std::fs::read(self.path.join(relative)).expect("read fixture")
    }

    pub(crate) fn skill_registry(&self) -> SkillRegistry {
        SkillRegistry::load(
            self.path.join(".agent-skills"),
            &BTreeSet::new(),
            &BTreeSet::new(),
        )
        .expect("create empty skill registry")
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

pub(crate) struct RecordingApproval {
    approved: bool,
    error: Option<String>,
    requests: Mutex<Vec<ApprovalRequest>>,
}

impl RecordingApproval {
    pub(crate) fn allow() -> Self {
        Self {
            approved: true,
            error: None,
            requests: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn deny() -> Self {
        Self {
            approved: false,
            error: None,
            requests: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn requests(&self) -> Vec<ApprovalRequest> {
        self.requests.lock().expect("approval requests").clone()
    }
}

#[async_trait]
impl ApprovalHook for RecordingApproval {
    async fn is_allowed(&self, _fingerprint: &str) -> bool {
        false
    }

    async fn request(&self, request: ApprovalRequest) -> Result<ApprovalDecision, String> {
        self.requests
            .lock()
            .expect("approval requests")
            .push(request);
        match &self.error {
            Some(error) => Err(error.clone()),
            None => Ok(if self.approved {
                ApprovalDecision::AllowOnce
            } else {
                ApprovalDecision::Deny
            }),
        }
    }
}

pub(crate) struct RecordingFolderAccess {
    allowed: bool,
    requests: Mutex<Vec<FolderAccessRequest>>,
}

impl RecordingFolderAccess {
    pub(crate) fn allow() -> Self {
        Self {
            allowed: true,
            requests: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn deny() -> Self {
        Self {
            allowed: false,
            requests: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn requests(&self) -> Vec<FolderAccessRequest> {
        self.requests
            .lock()
            .expect("folder access requests")
            .clone()
    }
}

#[async_trait]
impl FolderAccessHook for RecordingFolderAccess {
    async fn request(&self, request: FolderAccessRequest) -> Result<bool, String> {
        self.requests
            .lock()
            .expect("folder access requests")
            .push(request);
        Ok(self.allowed)
    }
}

#[derive(Default)]
pub(crate) struct RecordingDesktop {
    clipboard_writes: Mutex<Vec<String>>,
    notifications: Mutex<Vec<(String, String)>>,
}

impl RecordingDesktop {
    pub(crate) fn clipboard_writes(&self) -> Vec<String> {
        self.clipboard_writes
            .lock()
            .expect("clipboard writes")
            .clone()
    }

    pub(crate) fn notifications(&self) -> Vec<(String, String)> {
        self.notifications.lock().expect("notifications").clone()
    }
}

#[async_trait]
impl DesktopServices for RecordingDesktop {
    async fn write_clipboard(&self, text: String) -> Result<(), String> {
        self.clipboard_writes
            .lock()
            .expect("clipboard writes")
            .push(text);
        Ok(())
    }

    async fn notify(&self, title: String, body: String) -> Result<(), String> {
        self.notifications
            .lock()
            .expect("notifications")
            .push((title, body));
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct ScriptedResponse {
    status: StatusCode,
    body: Value,
    /// When set, served verbatim as `text/plain` instead of `body` as JSON.
    text_body: Option<String>,
    /// When set, served verbatim as `text/event-stream` — for hand-written
    /// SSE exotica the synthetic splitters cannot express.
    sse_body: Option<String>,
    delay: Duration,
}

impl ScriptedResponse {
    fn into_response(self) -> Response<Body> {
        if let Some(sse) = self.sse_body {
            return sse_response(sse);
        }
        match self.text_body {
            Some(text) => Response::builder()
                .status(self.status)
                .header(hyper::header::CONTENT_TYPE, "text/plain")
                .body(Body::from(text))
                .expect("build scripted text response"),
            None => json_response(self.status, self.body),
        }
    }
}

impl ScriptedResponse {
    pub(crate) fn completion(content: impl Into<String>) -> Self {
        Self {
            status: StatusCode::OK,
            body: serde_json::json!({
                "content": content.into(),
                "stop": true,
                "slot_id": 0,
                "tokens_evaluated": 1,
                "tokens_predicted": 1
            }),
            text_body: None,
            sse_body: None,
            delay: Duration::ZERO,
        }
    }

    /// OpenAI chat-completions envelope.
    pub(crate) fn chat_completion(content: impl Into<String>) -> Self {
        Self::chat_envelope(content, None)
    }

    pub(crate) fn chat_completion_with_reasoning(
        content: impl Into<String>,
        reasoning: impl Into<String>,
    ) -> Self {
        Self::chat_envelope(content, Some(reasoning.into()))
    }

    fn chat_envelope(content: impl Into<String>, reasoning: Option<String>) -> Self {
        let mut message = serde_json::json!({
            "role": "assistant",
            "content": content.into(),
        });
        if let Some(reasoning) = reasoning {
            message["reasoning_content"] = serde_json::json!(reasoning);
        }
        Self {
            status: StatusCode::OK,
            body: serde_json::json!({
                "id": "chatcmpl-scripted",
                "object": "chat.completion",
                "model": "scripted-test-model",
                "choices": [{"index": 0, "message": message, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1}
            }),
            text_body: None,
            sse_body: None,
            delay: Duration::ZERO,
        }
    }

    pub(crate) fn http_error(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            body: serde_json::json!({"error": {"message": message.into()}}),
            text_body: None,
            sse_body: None,
            delay: Duration::ZERO,
        }
    }

    /// A plain-text error body, as the Local API Server's own auth gate
    /// returns. The transport tells this apart from a provider's JSON error.
    pub(crate) fn text_error(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            body: Value::Null,
            text_body: Some(message.into()),
            sse_body: None,
            delay: Duration::ZERO,
        }
    }

    /// A verbatim SSE body (served with 200 + `text/event-stream`).
    pub(crate) fn raw_sse(payload: impl Into<String>) -> Self {
        Self {
            status: StatusCode::OK,
            body: Value::Null,
            text_body: None,
            sse_body: Some(payload.into()),
            delay: Duration::ZERO,
        }
    }

    pub(crate) fn delayed(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }
}

pub(crate) struct ScriptedCompletionServer {
    address: SocketAddr,
    requests: Arc<Mutex<Vec<Value>>>,
    shutdown: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl ScriptedCompletionServer {
    pub(crate) async fn start(responses: Vec<ScriptedResponse>) -> Self {
        Self::start_with_props(responses, serde_json::json!({})).await
    }

    pub(crate) async fn start_with_props(responses: Vec<ScriptedResponse>, props: Value) -> Self {
        let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .expect("bind scripted completion server");
        listener
            .set_nonblocking(true)
            .expect("set scripted server nonblocking");
        let address = listener.local_addr().expect("scripted server address");
        let responses = Arc::new(tokio::sync::Mutex::new(VecDeque::from(responses)));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let service_responses = Arc::clone(&responses);
        let service_requests = Arc::clone(&requests);
        let make_service = make_service_fn(move |_| {
            let responses = Arc::clone(&service_responses);
            let requests = Arc::clone(&service_requests);
            let props = props.clone();
            async move {
                Ok::<_, Infallible>(service_fn(move |request| {
                    serve_completion(
                        request,
                        Arc::clone(&responses),
                        Arc::clone(&requests),
                        props.clone(),
                    )
                }))
            }
        });
        let server = Server::from_tcp(listener)
            .expect("build scripted server")
            .serve(make_service)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            });
        let task = tokio::spawn(async move {
            let _ = server.await;
        });
        tokio::task::yield_now().await;
        Self {
            address,
            requests,
            shutdown: Some(shutdown_tx),
            task,
        }
    }

    pub(crate) fn client(&self) -> LlamaServerClient {
        LlamaServerClient::new(&LlamaSessionTarget {
            port: i32::from(self.address.port()),
            api_key: String::new(),
            model_id: "scripted-test-model".into(),
            has_vision: false,
            backend: super::llm_client::LlamaBackend::Llamacpp,
        })
        .expect("create scripted llama client")
    }

    pub(crate) fn requests(&self) -> Vec<Value> {
        self.requests.lock().expect("scripted requests").clone()
    }
}

impl Drop for ScriptedCompletionServer {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        self.task.abort();
    }
}

/// OpenAI-compatible twin of [`ScriptedCompletionServer`].
///
/// Serves only `POST /v1/chat/completions`; every other path answers 404 so a
/// stray `/props` probe fails loudly instead of silently succeeding.
pub(crate) struct ScriptedChatServer {
    address: SocketAddr,
    requests: Arc<Mutex<Vec<Value>>>,
    shutdown: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl ScriptedChatServer {
    pub(crate) async fn start(responses: Vec<ScriptedResponse>) -> Self {
        let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .expect("bind scripted chat server");
        listener
            .set_nonblocking(true)
            .expect("set scripted chat server nonblocking");
        let address = listener.local_addr().expect("scripted chat server address");
        let responses = Arc::new(tokio::sync::Mutex::new(VecDeque::from(responses)));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let service_responses = Arc::clone(&responses);
        let service_requests = Arc::clone(&requests);
        let make_service = make_service_fn(move |_| {
            let responses = Arc::clone(&service_responses);
            let requests = Arc::clone(&service_requests);
            async move {
                Ok::<_, Infallible>(service_fn(move |request| {
                    serve_chat_completion(request, Arc::clone(&responses), Arc::clone(&requests))
                }))
            }
        });
        let server = Server::from_tcp(listener)
            .expect("build scripted chat server")
            .serve(make_service)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            });
        let task = tokio::spawn(async move {
            let _ = server.await;
        });
        tokio::task::yield_now().await;
        Self {
            address,
            requests,
            shutdown: Some(shutdown_tx),
            task,
        }
    }

    fn target(&self, json_schema: bool) -> OpenAiTarget {
        OpenAiTarget {
            kind: OpenAiTargetKind::LocalMlx,
            base_url: format!("http://127.0.0.1:{}/v1", self.address.port()),
            api_key: None,
            model_id: "scripted-test-model".into(),
            has_vision: false,
            context_window: None,
            json_schema,
        }
    }

    pub(crate) fn client(&self) -> OpenAiCompatibleClient {
        OpenAiCompatibleClient::new(self.target(true)).expect("create scripted chat client")
    }

    pub(crate) fn client_without_schema(&self) -> OpenAiCompatibleClient {
        OpenAiCompatibleClient::new(self.target(false)).expect("create scripted chat client")
    }

    pub(crate) fn requests(&self) -> Vec<Value> {
        self.requests
            .lock()
            .expect("scripted chat requests")
            .clone()
    }
}

impl Drop for ScriptedChatServer {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        self.task.abort();
    }
}

async fn serve_chat_completion(
    request: Request<Body>,
    responses: Arc<tokio::sync::Mutex<VecDeque<ScriptedResponse>>>,
    requests: Arc<Mutex<Vec<Value>>>,
) -> Result<Response<Body>, Infallible> {
    if request.method() != Method::POST || request.uri().path() != "/v1/chat/completions" {
        return Ok(json_response(
            StatusCode::NOT_FOUND,
            serde_json::json!({"error": {"message": "not found"}}),
        ));
    }
    let body = to_bytes(request.into_body()).await.unwrap_or_default();
    let parsed: Value = serde_json::from_slice(&body)
        .unwrap_or_else(|_| serde_json::json!({"invalidBody": String::from_utf8_lossy(&body)}));
    let wants_stream = parsed.get("stream").and_then(Value::as_bool) == Some(true);
    let include_usage = parsed
        .pointer("/stream_options/include_usage")
        .and_then(Value::as_bool)
        == Some(true);
    requests
        .lock()
        .expect("scripted chat requests")
        .push(parsed);
    let response = responses.lock().await.pop_front().unwrap_or_else(|| {
        ScriptedResponse::http_error(StatusCode::INTERNAL_SERVER_ERROR, "script exhausted")
    });
    if !response.delay.is_zero() {
        tokio::time::sleep(response.delay).await;
    }
    // Mirror OpenAI-compatible servers: a successful `stream: true` chat
    // completion answers with SSE chunks; the usage trailer (empty `choices`)
    // appears only when the request opted in via `stream_options`.
    if wants_stream
        && response.status == StatusCode::OK
        && response.text_body.is_none()
        && response.sse_body.is_none()
        && response.body.pointer("/choices/0/message").is_some()
    {
        return Ok(sse_chat_completion_response(response.body, include_usage));
    }
    Ok(response.into_response())
}

/// Splits a whole chat-completions envelope into a scripted SSE stream:
/// role-only delta, reasoning delta, two content halves, a finish chunk
/// (`"usage": null` on every one of those, as OpenAI sends), then optionally
/// the usage trailer with an empty `choices` array, and `[DONE]`.
fn sse_chat_completion_response(body: Value, include_usage: bool) -> Response<Body> {
    let model = body
        .get("model")
        .cloned()
        .unwrap_or_else(|| serde_json::json!("scripted-test-model"));
    let message = body
        .pointer("/choices/0/message")
        .cloned()
        .unwrap_or_default();
    let content = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let reasoning = message
        .get("reasoning_content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let finish = body
        .pointer("/choices/0/finish_reason")
        .cloned()
        .unwrap_or_else(|| serde_json::json!("stop"));
    let chunk = |delta: Value, finish_reason: Value| {
        serde_json::json!({
            "id": "chatcmpl-scripted",
            "object": "chat.completion.chunk",
            "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
            "usage": Value::Null,
        })
    };
    let mut events = vec![chunk(serde_json::json!({"role": "assistant"}), Value::Null)];
    if !reasoning.is_empty() {
        events.push(chunk(
            serde_json::json!({"reasoning_content": reasoning}),
            Value::Null,
        ));
    }
    let split_at = content
        .char_indices()
        .nth(content.chars().count() / 2)
        .map_or(content.len(), |(index, _)| index);
    let (head, tail) = content.split_at(split_at);
    for part in [head, tail] {
        if !part.is_empty() {
            events.push(chunk(serde_json::json!({"content": part}), Value::Null));
        }
    }
    events.push(chunk(serde_json::json!({}), finish));
    if include_usage {
        if let Some(usage) = body.get("usage").filter(|usage| !usage.is_null()) {
            events.push(serde_json::json!({
                "id": "chatcmpl-scripted",
                "object": "chat.completion.chunk",
                "model": model,
                "choices": [],
                "usage": usage,
            }));
        }
    }
    let payload = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .chain(std::iter::once("data: [DONE]\n\n".to_owned()))
        .collect::<String>();
    sse_response(payload)
}

fn sse_response(payload: String) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header(hyper::header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(payload))
        .expect("build scripted SSE response")
}

async fn serve_completion(
    request: Request<Body>,
    responses: Arc<tokio::sync::Mutex<VecDeque<ScriptedResponse>>>,
    requests: Arc<Mutex<Vec<Value>>>,
    props: Value,
) -> Result<Response<Body>, Infallible> {
    if request.method() == Method::GET && request.uri().path() == "/props" {
        return Ok(json_response(StatusCode::OK, props));
    }
    if request.method() != Method::POST || request.uri().path() != "/completion" {
        return Ok(json_response(
            StatusCode::NOT_FOUND,
            serde_json::json!({"error": {"message": "not found"}}),
        ));
    }
    let body = to_bytes(request.into_body()).await.unwrap_or_default();
    let parsed: Value = serde_json::from_slice(&body)
        .unwrap_or_else(|_| serde_json::json!({"invalidBody": String::from_utf8_lossy(&body)}));
    let wants_stream = parsed.get("stream").and_then(Value::as_bool) == Some(true);
    requests.lock().expect("scripted requests").push(parsed);
    let response = responses.lock().await.pop_front().unwrap_or_else(|| {
        ScriptedResponse::http_error(StatusCode::INTERNAL_SERVER_ERROR, "script exhausted")
    });
    if !response.delay.is_zero() {
        tokio::time::sleep(response.delay).await;
    }
    // Mirror llama.cpp: a successful `stream: true` completion answers with
    // SSE — partial content chunks, then a final `stop: true` envelope whose
    // text fields are empty (the client accumulates the deltas).
    if wants_stream
        && response.status == StatusCode::OK
        && response.text_body.is_none()
        && response.body.get("content").is_some()
    {
        return Ok(sse_completion_response(response.body));
    }
    Ok(response.into_response())
}

fn sse_completion_response(body: Value) -> Response<Body> {
    let content = body
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let reasoning = body
        .get("reasoning_content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let split_at = content
        .char_indices()
        .nth(content.chars().count() / 2)
        .map_or(content.len(), |(index, _)| index);
    let (head, tail) = content.split_at(split_at);
    let mut events = Vec::new();
    if !reasoning.is_empty() {
        events.push(serde_json::json!({
            "content": "", "reasoning_content": reasoning, "stop": false
        }));
    }
    for chunk in [head, tail] {
        if !chunk.is_empty() {
            events.push(serde_json::json!({"content": chunk, "stop": false}));
        }
    }
    let mut final_event = body;
    final_event["content"] = Value::String(String::new());
    final_event["reasoning_content"] = Value::String(String::new());
    final_event["stop"] = Value::Bool(true);
    events.push(final_event);
    let payload = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect::<String>();
    Response::builder()
        .status(StatusCode::OK)
        .header(hyper::header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from(payload))
        .expect("build scripted SSE response")
}

fn json_response(status: StatusCode, body: Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(hyper::header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("build scripted response")
}

pub(crate) fn collect_event(events: &mut Vec<AgentEvent>, event: AgentEvent) -> Result<(), String> {
    events.push(event);
    Ok(())
}
