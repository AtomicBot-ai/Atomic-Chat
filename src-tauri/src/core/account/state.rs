//! The account session in memory, with refresh serialised.
//!
//! The file sits behind one `tokio::Mutex`, which is also what makes refresh
//! single-flight, as in `core/auth/state.rs`: a second caller waits on the same
//! lock, then finds the token the first one just fetched. The backend rotates
//! the refresh token on every use and treats a replayed one as theft, so two
//! refreshes racing with the same token would sign the user out.

use std::future::Future;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{oneshot, Mutex};

use super::api::{
    base_url_from_env, codes, AccountApi, AccountError, EmailChallenge, IdentityInfo, MeResponse,
    SessionInfo, TokenResponse,
};
use super::client_info::{self, ClientInfo};
use super::google;
use super::store::{self, AccountFile, StoredSession, StoredUser};
use crate::core::auth::state::now_unix;

/// Refresh this far ahead of the stated expiry. Covers clock skew and the
/// round trip; a 401 still outranks this arithmetic.
pub const REFRESH_SAFETY_MARGIN_SECS: i64 = 120;

const MAX_DISPLAY_NAME_CHARS: usize = 100;
const MAX_EMAIL_LEN: usize = 320;

/// What the UI may know about the signed-in person. Carries no token.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountUser {
    pub id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

