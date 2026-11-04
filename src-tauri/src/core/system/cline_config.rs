//! Cline CLI: what `cline auth` cannot say, and what Disconnect puts back.
//!
//! `cline auth --provider openai-compatible ...` saves the provider into
//! Cline's `providers.json` (`<CLINE_DIR>/data/settings/providers.json`) and
//! makes it `lastUsedProvider`, but has no flag for the context window. Cline
//! (3.x, `@cline/core`) reads it from the provider's `contextWindow`, and the
//! reply cap from `maxTokens`, so both are set on that entry afterwards; with
//! the window unknown they are removed, since whatever is there belonged to the
//! endpoint the entry pointed at before.
//!
//! Before `cline auth` runs, the entry and `lastUsedProvider` are recorded in
//! the backup sidecar; Disconnect restores them while they still hold ours.
//!
//! Twin of `src/integrations/configure/cline.ts` in atomic-chat-core.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::agent_files::{
    or_null, output_cap, read_json_object, read_sidecar, remove_sidecar, restore_key, write_json,
    write_sidecar,
};
use super::agent_user_env::{agent_env_var, expand_home};

const PROVIDER: &str = "openai-compatible";

/// `providers.json` where Cline resolves it: `$CLINE_PROVIDER_SETTINGS_PATH`,
/// else `$CLINE_DATA_DIR/settings`, else `$CLINE_DIR/data/settings`, else
/// `~/.cline/data/settings`. `env` answers for the variables.
pub(crate) fn providers_path(home: &Path, env: impl Fn(&str) -> Option<String>) -> PathBuf {
    if let Some(path) = env("CLINE_PROVIDER_SETTINGS_PATH") {
        return expand_home(&path, home);
    }
    let data = match env("CLINE_DATA_DIR") {
        Some(dir) => expand_home(&dir, home),
        None => match env("CLINE_DIR") {
            Some(dir) => expand_home(&dir, home).join("data"),
            None => home.join(".cline").join("data"),
        },
    };
    data.join("settings").join("providers.json")
}

pub(crate) fn resolve_providers_path() -> Result<PathBuf, String> {
    let home = super::commands::agent_home_dir()?;
    Ok(providers_path(Path::new(&home), agent_env_var))
}

fn entry_settings(root: &Map<String, Value>) -> Option<&Map<String, Value>> {
    root.get("providers")?
        .get(PROVIDER)?
        .get("settings")?
        .as_object()
}

/// Whether the entry still points where we pointed it.
fn holds_ours(root: &Map<String, Value>, written: Option<&Value>) -> bool {
    let (Some(settings), Some(written)) = (entry_settings(root), written) else {
        return false;
    };
    settings.get("baseUrl") == written.get("baseUrl")
        && settings.get("model") == written.get("model")
}

/// What Disconnect will need, read before `cline auth` rewrites the file. Kept
/// as it is across reconnects while the file still holds ours.
pub(crate) struct Snapshot {
    previous: Value,
}

pub(crate) fn snapshot(path: &Path) -> Result<Snapshot, String> {
    let root = read_json_object(path)?.unwrap_or_default();
    if let Some(backup) = read_sidecar(path) {
        if holds_ours(&root, backup.get("written")) {
            if let Some(previous) = backup.get("previous") {
                return Ok(Snapshot {
                    previous: previous.clone(),
                });
            }
        }
    }
    Ok(Snapshot {
        previous: json!({
            "lastUsedProvider": or_null(root.get("lastUsedProvider")),
            "entry": or_null(root.get("providers").and_then(|p| p.get(PROVIDER))),
        }),
    })
}

/// After a successful `cline auth`: set (or clear) the window on the entry it
/// saved, then record the backup.
pub(crate) fn finish(
    path: &Path,
    snapshot: Snapshot,
    api_url: &str,
    model: &str,
    context: Option<u32>,
) -> Result<(), String> {
    let mut root = read_json_object(path)?.unwrap_or_default();
    let settings = root
        .get_mut("providers")
        .and_then(|p| p.get_mut(PROVIDER))
        .and_then(|e| e.get_mut("settings"))
        .and_then(Value::as_object_mut);
    if let Some(settings) = settings {
        let before = settings.clone();
        match context.filter(|c| *c > 0) {
            Some(context) => {
                settings.insert("contextWindow".into(), json!(context));
                settings.insert("maxTokens".into(), json!(output_cap(context)));
            }
            None => {
                settings.remove("contextWindow");
                settings.remove("maxTokens");
            }
        }
        if *settings != before {
            // Cline keeps the file owner-only: it holds every provider's key.
            write_json(path, &Value::Object(root), true)?;
        }
    }
    write_sidecar(
        path,
        &json!({
            "previous": snapshot.previous,
            "written": { "baseUrl": api_url, "model": model },
        }),
    )
}

