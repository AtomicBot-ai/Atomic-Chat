//! OAuth 2.0 + PKCE against `auth.openai.com`, the way the Codex CLI signs in.
//!
//! Everything that can be exercised without a network or a browser — PKCE
//! derivation, the authorize URL, callback parsing, `state` comparison, claim
//! decoding — is a free function so `tests.rs` can drive it directly. The two
//! functions that do I/O (`exchange_code`, `refresh_tokens`) are thin wrappers
//! over one `reqwest` POST each.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::time::Duration;

use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Request, Response, Server, StatusCode};
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::core::auth::store::StoredTokens;

/// OpenAI's registered Codex client. See the ADR
/// `2026-08-27-connect-a-chatgpt-subscription-as-a-model-provider.md` for the
/// decision to present it.
pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const ISSUER: &str = "https://auth.openai.com";
pub const SCOPES: &str = "openid profile email offline_access";

/// The redirect URI is matched exactly by the authorization server, so this
/// port is not negotiable — unlike the Local API Server, we must not fall back
/// to an OS-assigned one when it is busy.
pub const CALLBACK_PORT: u16 = 1455;
pub const CALLBACK_PATH: &str = "/auth/callback";

/// How long the loopback listener waits for the browser before giving up.
pub const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

/// The claim namespace OpenAI puts the ChatGPT account fields under.
const AUTH_CLAIM_NAMESPACE: &str = "https://api.openai.com/auth";

/// Error codes that mean the refresh credential itself is finished. Anything
/// else from the token endpoint is treated as retryable.
const TERMINAL_TOKEN_ERRORS: [&str; 3] = [
    "invalid_grant",
    "invalid_refresh_token",
    "refresh_token_expired",
];

/// Marker the state layer looks for to decide whether to drop the session.
pub const REAUTHORIZATION_REQUIRED: &str = "reauthorization required";

/// Identifies this client to the authorization server and to the API. We
/// present ourselves under our own name; only the OAuth client id is OpenAI's
/// public Codex one.
pub const ORIGINATOR: &str = "atomic_chat";

pub fn redirect_uri() -> String {
    format!("http://localhost:{CALLBACK_PORT}{CALLBACK_PATH}")
}

/// A PKCE pair. The verifier stays in this process; only the challenge travels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn derive_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn random_url_safe(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

pub fn new_pkce() -> Pkce {
    let verifier = random_url_safe(64);
    let challenge = derive_challenge(&verifier);
    Pkce {
        verifier,
        challenge,
    }
}

pub fn new_state() -> String {
    random_url_safe(32)
}

/// Comparison that does not leak the position of the first differing byte.
/// The callback listens on loopback, where any local process can reach it, so
/// `state` is what makes the window safe.
pub fn state_matches(expected: &str, received: &str) -> bool {
    let a = expected.as_bytes();
    let b = received.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn authorize_url(pkce: &Pkce, state: &str) -> String {
    let mut url = url::Url::parse(&format!("{ISSUER}/oauth/authorize"))
        .expect("authorize endpoint is a valid URL");
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", &redirect_uri())
        .append_pair("scope", SCOPES)
        .append_pair("code_challenge", &pkce.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("originator", ORIGINATOR)
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("id_token_add_organizations", "true");
    url.to_string()
}

/// What the browser hands back on the loopback callback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallbackParams {
    Code {
        code: String,
        state: String,
    },
    /// The provider reported a failure (user declined, expired request, …).
    Error {
        error: String,
        description: Option<String>,
    },
}

/// Parse the callback's query string. Pure so the error paths are testable.
pub fn parse_callback_query(query: &str) -> Result<CallbackParams, String> {
    let pairs: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes())
        .into_owned()
        .collect();

    if let Some(error) = pairs.get("error") {
        return Ok(CallbackParams::Error {
            error: error.clone(),
            description: pairs.get("error_description").cloned(),
        });
    }

    let code = pairs
        .get("code")
        .filter(|c| !c.is_empty())
        .ok_or_else(|| "callback carried no authorization code".to_string())?;
    let state = pairs
        .get("state")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "callback carried no state".to_string())?;

    Ok(CallbackParams::Code {
        code: code.clone(),
        state: state.clone(),
    })
}

