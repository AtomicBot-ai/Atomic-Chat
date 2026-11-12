//! Tauri commands for remote access through the account. Desktop only.
//!
//! Only `account_remote_connections` returns keys (the managed providers need
//! them, like any provider's key); nothing returns an address.

use tauri::{AppHandle, Runtime, State};

use super::api::{remote_codes, HostInfo};
use super::client::ClientCtx;
use super::core_env::CoreEnv;
use super::host::HostCtx;
use super::protocol;
use super::runtime::{self, announce, data_dir, host_name, start_client, start_host};
use super::state::{
    ConnectionView, HostMemory, PairingView, ProviderConnection, RemoteState, RemoteStatus,
};
use super::store::PairingRecord;
use crate::core::account::api::{codes, AccountError};
use crate::core::account::commands::announce_if_lost;
use crate::core::account::AccountState;
use crate::core::auth::state::now_unix;

#[tauri::command]
pub async fn account_remote_status<R: Runtime>(
    app: AppHandle<R>,
    remote: State<'_, RemoteState>,
) -> Result<RemoteStatus, AccountError> {
    Ok(remote.status(&data_dir(&app)).await)
}

#[tauri::command]
pub async fn account_remote_connections<R: Runtime>(
    app: AppHandle<R>,
    remote: State<'_, RemoteState>,
) -> Result<Vec<ProviderConnection>, AccountError> {
    Ok(remote.provider_connections(&data_dir(&app)).await)
}

/// Turn sharing on or off. The webview has already made sure the server has
/// its own key and that the server and the tunnel run. Off pauses: the host
/// stays in the account and its devices keep their grants, but the core
/// stops accepting their keys and the host shows offline.
#[tauri::command]
pub async fn account_remote_set_sharing<R: Runtime>(
    app: AppHandle<R>,
    remote: State<'_, RemoteState>,
    account: State<'_, AccountState>,
    enabled: bool,
) -> Result<RemoteStatus, AccountError> {
    let dir = data_dir(&app);
    if enabled {
        announce_if_lost(
            &app,
            &account,
            remote.bind_signed_in_user(&account, &dir).await,
        )
        .await?;
        remote.update(&dir, |f| f.sharing = true).await;
        if !remote.host_running() {
            start_host(&app);
        }
    } else {
        remote.stop_host();
        let had_code = remote
            .update(&dir, |f| {
                f.sharing = false;
                f.pairing.take().is_some()
            })
            .await;
        if had_code {
            let _ = account
                .authed(&dir, |api, token| async move {
                    api.remote_close_pairing_code(&token).await
                })
                .await;
        }
        remote.set_memory(|m| {
            m.requests.clear();
            m.pairing_open = false;
            m.error = None;
        });
        let env = CoreEnv::new(app.clone());
        let ctx = HostCtx {
            remote: &remote,
            account: &account,
            data_dir: &dir,
            env: &env,
            host_name: host_name(),
        };
        ctx.push_keys().await;
    }
    announce(&app).await;
    Ok(remote.status(&dir).await)
}

/// Open a pairing code (one per host; a new one replaces the old) and its QR
/// secret, which never leaves this app except inside the QR.
#[tauri::command]
pub async fn account_remote_pairing_code<R: Runtime>(
    app: AppHandle<R>,
    remote: State<'_, RemoteState>,
    account: State<'_, AccountState>,
) -> Result<PairingView, AccountError> {
    let dir = data_dir(&app);
    if !remote.read(&dir, |f| f.sharing).await {
        return Err(AccountError::new(
            codes::INVALID_REQUEST,
            "turn sharing on before adding a device",
        ));
    }
    let env = CoreEnv::new(app.clone());
    let ctx = HostCtx {
        remote: &remote,
        account: &account,
        data_dir: &dir,
        env: &env,
        host_name: host_name(),
    };
    announce_if_lost(&app, &account, ctx.ensure_host().await).await?;
    let code = announce_if_lost(
        &app,
        &account,
        account
            .authed(&dir, |api, token| async move {
                api.remote_create_pairing_code(&token).await
            })
            .await,
    )
    .await?;
    let Some(normalized) = protocol::normalize_code(&code.code) else {
        return Err(AccountError::new(
            codes::UNEXPECTED,
            "the account service sent a malformed pairing code",
        ));
    };
    let qr = protocol::new_qr_secret();
    let expires_at = now_unix() + code.expires_in as i64;
    remote
        .update(&dir, |f| {
            f.pairing = Some(PairingRecord {
                code: normalized.clone(),
                qr_secret: protocol::b64u(&qr),
                expires_at,
            })
        })
        .await;
    remote.host_wake.notify_one();
    announce(&app).await;
    let formatted = protocol::format_code(&normalized);
    Ok(PairingView {
        link: protocol::pair_link(&formatted, &qr),
        code: formatted,
        expires_at,
    })
}

