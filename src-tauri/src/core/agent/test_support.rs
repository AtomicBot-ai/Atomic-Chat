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
use super::skills::SkillRegistry;
use super::tools::{ApprovalHook, DesktopServices, FolderAccessHook};
use super::types::{AgentEvent, ApprovalDecision, ApprovalRequest, FolderAccessRequest};

pub(crate) struct TestWorkspace {
    path: PathBuf,
}

impl TestWorkspace {
    pub(crate) fn new() -> Self {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target").join("agent-test-workspaces")
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
    delay: Duration,
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
            delay: Duration::ZERO,
        }
    }

    pub(crate) fn http_error(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            body: serde_json::json!({"error": {"message": message.into()}}),
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
    let parsed = serde_json::from_slice(&body)
        .unwrap_or_else(|_| serde_json::json!({"invalidBody": String::from_utf8_lossy(&body)}));
    requests.lock().expect("scripted requests").push(parsed);
    let response = responses.lock().await.pop_front().unwrap_or_else(|| {
        ScriptedResponse::http_error(StatusCode::INTERNAL_SERVER_ERROR, "script exhausted")
    });
    if !response.delay.is_zero() {
        tokio::time::sleep(response.delay).await;
    }
    Ok(json_response(response.status, response.body))
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
