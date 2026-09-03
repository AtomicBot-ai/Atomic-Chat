//! MCP OAuth 2.1 browser sign-in (spec: discovery → DCR → PKCE), one session
//! per remote server, mirroring the ChatGPT connection in `core/auth/`.
//!
//! Two rmcp 0.8.5 quirks shape this module. Its built-in expiry check compares
//! the token's *static* `expires_in` instead of remaining time, so it either
//! never refreshes or refreshes on every request — refresh is therefore driven
//! here, from a persisted absolute `expires_at`. And `OAuthState` cannot hand
//! out tokens once authorized, so every path goes through
//! `into_authorization_manager()` and `AuthClient`.
//!
//! Nothing here ever returns a token over IPC.

pub mod flow;
pub mod store;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use oauth2::TokenResponse as _;
use rmcp::transport::auth::{AuthorizationManager, OAuthState, OAuthTokenResponse};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_http::reqwest;
use tokio::sync::{oneshot, Mutex};

use crate::core::auth::state::{data_dir_for, now_unix};
use crate::core::state::AppState;
use store::McpOAuthEntry;

/// Refresh this far ahead of the stated expiry. Covers clock skew and the
/// round trip; a 401 is still treated as authoritative over this number.
pub const REFRESH_SAFETY_MARGIN_SECS: i64 = 120;

/// Refresh-failure codes that mean the credential itself is finished; anything
/// else is treated as retryable (a network blip must not sign the user out).
const TERMINAL_REFRESH_ERRORS: [&str; 3] = [
    "invalid_grant",
    "invalid_refresh_token",
    "refresh_token_expired",
];

/// Loose match over transport error strings. rmcp surfaces a 401 differently
/// per transport, so this deliberately over-matches rather than under-matches:
/// the worst consequence is one extra token refresh.
pub fn is_auth_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("401")
        || lower.contains("unauthorized")
        || lower.contains("authorization required")
}

fn is_terminal_refresh_error(error: &str) -> bool {
    TERMINAL_REFRESH_ERRORS.iter().any(|e| error.contains(e))
}

