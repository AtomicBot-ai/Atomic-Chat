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

// -- Contract fixtures
//
// Emits the JSON contract fixtures a TypeScript port replays. Run with
// `cargo test --lib -- --ignored server::state_file::fixture_dump`.
//
// `write_state` / `mark_running` / `mark_stopped` resolve the real data folder
// (no env override exists), so the write cases build the exact struct those
// functions build and serialise it with the same `to_string_pretty` call,
// rather than touching the user's data folder. Reads go through the real
// path-parameterised `read_state_from`.
#[cfg(test)]
mod fixture_dump {
    use super::*;
    use serde_json::{json, Value};
    use std::fs;

    enum Op {
        /// `mark_running(host, port, prefix, requires_api_key)`.
        MarkRunning {
            host: &'static str,
            port: u16,
            prefix: &'static str,
            requires_api_key: bool,
        },
        /// `mark_stopped()` with the given file already on disk (None = absent).
        MarkStopped { existing: Option<&'static str> },
        /// `read_state_from(path)` with the given file on disk (None = absent).
        Read { file: Option<&'static str> },
    }

    struct Case {
        name: &'static str,
        op: Op,
    }

    fn cases() -> Vec<Case> {
        vec![
            Case {
                name: "write_mark_running_defaults",
                op: Op::MarkRunning { host: "127.0.0.1", port: 1337, prefix: "/v1", requires_api_key: false },
            },
            Case {
                name: "write_mark_running_bind_all_with_key",
                op: Op::MarkRunning { host: "0.0.0.0", port: 8080, prefix: "/api", requires_api_key: true },
            },
            Case {
                name: "write_mark_running_records_bound_port_not_requested_zero",
                op: Op::MarkRunning { host: "127.0.0.1", port: 43121, prefix: "/v1", requires_api_key: false },
            },
            Case {
                name: "write_mark_stopped_preserves_address_clears_pid",
                op: Op::MarkStopped {
                    existing: Some(
                        "{\n  \"running\": true,\n  \"host\": \"0.0.0.0\",\n  \"port\": 8080,\n  \"prefix\": \"/api\",\n  \"requires_api_key\": true,\n  \"pid\": 4242\n}",
                    ),
                },
            },
            Case {
                name: "write_mark_stopped_when_file_missing_writes_defaults",
                op: Op::MarkStopped { existing: None },
            },
            Case {
                name: "write_mark_stopped_when_file_malformed_writes_defaults",
                op: Op::MarkStopped { existing: Some("{ not json") },
            },
            Case { name: "read_missing_file_defaults", op: Op::Read { file: None } },
            Case { name: "read_malformed_json_defaults", op: Op::Read { file: Some("{ not json") } },
            Case {
                name: "read_round_trip_running_state_bind_all_dials_loopback",
                op: Op::Read {
                    file: Some(
                        "{\"running\":true,\"host\":\"0.0.0.0\",\"port\":8080,\"prefix\":\"/api\",\"requires_api_key\":true,\"pid\":4242}",
                    ),
                },
            },
            Case {
                name: "read_missing_field_rejects_whole_file",
                op: Op::Read { file: Some("{\"running\":true,\"host\":\"10.0.0.2\",\"port\":9000,\"prefix\":\"/v1\",\"pid\":1}") },
            },
            Case {
                name: "read_unknown_fields_ignored_api_key_never_read",
                op: Op::Read {
                    file: Some(
                        "{\"running\":true,\"host\":\"localhost\",\"port\":1337,\"prefix\":\"\",\"requires_api_key\":true,\"pid\":7,\"api_key\":\"sk-secret\",\"extra\":[1,2]}",
                    ),
                },
            },
            Case {
                name: "read_port_out_of_u16_range_defaults",
                op: Op::Read {
                    file: Some("{\"running\":true,\"host\":\"127.0.0.1\",\"port\":70000,\"prefix\":\"/v1\",\"requires_api_key\":false,\"pid\":1}"),
                },
            },
        ]
    }

    /// What `write_state` puts on disk: pretty JSON, no trailing newline.
    fn written_text(state: &LocalApiServerState) -> String {
        serde_json::to_string_pretty(state).unwrap()
    }

    fn state_json(state: &LocalApiServerState) -> Value {
        serde_json::to_value(state).unwrap()
    }

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .canonicalize()
            .unwrap()
    }

    fn git_head(root: &PathBuf) -> String {
        std::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(root)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    }

