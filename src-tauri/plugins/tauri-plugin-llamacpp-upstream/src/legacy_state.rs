//! Publishes which models this (legacy) runtime currently holds, so a core
//! process that owns the same data folder can see them.
//!
//! Until the app becomes a core client, both runtimes can be live at once: the
//! desktop app loads models through this plugin, while `atomic-chat-core` can
//! load its own. Two copies of one model would double the VRAM and fight over
//! the GPU, and the core cannot ask us — it has no IPC into the webview. So the
//! session table is mirrored to `<data>/atomic-core/legacy-runtime.json` after
//! every load and unload, and the core refuses to load a model that appears
//! there while this process is alive.
//!
//! Best effort by design: a failed write is logged and never fails a load. The
//! file is advisory, and the core treats a stale one (dead PID) as empty.

use std::path::PathBuf;

use serde::Serialize;

use crate::state::SessionInfo;

/// File name under `<data>/atomic-core/`. Chosen to sit beside the core's own
/// `instance.lock` and `processes.json` rather than in the data-folder root,
/// which belongs to files the app has published for years.
pub const LEGACY_RUNTIME_FILE: &str = "legacy-runtime.json";

#[derive(Serialize)]
struct LegacySession {
    model_id: String,
    port: i32,
    pid: i32,
    is_embedding: bool,
}

#[derive(Serialize)]
struct LegacyRuntimeState {
    /// The desktop app's PID. A core that finds this process gone ignores the file.
    pid: u32,
    owner_start_id: Option<String>,
    /// Seconds since the epoch; only for humans reading the file.
    updated_at: u64,
    provider: &'static str,
    sessions: Vec<LegacySession>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn owner_start_id(pid: u32) -> Option<String> {
    use sysinfo::{Pid, ProcessesToUpdate, System};
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
    system
        .process(Pid::from_u32(pid))
        .map(|process| format!("epoch:{}", process.start_time()))
}

/// Serialize the table. Separated from the write so it can be tested without a
/// filesystem, and so the shape stays visible in one place.
pub fn render_state(sessions: &[SessionInfo], pid: u32, updated_at: u64) -> String {
    let state = LegacyRuntimeState {
        pid,
        owner_start_id: owner_start_id(pid),
        updated_at,
        provider: "llamacpp-upstream",
        sessions: sessions
            .iter()
            .map(|info| LegacySession {
                model_id: info.model_id.clone(),
                port: info.port,
                pid: info.pid,
                is_embedding: info.is_embedding,
            })
            .collect(),
    };
    serde_json::to_string_pretty(&state).unwrap_or_else(|_| "{}".to_string())
}

/// Write the table to `<core_dir>/legacy-runtime.json` through a temp file, so a
/// reader never sees a half-written document. Failures are logged only.
pub fn publish(core_dir: &PathBuf, sessions: &[SessionInfo]) {
    let contents = render_state(sessions, std::process::id(), now_secs());
    if let Err(e) = std::fs::create_dir_all(core_dir) {
        log::debug!("[legacy-state] cannot create {}: {e}", core_dir.display());
        return;
    }
    let target = core_dir.join(LEGACY_RUNTIME_FILE);
    let tmp = core_dir.join(format!("{LEGACY_RUNTIME_FILE}.tmp"));
    if let Err(e) = std::fs::write(&tmp, contents) {
        log::debug!("[legacy-state] cannot write {}: {e}", tmp.display());
        return;
    }
    if let Err(e) = std::fs::rename(&tmp, &target) {
        log::debug!("[legacy-state] cannot publish {}: {e}", target.display());
        let _ = std::fs::remove_file(&tmp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(model_id: &str, port: i32, pid: i32) -> SessionInfo {
        SessionInfo {
            pid,
            port,
            model_id: model_id.to_string(),
            model_path: format!("/models/{model_id}.gguf"),
            is_embedding: false,
            api_key: "secret-key-that-must-not-leak".to_string(),
            mmproj_path: None,
            runtime_device: None,
        }
    }

    #[test]
    fn publishes_the_models_a_core_needs_to_avoid_double_loading() {
        let json = render_state(&[session("a/b", 3001, 100), session("c", 3002, 101)], 42, 1_700_000_000);
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["pid"], 42);
        assert_eq!(parsed["provider"], "llamacpp-upstream");
        assert_eq!(parsed["updated_at"], 1_700_000_000u64);
        let sessions = parsed["sessions"].as_array().unwrap();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0]["model_id"], "a/b");
        assert_eq!(sessions[0]["port"], 3001);
        assert_eq!(sessions[0]["pid"], 100);
        assert_eq!(sessions[0]["is_embedding"], false);
    }

    #[test]
    fn never_publishes_the_session_api_key() {
        let json = render_state(&[session("a", 3001, 100)], 1, 0);
        assert!(
            !json.contains("secret-key-that-must-not-leak"),
            "the per-session key is the backend's credential, not a discovery detail"
        );
        assert!(!json.contains("model_path"));
    }

    #[test]
    fn an_idle_runtime_publishes_an_empty_list_rather_than_nothing() {
        let json = render_state(&[], 7, 0);
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["sessions"].as_array().unwrap().len(), 0);
        assert_eq!(parsed["pid"], 7);
    }

    #[test]
    fn writes_and_replaces_the_file_atomically() {
        let dir = std::env::temp_dir().join(format!("atomic-legacy-state-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        publish(&dir, &[session("a", 3001, 100)]);
        let first = std::fs::read_to_string(dir.join(LEGACY_RUNTIME_FILE)).unwrap();
        assert!(first.contains("\"a\""));

        publish(&dir, &[]);
        let second = std::fs::read_to_string(dir.join(LEGACY_RUNTIME_FILE)).unwrap();
        assert!(!second.contains("\"a\""), "a stale session must not survive a republish");
        assert!(!dir.join(format!("{LEGACY_RUNTIME_FILE}.tmp")).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
