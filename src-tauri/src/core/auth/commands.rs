//! Tauri commands for the ChatGPT subscription connection.
//!
//! Nothing here ever returns a token. `chatgpt_status` is the only read, and it
//! carries the account label and the expiry so the card can render itself.
//!
//! The core holds the session and refreshes it (PLAN.md §2 decision 11, stage 6):
//! each command is the core's answer, taken under the owner gate so a sign-in
//! never interleaves with a public-server start or stop.

use tauri::{AppHandle, Manager, Runtime};

use crate::core::atomic_core::cloud;
use crate::core::atomic_core::commands::AtomicCoreClient;
use crate::core::auth::state::ChatGptStatus;

async fn gate<R: Runtime>(app: &AppHandle<R>) -> Option<tokio::sync::MutexGuard<'_, ()>> {
    match app.try_state::<AtomicCoreClient>() {
        Some(client) => Some(client.inner().owner_gate().await),
        None => None,
    }
}

#[tauri::command]
pub async fn chatgpt_status<R: Runtime>(app: AppHandle<R>) -> Result<ChatGptStatus, String> {
    let _gate = gate(&app).await;
    cloud::chatgpt_status(&app).await
}

/// Open the system browser, wait for the loopback callback the core listens on, and report the
/// connected status or the reason it failed. One long-running command rather than start/poll, so
/// there is no half-state to reconcile if the app closes midway.
#[tauri::command]
pub async fn chatgpt_login<R: Runtime>(app: AppHandle<R>) -> Result<ChatGptStatus, String> {
    let _gate = gate(&app).await;
    cloud::chatgpt_login(&app, |url| {
        tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
    })
    .await
}

/// Abandon a sign-in that is still waiting on the browser. Not gated: the login holding the gate is
/// exactly what this cancels.
#[tauri::command]
pub async fn chatgpt_cancel_login<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    cloud::chatgpt_cancel_login(&app).await
}

/// What the connected subscription can serve, straight from the account.
#[tauri::command]
pub async fn chatgpt_models<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<crate::core::server::chatgpt_route::SubscriptionModel>, String> {
    let _gate = gate(&app).await;
    cloud::chatgpt_models(&app).await
}

#[tauri::command]
pub async fn chatgpt_logout<R: Runtime>(app: AppHandle<R>) -> Result<ChatGptStatus, String> {
    let _gate = gate(&app).await;
    cloud::chatgpt_logout(&app).await
}
