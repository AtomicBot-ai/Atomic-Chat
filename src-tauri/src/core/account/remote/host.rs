//! This computer as a host: one long-poll round of `POST /host/sync`, and
//! what it does about the answer.
//!
//! The host decides. A code pairing is honoured only when the device's proof
//! checks out against the code this computer showed; a request only when the
//! person clicked "Allow" here, for the device and the key its check code
//! covered. An `approved` the account service reports on its own gets
//! nothing. Each device then gets its own key for the public API, sealed to
//! the device, and its own sealed copy of the current addresses. Keys of
//! grants that are no longer live leave the core at once.

use std::collections::BTreeSet;
use std::path::Path;

use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::api::{remote_codes, status, HostGrant, HostSync};
use super::core_env::{HostEnv, Reachability};
use super::protocol::{self, Credential, Endpoint};
use super::state::{pending_requests, DeviceLeft, RemoteState};
use super::store::{AllowedRequest, HostRecord, IssuedKey, RemoteFile};
use crate::core::account::api::{codes, AccountError};
use crate::core::account::AccountState;
use crate::core::auth::state::now_unix;

/// A redeemed code still proves a device this long after it expired: the
/// device may pair in its last second and the host sync a little later.
const PAIRING_GRACE_SECS: i64 = 10 * 60;

/// A grant this host should hand a key to now.
#[derive(Clone, PartialEq, Eq)]
pub struct IssueOrder {
    pub grant_id: String,
    pub client_device_id: String,
    pub client_name: Option<String>,
    pub client_platform: Option<String>,
    pub client_public_key: String,
    /// For a code pairing: the secret the proof matched, to MAC the envelope.
    pub mac_secret: Option<Vec<u8>>,
}

impl std::fmt::Debug for IssueOrder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IssueOrder")
            .field("grant_id", &self.grant_id)
            .field("with_mac", &self.mac_secret.is_some())
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct HostPlan {
    /// Approved grants this computer did not approve: a code pairing whose
    /// proof does not check out, a request nobody allowed here (for that
    /// device and key), a method it does not know.
    pub deny: Vec<String>,
    pub issue: Vec<IssueOrder>,
    /// Active grants this computer holds no key for (its file was lost):
    /// they cannot be served, so the device has to pair again.
    pub revoke_unknown: Vec<String>,
    /// Issued keys whose grant is no longer live.
    pub dropped: Vec<String>,
    /// The open code expired past its grace. (A used one is cleared once its
    /// device got the key.)
    pub clear_pairing: bool,
}

fn pairing_secrets(file: &RemoteFile, now: i64) -> Vec<Vec<u8>> {
    let Some(pairing) = file
        .pairing
        .as_ref()
        .filter(|p| now <= p.expires_at + PAIRING_GRACE_SECS)
    else {
        return Vec::new();
    };
    let mut secrets = vec![protocol::code_secret(&pairing.code)];
    if let Ok(qr) = protocol::unb64u(&pairing.qr_secret) {
        secrets.push(qr);
    }
    secrets
}

/// The person allowed this very request here: same grant, same device, same
/// key as the check code showed.
fn allowed_here(file: &RemoteFile, grant: &HostGrant) -> bool {
    file.allowed.iter().any(|a| {
        a.grant_id == grant.id
            && a.client_device_id == grant.client.id
            && a.client_public_key == grant.client_public_key
    })
}

