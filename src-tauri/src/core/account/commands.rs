//! Tauri commands for the Atomic Chat account. None returns a token.
//!
//! Every change of who is signed in is also announced as the
//! `account-changed` event, so the rail and the settings page agree without
//! polling.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use super::api::{codes, AccountError, EmailChallenge, SessionInfo};
use super::google::GOOGLE;
use super::state::{AccountProfile, AccountState, AccountStatus};
use crate::core::auth::state::data_dir_for;
use crate::core::mcp::oauth::flow::CALLBACK_TIMEOUT;

pub const ACCOUNT_CHANGED_EVENT: &str = "account-changed";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChangeReason {
    SignedIn,
    SignedOut,
    SessionLost,
    ProfileUpdated,
    Deleted,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountChanged {
    status: AccountStatus,
    reason: ChangeReason,
}

fn emit<R: Runtime>(app: &AppHandle<R>, status: &AccountStatus, reason: ChangeReason) {
    let payload = AccountChanged {
        status: status.clone(),
        reason,
    };
    if let Err(err) = app.emit(ACCOUNT_CHANGED_EVENT, payload) {
        log::warn!("[account] cannot announce the account change: {err}");
    }
}

fn data_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    data_dir_for(app)
}

fn app_version<R: Runtime>(app: &AppHandle<R>) -> String {
    app.package_info().version.to_string()
}

/// An authenticated call ending in `invalid_grant` has just cleared the
/// session: tell the UI it is signed out.
async fn announce_if_lost<R: Runtime, T>(
    app: &AppHandle<R>,
    state: &AccountState,
    result: Result<T, AccountError>,
) -> Result<T, AccountError> {
    if let Err(err) = &result {
        if err.is(codes::INVALID_GRANT) {
            let status = state.status(&data_dir(app)).await;
            emit(app, &status, ChangeReason::SessionLost);
        }
    }
    result
}

fn bring_to_front<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub async fn account_status<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AccountState>,
) -> Result<AccountStatus, AccountError> {
    Ok(state.status(&data_dir(&app)).await)
}

#[tauri::command]
pub async fn account_providers(
    state: State<'_, AccountState>,
) -> Result<Vec<String>, AccountError> {
    state.providers().await
}

#[tauri::command]
pub async fn account_email_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AccountState>,
    email: String,
) -> Result<EmailChallenge, AccountError> {
    state
        .email_start(&data_dir(&app), &email, &app_version(&app))
        .await
}

#[tauri::command]
pub async fn account_email_verify<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AccountState>,
    challenge_id: String,
    code: String,
) -> Result<AccountStatus, AccountError> {
    let status = state
        .email_verify(&data_dir(&app), &challenge_id, &code, &app_version(&app))
        .await?;
    emit(&app, &status, ChangeReason::SignedIn);
    Ok(status)
}

/// Open the system browser and wait for it to come back. One long-running
/// command rather than start/poll, so closing the app midway leaves nothing
/// half-done.
#[tauri::command]
pub async fn account_google_login<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AccountState>,
) -> Result<AccountStatus, AccountError> {
    let result = state
        .browser_sign_in(
            &data_dir(&app),
            GOOGLE,
            &app_version(&app),
            CALLBACK_TIMEOUT,
            |url| tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string()),
        )
        .await;
    match &result {
        Ok(status) => {
            bring_to_front(&app);
            emit(&app, status, ChangeReason::SignedIn);
        }
        // The person came back from the browser with an answer.
        Err(err) if !err.is(codes::CANCELLED) && !err.is(codes::TIMEOUT) => bring_to_front(&app),
        Err(_) => {}
    }
    result
}

#[tauri::command]
pub async fn account_cancel_login(state: State<'_, AccountState>) -> Result<(), AccountError> {
    state.cancel_login();
    Ok(())
}

#[tauri::command]
pub async fn account_logout<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AccountState>,
) -> Result<AccountStatus, AccountError> {
    let status = state.logout(&data_dir(&app)).await;
    emit(&app, &status, ChangeReason::SignedOut);
    Ok(status)
}

#[tauri::command]
pub async fn account_profile<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AccountState>,
) -> Result<AccountProfile, AccountError> {
    let dir = data_dir(&app);
    let result = announce_if_lost(&app, &state, state.profile(&dir).await).await;
    let (profile, changed) = result?;
    if changed {
        emit(
            &app,
            &state.status(&dir).await,
            ChangeReason::ProfileUpdated,
        );
    }
    Ok(profile)
}

#[tauri::command]
pub async fn account_update_profile<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AccountState>,
    display_name: String,
) -> Result<AccountProfile, AccountError> {
    let dir = data_dir(&app);
    let profile = announce_if_lost(
        &app,
        &state,
        state.update_profile(&dir, &display_name).await,
    )
    .await?;
    emit(
        &app,
        &state.status(&dir).await,
        ChangeReason::ProfileUpdated,
    );
    Ok(profile)
}

#[tauri::command]
pub async fn account_sessions<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AccountState>,
) -> Result<Vec<SessionInfo>, AccountError> {
    let dir = data_dir(&app);
    announce_if_lost(&app, &state, state.sessions(&dir).await).await
}

#[tauri::command]
pub async fn account_revoke_session<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AccountState>,
    session_id: String,
) -> Result<(), AccountError> {
    let dir = data_dir(&app);
    let outcome =
        announce_if_lost(&app, &state, state.revoke_session(&dir, &session_id).await).await?;
    if let Some(status) = outcome {
        emit(&app, &status, ChangeReason::SignedOut);
    }
    Ok(())
}

#[tauri::command]
pub async fn account_delete<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AccountState>,
) -> Result<AccountStatus, AccountError> {
    let dir = data_dir(&app);
    let status = announce_if_lost(&app, &state, state.delete(&dir).await).await?;
    emit(&app, &status, ChangeReason::Deleted);
    Ok(status)
}
