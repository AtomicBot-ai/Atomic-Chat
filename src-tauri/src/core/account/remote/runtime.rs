//! The background side of remote access in the app: the host loop, one loop
//! per connection, and the listeners that start, wake and stop them.
//!
//! Events for the webview:
//! - `account-remote-changed` with a `RemoteStatus` (the page);
//! - `account-remote-connections` with the ready connections (the managed
//!   providers);
//! - `account-remote-connection-ended` with `{hostName, reason}` (a toast);
//! - `account-remote-device-left` with `{grantId, deviceName}` when a device's
//!   access to this computer ends from its side (a toast).

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime};
use tokio_util::sync::CancellationToken;

use super::api::{remote_codes, MAX_WAIT_SECS};
use super::client::{ClientCtx, Round};
use super::core_env::{CoreEnv, HostEnv};
use super::host::{HostCtx, UploadMark};
use super::state::{HostMemory, RemoteState};
use crate::core::account::api::{codes, AccountError};
use crate::core::account::client_info;
use crate::core::account::commands::{announce_if_lost, ACCOUNT_CHANGED_EVENT};
use crate::core::account::AccountState;
use crate::core::auth::state::data_dir_for;

pub const REMOTE_CHANGED_EVENT: &str = "account-remote-changed";
pub const REMOTE_CONNECTIONS_EVENT: &str = "account-remote-connections";
pub const REMOTE_CONNECTION_ENDED_EVENT: &str = "account-remote-connection-ended";
pub const REMOTE_DEVICE_LEFT_EVENT: &str = "account-remote-device-left";

const CORE_SNAPSHOT_EVENT: &str = "atomic-core://snapshot";
const CORE_TUNNEL_EVENT: &str = "atomic-core://remote-access:status";
const SERVER_STATE_EVENT: &str = "atomic-core://server-state-changed";

const BACKOFF_START: Duration = Duration::from_secs(2);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// A LAN may appear or go while nothing else changes.
const REPROBE_EVERY: Duration = Duration::from_secs(180);

pub(super) fn data_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    data_dir_for(app)
}

/// The name this computer shares under: its Computer Name or host name.
pub(super) fn host_name() -> String {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| client_info::device_name().unwrap_or_else(|| "Atomic Chat".to_string()))
        .clone()
}