/// Pure: what to do about a sync answer.
pub fn plan_host(sync: &HostSync, file: &RemoteFile, now: i64) -> HostPlan {
    let mut plan = HostPlan::default();
    let secrets = pairing_secrets(file, now);
    let issued = |id: &str| file.issued.iter().any(|k| k.grant_id == id);

    for grant in &sync.grants {
        match grant.status.as_str() {
            status::APPROVED if grant.needs_credential => {
                let order = |mac_secret| IssueOrder {
                    grant_id: grant.id.clone(),
                    client_device_id: grant.client.id.clone(),
                    client_name: grant.client.device_name.clone(),
                    client_platform: grant.client.platform.clone(),
                    client_public_key: grant.client_public_key.clone(),
                    mac_secret,
                };
                match grant.method.as_str() {
                    status::METHOD_CODE => {
                        let matched = grant.proof.as_deref().and_then(|proof| {
                            secrets.iter().find(|secret| {
                                protocol::verify_pair_proof(secret, &grant.client_public_key, proof)
                            })
                        });
                        match matched {
                            Some(secret) => plan.issue.push(order(Some(secret.clone()))),
                            None => plan.deny.push(grant.id.clone()),
                        }
                    }
                    status::METHOD_REQUEST if allowed_here(file, grant) => {
                        plan.issue.push(order(None))
                    }
                    _ => plan.deny.push(grant.id.clone()),
                }
            }
            status::ACTIVE if !issued(&grant.id) => plan.revoke_unknown.push(grant.id.clone()),
            _ => {}
        }
    }

    let live: BTreeSet<&str> = sync
        .grants
        .iter()
        .filter(|g| matches!(g.status.as_str(), status::APPROVED | status::ACTIVE))
        .map(|g| g.id.as_str())
        .collect();
    plan.dropped = file
        .issued
        .iter()
        .filter(|k| !live.contains(k.grant_id.as_str()))
        .map(|k| k.grant_id.clone())
        .collect();

    if file
        .pairing
        .as_ref()
        .is_some_and(|p| now > p.expires_at + PAIRING_GRACE_SECS)
    {
        plan.clear_pairing = true;
    }
    plan
}

/// What the host last uploaded: the same addresses to the same grants need
/// no new blobs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadMark {
    endpoints: Vec<Endpoint>,
    grants: BTreeSet<String>,
}

/// Errors that only mean "this grant moved on meanwhile".
fn is_grant_race(err: &AccountError) -> bool {
    err.is(remote_codes::INVALID_STATE)
        || err.is(remote_codes::KEY_MISMATCH)
        || err.is(remote_codes::GRANT_NOT_FOUND)
}

/// Ends the round early for these, rather than carrying on.
pub fn is_fatal(err: &AccountError) -> bool {
    err.is(codes::INVALID_GRANT)
        || err.is(codes::NOT_SIGNED_IN)
        || err.is(remote_codes::HOST_NOT_FOUND)
}

pub struct HostCtx<'a> {
    pub remote: &'a RemoteState,
    pub account: &'a AccountState,
    pub data_dir: &'a Path,
    pub env: &'a dyn HostEnv,
    pub host_name: String,
}

