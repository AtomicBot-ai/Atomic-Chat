//! Everything here runs without a network or a browser, mirroring
//! `core/auth/tests.rs`: the file store, the expiry arithmetic, the pure
//! classifiers, and the loopback listener's bind/cancel behaviour.

use std::time::Duration;

use oauth2::basic::BasicTokenType;
use oauth2::{
    AccessToken, EmptyExtraTokenFields, RefreshToken, StandardTokenResponse, TokenResponse as _,
};

use super::flow;
use super::store::{self, McpOAuthEntry};
use super::{is_auth_error, same_host};

fn token_response(expires_in: Option<u64>) -> rmcp::transport::auth::OAuthTokenResponse {
    let mut tokens = StandardTokenResponse::new(
        AccessToken::new("access-secret".to_string()),
        BasicTokenType::Bearer,
        EmptyExtraTokenFields {},
    );
    tokens.set_refresh_token(Some(RefreshToken::new("refresh-secret".to_string())));
    tokens.set_expires_in(expires_in.map(Duration::from_secs).as_ref());
    tokens
}

fn entry(expires_at: i64) -> McpOAuthEntry {
    McpOAuthEntry {
        client_id: "client-123".to_string(),
        url: "https://mcp.linear.app/sse".to_string(),
        tokens: token_response(Some(3600)),
        expires_at,
    }
}

#[test]
fn a_session_round_trips_through_the_store() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut servers = std::collections::HashMap::new();
    servers.insert("linear".to_string(), entry(1_900_000_000));

    store::save(dir.path(), &servers).expect("save");
    let loaded = store::load(dir.path());

    let restored = loaded.get("linear").expect("entry survives");
    assert_eq!(restored.client_id, "client-123");
    assert_eq!(restored.expires_at, 1_900_000_000);
    assert_eq!(
        restored.tokens.access_token().secret(),
        "access-secret",
        "the token response serializes verbatim"
    );
}

#[cfg(unix)]
#[test]
fn the_session_file_is_owner_readable_only() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().expect("tempdir");
    let mut servers = std::collections::HashMap::new();
    servers.insert("linear".to_string(), entry(0));
    store::save(dir.path(), &servers).expect("save");

    let mode = std::fs::metadata(store::oauth_file_path(dir.path()))
        .expect("metadata")
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[test]
fn a_corrupt_or_future_versioned_file_reads_as_no_sessions() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = store::oauth_file_path(dir.path());

    std::fs::write(&path, "not json").expect("write");
    assert!(store::load(dir.path()).is_empty());

    std::fs::write(&path, r#"{"version": 99, "servers": {}}"#).expect("write");
    assert!(store::load(dir.path()).is_empty());
}

#[test]
fn expiry_honours_the_safety_margin() {
    let e = entry(1_000);
    assert!(!e.is_expired_at(1_000 - 121, 120));
    assert!(e.is_expired_at(1_000 - 120, 120));
    assert!(e.is_expired_at(1_000, 120));
}

#[test]
fn expires_at_defaults_and_clamps() {
    // Provider said an hour.
    assert_eq!(
        flow::expires_at_from(&token_response(Some(3600)), 100),
        3700
    );
    // Provider said nothing → an hour.
    assert_eq!(flow::expires_at_from(&token_response(None), 100), 3700);
    // Nonsense lifetimes are clamped at both ends.
    assert_eq!(flow::expires_at_from(&token_response(Some(1)), 100), 160);
    assert_eq!(
        flow::expires_at_from(&token_response(Some(10_000_000_000)), 100),
        100 + 30 * 24 * 3600
    );
    // u64::MAX wraps negative through the i64 cast and lands on the floor —
    // still bounded, never a dead token that lives for weeks.
    assert_eq!(
        flow::expires_at_from(&token_response(Some(u64::MAX)), 100),
        160
    );
}

#[test]
fn the_dcr_fallback_client_id_is_rejected() {
    assert!(flow::dcr_was_rejected("mcp-client"));
    assert!(!flow::dcr_was_rejected("client-issued-by-provider"));
}

#[test]
fn sessions_only_apply_to_the_host_they_were_issued_for() {
    assert!(same_host(
        "https://mcp.linear.app/sse",
        "https://mcp.linear.app/mcp"
    ));
    assert!(same_host(
        "https://MCP.Linear.app/sse",
        "https://mcp.linear.app/sse"
    ));
    assert!(!same_host(
        "https://mcp.linear.app/sse",
        "https://evil.example.com/sse"
    ));
    assert!(!same_host("https://mcp.linear.app/sse", "not a url"));
}

#[test]
fn auth_errors_are_recognised_loosely() {
    assert!(is_auth_error(
        "Streamable HTTP handshake failed: 401 Unauthorized"
    ));
    assert!(is_auth_error(
        "SSE transport failed: authorization required"
    ));
    assert!(is_auth_error("server returned HTTP 401"));
    assert!(!is_auth_error("connection refused"));
    assert!(!is_auth_error("http handshake timed out after 30s"));
}

#[tokio::test]
async fn the_callback_listener_binds_a_real_port_and_honours_cancel() {
    let (port, waiter) = flow::start_callback_server().expect("bind");
    assert_ne!(port, 0, "an OS-assigned port was reported");

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    let wait = tokio::spawn(waiter.wait(Duration::from_secs(30), cancel_rx));
    let _ = cancel_tx.send(());

    let outcome = wait.await.expect("join");
    assert_eq!(outcome, Err("sign-in cancelled".to_string()));
}

#[tokio::test]
async fn the_callback_listener_returns_the_code_and_state_pair() {
    let (port, waiter) = flow::start_callback_server().expect("bind");

    let (_cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    let wait = tokio::spawn(waiter.wait(Duration::from_secs(30), cancel_rx));

    let url = format!(
        "http://127.0.0.1:{port}{}?code=abc123&state=xyz789",
        flow::CALLBACK_PATH
    );
    let body = tauri_plugin_http::reqwest::get(&url)
        .await
        .expect("callback request")
        .text()
        .await
        .expect("callback page");
    assert!(body.contains("Atomic Chat"), "static page served");

    let outcome = wait.await.expect("join");
    assert_eq!(outcome, Ok(("abc123".to_string(), "xyz789".to_string())));
}
