//! Host and client rounds against a fake account API, with a fake core.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{json, Value};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::client::{client_codes, ClientCtx, Round};
use super::core_env::{HostEnv, Reachability};
use super::host::{HostCtx, UploadMark};
use super::protocol::{self, DeviceKey, Endpoint, EndpointKind};
use super::state::{build_status, HostMemory, RemoteState};
use super::store::{self, PairingRecord, RemoteFile, REMOTE_FILE_NAME};
use crate::core::account::tests::{spawn_fake, token_response, Fake, Seen};
use crate::core::account::AccountState;
use crate::core::auth::state::now_unix;

const DEVICE_ID: &str = "aaaaaaaa-0000-4000-8000-000000000001";
const HOST_ID: &str = "bbbbbbbb-0000-4000-8000-000000000002";
const PHONE_ID: &str = "cccccccc-0000-4000-8000-000000000003";
const GRANT_ID: &str = "dddddddd-0000-4000-8000-000000000004";

/// What the fake backend answers with; tests change it between rounds.
#[derive(Default)]
struct World {
    grants: Vec<Value>,
    state_version: u64,
    /// For the client side: the grant a device reads.
    client_grant: Option<Value>,
}

fn host_grant(status: &str, method: &str, public_key: &str, proof: Option<&str>) -> Value {
    json!({
        "id": GRANT_ID,
        "status": status,
        "method": method,
        "client": {"id": PHONE_ID, "client_type": "mobile", "device_name": "Ann's iPhone", "platform": "ios"},
        "client_public_key": public_key,
        "proof": proof,
        "needs_credential": status == "approved",
        "credential_collected": false,
        "endpoints_updated_at": null,
        "created_at": "2026-11-12T10:00:00Z",
        "decided_at": null
    })
}

fn spawn_world(world: Arc<Mutex<World>>) -> Fake {
    spawn_fake(move |seen: &Seen| {
        let mut w = world.lock().unwrap();
        let path = seen.path.as_str();
        match (seen.method.as_str(), path) {
            ("POST", "/v1/auth/email/verify") => (200, token_response(0, 3600)),
            ("PUT", "/v1/remote/device") => (
                200,
                json!({
                    "id": DEVICE_ID, "client_type": "desktop", "device_name": "Studio Mac",
                    "platform": "macos", "public_key": seen.body["public_key"],
                    "created_at": "2026-11-12T10:00:00Z", "key_updated_at": "2026-11-12T10:00:00Z"
                }),
            ),
            ("PUT", "/v1/remote/host") => (
                201,
                json!({"id": HOST_ID, "name": seen.body["name"], "created_at": "2026-11-12T10:00:00Z"}),
            ),
            ("POST", "/v1/remote/host/sync") => (
                200,
                json!({
                    "host": {"id": HOST_ID, "name": "Studio Mac", "created_at": "2026-11-12T10:00:00Z"},
                    "state_version": w.state_version,
                    "grants": w.grants,
                    "pairing_code": null
                }),
            ),
            ("PUT", p) if p.ends_with("/credential") => {
                for g in w.grants.iter_mut() {
                    g["status"] = json!("active");
                    g["needs_credential"] = json!(false);
                }
                (204, Value::Null)
            }
            ("PUT", "/v1/remote/host/endpoints") => (204, Value::Null),
            ("POST", p) if p.ends_with("/deny") => {
                w.grants.clear();
                (204, Value::Null)
            }
            ("DELETE", p) if p.starts_with("/v1/remote/grants/") => {
                w.grants.clear();
                if let Some(g) = w.client_grant.as_mut() {
                    g["status"] = json!("revoked");
                }
                (204, Value::Null)
            }
            ("POST", "/v1/remote/pair") => (201, w.client_grant.clone().unwrap()),
            ("POST", p) if p.ends_with("/requests") => (201, w.client_grant.clone().unwrap()),
            ("GET", p) if p.starts_with("/v1/remote/grants/") => match &w.client_grant {
                Some(g) => (200, g.clone()),
                None => (
                    404,
                    json!({"error": "grant_not_found", "detail": "No such grant"}),
                ),
            },
            ("POST", p) if p.ends_with("/credential/ack") => {
                if let Some(g) = w.client_grant.as_mut() {
                    g["credential"] = Value::Null;
                }
                (204, Value::Null)
            }
            _ => (
                404,
                json!({"error": "not_found", "detail": format!("{} {path}", seen.method)}),
            ),
        }
    })
}

