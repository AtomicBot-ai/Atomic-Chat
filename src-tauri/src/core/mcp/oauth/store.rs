//! On-disk home for MCP OAuth sessions, one entry per server.
//!
//! Deliberately not `mcp_config.json`: that file is user-editable, exported
//! wholesale by the JSON editor, and rewritten by `save_mcp_configs` — a
//! refresh token must not travel any of those paths. Same 0600-file approach
//! as `core/auth/store.rs` (the ChatGPT session).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use rmcp::transport::auth::OAuthTokenResponse;
use serde::{Deserialize, Serialize};

/// Bumped only if the on-disk shape changes incompatibly; `load` treats an
/// unknown version as "no sessions" rather than guessing.
pub const OAUTH_FILE_VERSION: u32 = 1;

pub const OAUTH_FILE_NAME: &str = "atomic-mcp-oauth.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpOAuthEntry {
    /// The dynamically registered client id; restoring a session needs it.
    pub client_id: String,
    /// The MCP base URL the sign-in was performed against. Guards against a
    /// config edit silently sending this session's tokens to a different host.
    pub url: String,
    /// The token response as rmcp hands it back, serialized verbatim.
    pub tokens: OAuthTokenResponse,
    /// Unix seconds. Absolute rather than a duration because rmcp's own expiry
    /// check compares the static `expires_in` and never fires (see mod docs).
    pub expires_at: i64,
}

impl McpOAuthEntry {
    pub fn is_expired_at(&self, now_unix: i64, safety_margin_secs: i64) -> bool {
        self.expires_at - safety_margin_secs <= now_unix
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct McpOAuthFile {
    version: u32,
    servers: HashMap<String, McpOAuthEntry>,
}

pub fn oauth_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(OAUTH_FILE_NAME)
}

/// Read all stored sessions; a missing, corrupt, or future-versioned file is
/// an empty map — the only recovery is signing in again, and surfacing a parse
/// error on every server start would be noise.
pub fn load(data_dir: &Path) -> HashMap<String, McpOAuthEntry> {
    let path = oauth_file_path(data_dir);
    let Ok(raw) = fs::read_to_string(&path) else {
        return HashMap::new();
    };
    let file: McpOAuthFile = match serde_json::from_str(&raw) {
        Ok(file) => file,
        Err(err) => {
            log::warn!("[mcp-oauth] ignoring unreadable session file: {err}");
            return HashMap::new();
        }
    };
    if file.version != OAUTH_FILE_VERSION {
        log::warn!(
            "[mcp-oauth] ignoring session file version {} (expected {OAUTH_FILE_VERSION})",
            file.version
        );
        return HashMap::new();
    }
    file.servers
}

/// Write all sessions, owner-readable only.
///
/// The mode is set before the secrets are written, so the file is never
/// briefly world-readable; an existing file keeps its old mode through `open`,
/// so it is restated afterwards.
pub fn save(data_dir: &Path, servers: &HashMap<String, McpOAuthEntry>) -> Result<(), String> {
    fs::create_dir_all(data_dir).map_err(|e| format!("cannot create data folder: {e}"))?;
    let path = oauth_file_path(data_dir);
    let body = serde_json::to_string_pretty(&McpOAuthFile {
        version: OAUTH_FILE_VERSION,
        servers: servers.clone(),
    })
    .map_err(|e| format!("cannot serialize MCP OAuth sessions: {e}"))?;

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
            .map_err(|e| format!("cannot open MCP OAuth session file: {e}"))?;
        file.write_all(body.as_bytes())
            .map_err(|e| format!("cannot write MCP OAuth session file: {e}"))?;
        fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))
            .map_err(|e| format!("cannot set MCP OAuth session file permissions: {e}"))?;
    }

    #[cfg(not(unix))]
    {
        // Windows has no mode bits; the file inherits the data folder's ACL,
        // which is already per-user under APPDATA.
        fs::write(&path, body.as_bytes())
            .map_err(|e| format!("cannot write MCP OAuth session file: {e}"))?;
    }

    Ok(())
}