impl From<&StoredUser> for AccountUser {
    fn from(user: &StoredUser) -> Self {
        Self {
            id: user.id.clone(),
            email: user.email.clone(),
            display_name: user.display_name.clone(),
            avatar_url: user.avatar_url.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub signed_in: bool,
    pub user: Option<AccountUser>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile {
    pub user: AccountUser,
    pub created_at: String,
    pub identities: Vec<IdentityInfo>,
}

#[derive(Default)]
struct Slot {
    /// Whether the disk has been consulted yet in this process.
    hydrated: bool,
    /// `None` until this install first signs in (or the file was unusable).
    file: Option<AccountFile>,
}

impl Slot {
    fn session(&self) -> Option<&StoredSession> {
        self.file.as_ref().and_then(|f| f.session.as_ref())
    }

    fn status(&self) -> AccountStatus {
        match self.session() {
            None => AccountStatus::default(),
            Some(session) => AccountStatus {
                signed_in: true,
                user: Some(AccountUser::from(&session.user)),
            },
        }
    }

    /// The file, created with a fresh installation id on first use.
    fn file_mut(&mut self) -> &mut AccountFile {
        self.file.get_or_insert_with(AccountFile::fresh)
    }
}

pub struct AccountState {
    slot: Mutex<Slot>,
    api: OnceLock<Result<AccountApi, AccountError>>,
    device_name: OnceLock<Option<String>>,
    /// Cancels a browser sign-in that is still waiting; tagged so a finished
    /// sign-in never disarms the one that replaced it.
    login_cancel: std::sync::Mutex<Option<(u64, oneshot::Sender<()>)>>,
    login_seq: std::sync::atomic::AtomicU64,
}

impl Default for AccountState {
    fn default() -> Self {
        Self {
            slot: Mutex::new(Slot::default()),
            api: OnceLock::new(),
            device_name: OnceLock::new(),
            login_cancel: std::sync::Mutex::new(None),
            login_seq: std::sync::atomic::AtomicU64::new(0),
        }
    }
}

fn session_from(tokens: TokenResponse, now: i64) -> StoredSession {
    StoredSession {
        session_id: tokens.session_id,
        access_token: tokens.access_token,
        // Clamp a nonsense lifetime: never a dead token kept for days, never
        // a refresh on every call.
        access_expires_at: now + tokens.expires_in.clamp(60, 24 * 3600),
        refresh_token: tokens.refresh_token,
        user: StoredUser {
            id: tokens.user.id,
            email: tokens.user.email,
            display_name: tokens.user.display_name,
            avatar_url: tokens.user.avatar_url,
        },
    }
}

fn persist(data_dir: &Path, file: &AccountFile) {
    // A failed write keeps the session for this run; the next start may have
    // to sign in again. Not worth failing the call that already succeeded.
    if let Err(err) = store::save(data_dir, file) {
        log::warn!("[account] account file not saved: {err}");
    }
}

impl AccountState {
    /// For tests and tools: talk to a given API instead of the configured one.
    pub fn with_api(api: AccountApi) -> Self {
        let state = Self::default();
        let _ = state.api.set(Ok(api));
        let _ = state.device_name.set(Some("Test device".to_string()));
        state
    }

    pub fn api(&self) -> Result<AccountApi, AccountError> {
        self.api
            .get_or_init(|| base_url_from_env().and_then(AccountApi::new))
            .clone()
    }

    fn device_name(&self) -> Option<String> {
        self.device_name
            .get_or_init(client_info::device_name)
            .clone()
    }

    fn hydrate(slot: &mut Slot, data_dir: &Path) {
        if slot.hydrated {
            return;
        }
        slot.file = store::load(data_dir);
        slot.hydrated = true;
    }

    pub async fn status(&self, data_dir: &Path) -> AccountStatus {
        let mut slot = self.slot.lock().await;
        Self::hydrate(&mut slot, data_dir);
        slot.status()
    }

    pub async fn current_session_id(&self, data_dir: &Path) -> Option<String> {
        let mut slot = self.slot.lock().await;
        Self::hydrate(&mut slot, data_dir);
        slot.session().map(|s| s.session_id.clone())
    }

    async fn client_info(&self, data_dir: &Path, app_version: &str) -> ClientInfo {
        let installation_id = {
            let mut slot = self.slot.lock().await;
            Self::hydrate(&mut slot, data_dir);
            slot.file_mut().installation_id.clone()
        };
        ClientInfo::new(self.device_name(), app_version, &installation_id)
    }

    /// Keep a freshly issued session, in memory and on disk.
    async fn sign_in(&self, data_dir: &Path, tokens: TokenResponse) -> AccountStatus {
        let mut slot = self.slot.lock().await;
        Self::hydrate(&mut slot, data_dir);
        slot.file_mut().session = Some(session_from(tokens, now_unix()));
        if let Some(file) = &slot.file {
            persist(data_dir, file);
        }
        slot.status()
    }

    /// Forget the session but keep the installation id.
    async fn clear_session(&self, data_dir: &Path) -> AccountStatus {
        let mut slot = self.slot.lock().await;
        Self::hydrate(&mut slot, data_dir);
        if let Some(file) = slot.file.as_mut() {
            if file.session.take().is_some() {
                persist(data_dir, file);
            }
        }
        slot.status()
    }

    /// An access token good for the next request, refreshed first when it is
    /// close to expiry or when `rejected` names the token the server just
    /// refused. Refresh rejected with `invalid_grant` means the session is
    /// over (signed out elsewhere, revoked, expired): it is cleared and that
    /// error returned. Anything else keeps the session — a network blip must
    /// not sign anyone out.
    pub async fn access_token(
        &self,
        data_dir: &Path,
        rejected: Option<&str>,
    ) -> Result<String, AccountError> {
        let api = self.api()?;
        let mut slot = self.slot.lock().await;
        Self::hydrate(&mut slot, data_dir);

        let Some(current) = slot.session().cloned() else {
            return Err(AccountError::new(codes::NOT_SIGNED_IN, "not signed in"));
        };
        let now = now_unix();
        let needs_refresh = match rejected {
            // Someone else already refreshed past the rejected token.
            Some(token) => token == current.access_token,
            None => current.is_expired_at(now, REFRESH_SAFETY_MARGIN_SECS),
        };
        if !needs_refresh {
            return Ok(current.access_token);
        }

        match api.refresh(&current.refresh_token).await {
            Ok(tokens) => {
                let session = session_from(tokens, now_unix());
                let token = session.access_token.clone();
                let file = slot.file_mut();
                file.session = Some(session);
                persist(data_dir, file);
                Ok(token)
            }
            Err(err) if err.is(codes::INVALID_GRANT) => {
                log::info!("[account] session ended: {err}");
                if let Some(file) = slot.file.as_mut() {
                    file.session = None;
                    persist(data_dir, file);
                }
                Err(err)
            }
            Err(err) => Err(err),
        }
    }

    /// Run an authenticated call; on `401 invalid_token` refresh once and
    /// retry. An `invalid_grant` result means the session was just lost.
    pub async fn authed<T, F, Fut>(&self, data_dir: &Path, call: F) -> Result<T, AccountError>
    where
        F: Fn(AccountApi, String) -> Fut,
        Fut: Future<Output = Result<T, AccountError>>,
    {
        let api = self.api()?;
        let token = self.access_token(data_dir, None).await?;
        match call(api.clone(), token.clone()).await {
            Err(err) if err.is(codes::INVALID_TOKEN) => {
                let fresh = self.access_token(data_dir, Some(&token)).await?;
                call(api, fresh).await
            }
            other => other,
        }
    }

    pub async fn providers(&self) -> Result<Vec<String>, AccountError> {
        self.api()?.providers().await
    }

    pub async fn email_start(
        &self,
        data_dir: &Path,
        email: &str,
        app_version: &str,
    ) -> Result<EmailChallenge, AccountError> {
        let email = email.trim();
        if email.is_empty() || email.len() > MAX_EMAIL_LEN || !email.contains('@') {
            return Err(AccountError::new(
                codes::INVALID_REQUEST,
                "not an email address",
            ));
        }
        let api = self.api()?;
        let client = self.client_info(data_dir, app_version).await;
        api.email_start(email, &client).await
    }

    pub async fn email_verify(
        &self,
        data_dir: &Path,
        challenge_id: &str,
        code: &str,
        app_version: &str,
    ) -> Result<AccountStatus, AccountError> {
        let code: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
        let api = self.api()?;
        let client = self.client_info(data_dir, app_version).await;
        let tokens = api
            .email_verify(challenge_id.trim(), &code, &client)
            .await?;
        Ok(self.sign_in(data_dir, tokens).await)
    }

    /// Browser sign-in with a provider (Google). Resolves once the browser has
    /// come back to the loopback listener and the code has been redeemed.
    pub async fn browser_sign_in<O>(
        &self,
        data_dir: &Path,
        provider: &str,
        app_version: &str,
        timeout: Duration,
        open: O,
    ) -> Result<AccountStatus, AccountError>
    where
        O: FnOnce(&str) -> Result<(), String>,
    {
        let api = self.api()?;
        let client = self.client_info(data_dir, app_version).await;
        let (seq, cancel) = self.arm_cancel();
        let grant = google::run_browser_sign_in(&api, provider, cancel, timeout, open).await;
        self.disarm_cancel(seq);
        let grant = grant?;
        let tokens = api
            .exchange_code(
                &grant.code,
                &grant.code_verifier,
                &grant.redirect_uri,
                &client,
            )
            .await?;
        Ok(self.sign_in(data_dir, tokens).await)
    }

    /// Sign this device out. The server is told when it can be reached; the
    /// local session goes either way.
    pub async fn logout(&self, data_dir: &Path) -> AccountStatus {
        self.cancel_login();
        if self.status(data_dir).await.signed_in {
            let result = self
                .authed(
                    data_dir,
                    |api, token| async move { api.logout(&token).await },
                )
                .await;
            if let Err(err) = result {
                log::info!("[account] server-side sign-out skipped: {err}");
            }
        }
        self.clear_session(data_dir).await
    }

    /// The profile from the server, refreshing the cached user. The flag says
    /// whether the cached user changed.
    pub async fn profile(&self, data_dir: &Path) -> Result<(AccountProfile, bool), AccountError> {
        let me = self
            .authed(data_dir, |api, token| async move { api.me(&token).await })
            .await?;
        Ok(self.remember_profile(data_dir, me).await)
    }

    pub async fn update_profile(
        &self,
        data_dir: &Path,
        display_name: &str,
    ) -> Result<AccountProfile, AccountError> {
        let name = display_name.trim().to_string();
        if name.is_empty() || name.chars().count() > MAX_DISPLAY_NAME_CHARS {
            return Err(AccountError::new(
                codes::INVALID_REQUEST,
                "a display name has 1 to 100 characters",
            ));
        }
        let me = self
            .authed(data_dir, |api, token| {
                let name = name.clone();
                async move { api.update_me(&token, &name).await }
            })
            .await?;
        Ok(self.remember_profile(data_dir, me).await.0)
    }

    async fn remember_profile(&self, data_dir: &Path, me: MeResponse) -> (AccountProfile, bool) {
        let user = StoredUser {
            id: me.id,
            email: me.email,
            display_name: me.display_name,
            avatar_url: me.avatar_url,
        };
        let mut changed = false;
        {
            let mut slot = self.slot.lock().await;
            Self::hydrate(&mut slot, data_dir);
            if let Some(file) = slot.file.as_mut() {
                if let Some(session) = file.session.as_mut() {
                    // Only for the same person: a profile fetched just before a
                    // switch of account must not relabel the new session.
                    if session.user.id == user.id && session.user != user {
                        session.user = user.clone();
                        changed = true;
                        persist(data_dir, file);
                    }
                }
            }
        }
        (
            AccountProfile {
                user: AccountUser::from(&user),
                created_at: me.created_at,
                identities: me.identities,
            },
            changed,
        )
    }

    pub async fn sessions(&self, data_dir: &Path) -> Result<Vec<SessionInfo>, AccountError> {
        self.authed(
            data_dir,
            |api, token| async move { api.sessions(&token).await },
        )
        .await
    }

    /// Sign one device out. This device's own session is a plain sign-out.
    /// Returns the new status when it was this device.
    pub async fn revoke_session(
        &self,
        data_dir: &Path,
        session_id: &str,
    ) -> Result<Option<AccountStatus>, AccountError> {
        if self.current_session_id(data_dir).await.as_deref() == Some(session_id) {
            return Ok(Some(self.logout(data_dir).await));
        }
        let id = session_id.to_string();
        self.authed(data_dir, |api, token| {
            let id = id.clone();
            async move { api.revoke_session(&token, &id).await }
        })
        .await?;
        Ok(None)
    }

    /// Delete the account. `reauth_required` comes back unchanged when the last
    /// sign-in is older than the backend allows.
    pub async fn delete(&self, data_dir: &Path) -> Result<AccountStatus, AccountError> {
        self.authed(
            data_dir,
            |api, token| async move { api.delete_me(&token).await },
        )
        .await?;
        Ok(self.clear_session(data_dir).await)
    }

    fn arm_cancel(&self) -> (u64, oneshot::Receiver<()>) {
        let seq = self
            .login_seq
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1;
        let (tx, rx) = oneshot::channel();
        if let Ok(mut guard) = self.login_cancel.lock() {
            // A new sign-in replaces (and so cancels) one still waiting.
            if let Some((_, previous)) = guard.replace((seq, tx)) {
                let _ = previous.send(());
            }
        }
        (seq, rx)
    }

    fn disarm_cancel(&self, seq: u64) {
        if let Ok(mut guard) = self.login_cancel.lock() {
            if guard.as_ref().is_some_and(|(armed, _)| *armed == seq) {
                guard.take();
            }
        }
    }

    pub fn cancel_login(&self) {
        if let Ok(mut guard) = self.login_cancel.lock() {
            if let Some((_, tx)) = guard.take() {
                let _ = tx.send(());
            }
        }
    }
}