#[derive(Default)]
struct FakeCore {
    reach: Mutex<Reachability>,
    pushed: Mutex<Vec<Vec<String>>>,
}

#[async_trait]
impl HostEnv for FakeCore {
    async fn reachability(&self) -> Reachability {
        self.reach.lock().unwrap().clone()
    }

    async fn push_client_keys(&self, keys: Vec<String>) -> Result<(), String> {
        self.pushed.lock().unwrap().push(keys);
        Ok(())
    }
}

fn online(tunnel: &str) -> Reachability {
    Reachability {
        server_running: true,
        server_has_key: true,
        tunnel: "online".to_string(),
        lan: false,
        endpoints: vec![Endpoint {
            kind: EndpointKind::Tunnel,
            url: format!("https://{tunnel}.trycloudflare.com/v1"),
        }],
    }
}

struct Setup {
    _dir: tempfile::TempDir,
    dir: std::path::PathBuf,
    fake: Fake,
    world: Arc<Mutex<World>>,
    account: AccountState,
    remote: RemoteState,
    core: FakeCore,
}

async fn setup() -> Setup {
    let world = Arc::new(Mutex::new(World::default()));
    let fake = spawn_world(world.clone());
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    let account = fake.state();
    account
        .email_verify(&dir, "challenge-1", "123456", "2.4.0")
        .await
        .expect("sign-in");
    let core = FakeCore::default();
    *core.reach.lock().unwrap() = online("first-words");
    Setup {
        _dir: tmp,
        dir,
        fake,
        world,
        account,
        remote: RemoteState::default(),
        core,
    }
}

impl Setup {
    fn host(&self) -> HostCtx<'_> {
        HostCtx {
            remote: &self.remote,
            account: &self.account,
            data_dir: &self.dir,
            env: &self.core,
            host_name: "Studio Mac".to_string(),
        }
    }

    fn client(&self) -> ClientCtx<'_> {
        ClientCtx {
            remote: &self.remote,
            account: &self.account,
            data_dir: &self.dir,
        }
    }

    async fn file(&self) -> RemoteFile {
        self.remote.read(&self.dir, |f| f.clone()).await
    }

    async fn open_code(&self) -> Vec<u8> {
        let qr = protocol::new_qr_secret();
        self.remote
            .update(&self.dir, |f| {
                f.sharing = true;
                f.pairing = Some(PairingRecord {
                    code: "BCDFGHJK".to_string(),
                    qr_secret: protocol::b64u(&qr),
                    expires_at: now_unix() + 600,
                });
            })
            .await;
        qr.to_vec()
    }

    async fn host_round(&self, uploaded: &mut Option<UploadMark>) -> Option<u64> {
        self.host()
            .round(None, 0, uploaded, &Notify::new(), &CancellationToken::new())
            .await
            .expect("host round")
    }
}

#[tokio::test]
async fn a_qr_pairing_gets_a_sealed_key_a_mac_and_the_addresses() {
    let s = setup().await;
    let phone = DeviceKey::generate();
    let qr = s.open_code().await;
    let proof = protocol::pair_proof(&qr, &phone.public_b64());
    s.world.lock().unwrap().grants = vec![host_grant(
        "approved",
        "code",
        &phone.public_b64(),
        Some(&proof),
    )];

    let mut uploaded = None;
    assert_eq!(s.host_round(&mut uploaded).await, Some(0));

    // The envelope opens with the phone's key, and its MAC with the QR secret.
    let put = &s
        .fake
        .requests(&format!("/v1/remote/grants/{GRANT_ID}/credential"))[0];
    let envelope = put.body["envelope"].as_str().unwrap();
    let mac = put.body["mac"].as_str().unwrap();
    assert!(protocol::verify_credential_mac(
        &qr, GRANT_ID, envelope, mac
    ));
    let credential = protocol::open_credential(&phone, GRANT_ID, envelope).unwrap();
    assert_eq!(credential.host_name, "Studio Mac");

    // The core now accepts exactly that key.
    assert_eq!(
        s.core.pushed.lock().unwrap().last().unwrap(),
        &vec![credential.api_key.clone()]
    );

    // The phone's blob carries the tunnel address.
    let endpoints = &s.fake.requests("/v1/remote/host/endpoints")[0];
    let item = &endpoints.body["items"][0];
    assert_eq!(item["grant_id"], GRANT_ID);
    let secret = credential.grant_secret_bytes().unwrap();
    let opened =
        protocol::open_endpoints(&secret, GRANT_ID, item["blob"].as_str().unwrap()).unwrap();
    assert_eq!(opened.seq, 1);
    assert_eq!(opened.endpoints, online("first-words").endpoints);

    let file = s.file().await;
    assert_eq!(file.issued.len(), 1);
    assert_eq!(file.issued[0].client_name.as_deref(), Some("Ann's iPhone"));
    assert!(file.pairing.is_none(), "a redeemed code is forgotten");
}