/// Put back the provider entry and `lastUsedProvider` from before the first
/// Connect, as far as they still hold ours.
pub(crate) fn disconnect_in(path: &Path) -> Result<(), String> {
    let Some(backup) = read_sidecar(path) else {
        return Ok(());
    };
    let Some(mut root) = read_json_object(path)? else {
        return remove_sidecar(path);
    };
    if holds_ours(&root, backup.get("written")) {
        let previous = backup.get("previous").cloned().unwrap_or(Value::Null);
        if root.get("lastUsedProvider").and_then(Value::as_str) == Some(PROVIDER) {
            restore_key(
                &mut root,
                "lastUsedProvider",
                previous.get("lastUsedProvider").unwrap_or(&Value::Null),
            );
        }
        if let Some(providers) = root.get_mut("providers").and_then(Value::as_object_mut) {
            restore_key(
                providers,
                PROVIDER,
                previous.get("entry").unwrap_or(&Value::Null),
            );
        }
        write_json(path, &Value::Object(root), true)?;
    }
    remove_sidecar(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const URL: &str = "http://127.0.0.1:1337/v1";
    const MODEL: &str = "AtomicChat/Qwen3.5-9B-GGUF";

    /// What `cline auth` saves: the entry, merged over the previous one, made
    /// the last used provider.
    fn fake_auth(path: &Path, base_url: &str, model: &str) {
        let mut root = read_json_object(path).unwrap().unwrap_or_else(|| {
            json!({"version": 1, "providers": {}})
                .as_object()
                .unwrap()
                .clone()
        });
        let previous = root["providers"]
            .get(PROVIDER)
            .and_then(|e| e.get("settings"))
            .cloned()
            .unwrap_or(json!({}));
        let mut settings = previous.as_object().cloned().unwrap_or_default();
        settings.insert("provider".into(), json!(PROVIDER));
        settings.insert("apiKey".into(), json!("local"));
        settings.insert("model".into(), json!(model));
        settings.insert("baseUrl".into(), json!(base_url));
        root["providers"][PROVIDER] = json!({
            "settings": settings, "updatedAt": "2026-11-03T00:00:00.000Z", "tokenSource": "manual"
        });
        root.insert("lastUsedProvider".into(), json!(PROVIDER));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_string_pretty(&root).unwrap()).unwrap();
    }

    fn connect(path: &Path, context: Option<u32>) {
        let snap = snapshot(path).unwrap();
        fake_auth(path, URL, MODEL);
        finish(path, snap, URL, MODEL, context).unwrap();
    }

    fn read(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn the_path_follows_clines_variables() {
        let home = Path::new("/home/u");
        let none = |_: &str| None;
        assert_eq!(
            providers_path(home, none),
            PathBuf::from("/home/u/.cline/data/settings/providers.json")
        );
        let dir = |n: &str| (n == "CLINE_DIR").then(|| "~/cl".to_string());
        assert_eq!(
            providers_path(home, dir),
            PathBuf::from("/home/u/cl/data/settings/providers.json")
        );
        let data = |n: &str| match n {
            "CLINE_DIR" => Some("/x".to_string()),
            "CLINE_DATA_DIR" => Some("/d".to_string()),
            _ => None,
        };
        assert_eq!(
            providers_path(home, data),
            PathBuf::from("/d/settings/providers.json")
        );
        let file = |n: &str| (n == "CLINE_PROVIDER_SETTINGS_PATH").then(|| "/p.json".to_string());
        assert_eq!(providers_path(home, file), PathBuf::from("/p.json"));
    }

    #[test]
    fn a_known_window_lands_on_the_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        connect(&path, Some(32768));
        let settings = &read(&path)["providers"][PROVIDER]["settings"];
        assert_eq!(settings["contextWindow"], 32768);
        assert_eq!(settings["maxTokens"], 8192);
        // Reconnecting without a known window clears what we set.
        connect(&path, None);
        let settings = &read(&path)["providers"][PROVIDER]["settings"];
        assert!(settings.get("contextWindow").is_none());
        assert!(settings.get("maxTokens").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn the_file_stays_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        connect(&path, Some(16384));
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&super::super::agent_files::sidecar_path(&path)), 0o600);
    }

    #[test]
    fn disconnect_restores_the_users_provider_and_choice() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        let theirs = json!({
            "settings": {"provider": PROVIDER, "apiKey": "lm", "model": "qwen", "baseUrl": "http://127.0.0.1:1234/v1", "contextWindow": 4096},
            "updatedAt": "2026-01-01T00:00:00.000Z", "tokenSource": "manual"
        });
        let original = json!({
            "version": 1, "lastUsedProvider": "anthropic",
            "providers": {"anthropic": {"settings": {"provider": "anthropic"}, "updatedAt": "2026-01-01T00:00:00.000Z", "tokenSource": "manual"},
                          PROVIDER: theirs.clone()}
        });
        fs::write(&path, original.to_string()).unwrap();
        connect(&path, Some(16384));
        connect(&path, Some(16384));
        assert_eq!(read(&path)["lastUsedProvider"], PROVIDER);
        disconnect_in(&path).unwrap();
        assert_eq!(read(&path), original);
        assert!(!super::super::agent_files::sidecar_path(&path).exists());
    }

    #[test]
    fn disconnect_leaves_what_the_user_changed_after_connect() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        connect(&path, None);
        fake_auth(&path, "https://api.example/v1", "theirs");
        disconnect_in(&path).unwrap();
        let root = read(&path);
        assert_eq!(root["providers"][PROVIDER]["settings"]["model"], "theirs");
        assert_eq!(root["lastUsedProvider"], PROVIDER);
    }

    #[test]
    fn disconnect_removes_an_entry_that_did_not_exist_before() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        connect(&path, None);
        disconnect_in(&path).unwrap();
        assert_eq!(read(&path), json!({"version": 1, "providers": {}}));
        // Never connected (no backup): nothing is touched.
        disconnect_in(&path).unwrap();
        disconnect_in(&dir.path().join("missing.json")).unwrap();
    }
}