#[tauri::command]
pub async fn account_remote_close_pairing_code<R: Runtime>(
    app: AppHandle<R>,
    remote: State<'_, RemoteState>,
    account: State<'_, AccountState>,
) -> Result<(), AccountError> {
    let dir = data_dir(&app);
    remote.update(&dir, |f| f.pairing = None).await;
    let result = account
        .authed(&dir, |api, token| async move {
            api.remote_close_pairing_code(&token).await
        })
        .await;
    announce(&app).await;
    match result {
        Ok(()) => Ok(()),
        Err(err) if err.is(remote_codes::HOST_NOT_FOUND) => Ok(()),
        Err(err) => announce_if_lost(&app, &account, Err(err)).await,
    }
}

/// Allow or deny a device that asked for access.
#[tauri::command]
pub async fn account_remote_decide<R: Runtime>(
    app: AppHandle<R>,
    remote: State<'_, RemoteState>,
    account: State<'_, AccountState>,
    grant_id: String,
    allow: bool,
) -> Result<RemoteStatus, AccountError> {
    let dir = data_dir(&app);
    let id = grant_id.clone();
    let result = account
        .authed(&dir, |api, token| {
            let id = id.clone();
            async move { api.remote_decide(&token, &id, allow).await }
        })
        .await;
    remote.set_memory(|m: &mut HostMemory| m.requests.retain(|r| r.grant_id != grant_id));
    remote.host_wake.notify_one();
    announce(&app).await;
    announce_if_lost(&app, &account, result).await?;
    Ok(remote.status(&dir).await)
}

/// Revoke any grant of the account: a device of this host, or this device's
/// own access somewhere.
#[tauri::command]
pub async fn account_remote_revoke<R: Runtime>(
    app: AppHandle<R>,
    remote: State<'_, RemoteState>,
    account: State<'_, AccountState>,
    grant_id: String,
) -> Result<RemoteStatus, AccountError> {
    let dir = data_dir(&app);
    let id = grant_id.clone();
    let result = account
        .authed(&dir, |api, token| {
            let id = id.clone();
            async move { api.remote_revoke_grant(&token, &id).await }
        })
        .await;
    match result {
        Ok(()) => {}
        Err(err)
            if err.is(remote_codes::GRANT_NOT_FOUND) || err.is(remote_codes::INVALID_STATE) => {}
        Err(err) => return announce_if_lost(&app, &account, Err(err)).await,
    }
    let was_issued = remote
        .update(&dir, |f| {
            let before = f.issued.len();
            f.issued.retain(|k| k.grant_id != grant_id);
            f.connections.retain(|c| c.grant_id != grant_id);
            before != f.issued.len()
        })
        .await;
    remote.stop_client(&grant_id);
    if was_issued {
        let env = CoreEnv::new(app.clone());
        let ctx = HostCtx {
            remote: &remote,
            account: &account,
            data_dir: &dir,
            env: &env,
            host_name: host_name(),
        };
        ctx.push_keys().await;
    }
    remote.host_wake.notify_one();
    announce(&app).await;
    Ok(remote.status(&dir).await)
}

/// The account's hosts, this computer included (`isSelf`).
#[tauri::command]
pub async fn account_remote_hosts<R: Runtime>(
    app: AppHandle<R>,
    remote: State<'_, RemoteState>,
    account: State<'_, AccountState>,
) -> Result<Vec<HostInfo>, AccountError> {
    let dir = data_dir(&app);
    // Registers the device on first use, so its own host is recognised.
    announce_if_lost(
        &app,
        &account,
        remote.ensure_device(&account, &dir, false).await,
    )
    .await?;
    announce_if_lost(
        &app,
        &account,
        account
            .authed(
                &dir,
                |api, token| async move { api.remote_hosts(&token).await },
            )
            .await,
    )
    .await
}

