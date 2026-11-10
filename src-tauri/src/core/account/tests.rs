use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Request, Response, Server};
use serde_json::{json, Value};
use tauri_plugin_http::reqwest::StatusCode;
use url::Url;

use super::api::{self, codes, AccountApi, AccountError};
use super::client_info;
use super::google;
use super::state::AccountState;
use super::store::{self, AccountFile, ACCOUNT_FILE_NAME};
use crate::core::auth::chatgpt::derive_challenge;

// ---------------------------------------------------------------------------
// A fake account API

#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    auth: Option<String>,
    body: Value,
}

type Reply = (u16, Value);
type Handler = Arc<dyn Fn(&Seen) -> Reply + Send + Sync>;

struct Fake {
    base: Url,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Fake {
    fn requests(&self, path: &str) -> Vec<Seen> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.path == path)
            .cloned()
            .collect()
    }

    fn state(&self) -> AccountState {
        AccountState::with_api(AccountApi::new(self.base.clone()).unwrap())
    }
}

fn spawn_fake(handler: impl Fn(&Seen) -> Reply + Send + Sync + 'static) -> Fake {
    let handler: Handler = Arc::new(handler);
    let seen = Arc::new(Mutex::new(Vec::<Seen>::new()));
    let seen_for_server = seen.clone();
    let make_svc = make_service_fn(move |_conn| {
        let handler = handler.clone();
        let seen = seen_for_server.clone();
        async move {
            Ok::<_, Infallible>(service_fn(move |req: Request<Body>| {
                let handler = handler.clone();
                let seen = seen.clone();
                async move {
                    let method = req.method().to_string();
                    let path = req.uri().path().to_string();
                    let auth = req
                        .headers()
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_string);
                    let bytes = hyper::body::to_bytes(req.into_body()).await.unwrap();
                    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                    let request = Seen {
                        method,
                        path,
                        auth,
                        body,
                    };
                    let (status, reply) = handler(&request);
                    seen.lock().unwrap().push(request);
                    let mut response = Response::builder()
                        .status(status)
                        .header("content-type", "application/json");
                    if status == 429 {
                        response = response.header("retry-after", "42");
                    }
                    let body = if reply.is_null() {
                        Body::empty()
                    } else {
                        Body::from(reply.to_string())
                    };
                    Ok::<_, Infallible>(response.body(body).unwrap())
                }
            }))
        }
    });
    let server = Server::try_bind(&SocketAddr::from(([127, 0, 0, 1], 0)))
        .unwrap()
        .serve(make_svc);
    let port = server.local_addr().port();
    tokio::spawn(server);
    Fake {
        base: Url::parse(&format!("http://127.0.0.1:{port}")).unwrap(),
        seen,
    }
}

fn token_response(n: usize, expires_in: i64) -> Value {
    json!({
        "token_type": "Bearer",
        "access_token": format!("access-{n}"),
        "expires_in": expires_in,
        "refresh_token": format!("refresh-{n}"),
        "session_id": "11111111-1111-1111-1111-111111111111",
        "user": {
            "id": "user-1",
            "email": "ann@example.com",
            "display_name": "Ann",
            "avatar_url": null,
            "is_new": false
        }
    })
}

fn me_response(display_name: &str) -> Value {
    json!({
        "id": "user-1",
        "email": "ann@example.com",
        "display_name": display_name,
        "avatar_url": "https://example.com/a.png",
        "created_at": "2026-11-10T10:00:00Z",
        "identities": [
            {"provider": "email", "email": "ann@example.com", "created_at": "2026-11-10T10:00:00Z"}
        ]
    })
}

/// Sign in through the email code; the fake decides the token's lifetime.
async fn signed_in(dir: &std::path::Path, state: &AccountState) {
    state
        .email_verify(dir, "challenge-1", "123 456", "2.4.0")
        .await
        .expect("sign-in");
}