#[tokio::test]
async fn a_proof_that_does_not_check_out_is_denied_and_gets_nothing() {
    let s = setup().await;
    let phone = DeviceKey::generate();
    s.open_code().await;
    let forged = protocol::pair_proof(b"ZZZZZZZZ", &phone.public_b64());
    s.world.lock().unwrap().grants = vec![host_grant(
        "approved",
        "code",
        &phone.public_b64(),
        Some(&forged),
    )];

    s.host_round(&mut None).await;
    assert_eq!(
        s.fake
            .requests(&format!("/v1/remote/grants/{GRANT_ID}/deny"))
            .len(),
        1
    );
    assert!(s
        .fake
        .requests(&format!("/v1/remote/grants/{GRANT_ID}/credential"))
        .is_empty());
    assert!(s.file().await.issued.is_empty());
}

#[tokio::test]
async fn new_addresses_are_resealed_with_a_higher_number_and_a_gone_grant_loses_its_key() {
    let s = setup().await;
    let phone = DeviceKey::generate();
    s.remote.update(&s.dir, |f| f.sharing = true).await;
    s.world.lock().unwrap().grants =
        vec![host_grant("approved", "request", &phone.public_b64(), None)];

    let mut uploaded = None;
    s.host_round(&mut uploaded).await;
    let put = &s
        .fake
        .requests(&format!("/v1/remote/grants/{GRANT_ID}/credential"))[0];
    assert!(
        put.body.get("mac").is_none(),
        "an allowed request has no MAC"
    );
    let credential =
        protocol::open_credential(&phone, GRANT_ID, put.body["envelope"].as_str().unwrap())
            .unwrap();
    let secret = credential.grant_secret_bytes().unwrap();

    // Nothing changed: no new blob.
    s.host_round(&mut uploaded).await;
    assert_eq!(s.fake.requests("/v1/remote/host/endpoints").len(), 1);

    // The tunnel restarted under a new name.
    *s.core.reach.lock().unwrap() = online("second-words");
    s.host_round(&mut uploaded).await;
    let uploads = s.fake.requests("/v1/remote/host/endpoints");
    assert_eq!(uploads.len(), 2);
    let opened = protocol::open_endpoints(
        &secret,
        GRANT_ID,
        uploads[1].body["items"][0]["blob"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(opened.seq, 2);
    assert!(opened.endpoints[0].url.contains("second-words"));

    // Revoked elsewhere: gone from sync, so its key leaves the core.
    s.world.lock().unwrap().grants.clear();
    s.host_round(&mut uploaded).await;
    assert!(s.file().await.issued.is_empty());
    assert_eq!(
        s.core.pushed.lock().unwrap().last().unwrap(),
        &Vec::<String>::new()
    );
}

/// What a host puts in a device's mailbox.
fn active_client_grant(
    phone: &DeviceKey,
    mac_secret: Option<&[u8]>,
    method: &str,
) -> (Value, String) {
    let credential = protocol::Credential {
        v: 1,
        api_key: protocol::new_device_api_key(),
        grant_secret: protocol::new_grant_secret(),
        host_name: "Studio Mac".to_string(),
    };
    let envelope = protocol::seal_credential(&phone.public_b64(), GRANT_ID, &credential).unwrap();
    let mac = mac_secret.map(|s| protocol::credential_mac(s, GRANT_ID, &envelope));
    let blob = protocol::seal_endpoints(
        &credential.grant_secret_bytes().unwrap(),
        GRANT_ID,
        1,
        &online("host-words").endpoints,
    )
    .unwrap();
    (
        json!({
            "id": GRANT_ID, "status": "active", "status_reason": null, "method": method,
            "version": 3,
            "host": {"id": HOST_ID, "name": "Studio Mac", "client_type": "desktop",
                     "platform": "macos", "online": true, "tunnel_state": "online"},
            "credential": {"envelope": envelope, "mac": mac},
            "endpoints": {"blob": blob, "updated_at": "2026-11-12T10:00:00Z"},
            "created_at": "2026-11-12T10:00:00Z", "decided_at": "2026-11-12T10:00:01Z"
        }),
        credential.api_key,
    )
}

fn approved_client_grant(method: &str) -> Value {
    json!({
        "id": GRANT_ID, "status": "approved", "status_reason": null, "method": method,
        "version": 1,
        "host": {"id": HOST_ID, "name": "Studio Mac", "client_type": "desktop",
                 "platform": "macos", "online": true, "tunnel_state": "online"},
        "credential": null, "endpoints": null,
        "created_at": "2026-11-12T10:00:00Z", "decided_at": "2026-11-12T10:00:01Z"
    })
}

#[tokio::test]
async fn pairing_by_code_collects_the_key_confirms_it_and_follows_the_address() {
    let s = setup().await;
    s.world.lock().unwrap().client_grant = Some(approved_client_grant("code"));
    let input = protocol::parse_pair_input("bcdf-ghjk").unwrap();
    let view = s.client().pair(&input).await.unwrap();
    assert_eq!(view.host_name, "Studio Mac");

    let pair = &s.fake.requests("/v1/remote/pair")[0];
    assert_eq!(pair.body["code"], "BCDFGHJK");
    let phone = DeviceKey::from_secret_b64(&s.file().await.device_secret.unwrap()).unwrap();
    assert!(protocol::verify_pair_proof(
        b"BCDFGHJK",
        &phone.public_b64(),
        pair.body["proof"].as_str().unwrap()
    ));

    let (grant, api_key) = active_client_grant(&phone, Some(b"BCDFGHJK"), "code");
    s.world.lock().unwrap().client_grant = Some(grant);
    let round = s
        .client()
        .round(GRANT_ID, 0, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(round, Round::ConnectionsChanged);
    assert_eq!(
        s.fake
            .requests(&format!("/v1/remote/grants/{GRANT_ID}/credential/ack"))
            .len(),
        1
    );

    let connections = s.remote.provider_connections(&s.dir).await;
    assert_eq!(connections.len(), 1);
    assert_eq!(connections[0].api_key, api_key);
    assert_eq!(
        connections[0].base_url,
        "https://host-words.trycloudflare.com/v1"
    );
    let file = s.file().await;
    assert!(
        file.connections[0].pair_secret.is_none(),
        "the code is dropped once used"
    );
    assert!(file.connections[0].acked);
}

#[tokio::test]
async fn a_credential_without_the_codes_mac_is_refused_and_revoked() {
    let s = setup().await;
    s.world.lock().unwrap().client_grant = Some(approved_client_grant("code"));
    s.client()
        .pair(&protocol::parse_pair_input("BCDF-GHJK").unwrap())
        .await
        .unwrap();
    let phone = DeviceKey::from_secret_b64(&s.file().await.device_secret.unwrap()).unwrap();
    // Encrypted to the right key, but MACed with something else.
    let (grant, _) = active_client_grant(&phone, Some(b"ZZZZZZZZ"), "code");
    s.world.lock().unwrap().client_grant = Some(grant);

    let round = s
        .client()
        .round(GRANT_ID, 0, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        round,
        Round::Ended(client_codes::UNTRUSTED_CREDENTIAL.to_string())
    );
    assert!(s.file().await.connections.is_empty());
    assert!(s.remote.provider_connections(&s.dir).await.is_empty());
    assert_eq!(
        s.fake
            .requests(&format!("/v1/remote/grants/{GRANT_ID}"))
            .iter()
            .filter(|r| r.method == "DELETE")
            .count(),
        1
    );
}

#[tokio::test]
async fn a_request_shows_the_check_code_and_a_revoked_grant_ends_the_connection() {
    let s = setup().await;
    let mut pending = approved_client_grant("request");
    pending["status"] = json!("pending");
    s.world.lock().unwrap().client_grant = Some(pending);
    let view = s.client().request(HOST_ID).await.unwrap();
    let phone = DeviceKey::from_secret_b64(&s.file().await.device_secret.unwrap()).unwrap();
    assert_eq!(
        view.check_code.as_deref(),
        Some(protocol::sas(HOST_ID, DEVICE_ID, &phone.public_b64()).as_str())
    );

    let mut revoked = approved_client_grant("request");
    revoked["status"] = json!("revoked");
    revoked["status_reason"] = json!("revoked_by_user");
    s.world.lock().unwrap().client_grant = Some(revoked);
    let round = s
        .client()
        .round(GRANT_ID, 0, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(round, Round::Ended("revoked_by_user".to_string()));
    assert!(s.file().await.connections.is_empty());
}

#[tokio::test]
async fn the_device_registers_once_per_key() {
    let s = setup().await;
    let (key, id) = s
        .remote
        .ensure_device(&s.account, &s.dir, false)
        .await
        .unwrap();
    let (again, same) = s
        .remote
        .ensure_device(&s.account, &s.dir, false)
        .await
        .unwrap();
    assert_eq!(id, DEVICE_ID);
    assert_eq!(same, DEVICE_ID);
    assert_eq!(key.public_b64(), again.public_b64());
    let registered = s.fake.requests("/v1/remote/device");
    assert_eq!(registered.len(), 1);
    assert_eq!(registered[0].body["public_key"], key.public_b64());
}

#[test]
fn the_file_is_owner_only_and_belongs_to_one_account() {
    let tmp = tempfile::tempdir().unwrap();
    let mut file = RemoteFile::default();
    assert!(!file.bind_user("user-1"), "a fresh file is simply claimed");
    file.sharing = true;
    file.device_secret = Some(DeviceKey::generate().secret_b64());
    assert!(
        !file.bind_user("user-1"),
        "the same account keeps everything"
    );
    store::save(tmp.path(), &file).unwrap();
    assert_eq!(store::load(tmp.path()), file);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(tmp.path().join(REMOTE_FILE_NAME))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    assert!(file.bind_user("user-2"));
    assert!(!file.sharing && file.device_secret.is_none());
    assert_eq!(file.user_id.as_deref(), Some("user-2"));

    std::fs::write(tmp.path().join(REMOTE_FILE_NAME), "{not json").unwrap();
    assert_eq!(store::load(tmp.path()), RemoteFile::default());
}

#[test]
fn the_page_never_sees_keys_or_addresses() {
    let file = RemoteFile {
        sharing: true,
        issued: vec![super::store::IssuedKey {
            grant_id: GRANT_ID.to_string(),
            client_device_id: PHONE_ID.to_string(),
            client_name: Some("Ann's iPhone".to_string()),
            client_platform: Some("ios".to_string()),
            api_key: "sk-atomic-issued-secret".to_string(),
            grant_secret: "grant-secret-value".to_string(),
            issued_at: 1,
        }],
        connections: vec![super::store::Connection {
            grant_id: "g2".to_string(),
            host_id: HOST_ID.to_string(),
            host_name: "Studio Mac".to_string(),
            method: "request".to_string(),
            pair_secret: None,
            api_key: Some("sk-atomic-received-secret".to_string()),
            grant_secret: Some("another-grant-secret".to_string()),
            acked: true,
            version: Some(1),
            last_seq: 1,
            endpoints: online("hidden-words").endpoints,
            base_url: Some("https://hidden-words.trycloudflare.com/v1".to_string()),
            status: "active".to_string(),
        }],
        ..RemoteFile::default()
    };
    let memory = HostMemory {
        reach: Some(online("own-words")),
        ..HostMemory::default()
    };
    let shown = serde_json::to_string(&build_status(&file, &memory, 0)).unwrap();
    for secret in [
        "sk-atomic-issued-secret",
        "grant-secret-value",
        "sk-atomic-received-secret",
        "hidden-words",
        "own-words",
    ] {
        assert!(!shown.contains(secret), "{secret} leaked into the status");
    }
    assert!(shown.contains("\"via\":\"tunnel\""));
}