/// Announce the page's state and the provider list, each only when changed.
pub async fn announce<R: Runtime>(app: &AppHandle<R>) {
    let remote = app.state::<RemoteState>();
    let dir = data_dir(app);
    let status = remote.status(&dir).await;
    let status_changed = remote
        .last_status
        .lock()
        .map(|mut last| {
            let changed = last.as_ref() != Some(&status);
            *last = Some(status.clone());
            changed
        })
        .unwrap_or(true);
    if status_changed {
        if let Err(err) = app.emit(REMOTE_CHANGED_EVENT, &status) {
            log::warn!("[remote] cannot announce the remote access state: {err}");
        }
    }
    let connections = remote.provider_connections(&dir).await;
    let connections_changed = remote
        .last_connections
        .lock()
        .map(|mut last| {
            let changed = last.as_ref() != Some(&connections);
            *last = Some(connections.clone());
            changed
        })
        .unwrap_or(true);
    if connections_changed {
        if let Err(err) = app.emit(REMOTE_CONNECTIONS_EVENT, &connections) {
            log::warn!("[remote] cannot announce the remote connections: {err}");
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionEnded {
    host_name: String,
    reason: String,
}

pub(super) fn is_session_over(err: &AccountError) -> bool {
    err.is(codes::INVALID_GRANT) || err.is(codes::NOT_SIGNED_IN)
}

async fn sleep_or_cancel(duration: Duration, cancel: &CancellationToken) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(duration) => true,
        _ = cancel.cancelled() => false,
    }
}

// ---------------------------------------------------------------------------
// The host loop

pub fn start_host<R: Runtime>(app: &AppHandle<R>) {
    let cancel = app.state::<RemoteState>().arm_host();
    let app = app.clone();
    tauri::async_runtime::spawn(async move { host_loop(app, cancel).await });
}

async fn host_loop<R: Runtime>(app: AppHandle<R>, cancel: CancellationToken) {
    let env = CoreEnv::new(app.clone());
    let dir = data_dir(&app);
    let mut after = None;
    let mut quick = true;
    let mut uploaded: Option<UploadMark> = None;
    let mut backoff = BACKOFF_START;
    log::info!("[remote] sharing this computer's models");
    {
        let remote = app.state::<RemoteState>();
        let account = app.state::<AccountState>();
        let ctx = HostCtx {
            remote: &remote,
            account: &account,
            data_dir: &dir,
            env: &env,
            host_name: host_name(),
        };
        // The core may have restarted since the keys were last handed over.
        ctx.push_keys().await;
    }
    loop {
        if cancel.is_cancelled() {
            break;
        }
        let remote = app.state::<RemoteState>();
        let account = app.state::<AccountState>();
        if !remote.read(&dir, |f| f.sharing).await {
            break;
        }
        let ctx = HostCtx {
            remote: &remote,
            account: &account,
            data_dir: &dir,
            env: &env,
            host_name: host_name(),
        };
        let wait = if quick { 0 } else { MAX_WAIT_SECS };
        let result = ctx
            .round(after, wait, &mut uploaded, &remote.host_wake, &cancel)
            .await;
        for left in remote.take_left() {
            if let Err(err) = app.emit(REMOTE_DEVICE_LEFT_EVENT, &left) {
                log::warn!("[remote] cannot announce a device that left: {err}");
            }
        }
        match result {
            Ok(Some(version)) => {
                after = Some(version);
                quick = false;
                backoff = BACKOFF_START;
                announce(&app).await;
            }
            // Woken: send a fresh heartbeat (and addresses) right away.
            Ok(None) => {
                quick = true;
                announce(&app).await;
            }
            Err(err) if is_session_over(&err) => {
                let _ = announce_if_lost(&app, &account, Err::<(), _>(err)).await;
                break;
            }
            Err(err) if err.is(remote_codes::HOST_NOT_FOUND) => {
                // Removed from another device of the account (a "lost laptop").
                log::info!("[remote] this host was removed from the account; sharing stops");
                remote
                    .update(&dir, |f| {
                        f.sharing = false;
                        f.host = None;
                        f.pairing = None;
                        f.allowed.clear();
                        f.issued.clear();
                    })
                    .await;
                remote.set_memory(|m| *m = HostMemory::default());
                ctx.push_keys().await;
                announce(&app).await;
                break;
            }
            Err(err) => {
                log::warn!("[remote] host sync failed: {err}");
                remote.set_memory(|m| m.error = Some(err.message.clone()));
                announce(&app).await;
                quick = true;
                let woken = tokio::select! {
                    _ = tokio::time::sleep(backoff) => false,
                    _ = remote.host_wake.notified() => true,
                    _ = cancel.cancelled() => break,
                };
                if !woken {
                    backoff = (backoff * 2).min(BACKOFF_MAX);
                }
            }
        }
    }
    log::info!("[remote] host loop stopped");
}

// ---------------------------------------------------------------------------
// Connection loops

pub fn start_client<R: Runtime>(app: &AppHandle<R>, grant_id: &str) {
    let Some(cancel) = app.state::<RemoteState>().arm_client(grant_id) else {
        return;
    };
    let app = app.clone();
    let grant_id = grant_id.to_string();
    tauri::async_runtime::spawn(async move { client_loop(app, grant_id, cancel).await });
}

async fn client_loop<R: Runtime>(app: AppHandle<R>, grant_id: String, cancel: CancellationToken) {
    let dir = data_dir(&app);
    let mut backoff = BACKOFF_START;
    let mut last_probe = Instant::now();
    loop {
        if cancel.is_cancelled() {
            break;
        }
        let remote = app.state::<RemoteState>();
        let account = app.state::<AccountState>();
        let ctx = ClientCtx {
            remote: &remote,
            account: &account,
            data_dir: &dir,
        };
        let host_name = remote
            .read(&dir, |f| {
                f.connections
                    .iter()
                    .find(|c| c.grant_id == grant_id)
                    .map(|c| c.host_name.clone())
            })
            .await
            .unwrap_or_default();
        match ctx.round(&grant_id, MAX_WAIT_SECS, &cancel).await {
            Ok(Round::Cancelled) => break,
            Ok(Round::Ended(reason)) => {
                announce(&app).await;
                let _ = app.emit(
                    REMOTE_CONNECTION_ENDED_EVENT,
                    ConnectionEnded { host_name, reason },
                );
                break;
            }
            Ok(Round::ConnectionsChanged) | Ok(Round::Quiet) => {
                backoff = BACKOFF_START;
                announce(&app).await;
            }
            Err(err) if is_session_over(&err) => {
                let _ = announce_if_lost(&app, &account, Err::<(), _>(err)).await;
                break;
            }
            Err(err) => {
                log::warn!("[remote] waiting on grant {grant_id} failed: {err}");
                if !sleep_or_cancel(backoff, &cancel).await {
                    break;
                }
                backoff = (backoff * 2).min(BACKOFF_MAX);
            }
        }
        if last_probe.elapsed() >= REPROBE_EVERY {
            last_probe = Instant::now();
            if ctx.reprobe(&grant_id).await {
                announce(&app).await;
            }
        }
    }
    let remote = app.state::<RemoteState>();
    if cancel.is_cancelled() {
        return;
    }
    remote.stop_client(&grant_id);
}

// ---------------------------------------------------------------------------
// Start, stop, react

/// Forget everything the install shared and received: the backend has
/// already ended it (sign-out, a lost session, a new sign-in, deletion).
pub async fn end_access<R: Runtime>(app: &AppHandle<R>) {
    let remote = app.state::<RemoteState>();
    let dir = data_dir(app);
    remote.stop_all();
    remote.update(&dir, |f| f.end_access()).await;
    remote.set_memory(|m| *m = HostMemory::default());
    let env = CoreEnv::new(app.clone());
    if let Err(err) = env.push_client_keys(Vec::new()).await {
        log::debug!("[remote] could not clear the device keys in the core: {err}");
    }
    announce(app).await;
}

/// Pick up where the last run left off, when signed in.
pub async fn resume<R: Runtime>(app: &AppHandle<R>) {
    let remote = app.state::<RemoteState>();
    let account = app.state::<AccountState>();
    let dir = data_dir(app);
    if remote.bind_signed_in_user(&account, &dir).await.is_err() {
        // Signed out while the app was closed: nothing may stay usable.
        let leftover = remote
            .read(&dir, |f| {
                f.sharing || !f.issued.is_empty() || !f.connections.is_empty()
            })
            .await;
        if leftover {
            end_access(app).await;
        }
        return;
    }
    if remote.read(&dir, |f| f.sharing).await && !remote.host_running() {
        start_host(app);
    }
    let grants: Vec<String> = remote
        .read(&dir, |f| {
            f.connections.iter().map(|c| c.grant_id.clone()).collect()
        })
        .await;
    for grant_id in grants {
        start_client(app, &grant_id);
    }
    announce(app).await;
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountChangedPayload {
    reason: String,
}

/// Wire the listeners and resume. Called once at app setup.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    app.listen(ACCOUNT_CHANGED_EVENT, move |event| {
        let Ok(payload) = serde_json::from_str::<AccountChangedPayload>(event.payload()) else {
            return;
        };
        let app = handle.clone();
        tauri::async_runtime::spawn(async move {
            match payload.reason.as_str() {
                // A sign-in replaces this install's session, which ends what it
                // shared and received; it starts clean.
                "signedIn" | "signedOut" | "sessionLost" | "deleted" => {
                    end_access(&app).await;
                    if payload.reason == "signedIn" {
                        resume(&app).await;
                    }
                }
                _ => {}
            }
        });
    });

    let handle = app.clone();
    app.listen(CORE_SNAPSHOT_EVENT, move |_| {
        // A (re)attached core has an empty key list.
        let app = handle.clone();
        tauri::async_runtime::spawn(async move {
            let remote = app.state::<RemoteState>();
            let dir = data_dir(&app);
            let keys = remote.read(&dir, |f| f.client_keys()).await;
            if !keys.is_empty() {
                let env = CoreEnv::new(app.clone());
                if let Err(err) = env.push_client_keys(keys).await {
                    log::warn!("[remote] the core did not take the device keys: {err}");
                }
            }
            remote.host_wake.notify_one();
        });
    });

    for event in [CORE_TUNNEL_EVENT, SERVER_STATE_EVENT] {
        let handle = app.clone();
        app.listen(event, move |_| {
            handle.state::<RemoteState>().host_wake.notify_one();
        });
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move { resume(&app).await });
}