fn verify_handler(expires_in: i64) -> impl Fn(&Seen) -> Option<Reply> + Send + Sync + 'static {
    move |seen: &Seen| match seen.path.as_str() {
        "/v1/auth/email/verify" => Some((200, token_response(0, expires_in))),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Store

#[test]
fn store_round_trips_and_is_owner_only() {
    let dir = tempfile::tempdir().unwrap();
    let file = AccountFile::fresh();
    store::save(dir.path(), &file).unwrap();
    assert_eq!(store::load(dir.path()), Some(file));
    assert!(!dir.path().join(format!("{ACCOUNT_FILE_NAME}.tmp")).exists());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.path().join(ACCOUNT_FILE_NAME))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[test]
fn store_ignores_garbage_future_versions_and_bad_ids() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(ACCOUNT_FILE_NAME);

    std::fs::write(&path, "{not json").unwrap();
    assert_eq!(store::load(dir.path()), None);

    std::fs::write(
        &path,
        json!({"version": 99, "installation_id": "a".repeat(43)}).to_string(),
    )
    .unwrap();
    assert_eq!(store::load(dir.path()), None);

    std::fs::write(
        &path,
        json!({"version": 1, "installation_id": "short"}).to_string(),
    )
    .unwrap();
    assert_eq!(store::load(dir.path()), None);
}