impl HostCtx<'_> {
    /// Register the device, then this computer as a host (again when its
    /// name changed). The backend emails the owner about a new host.
    pub async fn ensure_host(&self) -> Result<HostRecord, AccountError> {
        self.remote
            .ensure_device(self.account, self.data_dir, false)
            .await?;
        let current = self.remote.read(self.data_dir, |f| f.host.clone()).await;
        if let Some(host) = current.filter(|h| h.name == self.host_name) {
            return Ok(host);
        }
        let name = self.host_name.clone();
        let result = self
            .account
            .authed(self.data_dir, |api, token| {
                let name = name.clone();
                async move { api.remote_enable_host(&token, &name).await }
            })
            .await;
        let host = match result {
            Err(err) if err.is(remote_codes::DEVICE_NOT_REGISTERED) => {
                self.remote
                    .ensure_device(self.account, self.data_dir, true)
                    .await?;
                let name = self.host_name.clone();
                self.account
                    .authed(self.data_dir, |api, token| {
                        let name = name.clone();
                        async move { api.remote_enable_host(&token, &name).await }
                    })
                    .await?
            }
            other => other?,
        };
        let record = HostRecord {
            host_id: host.id,
            name: host.name,
        };
        self.remote
            .update(self.data_dir, |f| f.host = Some(record.clone()))
            .await;
        Ok(record)
    }

    /// Allow or deny a device that asked. Only a request shown here now can
    /// be allowed, and it is written down first, with the device and the key
    /// its check code covered: only that grant, with that key, gets a key
    /// later, whatever the account service reports.
    pub async fn decide(&self, grant_id: &str, allow: bool) -> Result<(), AccountError> {
        if allow {
            let shown = self
                .remote
                .memory()
                .requests
                .into_iter()
                .find(|r| r.grant_id == grant_id);
            let Some(request) = shown else {
                return Err(AccountError::new(
                    remote_codes::GRANT_NOT_FOUND,
                    "no such request is waiting here",
                ));
            };
            let record = AllowedRequest {
                grant_id: request.grant_id,
                client_device_id: request.client_device_id,
                client_public_key: request.client_public_key,
                allowed_at: now_unix(),
            };
            self.remote
                .update(self.data_dir, |f| f.allow_request(record))
                .await;
        }
        let id = grant_id.to_string();
        let result = self
            .account
            .authed(self.data_dir, |api, token| {
                let id = id.clone();
                async move { api.remote_decide(&token, &id, allow).await }
            })
            .await;
        self.remote
            .set_memory(|m| m.requests.retain(|r| r.grant_id != grant_id));
        self.remote.host_wake.notify_one();
        result
    }

    /// Sharing off ends every device's access. Their keys leave the core
    /// first; then each live grant of this host is denied (a request still
    /// waiting) or revoked (`revoked_by_user`), so every device sees its
    /// access end and pairs again next time. The host record stays, so
    /// sharing again sends no "new computer" email. A grant the service
    /// could not end is revoked by the next round (no key for it here).
    pub async fn stop_sharing(&self) -> Result<(), AccountError> {
        let (host_id, had_code) = self
            .remote
            .update(self.data_dir, |f| {
                f.sharing = false;
                f.issued.clear();
                f.allowed.clear();
                let had_code = f.pairing.take().is_some();
                (f.host.as_ref().map(|h| h.host_id.clone()), had_code)
            })
            .await;
        self.remote.set_memory(|m| {
            m.requests.clear();
            m.pairing_open = false;
            m.error = None;
        });
        self.push_keys().await;
        if had_code {
            let _ = self
                .account
                .authed(self.data_dir, |api, token| async move {
                    api.remote_close_pairing_code(&token).await
                })
                .await;
        }
        let Some(host_id) = host_id else {
            return Ok(());
        };
        let grants = self
            .account
            .authed(self.data_dir, |api, token| async move {
                api.remote_grants(&token).await
            })
            .await?;
        let mut first_error: Option<AccountError> = None;
        for grant in grants
            .iter()
            .filter(|g| g.host_id == host_id && status::is_live(&g.status))
        {
            let (id, pending) = (grant.id.clone(), grant.status == status::PENDING);
            let result = self
                .account
                .authed(self.data_dir, |api, token| {
                    let id = id.clone();
                    async move {
                        if pending {
                            api.remote_decide(&token, &id, false).await
                        } else {
                            api.remote_revoke_grant(&token, &id).await
                        }
                    }
                })
                .await;
            match result {
                Ok(()) => {}
                Err(err) if is_grant_race(&err) => {}
                Err(err) if is_fatal(&err) => return Err(err),
                Err(err) => {
                    first_error.get_or_insert(err);
                }
            }
        }
        match first_error {
            Some(err) => Err(err),
            None => Ok(()),
        }
    }

    /// Hand the core the keys of every live grant.
    pub async fn push_keys(&self) {
        let keys = self
            .remote
            .read(self.data_dir, RemoteFile::client_keys)
            .await;
        if let Err(err) = self.env.push_client_keys(keys).await {
            log::warn!("[remote] the core did not take the device keys: {err}");
            self.remote
                .set_memory(|m| m.error = Some(format!("core: {err}")));
        }
    }

    /// One round: heartbeat + long-poll, then act on the answer. `None` when
    /// woken or cancelled before the answer came.
    pub async fn round(
        &self,
        after: Option<u64>,
        wait: u64,
        uploaded: &mut Option<UploadMark>,
        wake: &Notify,
        cancel: &CancellationToken,
    ) -> Result<Option<u64>, AccountError> {
        let host = self.ensure_host().await?;
        let reach = self.env.reachability().await;
        self.remote.set_memory(|m| m.reach = Some(reach.clone()));

        let tunnel = reach.tunnel_state();
        let lan = reach.lan;
        let call = self.account.authed(self.data_dir, |api, token| async move {
            api.remote_host_sync(&token, after, wait, Some(tunnel), Some(lan))
                .await
        });
        let sync = tokio::select! {
            result = call => result?,
            _ = wake.notified() => return Ok(None),
            _ = cancel.cancelled() => return Ok(None),
        };
        if sync.host.id != host.host_id {
            // Re-registered under a new id (the old host was removed).
            self.remote
                .update(self.data_dir, |f| {
                    f.host = Some(HostRecord {
                        host_id: sync.host.id.clone(),
                        name: sync.host.name.clone(),
                    })
                })
                .await;
        }
        self.apply(&sync, &reach, uploaded).await?;
        self.remote.set_memory(|m| {
            m.requests = pending_requests(&sync);
            m.pairing_open = sync.pairing_code.is_some();
            m.error = None;
        });
        Ok(Some(sync.state_version))
    }

    async fn apply(
        &self,
        sync: &HostSync,
        reach: &Reachability,
        uploaded: &mut Option<UploadMark>,
    ) -> Result<(), AccountError> {
        let plan = self
            .remote
            .read(self.data_dir, |f| plan_host(sync, f, now_unix()))
            .await;
        let mut first_error: Option<AccountError> = None;
        let mut keep = |result: Result<(), AccountError>| -> Result<(), AccountError> {
            match result {
                Ok(()) => Ok(()),
                Err(err) if is_fatal(&err) => Err(err),
                Err(err) if is_grant_race(&err) => Ok(()),
                Err(err) => {
                    first_error.get_or_insert(err);
                    Ok(())
                }
            }
        };

        for grant_id in &plan.deny {
            log::info!("[remote] denying grant {grant_id}: it was not approved on this computer");
            let id = grant_id.clone();
            keep(
                self.account
                    .authed(self.data_dir, |api, token| {
                        let id = id.clone();
                        async move { api.remote_decide(&token, &id, false).await }
                    })
                    .await,
            )?;
        }
        for grant_id in &plan.revoke_unknown {
            log::info!("[remote] revoking grant {grant_id}: this computer holds no key for it");
            let id = grant_id.clone();
            keep(
                self.account
                    .authed(self.data_dir, |api, token| {
                        let id = id.clone();
                        async move { api.remote_revoke_grant(&token, &id).await }
                    })
                    .await,
            )?;
        }

        let host_name = self.host_name.clone();
        let mut keys_changed = false;
        let mut activated = BTreeSet::new();
        for order in &plan.issue {
            let issued = IssuedKey {
                grant_id: order.grant_id.clone(),
                client_device_id: order.client_device_id.clone(),
                client_name: order.client_name.clone(),
                client_platform: order.client_platform.clone(),
                api_key: protocol::new_device_api_key(),
                grant_secret: protocol::new_grant_secret(),
                issued_at: now_unix(),
            };
            let credential = Credential {
                v: 1,
                api_key: issued.api_key.clone(),
                grant_secret: issued.grant_secret.clone(),
                host_name: host_name.clone(),
            };
            let envelope = match protocol::seal_credential(
                &order.client_public_key,
                &order.grant_id,
                &credential,
            ) {
                Ok(envelope) => envelope,
                Err(err) => {
                    log::warn!("[remote] cannot seal grant {}: {err}", order.grant_id);
                    continue;
                }
            };
            let mac = order
                .mac_secret
                .as_ref()
                .map(|secret| protocol::credential_mac(secret, &order.grant_id, &envelope));

            // Written before it is sent: a crash in between leaves a key for a
            // grant that never activated, which the next round drops.
            self.remote
                .update(self.data_dir, |f| {
                    f.issued.retain(|k| k.grant_id != issued.grant_id);
                    f.issued.push(issued.clone());
                })
                .await;
            let (id, public) = (order.grant_id.clone(), order.client_public_key.clone());
            let result = self
                .account
                .authed(self.data_dir, |api, token| {
                    let (id, envelope, mac, public) =
                        (id.clone(), envelope.clone(), mac.clone(), public.clone());
                    async move {
                        api.remote_upload_credential(
                            &token,
                            &id,
                            &envelope,
                            mac.as_deref(),
                            &public,
                        )
                        .await
                    }
                })
                .await;
            match result {
                Ok(()) => {
                    log::info!("[remote] gave grant {} its key", order.grant_id);
                    keys_changed = true;
                    activated.insert(order.grant_id.clone());
                }
                Err(err) => {
                    self.remote
                        .update(self.data_dir, |f| {
                            f.issued.retain(|k| k.grant_id != order.grant_id)
                        })
                        .await;
                    keep(Err(err))?;
                }
            }
        }

        // A used code is done once its device holds the key; a failed upload
        // keeps it for the next round.
        let code_used = plan
            .issue
            .iter()
            .any(|o| o.mac_secret.is_some() && activated.contains(&o.grant_id));
        // Allowed requests wait only while their grant does, and until their
        // key is out.
        let waiting: BTreeSet<&str> = sync
            .grants
            .iter()
            .filter(|g| matches!(g.status.as_str(), status::PENDING | status::APPROVED))
            .map(|g| g.id.as_str())
            .filter(|id| !activated.contains(*id))
            .collect();
        // Keep shown names current; drop keys of grants that ended.
        let renamed: Vec<_> = sync
            .grants
            .iter()
            .map(|g| {
                (
                    g.id.clone(),
                    g.client.device_name.clone(),
                    g.client.platform.clone(),
                )
            })
            .collect();
        let dropped = plan.dropped.clone();
        let clear_pairing = plan.clear_pairing || code_used;
        let (removed, left) = self
            .remote
            .update(self.data_dir, |f| {
                for (id, name, platform) in &renamed {
                    if let Some(key) = f.issued.iter_mut().find(|k| &k.grant_id == id) {
                        key.client_name = name.clone();
                        key.client_platform = platform.clone();
                    }
                }
                f.allowed.retain(|a| waiting.contains(a.grant_id.as_str()));
                // Their grant ended from the device's side: this computer's own
                // revoke and "stop sharing" remove the key before it gets here.
                let left: Vec<DeviceLeft> = f
                    .issued
                    .iter()
                    .filter(|k| dropped.contains(&k.grant_id))
                    .map(|k| DeviceLeft {
                        grant_id: k.grant_id.clone(),
                        device_name: k.client_name.clone(),
                    })
                    .collect();
                f.issued.retain(|k| !dropped.contains(&k.grant_id));
                if clear_pairing {
                    f.pairing = None;
                }
                (!left.is_empty(), left)
            })
            .await;
        if !left.is_empty() {
            self.remote.set_memory(|m| m.left.extend(left));
        }
        if keys_changed || removed {
            self.push_keys().await;
        }

        // Addresses: every active grant this computer holds a key for.
        let active: BTreeSet<String> = sync
            .grants
            .iter()
            .filter(|g| g.status == status::ACTIVE)
            .map(|g| g.id.clone())
            .chain(activated)
            .collect();
        let targets: Vec<(String, String)> = self
            .remote
            .read(self.data_dir, |f| {
                f.issued
                    .iter()
                    .filter(|k| active.contains(&k.grant_id))
                    .map(|k| (k.grant_id.clone(), k.grant_secret.clone()))
                    .collect()
            })
            .await;
        let mark = UploadMark {
            endpoints: reach.endpoints.clone(),
            grants: targets.iter().map(|(id, _)| id.clone()).collect(),
        };
        if !targets.is_empty() && uploaded.as_ref() != Some(&mark) {
            let seq = self
                .remote
                .update(self.data_dir, |f| {
                    f.endpoints_seq += 1;
                    f.endpoints_seq
                })
                .await;
            let items: Vec<(String, String)> = targets
                .iter()
                .filter_map(|(id, secret)| {
                    let secret = protocol::unb64u(secret).ok()?;
                    let blob = protocol::seal_endpoints(&secret, id, seq, &reach.endpoints).ok()?;
                    Some((id.clone(), blob))
                })
                .collect();
            let result = self
                .account
                .authed(self.data_dir, |api, token| {
                    let items = items.clone();
                    async move { api.remote_upload_endpoints(&token, &items).await }
                })
                .await;
            match result {
                Ok(()) => *uploaded = Some(mark),
                Err(err) => {
                    *uploaded = None;
                    keep(Err(err))?;
                }
            }
        }

        match first_error {
            Some(err) => Err(err),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::account::remote::api::{DeviceInfo, HostGrant, RemoteHost};
    use crate::core::account::remote::store::PairingRecord;

    const HOST: &str = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const DEVICE: &str = "11111111-2222-4333-8444-555555555555";
    const DEVICE_PUBLIC: &str = "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9_AsrhtHHw";

    fn grant(id: &str, status: &str, method: &str, proof: Option<String>) -> HostGrant {
        HostGrant {
            id: id.to_string(),
            status: status.to_string(),
            method: method.to_string(),
            client: DeviceInfo {
                id: DEVICE.to_string(),
                client_type: "mobile".to_string(),
                device_name: Some("Ann's iPhone".to_string()),
                platform: Some("ios".to_string()),
            },
            client_public_key: DEVICE_PUBLIC.to_string(),
            proof,
            needs_credential: status == "approved",
            credential_collected: false,
            created_at: "2026-11-12T10:00:00Z".to_string(),
            decided_at: None,
        }
    }

    fn sync(grants: Vec<HostGrant>) -> HostSync {
        HostSync {
            host: RemoteHost {
                id: HOST.to_string(),
                name: "Studio Mac".to_string(),
            },
            state_version: 4,
            grants,
            pairing_code: None,
        }
    }

    fn file_with_code(now: i64) -> (RemoteFile, Vec<u8>) {
        let qr = protocol::new_qr_secret();
        let file = RemoteFile {
            sharing: true,
            pairing: Some(PairingRecord {
                code: "BCDFGHJK".to_string(),
                qr_secret: protocol::b64u(&qr),
                expires_at: now + 300,
            }),
            ..RemoteFile::default()
        };
        (file, qr.to_vec())
    }

    fn allowed(grant_id: &str, device_id: &str, public_key: &str) -> AllowedRequest {
        AllowedRequest {
            grant_id: grant_id.to_string(),
            client_device_id: device_id.to_string(),
            client_public_key: public_key.to_string(),
            allowed_at: 0,
        }
    }

    fn issued(grant_id: &str) -> IssuedKey {
        IssuedKey {
            grant_id: grant_id.to_string(),
            client_device_id: "d".to_string(),
            client_name: None,
            client_platform: None,
            api_key: "sk-atomic-x".to_string(),
            grant_secret: protocol::new_grant_secret(),
            issued_at: 0,
        }
    }

    #[test]
    fn a_proof_made_with_the_qr_secret_gets_a_key_and_a_mac() {
        let now = 1_000;
        let (file, qr) = file_with_code(now);
        let proof = protocol::pair_proof(&qr, DEVICE_PUBLIC);
        let plan = plan_host(
            &sync(vec![grant("g1", "approved", "code", Some(proof))]),
            &file,
            now,
        );
        assert_eq!(plan.issue.len(), 1);
        assert_eq!(plan.issue[0].mac_secret.as_deref(), Some(qr.as_slice()));
        assert!(plan.deny.is_empty());
        // The code is cleared once the key is out, by the round, not the plan.
        assert!(!plan.clear_pairing);
    }

    #[test]
    fn a_proof_made_with_the_typed_code_also_counts() {
        let now = 1_000;
        let (file, _) = file_with_code(now);
        let proof = protocol::pair_proof(b"BCDFGHJK", DEVICE_PUBLIC);
        let plan = plan_host(
            &sync(vec![grant("g1", "approved", "code", Some(proof))]),
            &file,
            now,
        );
        assert_eq!(
            plan.issue[0].mac_secret.as_deref(),
            Some(b"BCDFGHJK".as_slice())
        );
    }

    #[test]
    fn a_wrong_or_missing_proof_is_denied() {
        let now = 1_000;
        let (file, _) = file_with_code(now);
        let wrong = protocol::pair_proof(b"ZZZZZZZZ", DEVICE_PUBLIC);
        let plan = plan_host(
            &sync(vec![
                grant("g1", "approved", "code", Some(wrong)),
                grant("g2", "approved", "code", None),
            ]),
            &file,
            now,
        );
        assert_eq!(plan.deny, ["g1", "g2"]);
        assert!(plan.issue.is_empty());
    }

    #[test]
    fn a_code_pairing_without_a_known_code_is_denied() {
        let proof = protocol::pair_proof(b"BCDFGHJK", DEVICE_PUBLIC);
        let file = RemoteFile::default();
        let plan = plan_host(
            &sync(vec![grant("g1", "approved", "code", Some(proof))]),
            &file,
            0,
        );
        assert_eq!(plan.deny, ["g1"]);
    }

    #[test]
    fn an_expired_code_no_longer_proves_anything() {
        let now = 1_000;
        let (file, qr) = file_with_code(now);
        let later = now + 300 + PAIRING_GRACE_SECS + 1;
        let proof = protocol::pair_proof(&qr, DEVICE_PUBLIC);
        let plan = plan_host(
            &sync(vec![grant("g1", "approved", "code", Some(proof))]),
            &file,
            later,
        );
        assert_eq!(plan.deny, ["g1"]);
        assert!(plan.clear_pairing);
    }

    #[test]
    fn a_request_allowed_here_gets_a_key_without_a_mac_and_pending_ones_wait() {
        let file = RemoteFile {
            allowed: vec![allowed("g1", DEVICE, DEVICE_PUBLIC)],
            ..RemoteFile::default()
        };
        let plan = plan_host(
            &sync(vec![
                grant("g1", "approved", "request", None),
                grant("g2", "pending", "request", None),
            ]),
            &file,
            0,
        );
        assert_eq!(plan.issue.len(), 1);
        assert_eq!(plan.issue[0].grant_id, "g1");
        assert!(plan.issue[0].mac_secret.is_none());
        assert!(plan.deny.is_empty());
    }

    /// The account service says "approved", but this computer never allowed
    /// that grant for that device and key: it gets nothing and is denied.
    #[test]
    fn an_approved_request_not_allowed_here_for_that_device_and_key_is_denied() {
        let other_key = "A".repeat(43);
        let cases: [(&str, Vec<AllowedRequest>); 4] = [
            ("nobody allowed anything here", vec![]),
            (
                "another grant was allowed",
                vec![allowed("g9", DEVICE, DEVICE_PUBLIC)],
            ),
            (
                "the key changed after the check code",
                vec![allowed("g1", DEVICE, &other_key)],
            ),
            (
                "another device was allowed",
                vec![allowed(
                    "g1",
                    "99999999-2222-4333-8444-555555555555",
                    DEVICE_PUBLIC,
                )],
            ),
        ];
        for (name, allowed) in cases {
            let file = RemoteFile {
                allowed,
                ..RemoteFile::default()
            };
            let plan = plan_host(
                &sync(vec![grant("g1", "approved", "request", None)]),
                &file,
                0,
            );
            assert!(plan.issue.is_empty(), "{name}: issued a key");
            assert_eq!(plan.deny, ["g1"], "{name}: not denied");
        }
    }

    #[test]
    fn an_approved_grant_of_an_unknown_method_is_denied() {
        let now = 1_000;
        let (mut file, qr) = file_with_code(now);
        file.allowed = vec![allowed("g1", DEVICE, DEVICE_PUBLIC)];
        let proof = protocol::pair_proof(&qr, DEVICE_PUBLIC);
        let plan = plan_host(
            &sync(vec![grant("g1", "approved", "anything", Some(proof))]),
            &file,
            now,
        );
        assert!(plan.issue.is_empty());
        assert_eq!(plan.deny, ["g1"]);
    }

    #[test]
    fn keys_of_grants_gone_from_sync_are_dropped() {
        let file = RemoteFile {
            issued: vec![issued("g1"), issued("g2")],
            ..RemoteFile::default()
        };
        let plan = plan_host(&sync(vec![grant("g1", "active", "code", None)]), &file, 0);
        assert_eq!(plan.dropped, ["g2"]);
        assert!(plan.revoke_unknown.is_empty());
    }

    #[test]
    fn an_active_grant_without_a_local_key_is_revoked() {
        let plan = plan_host(
            &sync(vec![grant("g1", "active", "request", None)]),
            &RemoteFile::default(),
            0,
        );
        assert_eq!(plan.revoke_unknown, ["g1"]);
    }
}
