//! The browser sign-in itself: loopback listener + rmcp's OAuth state machine.
//!
//! Shape borrowed from `core/auth/chatgpt.rs`, with two differences: the port
//! is OS-assigned (Dynamic Client Registration lets us register whatever
//! redirect URI we actually bound, unlike OpenAI's fixed one), and the CSRF
//! `state` comparison happens inside rmcp's `handle_callback` — the listener
//! just reports what the browser delivered.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::time::Duration;

use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Request, Response, Server, StatusCode};
use oauth2::TokenResponse as _;
use rmcp::transport::auth::{OAuthState, OAuthTokenResponse};
use tauri_plugin_http::reqwest;

use super::store::McpOAuthEntry;
use crate::core::auth::chatgpt::{parse_callback_query, CallbackParams};

pub const CALLBACK_PATH: &str = "/callback";

/// How long the loopback listener waits for the browser before giving up.
pub const CALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

/// rmcp's `AuthorizationSession::new` swallows a Dynamic Client Registration
/// failure and silently falls back to this stand-in client id, which then
/// fails at the authorize step with a message nobody can act on. Detect it and
/// stop before a browser ever opens.
const DCR_FALLBACK_CLIENT_ID: &str = "mcp-client";

pub(crate) fn dcr_was_rejected(client_id: &str) -> bool {
    client_id == DCR_FALLBACK_CLIENT_ID
}

/// The page the browser is left on. Static — nothing from the request is
/// reflected back into it.
const CALLBACK_PAGE: &str = concat!(
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<title>Atomic Chat</title></head><body style=\"font-family:system-ui;",
    "display:flex;align-items:center;justify-content:center;height:100vh;margin:0\">",
    "<p>You can close this tab and return to Atomic Chat.</p></body></html>"
);

/// Fresh token lifetime as absolute unix seconds. Defaults to an hour when the
/// server omits it, clamped so a nonsense lifetime neither hammers the token
/// endpoint nor leaves a dead token in place for weeks.
pub(crate) fn expires_at_from(tokens: &OAuthTokenResponse, now_unix: i64) -> i64 {
    let secs = tokens
        .expires_in()
        .map(|d| d.as_secs() as i64)
        .unwrap_or(3600)
        .clamp(60, 30 * 24 * 3600);
    now_unix + secs
}

pub(crate) struct CallbackWaiter {
    result_rx: tokio::sync::mpsc::Receiver<Result<(String, String), String>>,
    shutdown_tx: tokio::sync::oneshot::Sender<()>,
    server_task: tokio::task::JoinHandle<Result<(), hyper::Error>>,
}

impl CallbackWaiter {
    /// Wait for exactly one callback, then shut the listener down. Returns the
    /// `(code, state)` pair for rmcp to verify and exchange.
    pub(crate) async fn wait(
        mut self,
        timeout: Duration,
        cancel: tokio::sync::oneshot::Receiver<()>,
    ) -> Result<(String, String), String> {
        let outcome = tokio::select! {
            received = self.result_rx.recv() => {
                received.unwrap_or_else(|| Err("callback channel closed".to_string()))
            }
            _ = cancel => Err("sign-in cancelled".to_string()),
            _ = tokio::time::sleep(timeout) => {
                Err("timed out waiting for the browser sign-in".to_string())
            }
        };
        let _ = self.shutdown_tx.send(());
        let _ = self.server_task.await;
        outcome
    }
}

/// Bind the loopback listener on an OS-assigned port. Returns the port so the
/// caller can register the matching redirect URI — binding happens before the
/// browser opens, so a bind failure surfaces here.
pub(crate) fn start_callback_server() -> Result<(u16, CallbackWaiter), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], 0));
    let (result_tx, result_rx) = tokio::sync::mpsc::channel::<Result<(String, String), String>>(1);
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    let make_svc = make_service_fn(move |_conn| {
        let result_tx = result_tx.clone();
        async move {
            Ok::<_, Infallible>(service_fn(move |req: Request<Body>| {
                let result_tx = result_tx.clone();
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
                        // The `state` check is rmcp's `handle_callback`; a rogue
                        // local request can only make this sign-in fail, never
                        // complete it with a foreign code.
                        Ok(CallbackParams::Code { code, state }) => Ok((code, state)),
                    };

                    // Only the first callback is honoured.
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
        .map_err(|e| format!("cannot open a local port for the sign-in callback: {e}"))?
        .serve(make_svc);
    let port = server.local_addr().port();

    let graceful = server.with_graceful_shutdown(async {
        let _ = shutdown_rx.await;
    });
    let server_task = tokio::spawn(graceful);

    Ok((
        port,
        CallbackWaiter {
            result_rx,
            shutdown_tx,
            server_task,
        },
    ))
}

/// The whole sign-in: discovery → DCR → browser → code exchange. Resolves to
/// the entry to persist; the connect path rebuilds its own manager from it.
pub(crate) async fn run_login(
    name: &str,
    url: &str,
    cancel: tokio::sync::oneshot::Receiver<()>,
) -> Result<McpOAuthEntry, String> {
    let (port, waiter) = start_callback_server()?;
    let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("cannot build HTTP client: {e}"))?;

    let mut oauth = OAuthState::new(url, Some(http))
        .await
        .map_err(|e| format!("{name}: authorization discovery failed: {e}"))?;
    // Empty scopes: the provider's defaults. Discovery + DCR happen here.
    oauth
        .start_authorization(&[], &redirect_uri, Some("Atomic Chat"))
        .await
        .map_err(|e| format!("{name}: cannot start the browser sign-in: {e}"))?;

    let (client_id, _) = oauth
        .get_credentials()
        .await
        .map_err(|e| format!("{name}: cannot read the registered client: {e}"))?;
    if dcr_was_rejected(&client_id) {
        return Err(format!(
            "{name} did not accept automatic app registration, so browser sign-in \
             is not available for this server. Add it from \"Add Server\" with an \
             access token instead."
        ));
    }

    let auth_url = oauth
        .get_authorization_url()
        .await
        .map_err(|e| format!("{name}: cannot build the authorization URL: {e}"))?;
    if let Err(err) = tauri_plugin_opener::open_url(&auth_url, None::<&str>) {
        return Err(format!("cannot open the browser for sign-in: {err}"));
    }

    let (code, cb_state) = waiter.wait(CALLBACK_TIMEOUT, cancel).await?;
    oauth
        .handle_callback(&code, &cb_state)
        .await
        .map_err(|e| format!("{name}: sign-in could not be completed: {e}"))?;

    let (client_id, tokens) = oauth
        .get_credentials()
        .await
        .map_err(|e| format!("{name}: cannot read the signed-in session: {e}"))?;
    let tokens = tokens.ok_or_else(|| format!("{name}: sign-in produced no tokens"))?;

    Ok(McpOAuthEntry {
        client_id,
        url: url.to_string(),
        expires_at: expires_at_from(&tokens, crate::core::auth::state::now_unix()),
        tokens,
    })
}
