//! Opt-in: two installs of one account against a real account API, one the
//! host and one the device, through code pairing, a request with "Allow",
//! revocation and sign-out. The core is faked; everything else is real.
//!
//! Run against a local backend whose emails are appended to a file as JSON
//! lines (`{"to", "subject", "text"}`), e.g. by replacing
//! `MailgunClient.send`:
//!
//! ```text
//! ATOMIC_REMOTE_LIVE_API=http://127.0.0.1:8194 \
//! ATOMIC_REMOTE_LIVE_MAIL=/path/to/mail.jsonl \
//!   cargo test --lib account::remote::live_tests -- --ignored --nocapture
//! ```

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::client::{ClientCtx, Round};
use super::core_env::{HostEnv, Reachability};
use super::host::{HostCtx, UploadMark};
use super::protocol::{self, Endpoint, EndpointKind};
use super::state::RemoteState;
use super::store::PairingRecord;
use crate::core::account::api::AccountApi;
use crate::core::account::AccountState;
use crate::core::auth::state::now_unix;

struct Core {
    pushed: Mutex<Vec<Vec<String>>>,
}

#[async_trait]
impl HostEnv for Core {
    async fn reachability(&self) -> Reachability {
        Reachability {
            server_running: true,
            server_has_key: true,
            tunnel: "online".to_string(),
            lan: false,
            endpoints: vec![Endpoint {
                kind: EndpointKind::Tunnel,
                url: "https://live-words.trycloudflare.com/v1".to_string(),
            }],
        }
    }

    async fn push_client_keys(&self, keys: Vec<String>) -> Result<(), String> {
        self.pushed.lock().unwrap().push(keys);
        Ok(())
    }
}

impl Core {
    fn keys(&self) -> Vec<String> {
        self.pushed
            .lock()
            .unwrap()
            .last()
            .cloned()
            .unwrap_or_default()
    }
}

struct Install {
    _tmp: tempfile::TempDir,
    dir: std::path::PathBuf,
    account: AccountState,
    remote: RemoteState,
}