/// Whether the stored session may be presented to the configured URL — hosts
/// must match, so an edited server URL never receives another host's tokens.
pub(crate) fn same_host(stored: &str, configured: &str) -> bool {
    let host = |raw: &str| {
        url::Url::parse(raw)
            .ok()
            .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
    };
    match (host(stored), host(configured)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

#[derive(Default)]
struct Slot {
    /// Whether the disk has been consulted yet in this process.
    hydrated: bool,
    servers: HashMap<String, McpOAuthEntry>,
}

#[derive(Default)]
pub struct McpOAuthState {
    /// In-memory mirror of the session file; the lock also serialises refresh.
    slot: Mutex<Slot>,
    /// Cancels a sign-in that is still waiting on the browser. One at a time:
    /// arming replaces (and thereby cancels) any previous sign-in.
    login_cancel: std::sync::Mutex<Option<oneshot::Sender<()>>>,
    /// Managers of live `AuthClient`s, for refreshing a connected server's
    /// session in place instead of reconnecting.
    live: Mutex<HashMap<String, Arc<Mutex<AuthorizationManager>>>>,
}

impl McpOAuthState {
    async fn hydrate(&self, slot: &mut Slot, data_dir: &Path) {
        if slot.hydrated {
            return;
        }
        slot.servers = store::load(data_dir);
        slot.hydrated = true;
    }

    async fn entry(&self, data_dir: &Path, name: &str) -> Option<McpOAuthEntry> {
        let mut slot = self.slot.lock().await;
        self.hydrate(&mut slot, data_dir).await;
        slot.servers.get(name).cloned()
    }

    pub async fn has_entry(&self, data_dir: &Path, name: &str) -> bool {
        self.entry(data_dir, name).await.is_some()
    }

    pub fn arm_cancel(&self) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut guard) = self.login_cancel.lock() {
            if let Some(previous) = guard.replace(tx) {
                let _ = previous.send(());
            }
        }
        rx
    }

    pub fn cancel_login(&self) {
        if let Ok(mut guard) = self.login_cancel.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(());
            }
        }
    }

    pub fn disarm_cancel(&self) {
        if let Ok(mut guard) = self.login_cancel.lock() {
            guard.take();
        }
    }

    /// Run the full browser sign-in and persist the resulting session.
    pub async fn login(&self, data_dir: &Path, name: &str, url: &str) -> Result<(), String> {
        let cancel = self.arm_cancel();
        let result = flow::run_login(name, url, cancel).await;
        self.disarm_cancel();
        let entry = result?;

        let mut slot = self.slot.lock().await;
        self.hydrate(&mut slot, data_dir).await;
        slot.servers.insert(name.to_string(), entry);
        store::save(data_dir, &slot.servers)
    }

    /// Forget the session, on disk and in memory. Missing is success.
    pub async fn logout(&self, data_dir: &Path, name: &str) -> Result<(), String> {
        {
            let mut slot = self.slot.lock().await;
            self.hydrate(&mut slot, data_dir).await;
            if slot.servers.remove(name).is_some() {
                store::save(data_dir, &slot.servers)?;
            }
        }
        self.live.lock().await.remove(name);
        Ok(())
    }

    /// A manager carrying this server's stored session for a new connection,
    /// refreshed first when close to expiry — or `None` when the server has no
    /// session (plain connection) or the session belongs to a different host.
    pub async fn manager_for_connect(
        &self,
        data_dir: &Path,
        name: &str,
        config_url: &str,
    ) -> Result<Option<AuthorizationManager>, String> {
        let Some(entry) = self.entry(data_dir, name).await else {
            return Ok(None);
        };
        if !same_host(&entry.url, config_url) {
            log::warn!(
                "[mcp-oauth] {name}: config URL no longer matches the signed-in host; \
                 connecting without the stored session"
            );
            return Ok(None);
        }

        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("cannot build HTTP client: {e}"))?;
        // `set_credentials` re-runs discovery — a network round trip, bounded
        // by the caller's handshake timeout.
        let mut oauth = OAuthState::new(entry.url.as_str(), Some(http))
            .await
            .map_err(|e| format!("{name}: authorization discovery failed: {e}"))?;
        oauth
            .set_credentials(&entry.client_id, entry.tokens.clone())
            .await
            .map_err(|e| format!("{name}: cannot restore the sign-in session: {e}"))?;
        let manager = oauth
            .into_authorization_manager()
            .ok_or_else(|| format!("{name}: restored session is not authorized"))?;

        if entry.is_expired_at(now_unix(), REFRESH_SAFETY_MARGIN_SECS) {
            self.refresh_with(&manager, data_dir, name, &entry).await?;
        }
        Ok(Some(manager))
    }

    /// Remember the manager of a live connection so its session can be
    /// refreshed in place.
    pub async fn register_live(&self, name: &str, manager: Arc<Mutex<AuthorizationManager>>) {
        self.live.lock().await.insert(name.to_string(), manager);
    }

    /// Refresh a live session when it is close to expiry, or unconditionally
    /// with `force` (the upstream-401 path, where the server's opinion
    /// outranks our arithmetic). A cheap no-op for servers without a session.
    pub async fn refresh_if_stale(
        &self,
        data_dir: &Path,
        name: &str,
        force: bool,
    ) -> Result<(), String> {
        let Some(entry) = self.entry(data_dir, name).await else {
            return Ok(());
        };
        if !force && !entry.is_expired_at(now_unix(), REFRESH_SAFETY_MARGIN_SECS) {
            return Ok(());
        }
        let manager = self.live.lock().await.get(name).cloned();
        let Some(manager) = manager else {
            return Ok(());
        };
        let guard = manager.lock().await;
        // Re-check under the manager lock: a concurrent caller may have just
        // refreshed, and rotating the credential twice can invalidate it.
        if !force {
            match self.entry(data_dir, name).await {
                Some(current) if !current.is_expired_at(now_unix(), REFRESH_SAFETY_MARGIN_SECS) => {
                    return Ok(());
                }
                Some(current) => return self.refresh_with(&guard, data_dir, name, &current).await,
                None => return Ok(()),
            }
        }
        self.refresh_with(&guard, data_dir, name, &entry).await
    }

    async fn refresh_with(
        &self,
        manager: &AuthorizationManager,
        data_dir: &Path,
        name: &str,
        previous: &McpOAuthEntry,
    ) -> Result<(), String> {
        match manager.refresh_token().await {
            Ok(mut refreshed) => {
                // A provider that is not rotating the refresh token may omit
                // it; dropping ours would force a re-login at the next expiry.
                if refreshed.refresh_token().is_none() {
                    refreshed.set_refresh_token(previous.tokens.refresh_token().cloned());
                }
                self.persist_tokens(data_dir, name, refreshed).await;
                Ok(())
            }
            Err(err) => {
                let message = err.to_string();
                if is_terminal_refresh_error(&message) {
                    // The refresh credential itself is finished; keeping the
                    // entry would leave a card that says "connected" and fails
                    // every request.
                    let mut slot = self.slot.lock().await;
                    slot.servers.remove(name);
                    if let Err(save_err) = store::save(data_dir, &slot.servers) {
                        log::warn!("[mcp-oauth] {name}: cannot clear expired session: {save_err}");
                    }
                    drop(slot);
                    self.live.lock().await.remove(name);
                    Err(format!(
                        "{name}: sign-in expired — open Connectors and sign in again"
                    ))
                } else {
                    Err(format!("{name}: could not refresh the sign-in: {message}"))
                }
            }
        }
    }

    /// Persist a fresh token response for an existing session. A write failure
    /// is not fatal for the running connection, but the next process start
    /// would have to sign in again — say so.
    pub async fn persist_tokens(&self, data_dir: &Path, name: &str, tokens: OAuthTokenResponse) {
        let mut slot = self.slot.lock().await;
        self.hydrate(&mut slot, data_dir).await;
        if let Some(entry) = slot.servers.get_mut(name) {
            entry.expires_at = flow::expires_at_from(&tokens, now_unix());
            entry.tokens = tokens;
            if let Err(err) = store::save(data_dir, &slot.servers) {
                log::warn!("[mcp-oauth] {name}: refreshed tokens not persisted: {err}");
            }
        }
    }
}

/// Open the system browser, wait for the loopback callback, exchange the code,
/// persist the session. One long-running command (the ChatGPT precedent):
/// the caller awaits a single promise and gets either success or the reason it
/// failed, with no half-state to reconcile.
#[tauri::command]
pub async fn mcp_oauth_login<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    name: String,
    url: String,
) -> Result<(), String> {
    let data_dir = data_dir_for(&app);
    state.mcp_oauth.login(&data_dir, &name, &url).await
}

/// Abandon a sign-in that is still waiting on the browser.
#[tauri::command]
pub async fn mcp_oauth_cancel(state: State<'_, AppState>) -> Result<(), String> {
    state.mcp_oauth.cancel_login();
    Ok(())
}

#[tauri::command]
pub async fn mcp_oauth_logout<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    let data_dir = data_dir_for(&app);
    state.mcp_oauth.logout(&data_dir, &name).await
}
