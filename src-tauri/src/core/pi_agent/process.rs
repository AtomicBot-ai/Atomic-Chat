use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, watch},
};

use super::{
    profile::{self, StartRequest},
    protocol,
};
use crate::core::{
    process_env::sanitize_tokio_command,
    process_tree::{configure_process_tree, terminate_process_tree},
};

struct Activity {
    streaming: bool,
    approvals: HashMap<String, Value>,
    last_used: Instant,
}

type Reply = oneshot::Sender<Result<Value, String>>;

pub struct Session {
    pub request: StartRequest,
    dispatch: Option<super::bridge::Dispatch>,
    connector_turn: Mutex<tokio_util::sync::CancellationToken>,
    pub info: Mutex<Value>,
    channel: Mutex<Channel<Value>>,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, Reply>>,
    activity: Mutex<Activity>,
    shutdown: watch::Sender<bool>,
    finished: watch::Receiver<bool>,
}

impl Session {
    pub fn exited(&self) -> bool {
        *self.finished.borrow()
    }

    pub fn idle_for(&self) -> Option<Duration> {
        let state = self.activity.lock().unwrap();
        (!state.streaming && state.approvals.is_empty() && self.pending.lock().unwrap().is_empty())
            .then(|| state.last_used.elapsed())
    }

    pub fn reconnect(&self, channel: Channel<Value>) {
        let mut state = self.activity.lock().unwrap();
        state.last_used = Instant::now();
        for request in state.approvals.values() {
            let _ = channel.send(request.clone());
        }
        *self.channel.lock().unwrap() = channel;
    }

    async fn send(&self, value: Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        line.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .as_mut()
            .ok_or("pi has exited")?
            .write_all(&line)
            .await
            .map_err(|_| "pi stdin closed".into())
    }

    pub async fn call(&self, mut command: Value, timeout: Duration) -> Result<Value, String> {
        if command["type"] == "abort" {
            self.connector_turn.lock().unwrap().cancel();
        }
        let id = uuid::Uuid::new_v4().to_string();
        command["id"] = id.clone().into();
        let (reply, result) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), reply);
        self.activity.lock().unwrap().last_used = Instant::now();
        let response = tokio::time::timeout(timeout, async {
            self.send(command).await?;
            result.await.map_err(|_| "pi has exited".to_string())?
        })
        .await
        .unwrap_or_else(|_| Err("pi RPC timed out".into()));
        self.pending.lock().unwrap().remove(&id);
        response
    }

    pub async fn respond(&self, value: Value) -> Result<(), String> {
        let id = value["id"].as_str().ok_or("Missing pi UI request id")?;
        if value["type"] != "extension_ui_response"
            || self.activity.lock().unwrap().approvals.remove(id).is_none()
        {
            return Err("Unknown pi UI request".into());
        }
        self.send(value).await
    }

    fn receive(self: &Arc<Self>, event: Value) {
        if event["type"] == "extension_ui_request"
            && event["method"] == "input"
            && event["title"] == "atomic-chat-mcp-v1"
        {
            let session = self.clone();
            let token = self.connector_turn.lock().unwrap().child_token();
            tokio::spawn(async move {
                let result = session.dispatch_connector(&event, token).await;
                let payload = match result {
                    Ok(value) => value,
                    Err(error) => json!({"isError":true,"content":[{"type":"text","text":error}]}),
                };
                let _ = session.send(json!({"type":"extension_ui_response","id":event["id"],"value":payload.to_string()})).await;
            });
            return;
        }
        let kind = event["type"].as_str().unwrap_or_default();
        if kind == "response" {
            if let Some(reply) = event["id"]
                .as_str()
                .and_then(|id| self.pending.lock().unwrap().remove(id))
            {
                let result = if event["success"] == true {
                    Ok(event["data"].clone())
                } else {
                    Err(event["error"]
                        .as_str()
                        .unwrap_or("pi RPC failed")
                        .to_owned())
                };
                let _ = reply.send(result);
            }
            return;
        }
        let dialog = kind == "extension_ui_request"
            && matches!(
                event["method"].as_str(),
                Some("select" | "input" | "confirm" | "editor")
            );
        {
            let mut state = self.activity.lock().unwrap();
            state.last_used = Instant::now();
            match kind {
                "agent_start" => {
                    *self.connector_turn.lock().unwrap() =
                        tokio_util::sync::CancellationToken::new();
                    state.streaming = true;
                }
                "agent_settled" => {
                    self.connector_turn.lock().unwrap().cancel();
                    state.streaming = false;
                    state.approvals.clear();
                }
                _ if dialog => {
                    if let Some(id) = event["id"].as_str() {
                        state.approvals.insert(id.to_owned(), event.clone());
                    }
                }
                _ => {}
            }
        }
        if self.channel.lock().unwrap().send(event).is_err() && dialog {
            let _ = self.shutdown.send(true);
        }
    }

    async fn dispatch_connector(
        &self,
        event: &Value,
        token: tokio_util::sync::CancellationToken,
    ) -> Result<Value, String> {
        let call: Value = serde_json::from_str(
            event["placeholder"]
                .as_str()
                .ok_or("Missing connector arguments")?,
        )
        .map_err(|e| e.to_string())?;
        let alias = call["alias"].as_str().ok_or("Missing connector name")?;
        let tool = self
            .request
            .connectors
            .iter()
            .find(|tool| tool.alias() == alias)
            .ok_or("Connector is unavailable for this thread")?;
        let args = call["arguments"]
            .as_object()
            .ok_or("Expected connector arguments object")?;
        self.dispatch
            .as_ref()
            .ok_or("Connector host is unavailable")?(tool.clone(), args.clone(), token)
        .await
    }

    pub async fn stop(&self) {
        self.connector_turn.lock().unwrap().cancel();
        let mut finished = self.finished.clone();
        let _ = self.shutdown.send(true);
        let _ = finished.wait_for(|finished| *finished).await;
    }
}

