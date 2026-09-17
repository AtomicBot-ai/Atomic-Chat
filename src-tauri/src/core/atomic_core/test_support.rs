//! A fake core: an HTTP server that answers the control API the way
//! `atomic-chat-core` does, so the supervisor and the client can be tested
//! without a Bun binary on the machine.
//!
//! It is deliberately a *router*, not a queue of canned responses: the code
//! under test decides the order of calls (register, then heartbeat, then
//! events), and a queue would encode that order into the test instead of
//! checking it. What the tests do control is the interesting state — the
//! version and protocol it announces, whether it still remembers a client, what
//! it pushes onto the event stream, and whether it is alive at all.

use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Method, Request, Response, Server, StatusCode};
use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::client::ControlClient;
use super::lock;

/// Mutable state the tests steer, shared with the request handler.
struct CoreState {
    token: String,
    version: Mutex<String>,
    protocol: Mutex<u32>,
    instance_id: Mutex<String>,
    pid: u32,
    /// Registered client ids. `unregister` and `forget_clients` empty it, which
    /// is how an expired registration is simulated.
    clients: Mutex<Vec<String>>,
    next_client: AtomicU64,
    last_authorization: Mutex<Option<String>>,
    /// Cursors the relay asked to resume from, in order.
    event_cursors: Mutex<Vec<Option<String>>>,
    /// Open event streams. Each is a hyper body we can keep writing into.
    streams: tokio::sync::Mutex<Vec<hyper::body::Sender>>,
    seq: AtomicU64,
    /// When set, `/events` answers `resync` instead of replaying from a cursor.
    force_resync: Mutex<bool>,
    sessions: Mutex<Value>,
    /// Count a mutation before deliberately breaking its response body. This
    /// models the ambiguous failure where the core committed an operation but
    /// the client never received the acknowledgement.
    applied_mutations: AtomicU64,
}

pub(crate) struct FakeCore {
    address: SocketAddr,
    state: Arc<CoreState>,
    shutdown: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl FakeCore {
    pub(crate) async fn start() -> Self {
        let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .expect("bind fake core");
        listener
            .set_nonblocking(true)
            .expect("fake core nonblocking");
        let address = listener.local_addr().expect("fake core address");

        let state = Arc::new(CoreState {
            token: format!("fake-token-{}", address.port()),
            version: Mutex::new("9.9.9".to_string()),
            protocol: Mutex::new(super::client::CONTROL_PROTOCOL_VERSION),
            instance_id: Mutex::new("instance-a".to_string()),
            clients: Mutex::new(Vec::new()),
            // The lock this core publishes has to name a process that is really
            // alive, or every reader classifies it as stale. The test process is
            // the only one we can promise that about.
            pid: std::process::id(),
            next_client: AtomicU64::new(1),
            last_authorization: Mutex::new(None),
            event_cursors: Mutex::new(Vec::new()),
            streams: tokio::sync::Mutex::new(Vec::new()),
            seq: AtomicU64::new(0),
            force_resync: Mutex::new(false),
            sessions: Mutex::new(json!([])),
            applied_mutations: AtomicU64::new(0),
        });

        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let service_state = Arc::clone(&state);
        let make_service = make_service_fn(move |_| {
            let state = Arc::clone(&service_state);
            async move {
                Ok::<_, Infallible>(service_fn(move |request| {
                    serve(request, Arc::clone(&state))
                }))
            }
        });
        let server = Server::from_tcp(listener)
            .expect("build fake core server")
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
            state,
            shutdown: Some(shutdown_tx),
            task,
        }
    }

