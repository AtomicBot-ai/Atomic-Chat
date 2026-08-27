//! Everything in the sign-in flow that does not need a browser or a network.

use std::time::Duration;

use crate::core::auth::chatgpt::{
    authorize_url, decode_jwt_claims, derive_challenge, new_pkce, new_state,
    parse_callback_query, redirect_uri, state_matches, CallbackParams, CALLBACK_PORT, CLIENT_ID,
    ORIGINATOR,
};
use crate::core::auth::state::{now_unix, ChatGptAuthState, REFRESH_SAFETY_MARGIN_SECS};
use crate::core::auth::store::{self, StoredTokens, TOKEN_FILE_VERSION};

fn tokens(expires_at: i64) -> StoredTokens {
    StoredTokens {
        version: TOKEN_FILE_VERSION,
        access_token: "access-abc".into(),
        refresh_token: "refresh-xyz".into(),
        id_token: None,
        account_id: Some("acct_1".into()),
        plan_type: Some("plus".into()),
        email: Some("user@example.test".into()),
        expires_at,
    }
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("atomic-chatgpt-auth-test-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn pkce_challenge_matches_the_rfc_7636_vector() {
    // RFC 7636 Appendix B.
    let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    assert_eq!(
        derive_challenge(verifier),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
}

#[test]
fn each_sign_in_gets_a_fresh_verifier_and_state() {
    let a = new_pkce();
    let b = new_pkce();
    assert_ne!(a.verifier, b.verifier);
    assert_ne!(new_state(), new_state());
    assert_eq!(derive_challenge(&a.verifier), a.challenge);
}

#[test]
fn authorize_url_identifies_this_client_by_its_own_name() {
    // Only the OAuth *client id* is OpenAI's public Codex one; `originator`
    // says who is actually asking, and it is us.
    let url = authorize_url(&new_pkce(), "state-123");
    assert!(url.contains(&format!("originator={ORIGINATOR}")));
    assert!(url.contains("codex_cli_simplified_flow=true"));
    assert!(url.contains("id_token_add_organizations=true"));
}

#[test]
fn authorize_url_carries_the_pkce_challenge_and_never_the_verifier() {
    let pkce = new_pkce();
    let url = authorize_url(&pkce, "state-123");

    assert!(url.starts_with("https://auth.openai.com/oauth/authorize?"));
    assert!(url.contains(&format!("client_id={CLIENT_ID}")));
    assert!(url.contains("code_challenge_method=S256"));
    assert!(url.contains(&urlencoding_of(&pkce.challenge)));
    assert!(url.contains("state=state-123"));
    assert!(url.contains("response_type=code"));
    // The verifier is the secret half — it must stay in this process.
    assert!(!url.contains(&pkce.verifier));
}

/// `Url::query_pairs_mut` percent-encodes; base64url output can contain `-`
/// and `_`, which survive, so a plain containment check is enough once we
/// account for nothing needing escaping here.
fn urlencoding_of(value: &str) -> String {
    value.replace('+', "%2B").replace('/', "%2F").replace('=', "%3D")
}

#[test]
fn redirect_uri_is_the_fixed_loopback_address() {
    assert_eq!(
        redirect_uri(),
        format!("http://localhost:{CALLBACK_PORT}/auth/callback")
    );
}

#[test]
fn callback_query_yields_the_code_and_state() {
    let parsed = parse_callback_query("code=abc123&state=st-1").expect("parses");
    assert_eq!(
        parsed,
        CallbackParams::Code {
            code: "abc123".into(),
            state: "st-1".into()
        }
    );
}

#[test]
fn callback_query_surfaces_a_provider_error() {
    let parsed =
        parse_callback_query("error=access_denied&error_description=User+declined").expect("parses");
    assert_eq!(
        parsed,
        CallbackParams::Error {
            error: "access_denied".into(),
            description: Some("User declined".into())
        }
    );
}

#[test]
fn callback_query_rejects_a_missing_code_or_state() {
    assert!(parse_callback_query("state=st-1").is_err());
    assert!(parse_callback_query("code=abc").is_err());
    assert!(parse_callback_query("code=&state=st-1").is_err());
}

#[test]
fn state_comparison_rejects_mismatches_and_length_differences() {
    assert!(state_matches("abcdef", "abcdef"));
    assert!(!state_matches("abcdef", "abcdeg"));
    assert!(!state_matches("abcdef", "abcde"));
    assert!(!state_matches("", "x"));
}

#[test]
fn jwt_claims_are_read_from_the_openai_namespace() {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;

    let payload = serde_json::json!({
        "email": "user@example.test",
        "https://api.openai.com/auth": {
            "chatgpt_account_id": "acct_42",
            "chatgpt_plan_type": "pro"
        }
    });
    let token = format!(
        "{}.{}.{}",
        URL_SAFE_NO_PAD.encode(b"{\"alg\":\"none\"}"),
        URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes()),
        "signature"
    );

    let claims = decode_jwt_claims(&token);
    assert_eq!(claims.account_id.as_deref(), Some("acct_42"));
    assert_eq!(claims.plan_type.as_deref(), Some("pro"));
    assert_eq!(claims.email.as_deref(), Some("user@example.test"));
}

#[test]
fn a_malformed_token_yields_empty_claims_rather_than_an_error() {
    assert_eq!(decode_jwt_claims("not-a-jwt").account_id, None);
    assert_eq!(decode_jwt_claims("a.!!!.c").email, None);
    assert_eq!(decode_jwt_claims("").plan_type, None);
}

#[test]
fn expiry_accounts_for_the_safety_margin() {
    let now = 1_000_000;
    // Comfortably in the future.
    assert!(!tokens(now + 600).is_expired_at(now, REFRESH_SAFETY_MARGIN_SECS));
    // Inside the margin: treated as already stale so the refresh happens
    // before a request goes out on it.
    assert!(tokens(now + 60).is_expired_at(now, REFRESH_SAFETY_MARGIN_SECS));
    assert!(tokens(now - 1).is_expired_at(now, REFRESH_SAFETY_MARGIN_SECS));
}

#[test]
fn tokens_round_trip_through_the_store() {
    let dir = temp_dir("round-trip");
    let saved = tokens(now_unix() + 3600);
    store::save(&dir, &saved).expect("save");

    assert_eq!(store::load(&dir), Some(saved));

    store::clear(&dir).expect("clear");
    assert_eq!(store::load(&dir), None);
    // Clearing again is not an error — "not connected" is the goal state.
    store::clear(&dir).expect("clear is idempotent");
}

#[cfg(unix)]
#[test]
fn the_token_file_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let dir = temp_dir("permissions");
    store::save(&dir, &tokens(now_unix() + 3600)).expect("save");
    // Saving over an existing file must not widen it either.
    store::save(&dir, &tokens(now_unix() + 7200)).expect("save again");

    let mode = std::fs::metadata(store::token_file_path(&dir))
        .expect("metadata")
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn a_future_version_on_disk_reads_as_no_session() {
    let dir = temp_dir("version");
    let mut future = tokens(now_unix() + 3600);
    future.version = TOKEN_FILE_VERSION + 1;
    std::fs::write(
        store::token_file_path(&dir),
        serde_json::to_string(&future).unwrap(),
    )
    .expect("write");

    assert_eq!(store::load(&dir), None);
}

#[test]
fn corrupt_json_reads_as_no_session() {
    let dir = temp_dir("corrupt");
    std::fs::write(store::token_file_path(&dir), "{ not json").expect("write");
    assert_eq!(store::load(&dir), None);
}

#[tokio::test]
async fn status_reflects_what_is_on_disk() {
    let dir = temp_dir("status");
    let auth = ChatGptAuthState::default();

    assert!(!auth.status(&dir).await.connected);

    store::save(&dir, &tokens(now_unix() + 3600)).expect("save");
    // A fresh state hydrates from disk on first read.
    let auth = ChatGptAuthState::default();
    let status = auth.status(&dir).await;
    assert!(status.connected);
    assert_eq!(status.email.as_deref(), Some("user@example.test"));
    assert_eq!(status.plan_type.as_deref(), Some("plus"));
}

#[tokio::test]
async fn logout_forgets_the_session_in_memory_and_on_disk() {
    let dir = temp_dir("logout");
    let auth = ChatGptAuthState::default();
    auth.set(&dir, tokens(now_unix() + 3600)).await.expect("set");
    assert!(auth.status(&dir).await.connected);

    auth.logout(&dir).await.expect("logout");
    assert!(!auth.status(&dir).await.connected);
    assert_eq!(store::load(&dir), None);
}

#[tokio::test]
async fn a_live_token_is_returned_without_touching_the_network() {
    let dir = temp_dir("live-token");
    let auth = ChatGptAuthState::default();
    auth.set(&dir, tokens(now_unix() + 3600)).await.expect("set");

    let token = auth.access_token(&dir, false).await.expect("token");
    assert_eq!(token.token, "access-abc");
    assert_eq!(token.account_id.as_deref(), Some("acct_1"));
}

#[tokio::test]
async fn asking_for_a_token_without_a_session_is_an_error_not_a_panic() {
    let dir = temp_dir("no-session");
    let auth = ChatGptAuthState::default();
    let err = auth.access_token(&dir, false).await.unwrap_err();
    assert!(err.contains("no ChatGPT subscription"), "{err}");
}

#[tokio::test]
async fn a_cancelled_sign_in_stops_waiting_for_the_browser() {
    let auth = ChatGptAuthState::default();
    let cancel = auth.arm_cancel();

    let waiter = tokio::spawn(crate::core::auth::chatgpt::await_callback(
        "st".to_string(),
        Duration::from_secs(30),
        cancel,
    ));
    // Give the listener a moment to bind before cancelling it.
    tokio::time::sleep(Duration::from_millis(50)).await;
    auth.cancel_login();

    let result = waiter.await.expect("task joins");
    match result {
        Err(err) => assert!(
            err.contains("cancelled") || err.contains("cannot listen"),
            "unexpected error: {err}"
        ),
        Ok(code) => panic!("expected no code, got {code}"),
    }
}
