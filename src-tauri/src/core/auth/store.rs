//! On-disk home for the ChatGPT subscription tokens.
//!
//! Not `tauri-plugin-store`: that gives no control over the file mode and
//! shares one JSON file with the app-version/MCP migration data. A refresh
//! token is long-lived and higher-value than an API key, so it gets its own
//! file with its own permissions.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Bumped only if the on-disk shape changes incompatibly; `load` treats an
/// unknown version as "no session" rather than guessing.
pub const TOKEN_FILE_VERSION: u32 = 1;

pub const TOKEN_FILE_NAME: &str = "atomic-chatgpt-auth.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredTokens {
    pub version: u32,
    pub access_token: String,
    pub refresh_token: String,
    /// Kept so a reconnect-free restart can re-read the account claims without
    /// another round trip. Never sent anywhere.
    #[serde(default)]
    pub id_token: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub plan_type: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    /// Unix seconds. Absolute rather than a duration so a restart does not
    /// silently extend the token's life.
    pub expires_at: i64,
}

impl StoredTokens {
    pub fn is_expired_at(&self, now_unix: i64, safety_margin_secs: i64) -> bool {
        self.expires_at - safety_margin_secs <= now_unix
    }
}

pub fn token_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(TOKEN_FILE_NAME)
}

/// Read the stored session, or `None` when there is none / it is unreadable.
///
/// A corrupt or future-versioned file is treated as "not connected" rather than
/// an error: the only recovery is signing in again, and surfacing a parse error
/// on every status poll would be noise.
pub fn load(data_dir: &Path) -> Option<StoredTokens> {
    let path = token_file_path(data_dir);
    let raw = fs::read_to_string(&path).ok()?;
    let tokens: StoredTokens = match serde_json::from_str(&raw) {
        Ok(tokens) => tokens,
        Err(err) => {
            log::warn!("[chatgpt-auth] ignoring unreadable token file: {err}");
            return None;
        }
    };
    if tokens.version != TOKEN_FILE_VERSION {
        log::warn!(
            "[chatgpt-auth] ignoring token file version {} (expected {TOKEN_FILE_VERSION})",
            tokens.version
        );
        return None;
    }
    Some(tokens)
}

/// Write the session, owner-readable only.
///
/// The mode is set before the secret is written, so the file is never briefly
/// world-readable — `create_new` + `set_permissions` afterwards would leave
/// exactly that window.
pub fn save(data_dir: &Path, tokens: &StoredTokens) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|e| format!("cannot create data folder: {e}"))?;
    let path = token_file_path(data_dir);
    let body = serde_json::to_string_pretty(tokens)
        .map_err(|e| format!("cannot serialize tokens: {e}"))?;

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;

        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| format!("cannot open token file: {e}"))?;
        file.write_all(body.as_bytes())
            .map_err(|e| format!("cannot write token file: {e}"))?;
        // An existing file keeps its old mode through `open`, so restate it.
        fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))
            .map_err(|e| format!("cannot set token file permissions: {e}"))?;
    }

    #[cfg(not(unix))]
    {
        // Windows has no mode bits; the file inherits the data folder's ACL,
        // which is already per-user under APPDATA.
        fs::write(&path, body.as_bytes()).map_err(|e| format!("cannot write token file: {e}"))?;
    }

    Ok(())
}

/// Remove the session. Missing is success — "not connected" is the goal state.
pub fn clear(data_dir: &Path) -> Result<(), String> {
    let path = token_file_path(data_dir);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("cannot remove token file: {err}")),
    }
}