    pub(crate) fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.address.port())
    }

    pub(crate) fn token(&self) -> String {
        self.state.token.clone()
    }

    pub(crate) fn client(&self) -> ControlClient {
        ControlClient::new(self.base_url(), self.token()).expect("fake core client")
    }

    pub(crate) fn set_protocol(&self, protocol: u32) {
        *self.state.protocol.lock().unwrap() = protocol;
    }

    pub(crate) fn set_instance_id(&self, instance_id: &str) {
        *self.state.instance_id.lock().unwrap() = instance_id.to_string();
    }

    pub(crate) fn set_sessions(&self, sessions: Value) {
        *self.state.sessions.lock().unwrap() = sessions;
    }

    /// Answer the next `/events` request with `resync` — what a real core does
    /// when the cursor is older than its 1000-event ring, or from another
    /// instance entirely.
    pub(crate) fn demand_resync(&self, demand: bool) {
        *self.state.force_resync.lock().unwrap() = demand;
    }

    /// Drop every registration, as expiry does after three missed heartbeats.
    pub(crate) fn forget_clients(&self) {
        self.state.clients.lock().unwrap().clear();
    }

    pub(crate) fn registered_clients(&self) -> usize {
        self.state.clients.lock().unwrap().len()
    }

    pub(crate) fn applied_mutations(&self) -> u64 {
        self.state.applied_mutations.load(Ordering::SeqCst)
    }

    pub(crate) fn last_authorization(&self) -> Option<String> {
        self.state.last_authorization.lock().unwrap().clone()
    }

    pub(crate) fn event_cursors(&self) -> Vec<Option<String>> {
        self.state.event_cursors.lock().unwrap().clone()
    }

    /// Push an event to every open stream, with the next sequence number.
    pub(crate) async fn emit(&self, name: &str, payload: Value) {
        let seq = self.state.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let id = format!("{}:{seq}", self.state.instance_id.lock().unwrap());
        let frame = format!("id: {id}\nevent: {name}\ndata: {payload}\n\n");
        let mut streams = self.state.streams.lock().await;
        let mut alive = Vec::new();
        for mut sender in streams.drain(..) {
            if sender.send_data(frame.clone().into()).await.is_ok() {
                alive.push(sender);
            }
        }
        *streams = alive;
    }

    pub(crate) async fn open_stream_count(&self) -> usize {
        self.state.streams.lock().await.len()
    }

    /// Close every open event stream while staying up — a core that restarted
    /// its listener, or a connection dropped in between. The client should come
    /// back with its cursor rather than starting over.
    pub(crate) async fn drop_streams(&self) {
        self.state.streams.lock().await.clear();
    }

    /// Write the lock and token files a real owner publishes, so code that
    /// discovers the core through the filesystem finds this one.
    pub(crate) fn publish_lock(&self, data_folder: &std::path::Path) {
        let dir = lock::core_dir(data_folder);
        std::fs::create_dir_all(&dir).expect("create core dir");
        let record = json!({
            "instance_id": *self.state.instance_id.lock().unwrap(),
            "owner_scope": "app",
            "pid": self.state.pid,
            "process_start_id": "test:0",
            "owner_started_at": null,
            "protocol": *self.state.protocol.lock().unwrap(),
            "version": *self.state.version.lock().unwrap(),
            "data_folder": data_folder.to_string_lossy(),
            "control_host": "127.0.0.1",
            "control_port": self.address.port(),
            "state": "ready",
            "acquired_at": "2026-09-16T00:00:00.000Z",
        });
        std::fs::write(
            lock::instance_lock_path(data_folder),
            serde_json::to_string_pretty(&record).unwrap(),
        )
        .expect("write lock");
        std::fs::write(
            lock::control_token_path(data_folder),
            format!("{}\n", self.state.token),
        )
        .expect("write token");
    }

    /// Stop answering, as a core that died does. Open streams end.
    pub(crate) async fn stop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        self.state.streams.lock().await.clear();
        tokio::task::yield_now().await;
    }
}

impl Drop for FakeCore {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        self.task.abort();
    }
}