#[test]
fn installation_ids_match_the_backend_pattern() {
    let id = store::new_installation_id();
    assert_eq!(id.len(), 43);
    assert!(id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    assert_ne!(id, store::new_installation_id());
}

// ---------------------------------------------------------------------------
// Client info, base URL, error mapping

#[test]
fn device_names_are_cleaned() {
    assert_eq!(
        client_info::sanitize_device_name("  Anns-MacBook-Pro.local \n"),
        Some("Anns-MacBook-Pro".to_string())
    );
    assert_eq!(
        client_info::sanitize_device_name("Ann\u{0007}'s Mac"),
        Some("Ann's Mac".to_string())
    );
    assert_eq!(client_info::sanitize_device_name("   "), None);
    assert_eq!(
        client_info::sanitize_device_name(&"é".repeat(150))
            .unwrap()
            .chars()
            .count(),
        100
    );
}

#[test]
fn app_versions_follow_the_backend_pattern() {
    assert_eq!(
        client_info::sanitize_app_version("2.4.0"),
        Some("2.4.0".into())
    );
    assert_eq!(
        client_info::sanitize_app_version("2.4.0-rc.1+build"),
        Some("2.4.0-rc.1+build".into())
    );
    assert_eq!(client_info::sanitize_app_version("2.4 beta"), None);
    assert_eq!(client_info::sanitize_app_version(&"1".repeat(33)), None);
}

#[test]
fn desktop_platform_is_named() {
    #[cfg(target_os = "macos")]
    assert_eq!(client_info::platform(), Some("macos"));
    #[cfg(target_os = "windows")]
    assert_eq!(client_info::platform(), Some("windows"));
    #[cfg(target_os = "linux")]
    assert_eq!(client_info::platform(), Some("linux"));
}

#[test]
fn base_url_override_is_https_or_loopback_http() {
    assert!(api::parse_base_url("https://api.example.com/").is_ok());
    assert!(api::parse_base_url("http://127.0.0.1:8193").is_ok());
    assert!(api::parse_base_url("http://localhost:8193").is_ok());
    assert!(api::parse_base_url("http://[::1]:8193").is_ok());
    assert_eq!(
        api::parse_base_url("http://api.example.com")
            .unwrap_err()
            .code,
        codes::CONFIG
    );
    assert_eq!(
        api::parse_base_url("not a url").unwrap_err().code,
        codes::CONFIG
    );
}

#[test]
fn backend_errors_keep_their_code_and_extras() {
    let err = api::error_from_response(
        StatusCode::BAD_REQUEST,
        None,
        r#"{"error":"invalid_code","detail":"Wrong code","attempts_left":3}"#,
    );
    assert_eq!(err.code, "invalid_code");
    assert_eq!(err.message, "Wrong code");
    assert_eq!(err.attempts_left, Some(3));

    let err = api::error_from_response(
        StatusCode::TOO_MANY_REQUESTS,
        Some("42"),
        r#"{"error":"rate_limited","detail":"Too many requests"}"#,
    );
    assert_eq!(
        (err.code.as_str(), err.retry_after),
        ("rate_limited", Some(42))
    );

    let err = api::error_from_response(
        StatusCode::UNPROCESSABLE_ENTITY,
        None,
        r#"{"detail":[{"loc":["body","email"]}]}"#,
    );
    assert_eq!(err.code, codes::INVALID_REQUEST);

    let err = api::error_from_response(StatusCode::BAD_GATEWAY, None, "<html>");
    assert_eq!(err.code, codes::SERVER_ERROR);
}

#[test]
fn callback_errors_map_to_codes() {
    use crate::core::mcp::oauth::flow::{CALLBACK_CANCELLED, CALLBACK_TIMED_OUT};
    assert_eq!(
        google::callback_error(CALLBACK_CANCELLED.into()).code,
        codes::CANCELLED
    );
    assert_eq!(
        google::callback_error(CALLBACK_TIMED_OUT.into()).code,
        codes::TIMEOUT
    );
    assert_eq!(
        google::callback_error("access_denied".into()).code,
        "access_denied"
    );
    assert_eq!(
        google::callback_error("unverified_email: Google did not verify".into()).code,
        "unverified_email"
    );
    assert_eq!(
        google::callback_error("callback carried no authorization code".into()).code,
        codes::UNEXPECTED
    );
}

// ---------------------------------------------------------------------------
// Email sign-in and the session

#[tokio::test]
async fn email_sign_in_sends_the_client_and_persists_the_session() {
    let fake = spawn_fake(|seen| match seen.path.as_str() {
        "/v1/auth/email/start" => (
            202,
            json!({"challenge_id": "challenge-1", "expires_in": 600, "resend_in": 60}),
        ),
        "/v1/auth/email/verify" => (200, token_response(0, 900)),
        _ => (404, Value::Null),
    });
    let dir = tempfile::tempdir().unwrap();
    let state = fake.state();

    let challenge = state
        .email_start(dir.path(), "  ann@example.com ", "2.4.0")
        .await
        .unwrap();
    assert_eq!(challenge.challenge_id, "challenge-1");
    assert_eq!(challenge.resend_in, 60);
    // Nothing is written for an install that has not signed in.
    assert!(store::load(dir.path()).is_none());

    let status = state
        .email_verify(dir.path(), "challenge-1", "123 456", "2.4.0")
        .await
        .unwrap();
    assert!(status.signed_in);
    assert_eq!(status.user.unwrap().email, "ann@example.com");

    let start = &fake.requests("/v1/auth/email/start")[0];
    assert_eq!(start.body["email"], "ann@example.com");
    assert_eq!(start.body["client"]["client_type"], "desktop");
    assert_eq!(start.body["client"]["app_version"], "2.4.0");
    assert_eq!(start.body["client"]["device_name"], "Test device");
    let verify = &fake.requests("/v1/auth/email/verify")[0];
    assert_eq!(verify.body["code"], "123456");
    assert_eq!(
        verify.body["client"]["installation_id"],
        start.body["client"]["installation_id"]
    );

    let file = store::load(dir.path()).expect("saved");
    assert_eq!(
        Value::String(file.installation_id.clone()),
        start.body["client"]["installation_id"]
    );
    assert_eq!(file.session.unwrap().refresh_token, "refresh-0");

    // A new process reads the same session back.
    let restarted = fake.state();
    assert!(restarted.status(dir.path()).await.signed_in);
}

#[tokio::test]
async fn bad_email_is_refused_locally() {
    let fake = spawn_fake(|_| (500, Value::Null));
    let dir = tempfile::tempdir().unwrap();
    let err = fake
        .state()
        .email_start(dir.path(), "not-an-email", "2.4.0")
        .await
        .unwrap_err();
    assert_eq!(err.code, codes::INVALID_REQUEST);
    assert!(fake.requests("/v1/auth/email/start").is_empty());
}

#[tokio::test]
async fn backend_error_codes_reach_the_caller() {
    let fake = spawn_fake(|seen| match seen.path.as_str() {
        "/v1/auth/email/verify" => (
            400,
            json!({"error": "invalid_code", "detail": "Wrong code", "attempts_left": 4}),
        ),
        "/v1/auth/email/start" => (429, json!({"error": "rate_limited", "detail": "slow"})),
        _ => (404, Value::Null),
    });
    let dir = tempfile::tempdir().unwrap();
    let state = fake.state();

    let err = state
        .email_verify(dir.path(), "c", "000000", "2.4.0")
        .await
        .unwrap_err();
    assert_eq!(
        (err.code.as_str(), err.attempts_left),
        ("invalid_code", Some(4))
    );
    assert!(!state.status(dir.path()).await.signed_in);

    let err = state
        .email_start(dir.path(), "ann@example.com", "2.4.0")
        .await
        .unwrap_err();
    assert_eq!(
        (err.code.as_str(), err.retry_after),
        ("rate_limited", Some(42))
    );
}

#[tokio::test]
async fn concurrent_callers_share_one_refresh() {
    let refreshes = Arc::new(AtomicUsize::new(0));
    let counter = refreshes.clone();
    let verify = verify_handler(60);
    let fake = spawn_fake(move |seen| {
        if let Some(reply) = verify(seen) {
            return reply;
        }
        if seen.path == "/v1/auth/token" {
            assert_eq!(seen.body["grant_type"], "refresh_token");
            assert_eq!(seen.body["refresh_token"], "refresh-0");
            std::thread::sleep(Duration::from_millis(50));
            let n = counter.fetch_add(1, Ordering::SeqCst) + 1;
            return (200, token_response(n, 900));
        }
        (404, Value::Null)
    });
    let dir = tempfile::tempdir().unwrap();
    let state = fake.state();
    // 60 s of life is inside the refresh margin: the next use refreshes.
    signed_in(dir.path(), &state).await;

    let (a, b) = tokio::join!(
        state.access_token(dir.path(), None),
        state.access_token(dir.path(), None)
    );
    assert_eq!(a.unwrap(), "access-1");
    assert_eq!(b.unwrap(), "access-1");
    assert_eq!(refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(
        store::load(dir.path())
            .unwrap()
            .session
            .unwrap()
            .refresh_token,
        "refresh-1"
    );
}

#[tokio::test]
async fn invalid_grant_ends_the_session_but_keeps_the_install() {
    let verify = verify_handler(60);
    let fake = spawn_fake(move |seen| {
        verify(seen).unwrap_or_else(|| match seen.path.as_str() {
            "/v1/auth/token" => (
                400,
                json!({"error": "invalid_grant", "detail": "Session revoked"}),
            ),
            _ => (404, Value::Null),
        })
    });
    let dir = tempfile::tempdir().unwrap();
    let state = fake.state();
    signed_in(dir.path(), &state).await;
    let install = store::load(dir.path()).unwrap().installation_id;

    let err = state.access_token(dir.path(), None).await.unwrap_err();
    assert_eq!(err.code, codes::INVALID_GRANT);
    assert!(!state.status(dir.path()).await.signed_in);
    let file = store::load(dir.path()).unwrap();
    assert!(file.session.is_none());
    assert_eq!(file.installation_id, install);
}

#[tokio::test]
async fn a_failed_refresh_keeps_the_session() {
    let verify = verify_handler(60);
    let fake = spawn_fake(move |seen| {
        verify(seen).unwrap_or_else(|| match seen.path.as_str() {
            "/v1/auth/token" => (503, json!({"detail": "down"})),
            _ => (404, Value::Null),
        })
    });
    let dir = tempfile::tempdir().unwrap();
    let state = fake.state();
    signed_in(dir.path(), &state).await;

    let err = state.access_token(dir.path(), None).await.unwrap_err();
    assert_eq!(err.code, codes::SERVER_ERROR);
    assert!(state.status(dir.path()).await.signed_in);
    assert!(store::load(dir.path()).unwrap().session.is_some());
}

#[tokio::test]
async fn a_rejected_token_is_refreshed_once_and_retried() {
    let refreshes = Arc::new(AtomicUsize::new(0));
    let counter = refreshes.clone();
    let verify = verify_handler(900);
    let fake = spawn_fake(move |seen| {
        if let Some(reply) = verify(seen) {
            return reply;
        }
        match (seen.path.as_str(), seen.auth.as_deref()) {
            ("/v1/auth/token", _) => {
                let n = counter.fetch_add(1, Ordering::SeqCst) + 1;
                (200, token_response(n, 900))
            }
            ("/v1/me", Some("Bearer access-1")) => (200, me_response("Ann B")),
            ("/v1/me", _) => (401, json!({"error": "invalid_token", "detail": "expired"})),
            _ => (404, Value::Null),
        }
    });
    let dir = tempfile::tempdir().unwrap();
    let state = fake.state();
    signed_in(dir.path(), &state).await;

    let (profile, changed) = state.profile(dir.path()).await.unwrap();
    assert_eq!(profile.user.display_name.as_deref(), Some("Ann B"));
    assert_eq!(profile.identities[0].provider, "email");
    assert!(changed, "the cached user picks up the new name and avatar");
    assert_eq!(refreshes.load(Ordering::SeqCst), 1);
    let user = state.status(dir.path()).await.user.unwrap();
    assert_eq!(user.display_name.as_deref(), Some("Ann B"));
    assert_eq!(
        user.avatar_url.as_deref(),
        Some("https://example.com/a.png")
    );
}

#[tokio::test]
async fn sign_out_is_local_even_when_the_server_fails() {
    let verify = verify_handler(900);
    let fake = spawn_fake(move |seen| {
        verify(seen).unwrap_or_else(|| match seen.path.as_str() {
            "/v1/auth/logout" => (500, Value::Null),
            "/v1/auth/email/start" => (
                202,
                json!({"challenge_id": "c2", "expires_in": 600, "resend_in": 60}),
            ),
            _ => (404, Value::Null),
        })
    });
    let dir = tempfile::tempdir().unwrap();
    let state = fake.state();
    signed_in(dir.path(), &state).await;
    let install = store::load(dir.path()).unwrap().installation_id;

    let status = state.logout(dir.path()).await;
    assert!(!status.signed_in);
    let logout = &fake.requests("/v1/auth/logout")[0];
    assert_eq!(logout.method, "POST");
    assert_eq!(logout.auth.as_deref(), Some("Bearer access-0"));
    let file = store::load(dir.path()).unwrap();
    assert!(file.session.is_none());

    // The same install signs in again under the same id.
    state
        .email_start(dir.path(), "ann@example.com", "2.4.0")
        .await
        .unwrap();
    assert_eq!(
        fake.requests("/v1/auth/email/start")[0].body["client"]["installation_id"],
        Value::String(install)
    );
}

#[tokio::test]
async fn revoking_this_device_is_a_sign_out() {
    let verify = verify_handler(900);
    let fake = spawn_fake(move |seen| {
        verify(seen).unwrap_or(match (seen.method.as_str(), seen.path.as_str()) {
            ("POST", "/v1/auth/logout") => (204, Value::Null),
            ("DELETE", "/v1/me/sessions/22222222-2222-2222-2222-222222222222") => {
                (204, Value::Null)
            }
            _ => (404, Value::Null),
        })
    });
    let dir = tempfile::tempdir().unwrap();
    let state = fake.state();
    signed_in(dir.path(), &state).await;

    let other = state
        .revoke_session(dir.path(), "22222222-2222-2222-2222-222222222222")
        .await
        .unwrap();
    assert_eq!(other, None);
    assert!(state.status(dir.path()).await.signed_in);

    let err = state.revoke_session(dir.path(), "../me").await.unwrap_err();
    assert_eq!(err.code, codes::INVALID_REQUEST);

    let this = state
        .revoke_session(dir.path(), "11111111-1111-1111-1111-111111111111")
        .await
        .unwrap();
    assert!(!this.unwrap().signed_in);
    assert_eq!(fake.requests("/v1/auth/logout").len(), 1);
}

#[tokio::test]
async fn delete_passes_reauth_required_through_and_clears_on_success() {
    let deletes = Arc::new(AtomicUsize::new(0));
    let counter = deletes.clone();
    let verify = verify_handler(900);
    let fake = spawn_fake(move |seen| {
        verify(seen).unwrap_or_else(|| match (seen.method.as_str(), seen.path.as_str()) {
            ("DELETE", "/v1/me") => {
                if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                    (
                        403,
                        json!({"error": "reauth_required", "detail": "Sign in again"}),
                    )
                } else {
                    (204, Value::Null)
                }
            }
            _ => (404, Value::Null),
        })
    });
    let dir = tempfile::tempdir().unwrap();
    let state = fake.state();
    signed_in(dir.path(), &state).await;

    let err: AccountError = state.delete(dir.path()).await.unwrap_err();
    assert_eq!(err.code, "reauth_required");
    assert!(state.status(dir.path()).await.signed_in);

    let status = state.delete(dir.path()).await.unwrap();
    assert!(!status.signed_in);
}

#[tokio::test]
async fn signed_out_calls_say_so() {
    let fake = spawn_fake(|_| (500, Value::Null));
    let dir = tempfile::tempdir().unwrap();
    let err = fake.state().sessions(dir.path()).await.unwrap_err();
    assert_eq!(err.code, codes::NOT_SIGNED_IN);
}

// ---------------------------------------------------------------------------
// Browser sign-in

fn query(url: &str) -> std::collections::HashMap<String, String> {
    Url::parse(url)
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect()
}

/// Play the browser: hit the loopback callback the way the backend's
/// redirect would.
fn browser(
    answer: impl FnOnce(&std::collections::HashMap<String, String>) -> String + Send + 'static,
) -> impl FnOnce(&str) -> Result<(), String> {
    move |authorize: &str| {
        let params = query(authorize);
        let callback = format!("{}?{}", params["redirect_uri"], answer(&params));
        tokio::spawn(async move {
            let _ = tauri_plugin_http::reqwest::get(callback).await;
        });
        Ok(())
    }
}

#[tokio::test]
async fn google_sign_in_redeems_the_code_with_pkce() {
    let fake = spawn_fake(|seen| match seen.path.as_str() {
        "/v1/auth/token" => (200, token_response(7, 900)),
        _ => (404, Value::Null),
    });
    let dir = tempfile::tempdir().unwrap();
    let state = fake.state();
    let challenge = Arc::new(Mutex::new(String::new()));
    let seen_challenge = challenge.clone();

    let status = state
        .browser_sign_in(
            dir.path(),
            google::GOOGLE,
            "2.4.0",
            Duration::from_secs(10),
            browser(move |params| {
                *seen_challenge.lock().unwrap() = params["code_challenge"].clone();
                assert_eq!(params["code_challenge_method"], "S256");
                format!("code=login-code&state={}", params["state"])
            }),
        )
        .await
        .unwrap();
    assert!(status.signed_in);

    let exchange = &fake.requests("/v1/auth/token")[0];
    assert_eq!(exchange.body["grant_type"], "authorization_code");
    assert_eq!(exchange.body["code"], "login-code");
    let redirect = exchange.body["redirect_uri"].as_str().unwrap();
    assert!(redirect.starts_with("http://127.0.0.1:") && redirect.ends_with("/auth/callback"));
    let verifier = exchange.body["code_verifier"].as_str().unwrap();
    assert_eq!(derive_challenge(verifier), *challenge.lock().unwrap());
    assert_eq!(exchange.body["client"]["client_type"], "desktop");
}

#[tokio::test]
async fn google_sign_in_refuses_a_foreign_state() {
    let fake = spawn_fake(|_| (200, token_response(7, 900)));
    let dir = tempfile::tempdir().unwrap();
    let err = fake
        .state()
        .browser_sign_in(
            dir.path(),
            google::GOOGLE,
            "2.4.0",
            Duration::from_secs(10),
            browser(|_| "code=login-code&state=someone-elses".to_string()),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, codes::UNEXPECTED);
    assert!(fake.requests("/v1/auth/token").is_empty());
}

#[tokio::test]
async fn google_sign_in_reports_the_provider_error() {
    let fake = spawn_fake(|_| (404, Value::Null));
    let dir = tempfile::tempdir().unwrap();
    let err = fake
        .state()
        .browser_sign_in(
            dir.path(),
            google::GOOGLE,
            "2.4.0",
            Duration::from_secs(10),
            browser(|params| format!("error=access_denied&state={}", params["state"])),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, "access_denied");
}

#[tokio::test]
async fn google_sign_in_can_be_cancelled() {
    let fake = spawn_fake(|_| (404, Value::Null));
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(fake.state());
    let waiting = state.clone();
    let path = dir.path().to_path_buf();
    let task = tokio::spawn(async move {
        waiting
            .browser_sign_in(
                &path,
                google::GOOGLE,
                "2.4.0",
                Duration::from_secs(10),
                |_| Ok(()),
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    state.cancel_login();
    let err = task.await.unwrap().unwrap_err();
    assert_eq!(err.code, codes::CANCELLED);
}
