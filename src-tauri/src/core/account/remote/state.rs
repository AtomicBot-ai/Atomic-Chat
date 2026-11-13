//! Remote access in memory: the file behind one `tokio::Mutex`, what the last
//! host sync said, and the handles of the background tasks.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;

use super::api::{status, HostGrant, HostSync};
use super::core_env::Reachability;
use super::protocol::{self, DeviceKey, EndpointKind};
use super::store::{self, RemoteFile};
use crate::core::account::api::{codes, AccountError};
use crate::core::account::AccountState;
use crate::core::auth::state::now_unix;

/// A device asking this host for access ("Allow").
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingRequest {
    pub grant_id: String,
    pub device_name: Option<String>,
    pub platform: Option<String>,
    pub client_type: String,
    /// The same 6 digits the device shows.
    pub check_code: String,
    pub created_at: String,
    /// What the check code covered, as the last sync gave it: "Allow" writes
    /// down this device and key, and only they get a key. Memory only.
    #[serde(skip)]
    pub client_device_id: String,
    #[serde(skip)]
    pub client_public_key: String,
}

/// A device this host gave a key.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SharedDevice {
    pub grant_id: String,
    pub device_name: Option<String>,
    pub platform: Option<String>,
    pub issued_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingView {
    /// `BCDF-GHJK`.
    pub code: String,
    /// `atomic-chat://remote/pair?c=…&k=…`, for the QR code.
    pub link: String,
    /// Unix seconds.
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostView {
    pub id: String,
    pub name: String,
}

/// One computer this device uses (or waits to use).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    pub grant_id: String,
    pub host_id: String,
    pub host_name: String,
    /// `pending`, `approved`, `active`.
    pub status: String,
    /// Usable now: a key and an address.
    pub ready: bool,
    /// `lan` or `tunnel` once an address is picked.
    pub via: Option<String>,
    /// For a request: the digits to compare with the host's screen.
    pub check_code: Option<String>,
}

/// What the Remote models page shows. No keys, no addresses.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub sharing: bool,
    pub host: Option<HostView>,
    pub reach: Option<Reachability>,
    pub pairing: Option<PairingView>,
    pub requests: Vec<PendingRequest>,
    pub devices: Vec<SharedDevice>,
    pub connections: Vec<ConnectionView>,
    /// The last error of the host loop, for the status line.
    pub host_error: Option<String>,
}

/// What the provider sync needs for one ready connection. Carries the key:
/// it becomes the provider's API key in the webview, like any other.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConnection {
    pub host_id: String,
    pub host_name: String,
    pub base_url: String,
    pub api_key: String,
    /// The sequence number of the host's address list. A newer list (the
    /// host restarted its server, say) makes the webview list the models
    /// again, even when the picked address stays the same.
    pub endpoints_seq: u64,
}

#[derive(Default)]
struct Slot {
    hydrated: bool,
    file: RemoteFile,
}

/// What the latest host sync and core reads said. Memory only.
#[derive(Default, Clone)]
pub(super) struct HostMemory {
    pub reach: Option<Reachability>,
    pub requests: Vec<PendingRequest>,
    pub pairing_open: bool,
    pub error: Option<String>,
}

#[derive(Default)]
struct Tasks {
    host: Option<CancellationToken>,
    clients: HashMap<String, CancellationToken>,
}

#[derive(Default)]
pub struct RemoteState {
    slot: Mutex<Slot>,
    memory: std::sync::Mutex<HostMemory>,
    tasks: std::sync::Mutex<Tasks>,
    /// What was last announced, so an unchanged state is not announced again.
    pub(super) last_status: std::sync::Mutex<Option<RemoteStatus>>,
    pub(super) last_connections: std::sync::Mutex<Option<Vec<ProviderConnection>>>,
    /// Ends the host's long-poll early: reachability changed, or the person
    /// acted (allowed a device, opened a code).
    pub(super) host_wake: Notify,
}