/// The page the browser is left on. Static — nothing from the request is
/// reflected back into it.
const CALLBACK_PAGE: &str = concat!(
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<title>Atomic Chat</title></head><body style=\"font-family:system-ui;",
    "display:flex;align-items:center;justify-content:center;height:100vh;margin:0\">",
    "<p>You can close this tab and return to Atomic Chat.</p></body></html>"
);

/// Bind the loopback listener, wait for exactly one callback, shut down.
///
/// Returns the authorization code. Errors cover: the port being taken (usually
/// the real Codex CLI mid-login — there is no fallback port, so this is
/// reported as itself), a `state` mismatch, an error response, and the timeout.
pub async fn await_callback(
    expected_state: String,
    timeout: Duration,
    cancel: tokio::sync::oneshot::Receiver<()>,
) -> Result<String, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], CALLBACK_PORT));
    let (result_tx, result_rx) = tokio::sync::mpsc::channel::<Result<String, String>>(1);
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    let expected = expected_state.clone();
    let make_svc = make_service_fn(move |_conn| {
        let result_tx = result_tx.clone();
        let expected = expected.clone();
        async move {
            Ok::<_, Infallible>(service_fn(move |req: Request<Body>| {
                let result_tx = result_tx.clone();
                let expected = expected.clone();
                async move {
                    if req.uri().path() != CALLBACK_PATH {
                        return Ok::<_, Infallible>(
                            Response::builder()
                                .status(StatusCode::NOT_FOUND)
                                .body(Body::empty())
                                .expect("static 404 response"),
                        );
                    }

                    let outcome = match parse_callback_query(req.uri().query().unwrap_or("")) {
                        Err(err) => Err(err),
                        Ok(CallbackParams::Error { error, description }) => {
                            Err(match description {
                                Some(d) => format!("{error}: {d}"),
                                None => error,
                            })
                        }
                        Ok(CallbackParams::Code { code, state }) => {
                            if state_matches(&expected, &state) {
                                Ok(code)
                            } else {
                                Err("callback state did not match this sign-in".to_string())
                            }
                        }
                    };

                    // Only the first callback is honoured; the server shuts
                    // down as soon as this is received.
                    let _ = result_tx.try_send(outcome);

                    Ok::<_, Infallible>(
                        Response::builder()
                            .status(StatusCode::OK)
                            .header("content-type", "text/html; charset=utf-8")
                            .body(Body::from(CALLBACK_PAGE))
                            .expect("static callback page"),
                    )
                }
            }))
        }
    });

    let server = Server::try_bind(&addr)
        .map_err(|e| {
            format!(
                "cannot listen on 127.0.0.1:{CALLBACK_PORT} for the sign-in callback ({e}). \
                 This port is fixed by OpenAI's redirect URI — close whatever is using it \
                 (often the Codex CLI mid-login) and try again."
            )
        })?
        .serve(make_svc);

    let graceful = server.with_graceful_shutdown(async {
        let _ = shutdown_rx.await;
    });
    let server_task = tokio::spawn(graceful);

    let mut result_rx = result_rx;
    let outcome = tokio::select! {
        received = result_rx.recv() => received.unwrap_or_else(|| Err("callback channel closed".to_string())),
        _ = cancel => Err("sign-in cancelled".to_string()),
        _ = tokio::time::sleep(timeout) => Err("timed out waiting for the browser sign-in".to_string()),
    };

    let _ = shutdown_tx.send(());
    let _ = server_task.await;
    outcome
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

/// Claims we care about out of the `id_token`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IdClaims {
    pub account_id: Option<String>,
    pub plan_type: Option<String>,
    pub email: Option<String>,
}

