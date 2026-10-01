//! Thin, credential-free Tauri bridge to the core-owned Claude Code runtime.
//! The core supervises the official executable; this layer only relays IPC/SSE
//! and cancels its HTTP request when the user stops or the app exits.
use crate::core::atomic_core::{client::CoreError, commands::AtomicCoreClient, relay::SseParser};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{ipc::Channel, AppHandle, Manager, Runtime};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    installed: bool,
    logged_in: bool,
    subscription: bool,
    plan: Option<String>,
    version: Option<String>,
    error: Option<String>,
    models: Vec<ClaudeModel>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct ClaudeModel {
    id: String,
    model: String,
    name: String,
    description: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeRequest {
    request_id: String,
    model: String,
    prompt: String,
    system: Option<String>,
    session_id: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeResult {
    session_id: String,
    text: String,
    input_tokens: u64,
    output_tokens: u64,
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClaudeEvent {
    Ready,
    Delta { text: String },
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum CoreEvent {
    Ready,
    Delta { text: String },
    Result { result: ClaudeResult },
    Error { message: String },
}

fn message(error: CoreError) -> String {
    if error.message.contains("No such control route") {
        "This Atomic Chat core does not yet support Claude subscriptions. Install a core release containing the Claude Code runtime.".into()
    } else {
        error.message
    }
}
fn client<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::State<'_, AtomicCoreClient>, String> {
    app.try_state::<AtomicCoreClient>()
        .filter(|state| state.is_enabled())
        .ok_or_else(|| "The Atomic Chat core is not running.".into())
}
#[tauri::command]
pub async fn atomic_claude_status<R: Runtime>(app: AppHandle<R>) -> Result<ClaudeStatus, String> {
    let value = client(&app)?
        .call("GET", "/claude-code/status", None)
        .await
        .map_err(message)?;
    serde_json::from_value(value).map_err(|_| "Unexpected Claude Code status from the core.".into())
}

static RUNS: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
fn runs() -> &'static Mutex<HashMap<String, CancellationToken>> {
    RUNS.get_or_init(Mutex::default)
}
struct RunGuard(String);
impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Ok(mut runs) = runs().lock() {
            runs.remove(&self.0);
        }
    }
}
fn register(id: &str) -> Result<(CancellationToken, RunGuard), String> {
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid Claude request ID")?;
    let token = CancellationToken::new();
    let mut active = runs()
        .lock()
        .map_err(|_| "Claude request state unavailable")?;
    if active.contains_key(id) {
        return Err("Claude request is already running.".into());
    }
    active.insert(id.to_owned(), token.clone());
    Ok((token, RunGuard(id.to_owned())))
}
#[tauri::command]
pub fn atomic_claude_cancel(request_id: String) -> Result<(), String> {
    if let Some(token) = runs()
        .lock()
        .map_err(|_| "Claude request state unavailable")?
        .get(&request_id)
    {
        token.cancel();
    }
    Ok(())
}
pub async fn shutdown() {
    if let Ok(active) = runs().lock() {
        for token in active.values() {
            token.cancel();
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        while !runs()
            .lock()
            .map(|active| active.is_empty())
            .unwrap_or(true)
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
}
#[tauri::command]
pub async fn atomic_claude_login<R: Runtime>(
    app: AppHandle<R>,
    request_id: Option<String>,
    events: Channel<ClaudeEvent>,
) -> Result<(), String> {
    let id = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let (token, _guard) = register(&id)?;
    events
        .send(ClaudeEvent::Ready)
        .map_err(|_| "Sign-in window disconnected")?;
    let client = client(&app)?;
    tokio::select! {
        biased;
        _ = token.cancelled() => Err("Claude Code sign-in cancelled.".into()),
        result = client.call("POST", "/claude-code/login", None) => result.map(|_| ()).map_err(message),
    }
}
#[tauri::command]
pub async fn atomic_claude_chat<R: Runtime>(
    app: AppHandle<R>,
    request: ClaudeRequest,
    events: Channel<ClaudeEvent>,
) -> Result<ClaudeResult, String> {
    let (token, _guard) = register(&request.request_id)?;
    // Emit before opening HTTP so a stop arriving before the core responds is
    // still delivered. The matching token is already registered at this point.
    events
        .send(ClaudeEvent::Ready)
        .map_err(|_| "Chat window disconnected")?;
    let client = client(&app)?;
    let work = async {
        let body = serde_json::to_value(request).map_err(|e| e.to_string())?;
        let response = client.claude_chat(body).await.map_err(message)?;
        let mut stream = response.bytes_stream();
        let mut parser = SseParser::default();
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|_| "Claude Code stream disconnected. Please retry.")?;
            for frame in parser.push(&bytes).map_err(message)? {
                let event: CoreEvent = serde_json::from_str(&frame.data)
                    .map_err(|_| "Invalid Claude Code event from the core.")?;
                match event {
                    CoreEvent::Ready => {}
                    CoreEvent::Delta { text } => events
                        .send(ClaudeEvent::Delta { text })
                        .map_err(|_| "Chat window disconnected")?,
                    CoreEvent::Result { result } => return Ok(result),
                    CoreEvent::Error { message } => return Err(message),
                }
            }
        }
        Err("Claude Code ended before completing the response. Please retry.".into())
    };
    tokio::select! {
        biased;
        _ = token.cancelled() => Err("Claude Code response cancelled.".into()),
        result = work => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::IpcTestHarness;
    use serde_json::{json, Value};

    #[test]
    fn stop_dispatch_uses_camel_case_and_cancels_only_its_request() {
        let a = uuid::Uuid::new_v4().to_string();
        let b = uuid::Uuid::new_v4().to_string();
        let (first, _a) = register(&a).unwrap();
        let (second, _b) = register(&b).unwrap();
        let harness = IpcTestHarness::new(|builder| {
            builder.invoke_handler(tauri::generate_handler![atomic_claude_cancel])
        });
        let result: Value = harness
            .invoke("atomic_claude_cancel", json!({"requestId":a}))
            .unwrap();
        assert_eq!(result, Value::Null);
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        assert!(harness
            .invoke::<Value>("atomic_claude_cancel", json!({"wrongField":b}))
            .is_err());
    }
    #[test]
    fn request_registry_rejects_duplicates_and_releases_on_drop() {
        let id = uuid::Uuid::new_v4().to_string();
        let (_, guard) = register(&id).unwrap();
        assert!(register(&id).is_err());
        drop(guard);
        assert!(register(&id).is_ok());
        assert!(register("not-a-uuid").is_err());
    }
    #[test]
    fn status_dispatch_reports_a_stopped_core_without_reading_cli_credentials() {
        let harness = IpcTestHarness::new(|builder| {
            builder.invoke_handler(tauri::generate_handler![atomic_claude_status])
        });
        assert_eq!(
            harness
                .invoke::<Value>("atomic_claude_status", json!({}))
                .unwrap_err(),
            json!("The Atomic Chat core is not running.")
        );
    }
    #[test]
    #[ignore = "writes the cross-repository fixture directory explicitly supplied by the developer"]
    fn dump_claude_code_wire_fixtures() {
        let dir = std::path::PathBuf::from(
            std::env::var("ATOMIC_CLAUDE_FIXTURE_DIR").expect("set fixture output directory"),
        );
        std::fs::create_dir_all(&dir).unwrap();
        let id = "684286da-7283-4e22-9436-c6f6c3c03015";
        let values = [
            (
                "request",
                serde_json::to_value(ClaudeRequest {
                    request_id: id.into(),
                    model: "claude-fable-5-1[1m]".into(),
                    prompt: "Say OK".into(),
                    system: Some("Be concise.".into()),
                    session_id: None,
                })
                .unwrap(),
            ),
            (
                "result",
                serde_json::to_value(ClaudeResult {
                    session_id: id.into(),
                    text: "OK".into(),
                    input_tokens: 17,
                    output_tokens: 3,
                })
                .unwrap(),
            ),
            (
                "status",
                serde_json::to_value(ClaudeStatus {
                    installed: true,
                    logged_in: true,
                    subscription: true,
                    plan: Some("max".into()),
                    version: Some("2.1.281 (fixture)".into()),
                    error: None,
                    models: vec![ClaudeModel {
                        id: "claude-fable-5-1[1m]".into(),
                        model: "claude-fable-5-1[1m]".into(),
                        name: "Claude Fable 5.1 · 1M".into(),
                        description: "Fable fixture".into(),
                    }],
                })
                .unwrap(),
            ),
            (
                "delta",
                serde_json::to_value(ClaudeEvent::Delta { text: "OK".into() }).unwrap(),
            ),
        ];
        let output = std::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .output()
            .unwrap();
        assert!(output.status.success());
        let commit = String::from_utf8(output.stdout).unwrap().trim().to_string();
        let source = json!({"file":"src-tauri/src/core/system/claude_chat.rs", "commit":commit});
        let names: Vec<_> = values.iter().map(|(name, _)| *name).collect();
        let index = json!({"source":source,"comparator":"semantic JSON equality; status model list filtered to the fixture model", "cases":names});
        std::fs::write(
            dir.join("index.json"),
            serde_json::to_string_pretty(&index).unwrap() + "\n",
        )
        .unwrap();
        for (name, value) in values {
            let fixture = json!({"name":name,"source":source,"comparator":"semantic JSON equality", "input":value,"expected":value});
            std::fs::write(
                dir.join(format!("{name}.json")),
                serde_json::to_string_pretty(&fixture).unwrap() + "\n",
            )
            .unwrap();
        }
    }
}
