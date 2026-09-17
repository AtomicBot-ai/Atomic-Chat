//! Engines the app still runs itself — TurboQuant (`llamacpp`), MLX, and
//! llama.cpp upstream while that runtime is not the core's — registered with
//! the core so the Local API Server it serves can route to them (PLAN.md §4,
//! stage 4d).
//!
//! The app publishes its whole list as one snapshot and keeps it alive with
//! heartbeats; a registration that stops beating expires in the core, so an app
//! that crashed does not leave routes to dead ports behind. The generation is
//! this process's start time: a snapshot from a previous run can never replace
//! the current one.
//!
//! When the core needs one of these sessions grown it asks here, and the app
//! answers the way its own proxy always did — through the extension's
//! `local_backend://auto_increase_ctx` round trip — then republishes the list,
//! because the reloaded model listens on a new port, and only then answers.
//!
//! Foundation Models sessions are not published: the app's own proxy never
//! routed to them either.

use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

use super::cloud::core_owns_server;
use super::commands::AtomicCoreClient;
use crate::core::sessions::resolver::{
    PROVIDER_LLAMACPP, PROVIDER_LLAMACPP_UPSTREAM, PROVIDER_MLX,
};
use crate::core::state::AppState;

/// How this app names itself as an owner of external sessions.
pub const OWNER: &str = "atomic-chat-app";
/// Well inside the core's 30-second registration lifetime.
const PUBLISH_INTERVAL: Duration = Duration::from_secs(5);
pub const CTX_REQUESTED_EVENT: &str = "atomic-core://external-sessions:ctx-requested";

pub fn generation() -> u64 {
    static GENERATION: OnceLock<u64> = OnceLock::new();
    *GENERATION.get_or_init(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(1)
    })
}

/// The app-owned sessions, as the core's registration expects them.
pub async fn legacy_sessions<R: Runtime>(app: &AppHandle<R>) -> Vec<Value> {
    let Some(resolver) = app
        .try_state::<AppState>()
        .and_then(|state| state.session_resolver.get().cloned())
    else {
        return Vec::new();
    };
    let mut providers = vec![PROVIDER_LLAMACPP, PROVIDER_MLX];
    if !resolver.core_owns(PROVIDER_LLAMACPP_UPSTREAM) {
        providers.push(PROVIDER_LLAMACPP_UPSTREAM);
    }
    let mut out = Vec::new();
    for provider in providers {
        for session in resolver.list_legacy_in(provider).await {
            out.push(session_json(provider, &session));
        }
    }
    out
}

pub fn session_json(provider: &str, session: &crate::core::sessions::resolver::ResolvedSession) -> Value {
    json!({
        "provider": provider,
        "model_id": session.model_id,
        "port": session.port,
        "api_key": session.api_key,
        "is_embedding": session.is_embedding,
        "pid": session.pid,
    })
}

async fn call<R: Runtime>(app: &AppHandle<R>, method: &str, path: &str, body: Option<Value>) -> Option<Value> {
    let client = app.try_state::<AtomicCoreClient>()?;
    if !client.is_enabled() {
        return None;
    }
    match client.call(method, path, body).await {
        Ok(value) => Some(value),
        Err(error) => {
            log::debug!("[atomic-core] external sessions {method} {path}: {}", error.message);
            None
        }
    }
}

async fn publish<R: Runtime>(app: &AppHandle<R>, sessions: &[Value]) -> bool {
    call(
        app,
        "PUT",
        &format!("/external-sessions/{OWNER}"),
        Some(json!({ "generation": generation(), "sessions": sessions })),
    )
    .await
    .is_some()
}

/// Publish before opening the core's public listener, not at the next five-second tick.
pub async fn publish_before_server<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let sessions = legacy_sessions(app).await;
    if publish(app, &sessions).await { Ok(()) }
    else { Err("Could not register the app's models with the core before opening the API.".into()) }
}

pub async fn withdraw<R: Runtime>(app: &AppHandle<R>) {
    if let Some(client) = app.try_state::<AtomicCoreClient>() {
        if let Some(attached) = client.supervisor().current().await {
            let _ = attached.client.call("DELETE", &format!("/external-sessions/{OWNER}"),
                Some(json!({"generation": generation()}))).await;
        }
    }
}

/// Keep the core's view of the app's engines current while the core serves the
/// public API, and withdraw it when the app takes the server back. Runs for the
/// life of one attachment; the relay lifecycle cancels it.
pub async fn run<R: Runtime>(app: AppHandle<R>) {
    let mut published: Option<Vec<Value>> = None;
    let mut interval = tokio::time::interval(PUBLISH_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        if !core_owns_server(&app) {
            if published.take().is_some() {
                call(&app, "DELETE", &format!("/external-sessions/{OWNER}"),
                    Some(json!({"generation": generation()}))).await;
            }
            continue;
        }
        let current = legacy_sessions(&app).await;
        if published.as_ref() != Some(&current) {
            if publish(&app, &current).await {
                published = Some(current);
            }
            continue;
        }
        let alive = call(
            &app,
            "POST",
            &format!("/external-sessions/{OWNER}/heartbeat"),
            Some(json!({ "generation": generation() })),
        )
        .await
        .and_then(|v| v.get("alive").and_then(Value::as_bool))
        .unwrap_or(false);
        if !alive {
            // Expired or replaced (a restarted core): publish again on the next tick.
            published = None;
        }
    }
}

/// The core asks this app to grow one of its sessions.
pub fn on_ctx_requested<R: Runtime>(app: &AppHandle<R>, payload: &Value) {
    if payload.get("owner").and_then(Value::as_str) != Some(OWNER) {
        return;
    }
    let (Some(request_id), Some(provider), Some(model_id)) = (
        payload.get("request_id").and_then(Value::as_str).map(str::to_string),
        payload.get("provider").and_then(Value::as_str).map(str::to_string),
        payload.get("model_id").and_then(Value::as_str).map(str::to_string),
    ) else {
        return;
    };
    let trigger = payload
        .get("trigger")
        .and_then(Value::as_str)
        .unwrap_or("error")
        .to_string();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        let auto_state = state.auto_increase_ctx.clone();
        let outcome = crate::core::server::context_expansion::request_context_increase(
            &app,
            &auto_state,
            &provider,
            &model_id,
            &trigger,
            None,
        )
        .await;
        // The reloaded model has a new port: the core must know it before it retries.
        let sessions = legacy_sessions(&app).await;
        publish(&app, &sessions).await;
        call(
            &app,
            "POST",
            &format!("/external-sessions/{OWNER}/ctx/{request_id}"),
            Some(json!({
                "ok": outcome.ok,
                "new_ctx_len": outcome.new_ctx_len,
                "reason": outcome.reason,
            })),
        )
        .await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::sessions::resolver::ResolvedSession;

    #[test]
    fn a_session_is_published_with_what_routing_needs() {
        let session = ResolvedSession {
            pid: 7,
            port: 5001,
            model_id: "Qwen3.5-MLX".into(),
            model_path: "/m".into(),
            is_embedding: false,
            api_key: String::new(),
            mmproj_path: None,
            provider: "mlx".into(),
        };
        assert_eq!(
            session_json(PROVIDER_MLX, &session),
            json!({"provider": "mlx", "model_id": "Qwen3.5-MLX", "port": 5001, "api_key": "", "is_embedding": false, "pid": 7})
        );
    }

    #[test]
    fn the_generation_is_stable_within_a_run() {
        assert_eq!(generation(), generation());
        assert!(generation() > 0);
    }
}
