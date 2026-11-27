mod bridge;
#[cfg(test)]
mod integration_tests;
mod journal;
mod process;
mod profile;
mod project;
mod protocol;

use crate::core::app::commands::get_jan_data_folder_path;
use process::Session;
use profile::{profile_dir, StartRequest};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::{ipc::Channel, AppHandle, Manager, Runtime, State};
use tokio::sync::Mutex;

#[derive(Default, Clone)]
pub struct PiAgentState(Arc<Mutex<HashMap<String, Arc<Session>>>>);
const IDLE: Duration = Duration::from_secs(15 * 60);

fn binary<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let executable = if cfg!(windows) { "pi.exe" } else { "pi" };
    let resource = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("resources/pi").join(executable));
    let dev = cfg!(debug_assertions).then(|| {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/pi")
            .join(executable)
    });
    resource
        .into_iter()
        .chain(dev)
        .find(|path| path.metadata().is_ok_and(|m| m.is_file() && m.len() > 0))
}

#[tauri::command]
pub fn pi_agent_status<R: Runtime>(app: AppHandle<R>) -> Value {
    let package: Value =
        serde_json::from_str(include_str!("../../../../package.json")).expect("valid app manifest");
    let version = &package["piAgent"]["version"];
    json!({"available":binary(&app).is_some(), "version":version})
}

#[tauri::command]
pub async fn pi_agent_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PiAgentState>,
    mut request: StartRequest,
    on_event: Channel<Value>,
) -> Result<Value, String> {
    let bin = binary(&app).ok_or("The bundled pi agent is unavailable")?;
    let data = get_jan_data_folder_path(app.clone());
    let dir = profile_dir(&data, &request.thread_id)?;
    let mut sessions = state.0.lock().await;
    request.project_id = crate::core::secure_env::thread_project(&data, &request.thread_id)?;
    if let Some(id) = &request.project_id {
        request.secure_project = crate::core::secure_env::load_all(&data)?.contains_key(id);
    }
    request
        .connectors
        .sort_by(|a, b| (&a.server, &a.name).cmp(&(&b.server, &b.name)));
    request
        .connectors
        .dedup_by(|a, b| a.server == b.server && a.name == b.name);
    if request.secure_project || request.cwd.as_os_str().is_empty() {
        request.cwd =
            crate::core::chat_exec::workdir::ensure_chat_workdir(&data, &request.thread_id)?.root;
    }
    request.skills = bridge::enabled_skills(&data, &request.connectors)?;
    if request.project_id.is_some() {
        request
            .connectors
            .extend(project::tools(request.secure_project));
    }
    let dispatch = bridge::dispatcher(app, request.thread_id.clone(), request.project_id.clone());
    sessions.retain(|_, s| !s.exited());
    if let Some(current) = sessions.get(&request.thread_id) {
        let mut same = current.request.clone();
        same.session_file = request.session_file.clone();
        // The composer also sets effort on an attached child through RPC before prompting.
        same.thinking_level = request.thinking_level.clone();
        if same == request {
            current.reconnect(on_event);
            return Ok(current.info.lock().unwrap().clone());
        }
        if current.idle_for().is_none() {
            return Err(
                "Stop the current Agent turn before changing its model or workspace".into(),
            );
        }
        current.stop().await;
        sessions.remove(&request.thread_id);
    }
    if sessions.len() >= 4 {
        let victim = sessions
            .iter()
            .filter_map(|(id, s)| s.idle_for().map(|age| (age, id.clone())))
            .max()
            .ok_or("All four Agent sessions are busy")?
            .1;
        if let Some(s) = sessions.remove(&victim) {
            s.stop().await;
        }
    }
    let id = request.thread_id.clone();
    let session = process::launch(bin, dir, request, on_event, Some(dispatch)).await?;
    let info = session.info.lock().unwrap().clone();
    sessions.insert(id, session);
    Ok(info)
}

/// Reopening a chat attaches to a live child without creating a session.
#[tauri::command]
pub async fn pi_agent_attach(
    state: State<'_, PiAgentState>,
    thread_id: String,
    on_event: Channel<Value>,
) -> Result<bool, String> {
    let sessions = state.0.lock().await;
    if let Some(session) = sessions.get(&thread_id).filter(|s| !s.exited()) {
        session.reconnect(on_event);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn pi_agent_call(
    state: State<'_, PiAgentState>,
    thread_id: String,
    command: Value,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    if !protocol::command_allowed(&command) {
        return Err("Unsupported pi command".into());
    }
    let session = state
        .0
        .lock()
        .await
        .get(&thread_id)
        .cloned()
        .ok_or("Agent session is closed")?;
    session
        .call(
            command,
            Duration::from_millis(timeout_ms.unwrap_or(30000).clamp(100, 600000)),
        )
        .await
}

#[tauri::command]
pub async fn pi_agent_ui_respond(
    state: State<'_, PiAgentState>,
    thread_id: String,
    response: Value,
) -> Result<(), String> {
    let session = state
        .0
        .lock()
        .await
        .get(&thread_id)
        .cloned()
        .ok_or("Agent session is closed")?;
    session.respond(response).await
}

#[tauri::command]
pub async fn pi_agent_stop(
    state: State<'_, PiAgentState>,
    thread_id: String,
) -> Result<(), String> {
    if let Some(session) = state.0.lock().await.remove(&thread_id) {
        session.stop().await;
    }
    Ok(())
}

/// Serialize scope changes with session startup. A child cannot retain its old
/// tools after its task is moved or its project's environment changes.
pub(crate) async fn change_scope(
    state: &PiAgentState,
    affected: impl Fn(&str, Option<&str>) -> bool,
    save: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let mut sessions = state.0.lock().await;
    let ids: Vec<_> = sessions
        .iter()
        .filter(|(id, s)| affected(id, s.request.project_id.as_deref()))
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Some(session) = sessions.remove(&id) {
            session.stop().await;
        }
    }
    save()
}

pub async fn forget_thread(state: &PiAgentState, data: &Path, id: &str) {
    let mut sessions = state.0.lock().await;
    if let Some(session) = sessions.remove(id) {
        session.stop().await;
    }
    if let Ok(dir) = profile_dir(data, id) {
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}

pub async fn kill_all(state: &PiAgentState) {
    for (_, session) in state.0.lock().await.drain() {
        session.stop().await;
    }
}

pub fn setup<R: Runtime>(app: &AppHandle<R>, data: &Path) {
    if let Some(bin) = binary(app) {
        journal::reap(data, &bin);
    }
    let state = app.state::<PiAgentState>().inner().clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let mut sessions = state.0.lock().await;
            let idle: Vec<_> = sessions
                .iter()
                .filter(|(_, s)| s.exited() || s.idle_for().is_some_and(|time| time >= IDLE))
                .map(|(id, _)| id.clone())
                .collect();
            for id in idle {
                if let Some(session) = sessions.remove(&id) {
                    session.stop().await;
                }
            }
        }
    });
}