    #[test]
    #[ignore]
    fn dump_fixtures() {
        let root = repo_root();
        let out = root.join("tests/fixtures/core-contracts/state-file");
        fs::create_dir_all(&out).unwrap();
        let commit = git_head(&root);
        let source = "src-tauri/src/core/server/state_file.rs";

        let scratch = std::env::temp_dir().join("atomic-state-file-fixtures");
        let _ = fs::remove_dir_all(&scratch);
        fs::create_dir_all(&scratch).unwrap();

        let mut names = Vec::new();
        for c in cases() {
            let path = scratch.join(format!("{}.json", c.name));
            let (input, expected) = match c.op {
                Op::MarkRunning {
                    host,
                    port,
                    prefix,
                    requires_api_key,
                } => {
                    // Mirrors `mark_running`: the struct it builds, pid included.
                    let state = LocalApiServerState {
                        running: true,
                        host: host.to_string(),
                        port,
                        prefix: prefix.to_string(),
                        requires_api_key,
                        pid: std::process::id(),
                    };
                    let text = written_text(&state)
                        .replace(&format!("\"pid\": {}", state.pid), "\"pid\": \"<pid>\"");
                    let mut tree = state_json(&state);
                    tree["pid"] = json!("<pid>");
                    (
                        json!({"op": "mark_running", "host": host, "port": port,
                               "prefix": prefix, "requires_api_key": requires_api_key}),
                        json!({"file": tree, "text": text, "placeholders": ["<pid>"]}),
                    )
                }
                Op::MarkStopped { existing } => {
                    if let Some(text) = existing {
                        fs::write(&path, text).unwrap();
                    }
                    // Mirrors `mark_stopped`: read (defaults on failure), then
                    // clear `running` and `pid`, keep the address.
                    let mut state = read_state_from(&path);
                    state.running = false;
                    state.pid = 0;
                    (
                        json!({"op": "mark_stopped", "existing_file": existing}),
                        json!({"file": state_json(&state), "text": written_text(&state), "placeholders": []}),
                    )
                }
                Op::Read { file } => {
                    if let Some(text) = file {
                        fs::write(&path, text).unwrap();
                    }
                    let state = read_state_from(&path);
                    (
                        json!({"op": "read", "file": file}),
                        json!({"state": state_json(&state), "base_url": state.base_url(),
                               "api_url": state.api_url(), "placeholders": []}),
                    )
                }
            };
            let doc = json!({
                "name": c.name,
                "source": { "file": source, "commit": commit },
                "comparator": "state-file-schema",
                "input": input,
                "expected": expected,
            });
            fs::write(
                out.join(format!("{}.json", c.name)),
                serde_json::to_string_pretty(&doc).unwrap() + "\n",
            )
            .unwrap();
            names.push(c.name);
        }
        let _ = fs::remove_dir_all(&scratch);

        let index = json!({
            "source": { "file": source, "commit": commit },
            "comparator": "state-file-schema",
            "comparator_notes": {
                "state-file-schema": "The file lives at <data_folder>/local-api-server.json. input.op=mark_running: expected.file is the JSON the port must write (all six keys, nothing else — the API key is never written), expected.text is the exact bytes (serde_json pretty print: 2-space indent, `\"key\": value`, no trailing newline, key order running/host/port/prefix/requires_api_key/pid), with the live pid replaced by the placeholder \"<pid>\" in both. input.op=mark_stopped: read the existing file (input.existing_file, null = absent; unreadable/malformed/missing-field files read as the defaults), set running=false and pid=0, keep host/port/prefix/requires_api_key, write. input.op=read: expected.state is the struct read back plus the derived base_url/api_url; any parse failure (malformed JSON, a missing field, a port outside u16) yields the full default {running:false, host:'127.0.0.1', port:1337, prefix:'/v1', requires_api_key:false, pid:0}; unknown keys are ignored. base_url maps host 0.0.0.0 to 127.0.0.1 and never adds the prefix; api_url = base_url + prefix verbatim (prefix '' gives no trailing slash). Writes are best-effort: a failure to create the folder or write the file is logged and ignored, never propagated.",
                "placeholders": "\"<pid>\" stands for std::process::id() of the app process; compare it as any u32 > 0."
            },
            "cases": names,
        });
        fs::write(
            out.join("index.json"),
            serde_json::to_string_pretty(&index).unwrap() + "\n",
        )
        .unwrap();
        eprintln!(
            "wrote {} state-file fixtures to {}",
            names.len(),
            out.display()
        );
    }
}
