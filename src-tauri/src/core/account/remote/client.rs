//! This computer as a client of another one: a connection waits on its grant
//! (`GET /grants/{id}` long-poll), opens the key the host sealed to this
//! device, confirms it, and follows the host's sealed addresses.

use std::path::Path;
use std::time::Duration;

use tauri_plugin_http::reqwest;
use tokio_util::sync::CancellationToken;

use super::api::{remote_codes, status, ClientGrant};
use super::protocol::{self, DeviceKey, Endpoint, EndpointKind, PairInput};
use super::state::{ConnectionView, RemoteState};
use super::store::Connection;
use crate::core::account::api::{codes, AccountError};
use crate::core::account::AccountState;

/// How long a LAN address gets to answer before the tunnel is used instead.
const LAN_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// Client-side refusal codes.
pub mod client_codes {
    /// The credential's MAC does not match the code this device paired
    /// with: someone else encrypted it. The grant is revoked.
    pub const UNTRUSTED_CREDENTIAL: &str = "untrusted_credential";
    pub const UNREADABLE_CREDENTIAL: &str = "unreadable_credential";
    pub const NO_SUCH_CONNECTION: &str = "no_such_connection";
}

/// What one grant read means for the connection.
#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    /// Still waiting for the host.
    Waiting,
    /// The grant ended (`denied`, `revoked`, `expired`) or is gone.
    Closed(String),
    /// The host's envelope must not be trusted: revoke and forget.
    Refuse(&'static str),
    Active {
        /// Newly opened from the envelope: the key and the grant secret.
        credential: Option<(String, String)>,
        /// The server still holds the envelope: confirm it.
        ack: bool,
        /// A newer address list.
        endpoints: Option<(u64, Vec<Endpoint>)>,
    },
}

/// Pure: decide what a grant read means, given what this device holds.
pub fn client_step(conn: &Connection, grant: &ClientGrant, key: &DeviceKey) -> Step {
    match grant.status.as_str() {
        status::PENDING | status::APPROVED => Step::Waiting,
        status::ACTIVE => {
            let mut credential = None;
            let mut grant_secret = conn.grant_secret.clone();
            if conn.api_key.is_none() {
                let Some(sealed) = &grant.credential else {
                    // Active, the envelope already gone, and no key here: the
                    // key was collected by a run that crashed before saving.
                    return Step::Refuse(client_codes::UNREADABLE_CREDENTIAL);
                };
                if conn.method == status::METHOD_CODE {
                    let secret = conn
                        .pair_secret
                        .as_deref()
                        .and_then(|s| protocol::unb64u(s).ok());
                    let trusted = match (secret, sealed.mac.as_deref()) {
                        (Some(secret), Some(mac)) => protocol::verify_credential_mac(
                            &secret,
                            &grant.id,
                            &sealed.envelope,
                            mac,
                        ),
                        _ => false,
                    };
                    if !trusted {
                        return Step::Refuse(client_codes::UNTRUSTED_CREDENTIAL);
                    }
                }
                match protocol::open_credential(key, &grant.id, &sealed.envelope) {
                    Ok(opened) => {
                        grant_secret = Some(opened.grant_secret.clone());
                        credential = Some((opened.api_key, opened.grant_secret));
                    }
                    Err(_) => return Step::Refuse(client_codes::UNREADABLE_CREDENTIAL),
                }
            }
            let ack = grant.credential.is_some();
            let endpoints = match (&grant.endpoints, grant_secret) {
                (Some(sealed), Some(secret)) => protocol::unb64u(&secret)
                    .ok()
                    .and_then(|secret| {
                        protocol::open_endpoints(&secret, &grant.id, &sealed.blob).ok()
                    })
                    // A replayed older list is ignored.
                    .filter(|payload| payload.seq > conn.last_seq)
                    .map(|payload| (payload.seq, payload.endpoints)),
                _ => None,
            };
            Step::Active {
                credential,
                ack,
                endpoints,
            }
        }
        other => Step::Closed(
            grant
                .status_reason
                .clone()
                .unwrap_or_else(|| other.to_string()),
        ),
    }
}