pub async fn launch(
    binary: PathBuf,
    dir: PathBuf,
    request: StartRequest,
    channel: Channel<Value>,
    dispatch: Option<super::bridge::Dispatch>,
) -> Result<Arc<Session>, String> {
    let shell = if cfg!(windows) && !windows_git_bash() {
        "powershell"
    } else {
        "bash"
    };
    let resume = profile::prepare(&dir, &request, shell)?;
    let dir = dir.canonicalize().map_err(|e| e.to_string())?;
    let mut command = Command::new(&binary);
    command
        .current_dir(
            request
                .cwd
                .canonicalize()
                .map_err(|_| "Agent workspace is unavailable")?,
        )
        .args([
            "--mode",
            "rpc",
            "--provider",
            "atomic",
            "--model",
            &request.model,
            "-ne",
            "-ns",
            "-np",
            "--no-mcp",
            "--no-approve",
            "--offline",
            "-e",
        ])
        .arg(dir.join("atomic-approval.ts"))
        .arg("--session-dir")
        .arg(dir.join("sessions"))
        .env("ATOMIC_PI_INTEGRATIONS", dir.join("integrations.json"))
        .env("PI_CODING_AGENT_DIR", &dir)
        .env("PI_OFFLINE", "1")
        .env("PI_SKIP_VERSION_CHECK", "1")
        .env("PI_TELEMETRY", "0")
        .env(
            "ATOMIC_PI_API_KEY",
            request
                .api_key
                .as_deref()
                .filter(|key| !key.is_empty())
                .unwrap_or("atomic"),
        )
        .env("NO_PROXY", "127.0.0.1,localhost,::1")
        .env("no_proxy", "127.0.0.1,localhost,::1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = resume {
        command.arg("--session").arg(path);
    }
    if let Some(level) = &request.thinking_level {
        command.arg("--thinking").arg(level);
    }
    crate::core::system::commands::apply_login_path(command.as_std_mut());
    crate::core::system::commands::apply_runtime_path(command.as_std_mut());
    sanitize_tokio_command(&mut command);
    configure_process_tree(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start pi: {e}"))?;
    let pid = child.id();
    let journal = super::journal::record(&dir, pid)?;
    let stdout = child.stdout.take().ok_or("Missing pi stdout")?;
    let mut stderr = child.stderr.take().ok_or("Missing pi stderr")?;
    let (shutdown, mut stopping) = watch::channel(false);
    let (done, finished) = watch::channel(false);
    let session = Arc::new(Session {
        dispatch,
        connector_turn: Mutex::new(tokio_util::sync::CancellationToken::new()),
        request,
        info: Mutex::new(Value::Null),
        channel: Mutex::new(channel),
        stdin: tokio::sync::Mutex::new(child.stdin.take()),
        pending: Mutex::new(HashMap::new()),
        activity: Mutex::new(Activity {
            streaming: false,
            approvals: HashMap::new(),
            last_used: Instant::now(),
        }),
        shutdown,
        finished,
    });
    let (ready, loaded) = oneshot::channel();
    let output = session.clone();
    let reader = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut ready = Some(ready);
        while let Ok(Some(event)) = protocol::read_record(&mut reader).await {
            if event["type"] == "extension_ui_request"
                && event["method"] == "notify"
                && event["message"] == "atomic-approval-ready-v1"
            {
                if let Some(tx) = ready.take() {
                    let _ = tx.send(());
                }
            } else {
                output.receive(event);
            }
        }
        let _ = output.shutdown.send(true);
    });
    let tail = Arc::new(Mutex::new(VecDeque::new()));
    let log = tail.clone();
    let errors = tokio::spawn(async move {
        let mut buf = [0; 1024];
        while let Ok(n) = stderr.read(&mut buf).await {
            if n == 0 {
                break;
            }
            let mut bytes = log.lock().unwrap();
            bytes.extend(&buf[..n]);
            while bytes.len() > 4096 {
                bytes.pop_front();
            }
        }
    });
    let running = session.clone();
    tokio::spawn(async move {
        let status = tokio::select! {
            status = child.wait() => status.ok(),
            _ = stopping.changed() => close_child(&mut child, &running, pid).await,
        };
        let _ = std::fs::remove_file(journal);
        running.connector_turn.lock().unwrap().cancel();
        reader.abort();
        errors.abort();
        running.pending.lock().unwrap().clear();
        let mut stderr =
            String::from_utf8_lossy(tail.lock().unwrap().make_contiguous()).into_owned();
        if let Some(key) = running
            .request
            .api_key
            .as_deref()
            .filter(|key| !key.is_empty())
        {
            stderr = stderr.replace(key, "[redacted]");
        }
        let _ =
            running.channel.lock().unwrap().send(
                json!({"type":"exit","code":status.and_then(|s| s.code()),"stderrTail":stderr}),
            );
        let _ = done.send(true);
    });
    let result = async {
        tokio::time::timeout(Duration::from_secs(12), loaded)
            .await
            .ok()
            .and_then(Result::ok)
            .ok_or("The pi approval extension did not start")?;
        let state = session
            .call(json!({"type":"get_state"}), Duration::from_secs(5))
            .await?;
        if state["model"]["provider"] != "atomic" || state["model"]["id"] != session.request.model {
            return Err("pi selected an unexpected model".into());
        }
        *session.info.lock().unwrap() =
            json!({"sessionFile":state["sessionFile"],"model":state["model"]["id"]});
        Ok::<(), String>(())
    }
    .await;
    if let Err(message) = result {
        session.stop().await;
        return Err(message);
    }
    Ok(session)
}

async fn close_child(
    child: &mut Child,
    session: &Session,
    pid: Option<u32>,
) -> Option<std::process::ExitStatus> {
    session.stdin.lock().await.take();
    if let Ok(result) = tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
        return result.ok();
    }
    terminate_process_tree(child, pid).await;
    child.try_wait().ok().flatten()
}

fn windows_git_bash() -> bool {
    ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .iter()
        .filter_map(std::env::var_os)
        .any(|root| {
            ["Git/bin/bash.exe", "Programs/Git/bin/bash.exe"]
                .iter()
                .any(|suffix| Path::new(&root).join(suffix).is_file())
        })
}