impl RemoteState {
    async fn hydrated<'a>(&'a self, data_dir: &Path) -> tokio::sync::MutexGuard<'a, Slot> {
        let mut slot = self.slot.lock().await;
        if !slot.hydrated {
            slot.file = store::load(data_dir);
            slot.hydrated = true;
        }
        slot
    }

    /// Read the file.
    pub async fn read<T>(&self, data_dir: &Path, f: impl FnOnce(&RemoteFile) -> T) -> T {
        let slot = self.hydrated(data_dir).await;
        f(&slot.file)
    }

    /// Change the file; it is written only when something changed. A failed
    /// write keeps the change for this run.
    pub async fn update<T>(&self, data_dir: &Path, f: impl FnOnce(&mut RemoteFile) -> T) -> T {
        let mut slot = self.hydrated(data_dir).await;
        let before = slot.file.clone();
        let out = f(&mut slot.file);
        if slot.file != before {
            if let Err(err) = store::save(data_dir, &slot.file) {
                log::warn!("[remote] remote access file not saved: {err}");
            }
        }
        out
    }

    pub(super) fn memory(&self) -> HostMemory {
        self.memory.lock().map(|m| m.clone()).unwrap_or_default()
    }

    pub(super) fn set_memory(&self, f: impl FnOnce(&mut HostMemory)) {
        if let Ok(mut memory) = self.memory.lock() {
            f(&mut memory);
        }
    }

    /// The signed-in user's id, with the file bound to it.
    pub async fn bind_signed_in_user(
        &self,
        account: &AccountState,
        data_dir: &Path,
    ) -> Result<String, AccountError> {
        let status = account.status(data_dir).await;
        let Some(user) = status.user.filter(|_| status.signed_in) else {
            return Err(AccountError::new(codes::NOT_SIGNED_IN, "not signed in"));
        };
        let switched = self.update(data_dir, |file| file.bind_user(&user.id)).await;
        if switched {
            log::info!("[remote] another account signed in; remote access state reset");
        }
        Ok(user.id)
    }

    /// This device's key and backend id, generating and registering them on
    /// first use, or again when the backend lost the registration.
    pub async fn ensure_device(
        &self,
        account: &AccountState,
        data_dir: &Path,
        force_register: bool,
    ) -> Result<(DeviceKey, String), AccountError> {
        self.bind_signed_in_user(account, data_dir).await?;
        let (key, registered) = self
            .update(data_dir, |file| {
                let key = file
                    .device_secret
                    .as_deref()
                    .and_then(|s| DeviceKey::from_secret_b64(s).ok())
                    .unwrap_or_else(|| {
                        let key = DeviceKey::generate();
                        file.device_secret = Some(key.secret_b64());
                        file.device_id = None;
                        file.registered_key = None;
                        key
                    });
                let public = key.public_b64();
                let registered = match (&file.device_id, &file.registered_key) {
                    (Some(id), Some(k)) if *k == public => Some(id.clone()),
                    _ => None,
                };
                (key, registered)
            })
            .await;
        if let (Some(id), false) = (registered, force_register) {
            return Ok((key, id));
        }
        let public = key.public_b64();
        let device = account
            .authed(data_dir, |api, token| {
                let public = public.clone();
                async move { api.remote_register_device(&token, &public, None).await }
            })
            .await?;
        self.update(data_dir, |file| {
            file.device_id = Some(device.id.clone());
            file.registered_key = Some(public.clone());
        })
        .await;
        Ok((key, device.id))
    }

    /// What the page shows.
    pub async fn status(&self, data_dir: &Path) -> RemoteStatus {
        let memory = self.memory();
        self.read(data_dir, |file| build_status(file, &memory, now_unix()))
            .await
    }

    /// Every ready connection, for the provider sync.
    pub async fn provider_connections(&self, data_dir: &Path) -> Vec<ProviderConnection> {
        self.read(data_dir, provider_connections).await
    }

    // -- task handles ----------------------------------------------------

    /// A fresh token for the host task, cancelling the one it replaces.
    pub(super) fn arm_host(&self) -> CancellationToken {
        let token = CancellationToken::new();
        if let Ok(mut tasks) = self.tasks.lock() {
            if let Some(old) = tasks.host.replace(token.clone()) {
                old.cancel();
            }
        }
        token
    }

    pub(super) fn host_running(&self) -> bool {
        self.tasks
            .lock()
            .map(|t| t.host.as_ref().is_some_and(|c| !c.is_cancelled()))
            .unwrap_or(false)
    }

    pub(super) fn stop_host(&self) {
        if let Ok(mut tasks) = self.tasks.lock() {
            if let Some(token) = tasks.host.take() {
                token.cancel();
            }
        }
    }

    /// A token for a connection's task; `None` when one is already running.
    pub(super) fn arm_client(&self, grant_id: &str) -> Option<CancellationToken> {
        let mut tasks = self.tasks.lock().ok()?;
        if tasks
            .clients
            .get(grant_id)
            .is_some_and(|c| !c.is_cancelled())
        {
            return None;
        }
        let token = CancellationToken::new();
        tasks.clients.insert(grant_id.to_string(), token.clone());
        Some(token)
    }

    pub(super) fn stop_client(&self, grant_id: &str) {
        if let Ok(mut tasks) = self.tasks.lock() {
            if let Some(token) = tasks.clients.remove(grant_id) {
                token.cancel();
            }
        }
    }

    pub(super) fn stop_all(&self) {
        if let Ok(mut tasks) = self.tasks.lock() {
            if let Some(token) = tasks.host.take() {
                token.cancel();
            }
            for (_, token) in tasks.clients.drain() {
                token.cancel();
            }
        }
    }
}