/// The newest 6-digit code mailed to `email` after `skip` earlier mails.
async fn mailed_code(mail: &Path, email: &str, skip: usize) -> String {
    for _ in 0..50 {
        let text = std::fs::read_to_string(mail).unwrap_or_default();
        let mails: Vec<serde_json::Value> = text
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .filter(|m: &serde_json::Value| m["to"] == email)
            .collect();
        if mails.len() > skip {
            let body = mails.last().unwrap()["text"].as_str().unwrap().to_string();
            let code: String = body
                .split(|c: char| !c.is_ascii_digit())
                .find(|w| w.len() == 6)
                .expect("a 6-digit code in the email")
                .to_string();
            return code;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("no sign-in email for {email}");
}

fn mail_count(mail: &Path, email: &str) -> usize {
    std::fs::read_to_string(mail)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(|m| m["to"] == email)
        .count()
}

async fn sign_in(api: &Url, mail: &Path, email: &str) -> Install {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().to_path_buf();
    let account = AccountState::with_api(AccountApi::new(api.clone()).unwrap());
    let before = mail_count(mail, email);
    // One code per address per minute: the second install waits its turn.
    let challenge = match account.email_start(&dir, email, "2.4.3").await {
        Err(err) if err.is("rate_limited") => {
            let wait = err.retry_after.unwrap_or(60) + 1;
            eprintln!("waiting {wait} s for the next sign-in code");
            tokio::time::sleep(Duration::from_secs(wait)).await;
            account.email_start(&dir, email, "2.4.3").await.unwrap()
        }
        other => other.unwrap(),
    };
    let code = mailed_code(mail, email, before).await;
    let status = account
        .email_verify(&dir, &challenge.challenge_id, &code, "2.4.3")
        .await
        .unwrap();
    assert!(status.signed_in);
    Install {
        _tmp: tmp,
        dir,
        account,
        remote: RemoteState::default(),
    }
}

fn host_ctx<'a>(i: &'a Install, core: &'a Core) -> HostCtx<'a> {
    HostCtx {
        remote: &i.remote,
        account: &i.account,
        data_dir: &i.dir,
        env: core,
        host_name: "Live Host".to_string(),
    }
}

fn client_ctx(i: &Install) -> ClientCtx<'_> {
    ClientCtx {
        remote: &i.remote,
        account: &i.account,
        data_dir: &i.dir,
    }
}

async fn host_round(i: &Install, core: &Core, uploaded: &mut Option<UploadMark>) {
    host_ctx(i, core)
        .round(None, 0, uploaded, &Notify::new(), &CancellationToken::new())
        .await
        .expect("host round");
}

async fn client_round(i: &Install, grant: &str) -> Round {
    client_ctx(i)
        .round(grant, 0, &CancellationToken::new())
        .await
        .expect("client round")
}

#[tokio::test]
#[ignore]
async fn two_installs_pair_share_and_lose_access() {
    let (Ok(api), Ok(mail)) = (
        std::env::var("ATOMIC_REMOTE_LIVE_API"),
        std::env::var("ATOMIC_REMOTE_LIVE_MAIL"),
    ) else {
        eprintln!("set ATOMIC_REMOTE_LIVE_API and ATOMIC_REMOTE_LIVE_MAIL");
        return;
    };
    let api = Url::parse(&api).unwrap();
    let mail = std::path::PathBuf::from(mail);
    let email = format!("remote-live-{}@example.com", now_unix());

    let host = sign_in(&api, &mail, &email).await;
    let device = sign_in(&api, &mail, &email).await;
    let core = Core {
        pushed: Mutex::new(Vec::new()),
    };
    let mut uploaded = None;

    // -- Code pairing, through the QR link -----------------------------
    host.remote.update(&host.dir, |f| f.sharing = true).await;
    let record = host_ctx(&host, &core).ensure_host().await.unwrap();
    let opened = host
        .account
        .authed(&host.dir, |api, token| async move {
            api.remote_create_pairing_code(&token).await
        })
        .await
        .unwrap();
    let code = protocol::normalize_code(&opened.code).unwrap();
    let qr = protocol::new_qr_secret();
    host.remote
        .update(&host.dir, |f| {
            f.pairing = Some(PairingRecord {
                code: code.clone(),
                qr_secret: protocol::b64u(&qr),
                expires_at: now_unix() + 600,
            })
        })
        .await;
    let link = protocol::pair_link(&protocol::format_code(&code), &qr);
    let paired = client_ctx(&device)
        .pair(&protocol::parse_pair_input(&link).unwrap())
        .await
        .unwrap();
    assert_eq!(paired.host_id, record.host_id);
    assert_eq!(paired.status, "approved");

    host_round(&host, &core, &mut uploaded).await;
    let issued = core.keys();
    assert_eq!(issued.len(), 1, "the core accepts the device's key");

    assert_eq!(
        client_round(&device, &paired.grant_id).await,
        Round::ConnectionsChanged
    );
    let connections = device.remote.provider_connections(&device.dir).await;
    assert_eq!(connections.len(), 1);
    assert_eq!(connections[0].api_key, issued[0]);
    assert_eq!(
        connections[0].base_url,
        "https://live-words.trycloudflare.com/v1"
    );
    assert_eq!(connections[0].host_name, "Live Host");

    // The server copy of the envelope is gone after the ack.
    let read = device
        .account
        .authed(&device.dir, |api, token| {
            let id = paired.grant_id.clone();
            async move { api.remote_grant(&token, &id, None, 0).await }
        })
        .await
        .unwrap();
    assert!(read.credential.is_none());
    assert_eq!(read.status, "active");

    // -- Revoked on the host: the key leaves the core, the device lets go --
    host.account
        .authed(&host.dir, |api, token| {
            let id = paired.grant_id.clone();
            async move { api.remote_revoke_grant(&token, &id).await }
        })
        .await
        .unwrap();
    host_round(&host, &core, &mut uploaded).await;
    assert!(core.keys().is_empty());
    assert!(matches!(
        client_round(&device, &paired.grant_id).await,
        Round::Ended(_)
    ));
    assert!(device
        .remote
        .provider_connections(&device.dir)
        .await
        .is_empty());

    // -- A request, "Allow" with matching check codes -------------------
    let asked = client_ctx(&device).request(&record.host_id).await.unwrap();
    host_round(&host, &core, &mut uploaded).await;
    let pending = host.remote.status(&host.dir).await.requests;
    assert_eq!(pending.len(), 1);
    assert_eq!(Some(pending[0].check_code.clone()), asked.check_code);
    host.account
        .authed(&host.dir, |api, token| {
            let id = asked.grant_id.clone();
            async move { api.remote_decide(&token, &id, true).await }
        })
        .await
        .unwrap();
    host_round(&host, &core, &mut uploaded).await;
    assert_eq!(core.keys().len(), 1);
    assert_eq!(
        client_round(&device, &asked.grant_id).await,
        Round::ConnectionsChanged
    );
    assert_eq!(
        device.remote.provider_connections(&device.dir).await.len(),
        1
    );

    // -- The device signs out: its grant ends and the host drops the key --
    device.account.logout(&device.dir).await;
    host_round(&host, &core, &mut uploaded).await;
    assert!(core.keys().is_empty());

    // -- The host stops sharing: removing it from the account works --
    host.account
        .authed(&host.dir, |api, token| async move {
            api.remote_disable_host(&token).await
        })
        .await
        .unwrap();
    host.account.logout(&host.dir).await;
}