fn json_response(status: StatusCode, body: Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(hyper::header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("build fake core response")
}

fn error_response(status: StatusCode, code: &str, message: &str) -> Response<Body> {
    json_response(
        status,
        json!({ "error": { "code": code, "message": message } }),
    )
}

async fn serve(
    request: Request<Body>,
    state: Arc<CoreState>,
) -> Result<Response<Body>, Infallible> {
    let authorization = request
        .headers()
        .get(hyper::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    *state.last_authorization.lock().unwrap() = authorization.clone();

    if authorization.as_deref() != Some(&format!("Bearer {}", state.token)) {
        return Ok(error_response(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "The control API needs the control token.",
        ));
    }

    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let query = request.uri().query().unwrap_or("").to_string();
    let Some(route) = path.strip_prefix(super::client::CONTROL_API_PREFIX) else {
        return Ok(error_response(
            StatusCode::NOT_FOUND,
            "INVALID_ARGUMENT",
            "No such control route.",
        ));
    };

    Ok(match (&method, route) {
        (&Method::GET, "/health") => json_response(StatusCode::OK, health(&state)),
        (&Method::GET, "/snapshot") => json_response(StatusCode::OK, snapshot(&state)),
        (&Method::GET, "/sessions") => json_response(
            StatusCode::OK,
            json!({ "sessions": *state.sessions.lock().unwrap() }),
        ),
        (
            &Method::POST | &Method::PUT | &Method::PATCH | &Method::DELETE,
            "/test/apply-then-drop-response",
        ) => {
            state.applied_mutations.fetch_add(1, Ordering::SeqCst);
            let (sender, body) = Body::channel();
            sender.abort();
            Response::builder()
                .status(StatusCode::OK)
                .header(hyper::header::CONTENT_TYPE, "application/json")
                .body(body)
                .expect("build broken fake response")
        }
        (&Method::POST, "/clients") => {
            let id = format!(
                "client-{}",
                state.next_client.fetch_add(1, Ordering::SeqCst)
            );
            state.clients.lock().unwrap().push(id.clone());
            json_response(
                StatusCode::CREATED,
                json!({
                    "client": { "id": id, "name": "atomic-chat-app", "pid": 1, "registered_at": 0, "last_seen": 0 },
                    "heartbeat_interval_ms": 15_000,
                    "snapshot": snapshot(&state),
                }),
            )
        }
        (&Method::GET, "/events") => return Ok(events(&state, &query).await),
        _ => {
            if let Some(id) = route.strip_prefix("/clients/") {
                let id = id.trim_end_matches("/heartbeat");
                let known = state.clients.lock().unwrap().iter().any(|c| c == id);
                if method == Method::DELETE {
                    state.clients.lock().unwrap().retain(|c| c != id);
                    return Ok(json_response(StatusCode::OK, json!({ "ok": true })));
                }
                return Ok(if known {
                    json_response(StatusCode::OK, json!({ "ok": true }))
                } else {
                    error_response(
                        StatusCode::GONE,
                        "CORE_NOT_RUNNING",
                        "This client registration has expired; register again.",
                    )
                });
            }
            error_response(
                StatusCode::NOT_FOUND,
                "INVALID_ARGUMENT",
                "No such control route.",
            )
        }
    })
}

fn health(state: &CoreState) -> Value {
    json!({
        "ok": true,
        "pid": state.pid,
        "version": *state.version.lock().unwrap(),
        "owner_scope": "app",
        "instance_id": *state.instance_id.lock().unwrap(),
        "protocol": *state.protocol.lock().unwrap(),
        "dataFolder": "/fake",
        "uptime_ms": 1,
    })
}

fn snapshot(state: &CoreState) -> Value {
    json!({
        "instance_id": *state.instance_id.lock().unwrap(),
        "protocol": *state.protocol.lock().unwrap(),
        "version": *state.version.lock().unwrap(),
        "pid": state.pid,
        "data_folder": "/fake",
        "started_at": 0,
        "uptime_ms": 1,
        "cursor": format!("{}:{}", state.instance_id.lock().unwrap(), state.seq.load(Ordering::SeqCst)),
        "sessions": *state.sessions.lock().unwrap(),
        "server": { "running": false },
        "clients": [],
        "downloads": [],
    })
}

async fn events(state: &Arc<CoreState>, query: &str) -> Response<Body> {
    let cursor = query
        .split('&')
        .find_map(|pair| pair.strip_prefix("cursor="))
        .map(|c| c.to_string());
    state.event_cursors.lock().unwrap().push(cursor.clone());

    let (mut sender, body) = Body::channel();
    let resync = *state.force_resync.lock().unwrap() || cursor.is_none();
    if resync {
        let reason = if cursor.is_some() {
            "cursor-expired"
        } else {
            "no-cursor"
        };
        let frame = format!(
            "id: {}:{}\nevent: resync\ndata: {{\"reason\":\"{reason}\"}}\n\n",
            state.instance_id.lock().unwrap(),
            state.seq.load(Ordering::SeqCst)
        );
        let _ = sender.send_data(frame.into()).await;
    }
    state.streams.lock().await.push(sender);

    Response::builder()
        .status(StatusCode::OK)
        .header(hyper::header::CONTENT_TYPE, "text/event-stream")
        .header(hyper::header::CACHE_CONTROL, "no-store")
        .body(body)
        .expect("build fake core event stream")
}
