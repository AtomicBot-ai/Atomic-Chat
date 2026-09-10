//! On-disk mirror of the Local API Server's runtime state.
//!
//! The server's host / port / prefix live in the webview's localStorage
//! (`useLocalApiServer`), which a headless process cannot read. The desktop app
//! mirrors them into `<data_folder>/local-api-server.json` whenever the proxy
//! starts or stops, so `atomic-chat-cli server status` knows where to probe.
//!
//! The API key itself is deliberately never written — the CLI only needs to
//! know *whether* one is required, not what it is.
//!
//! The file is a hint, not a source of truth: a crashed app leaves
//! `running: true` behind. Callers are expected to confirm over HTTP.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::core::app::commands::resolve_jan_data_folder;

/// File name inside the Jan data folder.
pub const SERVER_STATE_FILE: &str = "local-api-server.json";

/// Defaults matching `useLocalApiServer`'s initial state, used when the file is
/// missing (app never started the server, or a pre-mirror build wrote nothing).
pub const DEFAULT_HOST: &str = "127.0.0.1";
pub const DEFAULT_PORT: u16 = 1337;
pub const DEFAULT_PREFIX: &str = "/v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalApiServerState {
    pub running: bool,
    pub host: String,
    /// The port the proxy actually bound to, which can differ from the
    /// requested one when the user configured port 0.
    pub port: u16,
    pub prefix: String,
    /// Whether the proxy rejects unauthenticated requests. The key is not stored.
    pub requires_api_key: bool,
    /// PID of the app process hosting the proxy, for diagnostics only.
    pub pid: u32,
}

impl Default for LocalApiServerState {
    fn default() -> Self {
        Self {
            running: false,
            host: DEFAULT_HOST.to_string(),
            port: DEFAULT_PORT,
            prefix: DEFAULT_PREFIX.to_string(),
            requires_api_key: false,
            pid: 0,
        }
    }
}

impl LocalApiServerState {
    /// Base URL of the proxy, without the API prefix.
    pub fn base_url(&self) -> String {
        // 0.0.0.0 is a bind address, not a connect address.
        let host = if self.host == "0.0.0.0" {
            DEFAULT_HOST
        } else {
            self.host.as_str()
        };
        format!("http://{host}:{}", self.port)
    }

    /// Base URL including the API prefix (e.g. `http://127.0.0.1:1337/v1`).
    pub fn api_url(&self) -> String {
        format!("{}{}", self.base_url(), self.prefix)
    }
}

pub fn state_path() -> PathBuf {
    resolve_jan_data_folder().join(SERVER_STATE_FILE)
}

/// Read the mirrored state, falling back to defaults when the file is absent or
/// unreadable. Never fails: a missing file simply means "not running, probe the
/// default address".
pub fn read_state() -> LocalApiServerState {
    read_state_from(&state_path())
}

pub fn read_state_from(path: &std::path::Path) -> LocalApiServerState {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Best-effort write. Failures are logged, never propagated — the proxy must
/// not fail to start just because the hint file could not be written.
pub fn write_state(state: &LocalApiServerState) {
    let path = state_path();
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log::warn!("Cannot create data folder for {SERVER_STATE_FILE}: {e}");
            return;
        }
    }
    match serde_json::to_string_pretty(state) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                log::warn!("Cannot write {}: {e}", path.display());
            }
        }
        Err(e) => log::warn!("Cannot serialize {SERVER_STATE_FILE}: {e}"),
    }
}

/// Record that the proxy is up on `port`, preserving the configured prefix/host.
pub fn mark_running(host: &str, port: u16, prefix: &str, requires_api_key: bool) {
    write_state(&LocalApiServerState {
        running: true,
        host: host.to_string(),
        port,
        prefix: prefix.to_string(),
        requires_api_key,
        pid: std::process::id(),
    });
}

/// Record that the proxy is down, keeping the last known address so the CLI can
/// still report where it *would* be.
pub fn mark_stopped() {
    let mut state = read_state();
    state.running = false;
    state.pid = 0;
    write_state(&state);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("atomic-server-state-tests")
            .join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn missing_file_falls_back_to_defaults() {
        let dir = temp_dir("missing");
        let state = read_state_from(&dir.join("nope.json"));
        assert!(!state.running);
        assert_eq!(state.host, DEFAULT_HOST);
        assert_eq!(state.port, DEFAULT_PORT);
        assert_eq!(state.prefix, DEFAULT_PREFIX);
        assert_eq!(state.api_url(), "http://127.0.0.1:1337/v1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_file_falls_back_to_defaults() {
        let dir = temp_dir("malformed");
        let path = dir.join(SERVER_STATE_FILE);
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(read_state_from(&path), LocalApiServerState::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn round_trips_a_running_state() {
        let dir = temp_dir("roundtrip");
        let path = dir.join(SERVER_STATE_FILE);
        let state = LocalApiServerState {
            running: true,
            host: "0.0.0.0".into(),
            port: 8080,
            prefix: "/api".into(),
            requires_api_key: true,
            pid: 4242,
        };
        std::fs::write(&path, serde_json::to_string_pretty(&state).unwrap()).unwrap();
        let read = read_state_from(&path);
        assert_eq!(read, state);
        // 0.0.0.0 is a bind address — never dial it.
        assert_eq!(read.base_url(), "http://127.0.0.1:8080");
        assert_eq!(read.api_url(), "http://127.0.0.1:8080/api");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The key itself must never reach disk — only the boolean saying whether
    /// one is needed.
    #[test]
    fn the_api_key_itself_is_never_serialized() {
        let json: serde_json::Value = serde_json::to_value(LocalApiServerState::default()).unwrap();
        let keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert!(keys.contains(&"requires_api_key"));
        assert!(
            !keys.contains(&"api_key"),
            "state file must not carry the key: {keys:?}"
        );
    }
}
