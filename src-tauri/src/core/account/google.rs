//! Browser sign-in with a provider (Google today), brokered by our backend.
//!
//! The app binds a loopback listener, opens the backend's `authorize` URL in
//! the system browser with a PKCE challenge, and gets a one-time login code
//! back on `http://127.0.0.1:<port>/auth/callback`. Loopback rather than the
//! `atomic-chat://` scheme because that scheme is only registered on macOS.
//! The listener is the MCP sign-in's (`core/mcp/oauth/flow.rs`); PKCE and the
//! `state` check are the ChatGPT sign-in's (`core/auth/chatgpt.rs`).

use std::time::Duration;

use tokio::sync::oneshot;

use super::api::{codes, AccountApi, AccountError};
use crate::core::auth::chatgpt::{new_pkce, new_state, state_matches};
use crate::core::mcp::oauth::flow::{
    start_callback_server, CALLBACK_CANCELLED, CALLBACK_TIMED_OUT,
};

/// The path the backend allows for loopback redirects.
pub const CALLBACK_PATH: &str = "/auth/callback";

pub const GOOGLE: &str = "google";

/// What the token endpoint needs to redeem the login code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserGrant {
    pub code: String,
    pub code_verifier: String,
    pub redirect_uri: String,
}

pub fn redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}{CALLBACK_PATH}")
}

/// Map what the listener reported into an `AccountError`. The backend sends
/// `error=access_denied|unverified_email|account_disabled|server_error`, which
/// arrives as that bare code.
pub fn callback_error(message: String) -> AccountError {
    if message == CALLBACK_CANCELLED {
        return AccountError::new(codes::CANCELLED, "sign-in cancelled");
    }
    if message == CALLBACK_TIMED_OUT {
        return AccountError::new(codes::TIMEOUT, message);
    }
    let code = message.split(':').next().unwrap_or_default().trim();
    let looks_like_code = !code.is_empty()
        && code.len() <= 64
        && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
    if looks_like_code {
        AccountError::new(code, message.clone())
    } else {
        AccountError::new(codes::UNEXPECTED, message)
    }
}

pub async fn run_browser_sign_in<O>(
    api: &AccountApi,
    provider: &str,
    cancel: oneshot::Receiver<()>,
    timeout: Duration,
    open: O,
) -> Result<BrowserGrant, AccountError>
where
    O: FnOnce(&str) -> Result<(), String>,
{
    let (port, waiter) = start_callback_server(CALLBACK_PATH)
        .map_err(|e| AccountError::new(codes::UNEXPECTED, e))?;
    let redirect_uri = redirect_uri(port);
    let pkce = new_pkce();
    let state = new_state();
    let url = api.authorize_url(provider, &redirect_uri, &pkce.challenge, &state);

    // Dropping the waiter on this path stops the listener.
    open(&url).map_err(|e| {
        AccountError::new(codes::UNEXPECTED, format!("cannot open the browser: {e}"))
    })?;

    let (code, received_state) = waiter.wait(timeout, cancel).await.map_err(callback_error)?;
    // Any local process can reach the listener; only the browser that started
    // here knows `state`.
    if !state_matches(&state, &received_state) {
        return Err(AccountError::new(
            codes::UNEXPECTED,
            "the sign-in answer did not match this request",
        ));
    }
    Ok(BrowserGrant {
        code,
        code_verifier: pkce.verifier,
        redirect_uri,
    })
}