/// Ask a host for access; the host's person clicks "Allow" after comparing
/// the check code.
#[tauri::command]
pub async fn account_remote_request<R: Runtime>(
    app: AppHandle<R>,
    remote: State<'_, RemoteState>,
    account: State<'_, AccountState>,
    host_id: String,
) -> Result<ConnectionView, AccountError> {
    let dir = data_dir(&app);
    let ctx = ClientCtx {
        remote: &remote,
        account: &account,
        data_dir: &dir,
    };
    let view = announce_if_lost(&app, &account, ctx.request(&host_id).await).await?;
    start_client(&app, &view.grant_id);
    announce(&app).await;
    Ok(view)
}

/// Pair with a code typed from a host's screen, or a pasted pair link.
#[tauri::command]
pub async fn account_remote_pair<R: Runtime>(
    app: AppHandle<R>,
    remote: State<'_, RemoteState>,
    account: State<'_, AccountState>,
    input: String,
) -> Result<ConnectionView, AccountError> {
    let Some(input) = protocol::parse_pair_input(&input) else {
        return Err(AccountError::new(
            remote_codes::INVALID_CODE,
            "not a pairing code",
        ));
    };
    let dir = data_dir(&app);
    let ctx = ClientCtx {
        remote: &remote,
        account: &account,
        data_dir: &dir,
    };
    let view = announce_if_lost(&app, &account, ctx.pair(&input).await).await?;
    start_client(&app, &view.grant_id);
    announce(&app).await;
    Ok(view)
}

/// Stop using a host: its grant is revoked and its provider goes away.
#[tauri::command]
pub async fn account_remote_disconnect<R: Runtime>(
    app: AppHandle<R>,
    remote: State<'_, RemoteState>,
    account: State<'_, AccountState>,
    host_id: String,
) -> Result<RemoteStatus, AccountError> {
    let dir = data_dir(&app);
    let ctx = ClientCtx {
        remote: &remote,
        account: &account,
        data_dir: &dir,
    };
    if let Some(grant_id) = announce_if_lost(&app, &account, ctx.disconnect(&host_id).await).await?
    {
        remote.stop_client(&grant_id);
    }
    announce(&app).await;
    Ok(remote.status(&dir).await)
}

/// Remove a host from the account, e.g. a lost laptop. Its devices lose access.
#[tauri::command]
pub async fn account_remote_remove_host<R: Runtime>(
    app: AppHandle<R>,
    remote: State<'_, RemoteState>,
    account: State<'_, AccountState>,
    host_id: String,
) -> Result<RemoteStatus, AccountError> {
    let dir = data_dir(&app);
    let id = host_id.clone();
    let result = account
        .authed(&dir, |api, token| {
            let id = id.clone();
            async move { api.remote_delete_host(&token, &id).await }
        })
        .await;
    match result {
        Ok(()) => {}
        Err(err) if err.is(remote_codes::HOST_NOT_FOUND) => {}
        Err(err) => return announce_if_lost(&app, &account, Err(err)).await,
    }
    let own = remote
        .update(&dir, |f| {
            let own = f.host.as_ref().is_some_and(|h| h.host_id == host_id);
            if own {
                // This computer: it stops sharing, and its devices' keys go.
                f.sharing = false;
                f.host = None;
                f.pairing = None;
                f.issued.clear();
            }
            own
        })
        .await;
    if own {
        remote.stop_host();
        remote.set_memory(|m| *m = HostMemory::default());
        let env = CoreEnv::new(app.clone());
        let ctx = HostCtx {
            remote: &remote,
            account: &account,
            data_dir: &dir,
            env: &env,
            host_name: host_name(),
        };
        ctx.push_keys().await;
    }
    let ended: Vec<String> = remote
        .update(&dir, |f| {
            let ended = f
                .connections
                .iter()
                .filter(|c| c.host_id == host_id)
                .map(|c| c.grant_id.clone())
                .collect();
            f.connections.retain(|c| c.host_id != host_id);
            ended
        })
        .await;
    for grant_id in ended {
        remote.stop_client(&grant_id);
    }
    announce(&app).await;
    Ok(remote.status(&dir).await)
}

/// Exposed for `lib.rs` setup.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    runtime::init(app);
}