/// Read the account fields out of a JWT payload.
///
/// Both tokens are read this way, for different fields: the **access token**
/// carries `chatgpt_account_id`, which every upstream request needs as a
/// routing hint, while the id token carries the email that labels the card.
///
/// The signature is not verified: the token arrived over a TLS connection this
/// process opened to a pinned host, and nothing here is a security decision.
/// Returns defaults on anything unparseable.
pub fn decode_jwt_claims(id_token: &str) -> IdClaims {
    let mut parts = id_token.split('.');
    let (_header, payload) = match (parts.next(), parts.next()) {
        (Some(h), Some(p)) => (h, p),
        _ => return IdClaims::default(),
    };

    // JWTs are base64url without padding, but be lenient about both.
    let decoded = URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| STANDARD_NO_PAD.decode(payload));
    let Ok(bytes) = decoded else {
        return IdClaims::default();
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return IdClaims::default();
    };

    let auth = value.get(AUTH_CLAIM_NAMESPACE);
    IdClaims {
        account_id: auth
            .and_then(|a| a.get("chatgpt_account_id"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        plan_type: auth
            .and_then(|a| a.get("chatgpt_plan_type"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        email: value
            .get("email")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    }
}

fn to_stored(
    response: TokenResponse,
    now_unix: i64,
    previous_refresh: Option<&str>,
) -> Result<StoredTokens, String> {
    // A refresh response may omit `refresh_token` when the provider is not
    // rotating it; dropping the old one there would force a re-login an hour
    // later.
    let refresh_token = response
        .refresh_token
        .or_else(|| previous_refresh.map(str::to_string))
        .ok_or_else(|| "sign-in returned no refresh token".to_string())?;

    // The account id lives on the *access* token; a refresh response may carry
    // no id token at all, so reading it from there would leave every refreshed
    // session unable to address its own account.
    let access_claims = decode_jwt_claims(&response.access_token);
    let id_claims = response
        .id_token
        .as_deref()
        .map(decode_jwt_claims)
        .unwrap_or_default();

    Ok(StoredTokens {
        version: crate::core::auth::store::TOKEN_FILE_VERSION,
        access_token: response.access_token,
        refresh_token,
        id_token: response.id_token,
        account_id: access_claims.account_id.or(id_claims.account_id),
        plan_type: access_claims.plan_type.or(id_claims.plan_type),
        email: id_claims.email.or(access_claims.email),
        // Default to an hour when the server omits it, and clamp: a nonsense
        // lifetime would either hammer the refresh endpoint or leave a dead
        // token in place for weeks. The 401 retry is the real backstop.
        expires_at: now_unix
            + response
                .expires_in
                .unwrap_or(3600)
                .clamp(60, 30 * 24 * 3600),
    })
}

async fn post_token_form(form: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("cannot build HTTP client: {e}"))?;

    let response = client
        .post(format!("{ISSUER}/oauth/token"))
        .form(form)
        .send()
        .await
        .map_err(|e| format!("token request failed: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("cannot read token response: {e}"))?;

    if !status.is_success() {
        // A spent or revoked refresh credential is terminal — the session is
        // gone and only a reconnect fixes it. Anything else may be transient,
        // and clearing the tokens over it would sign the user out for a blip.
        let code = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| {
                v.get("error").map(|e| match e {
                    serde_json::Value::String(s) => s.clone(),
                    other => other
                        .get("code")
                        .and_then(|c| c.as_str())
                        .unwrap_or_default()
                        .to_string(),
                })
            })
            .unwrap_or_default();
        if TERMINAL_TOKEN_ERRORS.contains(&code.as_str()) {
            return Err(format!("{REAUTHORIZATION_REQUIRED}: {code}"));
        }
        // Otherwise pass the provider's own words through — they are the
        // actionable part.
        return Err(format!("token request rejected ({status}): {body}"));
    }

    serde_json::from_str::<TokenResponse>(&body)
        .map_err(|e| format!("cannot parse token response: {e}"))
}

pub async fn exchange_code(code: &str, pkce: &Pkce, now_unix: i64) -> Result<StoredTokens, String> {
    let redirect = redirect_uri();
    let response = post_token_form(&[
        ("grant_type", "authorization_code"),
        ("client_id", CLIENT_ID),
        ("code", code),
        ("redirect_uri", &redirect),
        ("code_verifier", &pkce.verifier),
    ])
    .await?;
    to_stored(response, now_unix, None)
}

pub async fn refresh_tokens(refresh_token: &str, now_unix: i64) -> Result<StoredTokens, String> {
    let response = post_token_form(&[
        ("grant_type", "refresh_token"),
        ("client_id", CLIENT_ID),
        ("refresh_token", refresh_token),
        ("scope", SCOPES),
    ])
    .await?;
    to_stored(response, now_unix, Some(refresh_token))
}
