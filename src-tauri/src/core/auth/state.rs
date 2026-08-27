//! In-memory view of the ChatGPT session, with refresh serialised.
//!
//! The tokens live behind one `tokio::Mutex`, which is also what makes refresh
//! single-flight: a second caller blocks on the same lock, then re-checks the
//! expiry and finds the token the first caller just fetched. With exactly one
//! session there is nothing to key a `Notify` map on, so this is simpler than
//! `AutoIncreaseState`'s per-model coordinator and has the same guarantee.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::{oneshot, Mutex};

use crate::core::auth::chatgpt;
use crate::core::auth::store::{self, StoredTokens};

/// Refresh this far ahead of the stated expiry. Covers clock skew and the
/// round trip; a 401 is still treated as authoritative over this number.
pub const REFRESH_SAFETY_MARGIN_SECS: i64 = 120;

pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// What the frontend is allowed to know. Deliberately carries no token.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ChatGptStatus {
    pub connected: bool,
    pub email: Option<String>,
    pub plan_type: Option<String>,
    pub expires_at: Option<i64>,
}

/// A usable credential for one upstream request.
#[derive(Debug, Clone)]
pub struct AccessToken {
    pub token: String,
    pub account_id: Option<String>,
}

#[derive(Default)]
struct TokenSlot {
    /// Whether the disk has been consulted yet in this process.
    hydrated: bool,
    tokens: Option<StoredTokens>,
}

#[derive(Default)]
pub struct ChatGptAuthState {
    slot: Mutex<TokenSlot>,
    /// Cancels a sign-in that is still waiting on the browser.
    login_cancel: std::sync::Mutex<Option<oneshot::Sender<()>>>,
}

impl ChatGptAuthState {
    async fn hydrate(&self, slot: &mut TokenSlot, data_dir: &Path) {
        if slot.hydrated {
            return;
        }
        slot.tokens = store::load(data_dir);
        slot.hydrated = true;
    }

    pub async fn status(&self, data_dir: &Path) -> ChatGptStatus {
        let mut slot = self.slot.lock().await;
        self.hydrate(&mut slot, data_dir).await;
        match &slot.tokens {
            None => ChatGptStatus::default(),
            Some(tokens) => ChatGptStatus {
                connected: true,
                email: tokens.email.clone(),
                plan_type: tokens.plan_type.clone(),
                expires_at: Some(tokens.expires_at),
            },
        }
    }

    /// Persist a freshly obtained session.
    pub async fn set(&self, data_dir: &Path, tokens: StoredTokens) -> Result<(), String> {
        store::save(data_dir, &tokens)?;
        let mut slot = self.slot.lock().await;
        slot.tokens = Some(tokens);
        slot.hydrated = true;
        Ok(())
    }

    /// Forget the session, on disk and in memory.
    pub async fn logout(&self, data_dir: &Path) -> Result<(), String> {
        let mut slot = self.slot.lock().await;
        slot.tokens = None;
        slot.hydrated = true;
        store::clear(data_dir)
    }

    /// A token good for the next request, refreshing first if it is close to
    /// expiry. `force` skips the expiry check — that is the upstream-401 path,
    /// where the server's opinion outranks our arithmetic.
    pub async fn access_token(
        &self,
        data_dir: &Path,
        force_refresh: bool,
    ) -> Result<AccessToken, String> {
        let mut slot = self.slot.lock().await;
        self.hydrate(&mut slot, data_dir).await;

        let Some(current) = slot.tokens.clone() else {
            return Err("no ChatGPT subscription is connected".to_string());
        };

        let stale = current.is_expired_at(now_unix(), REFRESH_SAFETY_MARGIN_SECS);
        if !force_refresh && !stale {
            return Ok(AccessToken {
                token: current.access_token,
                account_id: current.account_id,
            });
        }

        match chatgpt::refresh_tokens(&current.refresh_token, now_unix()).await {
            Ok(refreshed) => {
                // A write failure is not fatal for this request, but it does
                // mean the next process start has to sign in again — say so.
                if let Err(err) = store::save(data_dir, &refreshed) {
                    log::warn!("[chatgpt-auth] refreshed token not persisted: {err}");
                }
                let token = AccessToken {
                    token: refreshed.access_token.clone(),
                    account_id: refreshed.account_id.clone(),
                };
                slot.tokens = Some(refreshed);
                Ok(token)
            }
            Err(err) if err.contains(chatgpt::REAUTHORIZATION_REQUIRED) => {
                // The refresh credential itself is finished: the session is
                // gone, and pretending otherwise leaves a card that says
                // "connected" and fails every request.
                slot.tokens = None;
                let _ = store::clear(data_dir);
                Err(format!("ChatGPT sign-in expired: {err}"))
            }
            Err(err) => {
                // Could not reach the token endpoint, or it answered something
                // we do not recognise. Keep the session — signing the user out
                // over a network blip is the worse failure.
                Err(format!("Could not refresh the ChatGPT session: {err}"))
            }
        }
    }

    /// Arm cancellation for a sign-in about to start, replacing any previous
    /// one (which cancels it — two browser windows racing for port 1455 cannot
    /// both win anyway).
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
}

/// Convenience for callers that hold an `AppHandle` rather than a path.
pub fn data_dir_for<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    crate::core::app::commands::get_jan_data_folder_path(app.clone())
}