/// The address to use: the first LAN address that answers with this key,
/// else the tunnel, else nothing.
pub async fn pick_base_url(endpoints: &[Endpoint], api_key: &str) -> Option<String> {
    let http = reqwest::Client::builder()
        .timeout(LAN_PROBE_TIMEOUT)
        .build()
        .ok();
    if let Some(http) = http {
        for endpoint in endpoints.iter().filter(|e| e.kind == EndpointKind::Lan) {
            let probe = http
                .get(format!("{}/models", endpoint.url.trim_end_matches('/')))
                .bearer_auth(api_key)
                .send()
                .await;
            if probe.is_ok_and(|r| r.status().is_success()) {
                return Some(endpoint.url.clone());
            }
        }
    }
    endpoints
        .iter()
        .find(|e| e.kind == EndpointKind::Tunnel)
        .map(|e| e.url.clone())
}

pub struct ClientCtx<'a> {
    pub remote: &'a RemoteState,
    pub account: &'a AccountState,
    pub data_dir: &'a Path,
}

/// What a round did, for the caller to announce.
#[derive(Debug, PartialEq, Eq)]
pub enum Round {
    /// Nothing for the provider list.
    Quiet,
    /// The key, the picked address or the host's address list changed.
    ConnectionsChanged,
    /// The connection is over; its task ends.
    Ended(String),
    /// Cancelled while waiting.
    Cancelled,
}

