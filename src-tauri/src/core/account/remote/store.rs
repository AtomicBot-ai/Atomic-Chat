//! `atomic-remote.json`: this install's remote-access secrets, owner-readable
//! only, next to `atomic-account.json` and written the same way (temp file,
//! then rename).
//!
//! It holds the device's X25519 private key, the keys this computer handed
//! out as a host, and the keys it received as a client. It belongs to one
//! account: a different signed-in user starts from an empty file.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::protocol::Endpoint;
use crate::core::account::store::write_owner_only;

pub const REMOTE_FILE_NAME: &str = "atomic-remote.json";
pub const REMOTE_FILE_VERSION: u32 = 1;

/// This computer as a host: the backend's id for it and its shown name.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostRecord {
    pub host_id: String,
    pub name: String,
}

/// The open pairing code's secrets, kept until a device redeems it so the
/// proof can still be checked after a restart.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PairingRecord {
    /// Normalized, no dash.
    pub code: String,
    /// The QR secret, base64url.
    pub qr_secret: String,
    pub expires_at: i64,
}

/// A key this host gave a device.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IssuedKey {
    pub grant_id: String,
    pub client_device_id: String,
    #[serde(default)]
    pub client_name: Option<String>,
    #[serde(default)]
    pub client_platform: Option<String>,
    pub api_key: String,
    pub grant_secret: String,
    pub issued_at: i64,
}

impl std::fmt::Debug for IssuedKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IssuedKey")
            .field("grant_id", &self.grant_id)
            .field("client_device_id", &self.client_device_id)
            .finish_non_exhaustive()
    }
}

/// Access this device has, or is waiting for, to another computer's models.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Connection {
    pub grant_id: String,
    pub host_id: String,
    pub host_name: String,
    /// `code` or `request`.
    pub method: String,
    /// The secret the pairing proof was made with (QR secret or code
    /// letters, base64url); checks the credential MAC, then is dropped.
    #[serde(default)]
    pub pair_secret: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub grant_secret: Option<String>,
    #[serde(default)]
    pub acked: bool,
    /// The grant version last seen, for the long-poll.
    #[serde(default)]
    pub version: Option<u64>,
    /// The endpoints blob's sequence number last accepted.
    #[serde(default)]
    pub last_seq: u64,
    #[serde(default)]
    pub endpoints: Vec<Endpoint>,
    /// The address last picked from `endpoints`.
    #[serde(default)]
    pub base_url: Option<String>,
    /// The grant status last seen.
    #[serde(default)]
    pub status: String,
}

impl std::fmt::Debug for Connection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Connection")
            .field("grant_id", &self.grant_id)
            .field("host_id", &self.host_id)
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteFile {
    pub version: u32,
    /// The account this file belongs to.
    #[serde(default)]
    pub user_id: Option<String>,
    /// X25519 private key, base64url.
    #[serde(default)]
    pub device_secret: Option<String>,
    /// The backend's id for this device, once registered with the current key.
    #[serde(default)]
    pub device_id: Option<String>,
    /// The public key that `device_id` was registered with.
    #[serde(default)]
    pub registered_key: Option<String>,
    /// The person turned sharing on.
    #[serde(default)]
    pub sharing: bool,
    #[serde(default)]
    pub host: Option<HostRecord>,
    #[serde(default)]
    pub pairing: Option<PairingRecord>,
    #[serde(default)]
    pub issued: Vec<IssuedKey>,
    /// The last sequence number the host sealed endpoints with. Monotonic
    /// across restarts: a device ignores a number it has already seen.
    #[serde(default)]
    pub endpoints_seq: u64,
    #[serde(default)]
    pub connections: Vec<Connection>,
}

impl std::fmt::Debug for RemoteFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteFile")
            .field("user_id", &self.user_id)
            .field("sharing", &self.sharing)
            .field("issued", &self.issued.len())
            .field("connections", &self.connections.len())
            .finish_non_exhaustive()
    }
}

impl Default for RemoteFile {
    fn default() -> Self {
        Self {
            version: REMOTE_FILE_VERSION,
            user_id: None,
            device_secret: None,
            device_id: None,
            registered_key: None,
            sharing: false,
            host: None,
            pairing: None,
            issued: Vec::new(),
            endpoints_seq: 0,
            connections: Vec::new(),
        }
    }
}

impl RemoteFile {
    /// Forget what the install shared and received; the backend has already
    /// ended it (sign-out, session lost, a new sign-in). The device key stays.
    pub fn end_access(&mut self) {
        self.sharing = false;
        self.host = None;
        self.pairing = None;
        self.issued.clear();
        self.connections.clear();
    }

    /// Bind the file to `user_id`; another account's file starts over.
    /// True when anything was dropped.
    pub fn bind_user(&mut self, user_id: &str) -> bool {
        match self.user_id.as_deref() {
            Some(current) if current == user_id => false,
            None if self.is_blank() => {
                self.user_id = Some(user_id.to_string());
                false
            }
            _ => {
                *self = Self {
                    user_id: Some(user_id.to_string()),
                    endpoints_seq: self.endpoints_seq,
                    ..Self::default()
                };
                true
            }
        }
    }

    fn is_blank(&self) -> bool {
        self.device_secret.is_none()
            && self.host.is_none()
            && self.issued.is_empty()
            && self.connections.is_empty()
    }

    /// The keys core must accept besides the server's own.
    pub fn client_keys(&self) -> Vec<String> {
        if !self.sharing {
            return Vec::new();
        }
        self.issued.iter().map(|k| k.api_key.clone()).collect()
    }
}

pub fn remote_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(REMOTE_FILE_NAME)
}

/// Read the file; a missing, corrupt or future-versioned file reads as empty.
pub fn load(data_dir: &Path) -> RemoteFile {
    let Ok(raw) = fs::read_to_string(remote_file_path(data_dir)) else {
        return RemoteFile::default();
    };
    match serde_json::from_str::<RemoteFile>(&raw) {
        Ok(file) if file.version == REMOTE_FILE_VERSION => file,
        Ok(file) => {
            log::warn!(
                "[remote] ignoring remote access file version {} (expected {REMOTE_FILE_VERSION})",
                file.version
            );
            RemoteFile::default()
        }
        Err(err) => {
            log::warn!("[remote] ignoring unreadable remote access file: {err}");
            RemoteFile::default()
        }
    }
}

pub fn save(data_dir: &Path, file: &RemoteFile) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|e| format!("cannot create data folder: {e}"))?;
    let path = remote_file_path(data_dir);
    let tmp = data_dir.join(format!("{REMOTE_FILE_NAME}.tmp"));
    let body = serde_json::to_string_pretty(file)
        .map_err(|e| format!("cannot serialize remote access state: {e}"))?;
    write_owner_only(&tmp, body.as_bytes())?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("cannot replace remote access file: {e}")
    })
}
