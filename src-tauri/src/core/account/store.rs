//! On-disk home for the Atomic Chat account session.
//!
//! One file in the data folder, owner-readable only, like
//! `atomic-chatgpt-auth.json` and `atomic-mcp-oauth.json`. Besides the session
//! it keeps this install's `installation_id`, which outlives a sign-out: the
//! backend uses it to replace the previous session of the same install when
//! someone signs in again.

use std::fs;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::RngCore as _;
use serde::{Deserialize, Serialize};

/// Bumped only if the on-disk shape changes incompatibly; `load` treats an
/// unknown version as "no file" rather than guessing.
pub const ACCOUNT_FILE_VERSION: u32 = 1;

pub const ACCOUNT_FILE_NAME: &str = "atomic-account.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredUser {
    pub id: String,
    pub email: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredSession {
    pub session_id: String,
    pub access_token: String,
    /// Unix seconds. Absolute so a restart does not extend the token's life.
    pub access_expires_at: i64,
    /// Opaque and rotated on every refresh; the newest one must reach the disk
    /// before it is relied on, or the next start presents a spent token.
    pub refresh_token: String,
    pub user: StoredUser,
}

impl StoredSession {
    pub fn is_expired_at(&self, now_unix: i64, safety_margin_secs: i64) -> bool {
        self.access_expires_at - safety_margin_secs <= now_unix
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AccountFile {
    pub version: u32,
    pub installation_id: String,
    #[serde(default)]
    pub session: Option<StoredSession>,
}

impl AccountFile {
    /// A file for an install that has never signed in.
    pub fn fresh() -> Self {
        Self {
            version: ACCOUNT_FILE_VERSION,
            installation_id: new_installation_id(),
            session: None,
        }
    }
}

/// 32 random bytes, base64url: 43 characters of `[A-Za-z0-9_-]`, which is what
/// the backend accepts (16–128 of those).
pub fn new_installation_id() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

pub fn account_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(ACCOUNT_FILE_NAME)
}

fn is_valid_installation_id(id: &str) -> bool {
    (16..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Read the account file, or `None` when there is none or it is unusable.
///
/// A corrupt or future-versioned file means "signed out": the only recovery is
/// signing in again, and an error on every status read would be noise.
pub fn load(data_dir: &Path) -> Option<AccountFile> {
    let raw = fs::read_to_string(account_file_path(data_dir)).ok()?;
    let file: AccountFile = match serde_json::from_str(&raw) {
        Ok(file) => file,
        Err(err) => {
            log::warn!("[account] ignoring unreadable account file: {err}");
            return None;
        }
    };
    if file.version != ACCOUNT_FILE_VERSION {
        log::warn!(
            "[account] ignoring account file version {} (expected {ACCOUNT_FILE_VERSION})",
            file.version
        );
        return None;
    }
    if !is_valid_installation_id(&file.installation_id) {
        log::warn!("[account] ignoring account file with a malformed installation id");
        return None;
    }
    Some(file)
}

/// Write the account file, owner-readable only.
///
/// Written to a sibling temp file first and renamed over the old one: a crash
/// halfway through must not leave a truncated file, because losing the newest
/// refresh token signs the user out.
pub fn save(data_dir: &Path, file: &AccountFile) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|e| format!("cannot create data folder: {e}"))?;
    let path = account_file_path(data_dir);
    let tmp = data_dir.join(format!("{ACCOUNT_FILE_NAME}.tmp"));
    let body =
        serde_json::to_string_pretty(file).map_err(|e| format!("cannot serialize account: {e}"))?;

    write_owner_only(&tmp, body.as_bytes())?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("cannot replace account file: {e}")
    })
}

/// The mode is set when the file is opened, so the secret is never briefly
/// world-readable.
pub(in crate::core::account) fn write_owner_only(path: &Path, bytes: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        let mut out = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("cannot open account file: {e}"))?;
        out.write_all(bytes)
            .map_err(|e| format!("cannot write account file: {e}"))?;
        out.sync_all()
            .map_err(|e| format!("cannot flush account file: {e}"))?;
        // A leftover temp file keeps its old mode through `open`, so restate it.
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("cannot set account file permissions: {e}"))?;
    }

    #[cfg(not(unix))]
    {
        // Windows has no mode bits; the file inherits the data folder's ACL,
        // which is already per-user under APPDATA.
        fs::write(path, bytes).map_err(|e| format!("cannot write account file: {e}"))?;
    }

    Ok(())
}