impl ClientCtx<'_> {
    async fn connection(&self, grant_id: &str) -> Option<Connection> {
        self.remote
            .read(self.data_dir, |f| {
                f.connections
                    .iter()
                    .find(|c| c.grant_id == grant_id)
                    .cloned()
            })
            .await
    }

    async fn forget(&self, grant_id: &str) {
        self.remote
            .update(self.data_dir, |f| {
                f.connections.retain(|c| c.grant_id != grant_id)
            })
            .await;
    }

    async fn device_key(&self) -> Result<DeviceKey, AccountError> {
        self.remote
            .read(self.data_dir, |f| {
                f.device_secret
                    .as_deref()
                    .and_then(|s| DeviceKey::from_secret_b64(s).ok())
            })
            .await
            .ok_or_else(|| AccountError::new(codes::UNEXPECTED, "this device has no remote key"))
    }

    /// One long-poll of a grant and what follows from it.
    pub async fn round(
        &self,
        grant_id: &str,
        wait: u64,
        cancel: &CancellationToken,
    ) -> Result<Round, AccountError> {
        let Some(conn) = self.connection(grant_id).await else {
            return Ok(Round::Ended(client_codes::NO_SUCH_CONNECTION.to_string()));
        };
        let key = self.device_key().await?;
        let (id, after) = (grant_id.to_string(), conn.version);
        let call = self.account.authed(self.data_dir, |api, token| {
            let id = id.clone();
            async move { api.remote_grant(&token, &id, after, wait).await }
        });
        let grant = tokio::select! {
            result = call => result,
            _ = cancel.cancelled() => return Ok(Round::Cancelled),
        };
        let grant = match grant {
            Ok(grant) => grant,
            Err(err) if err.is(remote_codes::GRANT_NOT_FOUND) || err.is("not_your_grant") => {
                self.forget(grant_id).await;
                return Ok(Round::Ended(err.code));
            }
            Err(err) => return Err(err),
        };

        let step = client_step(&conn, &grant, &key);
        let version = grant.version;
        let status_now = grant.status.clone();
        let host_name = grant.host.name.clone();
        let host_offline = !grant.host.online;
        match step {
            Step::Waiting => {
                self.remote
                    .update(self.data_dir, |f| {
                        if let Some(c) = f.connections.iter_mut().find(|c| c.grant_id == grant_id) {
                            c.version = Some(version);
                            c.status = status_now;
                            c.host_name = host_name;
                            c.host_offline = host_offline;
                        }
                    })
                    .await;
                Ok(Round::Quiet)
            }
            Step::Closed(reason) => {
                log::info!("[remote] access through grant {grant_id} ended: {reason}");
                self.forget(grant_id).await;
                Ok(Round::Ended(reason))
            }
            Step::Refuse(code) => {
                log::warn!("[remote] refusing the credential of grant {grant_id}: {code}");
                let id = grant_id.to_string();
                let _ = self
                    .account
                    .authed(self.data_dir, |api, token| {
                        let id = id.clone();
                        async move { api.remote_revoke_grant(&token, &id).await }
                    })
                    .await;
                self.forget(grant_id).await;
                Ok(Round::Ended(code.to_string()))
            }
            Step::Active {
                credential,
                ack,
                endpoints,
            } => {
                // Saved before the ack: once acknowledged, the server copy is gone.
                let online_changed = self
                    .remote
                    .update(self.data_dir, |f| {
                        let Some(c) = f.connections.iter_mut().find(|c| c.grant_id == grant_id)
                        else {
                            return false;
                        };
                        if let Some((api_key, grant_secret)) = &credential {
                            c.api_key = Some(api_key.clone());
                            c.grant_secret = Some(grant_secret.clone());
                            c.pair_secret = None;
                        }
                        c.version = Some(version);
                        c.status = status_now;
                        c.host_name = host_name;
                        let changed = c.host_offline != host_offline;
                        c.host_offline = host_offline;
                        changed
                    })
                    .await;
                // A key, or the host going offline or coming back.
                let mut changed = credential.is_some() || online_changed;
                if ack {
                    let id = grant_id.to_string();
                    let acked = self
                        .account
                        .authed(self.data_dir, |api, token| {
                            let id = id.clone();
                            async move { api.remote_ack_credential(&token, &id).await }
                        })
                        .await;
                    if acked.is_ok() {
                        self.remote
                            .update(self.data_dir, |f| {
                                if let Some(c) =
                                    f.connections.iter_mut().find(|c| c.grant_id == grant_id)
                                {
                                    c.acked = true;
                                }
                            })
                            .await;
                    }
                }
                if let Some((seq, list)) = endpoints {
                    let api_key = self
                        .connection(grant_id)
                        .await
                        .and_then(|c| c.api_key)
                        .unwrap_or_default();
                    let picked = pick_base_url(&list, &api_key).await;
                    let accepted = self
                        .remote
                        .update(self.data_dir, |f| {
                            let Some(c) = f.connections.iter_mut().find(|c| c.grant_id == grant_id)
                            else {
                                return false;
                            };
                            c.last_seq = seq;
                            c.endpoints = list.clone();
                            // Offline (no address): keep the last one, so the
                            // provider stays and works again when it is back.
                            c.base_url = picked.clone().or_else(|| c.base_url.clone());
                            true
                        })
                        .await;
                    // A newer list counts even with the same address: the
                    // provider lists the host's models again.
                    changed |= accepted;
                }
                Ok(if changed {
                    Round::ConnectionsChanged
                } else {
                    Round::Quiet
                })
            }
        }
    }

    /// Re-pick the address (a LAN may have appeared or gone). True when it moved.
    pub async fn reprobe(&self, grant_id: &str) -> bool {
        let Some(conn) = self.connection(grant_id).await else {
            return false;
        };
        let (Some(api_key), false) = (conn.api_key.as_deref(), conn.endpoints.is_empty()) else {
            return false;
        };
        let Some(picked) = pick_base_url(&conn.endpoints, api_key).await else {
            return false;
        };
        self.remote
            .update(self.data_dir, |f| {
                let Some(c) = f.connections.iter_mut().find(|c| c.grant_id == grant_id) else {
                    return false;
                };
                let moved = c.base_url.as_deref() != Some(picked.as_str());
                c.base_url = Some(picked.clone());
                moved
            })
            .await
    }

    /// Ask a host for access ("Allow" on the host). Returns the new
    /// connection with the check code to compare.
    pub async fn request(&self, host_id: &str) -> Result<ConnectionView, AccountError> {
        let (key, device_id) = self
            .remote
            .ensure_device(self.account, self.data_dir, false)
            .await?;
        let id = host_id.to_string();
        let grant = self
            .account
            .authed(self.data_dir, |api, token| {
                let id = id.clone();
                async move { api.remote_request_access(&token, &id).await }
            })
            .await?;
        self.remember(&grant, None).await;
        Ok(ConnectionView {
            grant_id: grant.id.clone(),
            host_id: grant.host.id.clone(),
            host_name: grant.host.name.clone(),
            status: grant.status.clone(),
            ready: false,
            via: None,
            offline: false,
            check_code: Some(protocol::sas(&grant.host.id, &device_id, &key.public_b64())),
        })
    }

    /// Pair with a code or a pasted pair link.
    pub async fn pair(&self, input: &PairInput) -> Result<ConnectionView, AccountError> {
        let (key, _) = self
            .remote
            .ensure_device(self.account, self.data_dir, false)
            .await?;
        let proof = protocol::pair_proof(&input.secret, &key.public_b64());
        let code = input.code.clone();
        let grant = self
            .account
            .authed(self.data_dir, |api, token| {
                let (code, proof) = (code.clone(), proof.clone());
                async move { api.remote_pair(&token, &code, &proof).await }
            })
            .await?;
        self.remember(&grant, Some(protocol::b64u(&input.secret)))
            .await;
        Ok(ConnectionView {
            grant_id: grant.id.clone(),
            host_id: grant.host.id.clone(),
            host_name: grant.host.name.clone(),
            status: grant.status.clone(),
            ready: false,
            via: None,
            offline: false,
            check_code: None,
        })
    }

    /// A new grant for a host replaces this device's earlier connection to it.
    async fn remember(&self, grant: &ClientGrant, pair_secret: Option<String>) {
        let conn = Connection {
            grant_id: grant.id.clone(),
            host_id: grant.host.id.clone(),
            host_name: grant.host.name.clone(),
            method: grant.method.clone(),
            pair_secret,
            api_key: None,
            grant_secret: None,
            acked: false,
            version: None,
            last_seq: 0,
            endpoints: Vec::new(),
            base_url: None,
            status: grant.status.clone(),
            host_offline: !grant.host.online,
        };
        self.remote
            .update(self.data_dir, |f| {
                f.connections
                    .retain(|c| c.host_id != conn.host_id && c.grant_id != conn.grant_id);
                f.connections.push(conn.clone());
            })
            .await;
    }

    /// Give up access to a host: revoke the grant, forget the key.
    pub async fn disconnect(&self, host_id: &str) -> Result<Option<String>, AccountError> {
        let conn = self
            .remote
            .read(self.data_dir, |f| {
                f.connections.iter().find(|c| c.host_id == host_id).cloned()
            })
            .await;
        let Some(conn) = conn else {
            return Ok(None);
        };
        let id = conn.grant_id.clone();
        let result = self
            .account
            .authed(self.data_dir, |api, token| {
                let id = id.clone();
                async move { api.remote_revoke_grant(&token, &id).await }
            })
            .await;
        match result {
            Ok(()) => {}
            Err(err)
                if err.is(remote_codes::GRANT_NOT_FOUND) || err.is(remote_codes::INVALID_STATE) => {
            }
            Err(err) => return Err(err),
        }
        self.forget(&conn.grant_id).await;
        Ok(Some(conn.grant_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::account::remote::api::{GrantHost, SealedCredential, SealedEndpoints};

    const GRANT: &str = "6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b";

    fn conn(method: &str, pair_secret: Option<&[u8]>) -> Connection {
        Connection {
            grant_id: GRANT.to_string(),
            host_id: "h".to_string(),
            host_name: "Studio Mac".to_string(),
            method: method.to_string(),
            pair_secret: pair_secret.map(protocol::b64u),
            api_key: None,
            grant_secret: None,
            acked: false,
            version: None,
            last_seq: 0,
            endpoints: Vec::new(),
            base_url: None,
            status: "approved".to_string(),
            host_offline: false,
        }
    }

    fn grant(status: &str, method: &str) -> ClientGrant {
        ClientGrant {
            id: GRANT.to_string(),
            status: status.to_string(),
            status_reason: None,
            method: method.to_string(),
            version: 3,
            host: GrantHost {
                id: "h".to_string(),
                name: "Studio Mac".to_string(),
                client_type: "desktop".to_string(),
                platform: Some("macos".to_string()),
                online: true,
                tunnel_state: Some("online".to_string()),
            },
            credential: None,
            endpoints: None,
        }
    }

    struct Sealed {
        envelope: String,
        api_key: String,
        grant_secret: String,
    }

    fn seal_for(key: &DeviceKey) -> Sealed {
        let credential = protocol::Credential {
            v: 1,
            api_key: protocol::new_device_api_key(),
            grant_secret: protocol::new_grant_secret(),
            host_name: "Studio Mac".to_string(),
        };
        Sealed {
            envelope: protocol::seal_credential(&key.public_b64(), GRANT, &credential).unwrap(),
            api_key: credential.api_key,
            grant_secret: credential.grant_secret,
        }
    }

    fn endpoints() -> Vec<Endpoint> {
        vec![Endpoint {
            kind: EndpointKind::Tunnel,
            url: "https://a.trycloudflare.com/v1".to_string(),
        }]
    }

    #[test]
    fn waits_while_pending_or_approved() {
        let key = DeviceKey::generate();
        assert_eq!(
            client_step(&conn("request", None), &grant("pending", "request"), &key),
            Step::Waiting
        );
        assert_eq!(
            client_step(&conn("code", None), &grant("approved", "code"), &key),
            Step::Waiting
        );
    }

    #[test]
    fn opens_a_code_credential_whose_mac_matches_and_reads_its_addresses() {
        let key = DeviceKey::generate();
        let secret = b"BCDFGHJK";
        let sealed = seal_for(&key);
        let mut g = grant("active", "code");
        g.credential = Some(SealedCredential {
            mac: Some(protocol::credential_mac(secret, GRANT, &sealed.envelope)),
            envelope: sealed.envelope.clone(),
        });
        let blob_secret = protocol::unb64u(&sealed.grant_secret).unwrap();
        g.endpoints = Some(SealedEndpoints {
            blob: protocol::seal_endpoints(&blob_secret, GRANT, 5, &endpoints()).unwrap(),
        });
        match client_step(&conn("code", Some(secret)), &g, &key) {
            Step::Active {
                credential: Some((api_key, grant_secret)),
                ack: true,
                endpoints: Some((5, list)),
            } => {
                assert_eq!(api_key, sealed.api_key);
                assert_eq!(grant_secret, sealed.grant_secret);
                assert_eq!(list, endpoints());
            }
            other => panic!("unexpected step: {other:?}"),
        }
    }

    #[test]
    fn refuses_a_code_credential_with_a_foreign_mac_or_none() {
        let key = DeviceKey::generate();
        let sealed = seal_for(&key);
        let mut g = grant("active", "code");
        g.credential = Some(SealedCredential {
            mac: Some(protocol::credential_mac(
                b"ZZZZZZZZ",
                GRANT,
                &sealed.envelope,
            )),
            envelope: sealed.envelope.clone(),
        });
        assert_eq!(
            client_step(&conn("code", Some(b"BCDFGHJK")), &g, &key),
            Step::Refuse(client_codes::UNTRUSTED_CREDENTIAL)
        );
        g.credential = Some(SealedCredential {
            mac: None,
            envelope: sealed.envelope,
        });
        assert_eq!(
            client_step(&conn("code", Some(b"BCDFGHJK")), &g, &key),
            Step::Refuse(client_codes::UNTRUSTED_CREDENTIAL)
        );
    }

    #[test]
    fn a_request_credential_needs_no_mac_but_must_open() {
        let key = DeviceKey::generate();
        let sealed = seal_for(&key);
        let mut g = grant("active", "request");
        g.credential = Some(SealedCredential {
            mac: None,
            envelope: sealed.envelope,
        });
        assert!(matches!(
            client_step(&conn("request", None), &g, &key),
            Step::Active {
                credential: Some(_),
                ack: true,
                ..
            }
        ));
        // Sealed to someone else.
        assert_eq!(
            client_step(&conn("request", None), &g, &DeviceKey::generate()),
            Step::Refuse(client_codes::UNREADABLE_CREDENTIAL)
        );
    }

    #[test]
    fn ignores_an_address_list_it_has_already_seen() {
        let key = DeviceKey::generate();
        let secret = protocol::new_grant_secret();
        let mut c = conn("request", None);
        c.api_key = Some("sk-atomic-x".to_string());
        c.grant_secret = Some(secret.clone());
        c.acked = true;
        c.last_seq = 5;
        let mut g = grant("active", "request");
        let raw = protocol::unb64u(&secret).unwrap();
        g.endpoints = Some(SealedEndpoints {
            blob: protocol::seal_endpoints(&raw, GRANT, 5, &endpoints()).unwrap(),
        });
        assert_eq!(
            client_step(&c, &g, &key),
            Step::Active {
                credential: None,
                ack: false,
                endpoints: None
            }
        );
        g.endpoints = Some(SealedEndpoints {
            blob: protocol::seal_endpoints(&raw, GRANT, 6, &endpoints()).unwrap(),
        });
        assert!(matches!(
            client_step(&c, &g, &key),
            Step::Active {
                endpoints: Some((6, _)),
                ..
            }
        ));
    }

    #[test]
    fn a_closed_grant_ends_the_connection_with_its_reason() {
        let mut g = grant("revoked", "request");
        g.status_reason = Some("revoked_by_user".to_string());
        assert_eq!(
            client_step(&conn("request", None), &g, &DeviceKey::generate()),
            Step::Closed("revoked_by_user".to_string())
        );
    }

    #[tokio::test]
    async fn falls_back_to_the_tunnel_when_no_lan_address_answers() {
        let list = vec![
            Endpoint {
                kind: EndpointKind::Lan,
                // TEST-NET-1: never answers.
                url: "http://192.0.2.1:1337/v1".to_string(),
            },
            Endpoint {
                kind: EndpointKind::Tunnel,
                url: "https://a.trycloudflare.com/v1".to_string(),
            },
        ];
        assert_eq!(
            pick_base_url(&list, "k").await.as_deref(),
            Some("https://a.trycloudflare.com/v1")
        );
        assert_eq!(pick_base_url(&[], "k").await, None);
    }
}
