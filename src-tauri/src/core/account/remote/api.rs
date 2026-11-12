//! `/v1/remote/*` on the account API client: wire format only. Shapes mirror
//! the backend's `libs/dto/remote.py`; the values that matter are sealed
//! before they get here (`protocol.rs`).

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri_plugin_http::reqwest::Method;

use crate::core::account::api::{codes, AccountApi, AccountError};

/// The longest wait the backend allows on a long-poll.
pub const MAX_WAIT_SECS: u64 = 25;
/// How long a long-poll may take beyond its wait before it counts as lost.
const LONG_POLL_GRACE: Duration = Duration::from_secs(15);

/// Backend error codes this module acts on.
pub mod remote_codes {
    pub const HOST_NOT_FOUND: &str = "host_not_found";
    pub const GRANT_NOT_FOUND: &str = "grant_not_found";
    pub const KEY_MISMATCH: &str = "key_mismatch";
    pub const INVALID_STATE: &str = "invalid_state";
    pub const DEVICE_NOT_REGISTERED: &str = "device_not_registered";
    pub const INVALID_CODE: &str = "invalid_code";
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct RemoteDevice {
    pub id: String,
    pub client_type: String,
    pub device_name: Option<String>,
    pub platform: Option<String>,
    pub public_key: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct RemoteHost {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct DeviceInfo {
    pub id: String,
    pub client_type: String,
    pub device_name: Option<String>,
    pub platform: Option<String>,
}

/// A live grant as its host sees it in sync.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct HostGrant {
    pub id: String,
    pub status: String,
    pub method: String,
    pub client: DeviceInfo,
    pub client_public_key: String,
    pub proof: Option<String>,
    pub needs_credential: bool,
    pub credential_collected: bool,
    pub created_at: String,
    pub decided_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PairingCodeState {
    pub expires_at: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct HostSync {
    pub host: RemoteHost,
    pub state_version: u64,
    pub grants: Vec<HostGrant>,
    pub pairing_code: Option<PairingCodeState>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PairingCode {
    pub code: String,
    pub expires_in: u64,
    pub expires_at: String,
}

/// What the host tells the backend about its reachability in each sync.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TunnelState {
    Online,
    Off,
    Error,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct GrantSummary {
    pub id: String,
    pub status: String,
}

/// One of the account's hosts. Never carries an address.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct HostInfo {
    pub id: String,
    pub name: String,
    pub client_type: String,
    pub platform: Option<String>,
    pub online: bool,
    pub tunnel_state: Option<String>,
    pub lan_enabled: bool,
    pub last_seen_at: Option<String>,
    pub created_at: String,
    pub is_self: bool,
    pub my_grant: Option<GrantSummary>,
}

#[derive(Deserialize)]
struct HostsResponse {
    hosts: Vec<HostInfo>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct GrantHost {
    pub id: String,
    pub name: String,
    pub client_type: String,
    pub platform: Option<String>,
    pub online: bool,
    pub tunnel_state: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct SealedCredential {
    pub envelope: String,
    pub mac: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct SealedEndpoints {
    pub blob: String,
}

/// A grant as its device sees it: the mailbox from the host.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct ClientGrant {
    pub id: String,
    pub status: String,
    pub status_reason: Option<String>,
    pub method: String,
    pub version: u64,
    pub host: GrantHost,
    pub credential: Option<SealedCredential>,
    pub endpoints: Option<SealedEndpoints>,
}

/// Every grant of the account, for "who has access".
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct GrantListItem {
    pub id: String,
    pub status: String,
    pub status_reason: Option<String>,
    pub method: String,
    pub host_id: String,
    pub host_name: String,
    pub client: DeviceInfo,
    pub created_at: String,
    pub decided_at: Option<String>,
    pub updated_at: String,
}

#[derive(Deserialize)]
struct GrantsResponse {
    grants: Vec<GrantListItem>,
}

pub mod status {
    pub const PENDING: &str = "pending";
    pub const APPROVED: &str = "approved";
    pub const ACTIVE: &str = "active";
    pub const METHOD_CODE: &str = "code";
    pub const METHOD_REQUEST: &str = "request";

    /// Still able to become or stay active.
    pub fn is_live(status: &str) -> bool {
        matches!(status, PENDING | APPROVED | ACTIVE)
    }
}

/// An id from the backend goes into a path only as a UUID.
pub fn checked_id(id: &str) -> Result<&str, AccountError> {
    let valid = id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        });
    if valid {
        Ok(id)
    } else {
        Err(AccountError::new(
            codes::INVALID_REQUEST,
            "not a remote access id",
        ))
    }
}

fn long_poll_timeout(wait: u64) -> Duration {
    Duration::from_secs(wait.min(MAX_WAIT_SECS)) + LONG_POLL_GRACE
}

impl AccountApi {
    pub async fn remote_register_device(
        &self,
        token: &str,
        public_key: &str,
        device_name: Option<&str>,
    ) -> Result<RemoteDevice, AccountError> {
        let mut body = json!({ "public_key": public_key });
        if let Some(name) = device_name {
            body["device_name"] = json!(name);
        }
        self.call_json(Method::PUT, "/v1/remote/device", Some(token), Some(body))
            .await
    }

    pub async fn remote_enable_host(
        &self,
        token: &str,
        name: &str,
    ) -> Result<RemoteHost, AccountError> {
        self.call_json(
            Method::PUT,
            "/v1/remote/host",
            Some(token),
            Some(json!({ "name": name })),
        )
        .await
    }

    pub async fn remote_disable_host(&self, token: &str) -> Result<(), AccountError> {
        self.call(Method::DELETE, "/v1/remote/host", Some(token), None)
            .await
            .map(|_| ())
    }

    pub async fn remote_host_sync(
        &self,
        token: &str,
        after: Option<u64>,
        wait: u64,
        tunnel: Option<TunnelState>,
        lan: Option<bool>,
    ) -> Result<HostSync, AccountError> {
        let mut body = json!({ "wait": wait.min(MAX_WAIT_SECS) });
        if let Some(after) = after {
            body["after"] = json!(after);
        }
        if let Some(tunnel) = tunnel {
            body["tunnel"] = json!(tunnel);
        }
        if let Some(lan) = lan {
            body["lan"] = json!(lan);
        }
        self.call_json_timed(
            Method::POST,
            "/v1/remote/host/sync",
            Some(token),
            Some(body),
            long_poll_timeout(wait),
        )
        .await
    }

    pub async fn remote_create_pairing_code(
        &self,
        token: &str,
    ) -> Result<PairingCode, AccountError> {
        self.call_json(
            Method::POST,
            "/v1/remote/host/pairing-code",
            Some(token),
            None,
        )
        .await
    }

    pub async fn remote_close_pairing_code(&self, token: &str) -> Result<(), AccountError> {
        self.call(
            Method::DELETE,
            "/v1/remote/host/pairing-code",
            Some(token),
            None,
        )
        .await
        .map(|_| ())
    }

    /// All or nothing: every grant must be an active grant of this host.
    pub async fn remote_upload_endpoints(
        &self,
        token: &str,
        items: &[(String, String)],
    ) -> Result<(), AccountError> {
        let items: Vec<_> = items
            .iter()
            .map(|(grant_id, blob)| json!({ "grant_id": grant_id, "blob": blob }))
            .collect();
        self.call(
            Method::PUT,
            "/v1/remote/host/endpoints",
            Some(token),
            Some(json!({ "items": items })),
        )
        .await
        .map(|_| ())
    }

    pub async fn remote_hosts(&self, token: &str) -> Result<Vec<HostInfo>, AccountError> {
        let body: HostsResponse = self
            .call_json(Method::GET, "/v1/remote/hosts", Some(token), None)
            .await?;
        Ok(body.hosts)
    }

    pub async fn remote_delete_host(&self, token: &str, host_id: &str) -> Result<(), AccountError> {
        let id = checked_id(host_id)?;
        self.call(
            Method::DELETE,
            &format!("/v1/remote/hosts/{id}"),
            Some(token),
            None,
        )
        .await
        .map(|_| ())
    }

    pub async fn remote_request_access(
        &self,
        token: &str,
        host_id: &str,
    ) -> Result<ClientGrant, AccountError> {
        let id = checked_id(host_id)?;
        self.call_json(
            Method::POST,
            &format!("/v1/remote/hosts/{id}/requests"),
            Some(token),
            None,
        )
        .await
    }

    pub async fn remote_pair(
        &self,
        token: &str,
        code: &str,
        proof: &str,
    ) -> Result<ClientGrant, AccountError> {
        self.call_json(
            Method::POST,
            "/v1/remote/pair",
            Some(token),
            Some(json!({ "code": code, "proof": proof })),
        )
        .await
    }

    pub async fn remote_grants(&self, token: &str) -> Result<Vec<GrantListItem>, AccountError> {
        let body: GrantsResponse = self
            .call_json(Method::GET, "/v1/remote/grants", Some(token), None)
            .await?;
        Ok(body.grants)
    }

    pub async fn remote_grant(
        &self,
        token: &str,
        grant_id: &str,
        after: Option<u64>,
        wait: u64,
    ) -> Result<ClientGrant, AccountError> {
        let id = checked_id(grant_id)?;
        let wait = wait.min(MAX_WAIT_SECS);
        let path = match after {
            Some(after) => format!("/v1/remote/grants/{id}?after={after}&wait={wait}"),
            None => format!("/v1/remote/grants/{id}?wait={wait}"),
        };
        self.call_json_timed(
            Method::GET,
            &path,
            Some(token),
            None,
            long_poll_timeout(wait),
        )
        .await
    }

    pub async fn remote_revoke_grant(
        &self,
        token: &str,
        grant_id: &str,
    ) -> Result<(), AccountError> {
        let id = checked_id(grant_id)?;
        self.call(
            Method::DELETE,
            &format!("/v1/remote/grants/{id}"),
            Some(token),
            None,
        )
        .await
        .map(|_| ())
    }

    /// `allow` approves a pending request; otherwise denies it (or a code
    /// pairing whose proof did not check out).
    pub async fn remote_decide(
        &self,
        token: &str,
        grant_id: &str,
        allow: bool,
    ) -> Result<(), AccountError> {
        let id = checked_id(grant_id)?;
        let verb = if allow { "approve" } else { "deny" };
        self.call(
            Method::POST,
            &format!("/v1/remote/grants/{id}/{verb}"),
            Some(token),
            None,
        )
        .await
        .map(|_| ())
    }

    pub async fn remote_upload_credential(
        &self,
        token: &str,
        grant_id: &str,
        envelope: &str,
        mac: Option<&str>,
        client_public_key: &str,
    ) -> Result<(), AccountError> {
        let id = checked_id(grant_id)?;
        let mut body = json!({ "envelope": envelope, "client_public_key": client_public_key });
        if let Some(mac) = mac {
            body["mac"] = json!(mac);
        }
        self.call(
            Method::PUT,
            &format!("/v1/remote/grants/{id}/credential"),
            Some(token),
            Some(body),
        )
        .await
        .map(|_| ())
    }

    pub async fn remote_ack_credential(
        &self,
        token: &str,
        grant_id: &str,
    ) -> Result<(), AccountError> {
        let id = checked_id(grant_id)?;
        self.call(
            Method::POST,
            &format!("/v1/remote/grants/{id}/credential/ack"),
            Some(token),
            None,
        )
        .await
        .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_uuids_go_into_paths() {
        assert!(checked_id("6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b").is_ok());
        assert!(checked_id("../me").is_err());
        assert!(checked_id("6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b/approve").is_err());
        assert!(checked_id("6f1c2a3b_4d5e-4f60-8a9b-0c1d2e3f4a5b").is_err());
    }

    #[test]
    fn long_polls_wait_at_most_what_the_backend_allows() {
        assert_eq!(long_poll_timeout(60), Duration::from_secs(40));
        assert_eq!(long_poll_timeout(0), Duration::from_secs(15));
    }
}