fn pairing_view(file: &RemoteFile, now: i64) -> Option<PairingView> {
    let pairing = file.pairing.as_ref().filter(|p| p.expires_at > now)?;
    let qr = protocol::unb64u(&pairing.qr_secret).ok()?;
    let code = protocol::format_code(&pairing.code);
    Some(PairingView {
        link: protocol::pair_link(&code, &qr),
        code,
        expires_at: pairing.expires_at,
    })
}

fn connection_view(
    conn: &super::store::Connection,
    device: Option<(&str, &str)>,
) -> ConnectionView {
    let via = conn.base_url.as_ref().and_then(|url| {
        conn.endpoints
            .iter()
            .find(|e| &e.url == url)
            .map(|e| match e.kind {
                EndpointKind::Lan => "lan".to_string(),
                EndpointKind::Tunnel => "tunnel".to_string(),
            })
    });
    let check_code = (conn.method == status::METHOD_REQUEST && conn.status == status::PENDING)
        .then(|| device.map(|(id, key)| protocol::sas(&conn.host_id, id, key)))
        .flatten();
    ConnectionView {
        grant_id: conn.grant_id.clone(),
        host_id: conn.host_id.clone(),
        host_name: conn.host_name.clone(),
        status: conn.status.clone(),
        ready: conn.api_key.is_some() && conn.base_url.is_some(),
        via,
        check_code,
    }
}

pub(super) fn build_status(file: &RemoteFile, memory: &HostMemory, now: i64) -> RemoteStatus {
    let public = file
        .device_secret
        .as_deref()
        .and_then(|s| DeviceKey::from_secret_b64(s).ok())
        .map(|k| k.public_b64());
    let device = match (file.device_id.as_deref(), public.as_deref()) {
        (Some(id), Some(key)) => Some((id, key)),
        _ => None,
    };
    RemoteStatus {
        sharing: file.sharing,
        host: file.host.as_ref().map(|h| HostView {
            id: h.host_id.clone(),
            name: h.name.clone(),
        }),
        reach: memory.reach.clone(),
        pairing: if file.sharing {
            pairing_view(file, now)
        } else {
            None
        },
        requests: if file.sharing {
            memory.requests.clone()
        } else {
            Vec::new()
        },
        devices: file
            .issued
            .iter()
            .map(|k| SharedDevice {
                grant_id: k.grant_id.clone(),
                device_name: k.client_name.clone(),
                platform: k.client_platform.clone(),
                issued_at: k.issued_at,
            })
            .collect(),
        connections: file
            .connections
            .iter()
            .map(|c| connection_view(c, device))
            .collect(),
        host_error: if file.sharing {
            memory.error.clone()
        } else {
            None
        },
    }
}

pub(super) fn provider_connections(file: &RemoteFile) -> Vec<ProviderConnection> {
    file.connections
        .iter()
        .filter(|c| c.status == status::ACTIVE)
        .filter_map(|c| {
            Some(ProviderConnection {
                host_id: c.host_id.clone(),
                host_name: c.host_name.clone(),
                base_url: c.base_url.clone()?,
                api_key: c.api_key.clone()?,
                endpoints_seq: c.last_seq,
            })
        })
        .collect()
}

/// The requests a sync lists, with the check code the device also shows.
pub(super) fn pending_requests(sync: &HostSync) -> Vec<PendingRequest> {
    sync.grants
        .iter()
        .filter(|g| g.status == status::PENDING && g.method == status::METHOD_REQUEST)
        .map(|g: &HostGrant| PendingRequest {
            grant_id: g.id.clone(),
            device_name: g.client.device_name.clone(),
            platform: g.client.platform.clone(),
            client_type: g.client.client_type.clone(),
            check_code: protocol::sas(&sync.host.id, &g.client.id, &g.client_public_key),
            created_at: g.created_at.clone(),
            client_device_id: g.client.id.clone(),
            client_public_key: g.client_public_key.clone(),
        })
        .collect()
}
