//! Factory Droid: our entry in the `customModels` array of
//! `~/.factory/settings.json`, selected as the default for new sessions.
//!
//! Droid addresses a custom model by its `id`, `custom:<displayName with
//! dashes>-<n>`; the entry carries `id` and `index` explicitly so the selector
//! cannot drift when other entries move. The default lives in
//! `sessionDefaultSettings.model`: Droid moves a legacy top-level `model` there
//! only when that key is empty, so a top-level value (what earlier releases
//! wrote) loses to any default the user already had.
//!
//! The default model the user had before is kept in the backup sidecar and put
//! back on Disconnect, unless they picked another one meanwhile.
//!
//! Twin of `src/integrations/configure/droid.ts` in atomic-chat-core.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::agent_files::{
    or_null, output_cap, read_json_object, read_sidecar, remove_sidecar, restore_key, write_json,
    write_sidecar,
};

/// Our entry's `displayName`, which also marks it as ours.
const DISPLAY_NAME: &str = "Atomic Chat";
/// `custom:` + the display name with whitespace runs turned into dashes.
const SELECTOR_PREFIX: &str = "custom:Atomic-Chat-";
const SESSION_DEFAULTS: &str = "sessionDefaultSettings";

pub(crate) fn settings_path(home: &Path) -> PathBuf {
    home.join(".factory").join("settings.json")
}

fn is_ours(entry: &Value) -> bool {
    entry.get("displayName").and_then(Value::as_str) == Some(DISPLAY_NAME)
}

fn is_our_selector(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|s| s.starts_with(SELECTOR_PREFIX))
}

fn session_defaults(root: &Map<String, Value>) -> Option<&Map<String, Value>> {
    root.get(SESSION_DEFAULTS).and_then(Value::as_object)
}

/// The `customModels` entry. A known window caps the reply at a quarter of it
/// (8192 at most) and gives Droid the rest as its context limit; unknown,
/// neither is written and Droid keeps its own defaults.
fn entry(
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
    context: Option<u32>,
    index: usize,
) -> Value {
    let mut entry = json!({
        "model": model,
        "id": format!("{SELECTOR_PREFIX}{index}"),
        "index": index,
        "displayName": DISPLAY_NAME,
        "baseUrl": api_url,
        // Droid rejects an empty apiKey, so a keyless server gets a placeholder.
        "apiKey": api_key.filter(|k| !k.is_empty()).unwrap_or("atomic"),
        "provider": "generic-chat-completion-api",
    });
    if let Some(context) = context.filter(|c| *c > 0) {
        let cap = output_cap(context);
        entry["maxOutputTokens"] = json!(cap);
        entry["maxContextLimit"] = json!(context - cap);
    }
    entry
}

/// Upsert our entry and make it the default. Returns the selector.
pub(crate) fn configure_in(
    path: &Path,
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
    context: Option<u32>,
) -> Result<String, String> {
    let mut root = read_json_object(path)?.unwrap_or_default();

    // What Disconnect puts back: the default before the first Connect, kept
    // across reconnects while the file still has ours.
    let current_default = session_defaults(&root)
        .and_then(|s| s.get("model"))
        .cloned();
    let sidecar = read_sidecar(path);
    let previous = match &sidecar {
        Some(backup)
            if current_default.is_some()
                && backup.get("written").and_then(|w| w.get("defaultModel"))
                    == current_default.as_ref() =>
        {
            backup.get("previous").cloned().unwrap_or(Value::Null)
        }
        _ => json!({
            "defaultModel": or_null(current_default.as_ref()),
            "sessionDefaultSettings": root.contains_key(SESSION_DEFAULTS),
        }),
    };

    // A `customModels` that is not an array is unusable to Droid anyway.
    if !root.get("customModels").is_some_and(Value::is_array) {
        root.insert("customModels".into(), json!([]));
    }
    let models = root
        .get_mut("customModels")
        .and_then(Value::as_array_mut)
        .expect("customModels was just made an array");
    let index = models.iter().position(is_ours).unwrap_or(models.len());
    let ours = entry(api_url, model, api_key, context, index);
    let selector = ours["id"].as_str().unwrap_or_default().to_string();
    if index < models.len() {
        models[index] = ours;
    } else {
        models.push(ours);
    }

    // Earlier releases selected us through the legacy top-level key.
    if is_our_selector(root.get("model")) {
        root.remove("model");
    }
    if !root.get(SESSION_DEFAULTS).is_some_and(Value::is_object) {
        root.insert(SESSION_DEFAULTS.into(), json!({}));
    }
    root[SESSION_DEFAULTS]["model"] = json!(selector);

    write_json(path, &Value::Object(root), false)?;
    write_sidecar(
        path,
        &json!({ "previous": previous, "written": { "defaultModel": selector } }),
    )?;
    Ok(selector)
}

/// Remove our entry and put the previous default back, unless the user chose
/// another one after Connect.
pub(crate) fn disconnect_in(path: &Path) -> Result<(), String> {
    let sidecar = read_sidecar(path);
    let Some(mut root) = read_json_object(path)? else {
        return remove_sidecar(path);
    };
    let before = root.clone();

    if let Some(models) = root.get_mut("customModels").and_then(Value::as_array_mut) {
        models.retain(|m| !is_ours(m));
    }
    if is_our_selector(root.get("model")) {
        root.remove("model");
    }
    let still_ours = session_defaults(&root).is_some_and(|s| is_our_selector(s.get("model")));
    if still_ours {
        let previous = sidecar
            .as_ref()
            .and_then(|b| b.get("previous"))
            .cloned()
            .unwrap_or(Value::Null);
        let previous_model = previous.get("defaultModel").cloned().unwrap_or(Value::Null);
        let had_defaults = previous
            .get("sessionDefaultSettings")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if let Some(defaults) = root
            .get_mut(SESSION_DEFAULTS)
            .and_then(Value::as_object_mut)
        {
            restore_key(defaults, "model", &previous_model);
            if defaults.is_empty() && !had_defaults {
                root.remove(SESSION_DEFAULTS);
            }
        }
    }

    if root != before {
        write_json(path, &Value::Object(root), false)?;
    }
    remove_sidecar(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const URL: &str = "http://127.0.0.1:1337/v1";
    const MODEL: &str = "AtomicChat/Qwen3.5-9B-GGUF";

    fn setup(text: Option<&str>) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = settings_path(dir.path());
        if let Some(text) = text {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, text).unwrap();
        }
        (dir, path)
    }

    fn read(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn a_known_window_sets_both_limits() {
        let (_dir, path) = setup(None);
        let selector = configure_in(&path, URL, MODEL, Some("sk"), Some(16384)).unwrap();
        assert_eq!(selector, "custom:Atomic-Chat-0");
        let root = read(&path);
        let ours = &root["customModels"][0];
        assert_eq!(ours["maxOutputTokens"], 4096);
        assert_eq!(ours["maxContextLimit"], 12288);
        assert_eq!(ours["id"], "custom:Atomic-Chat-0");
        assert_eq!(ours["index"], 0);
        assert_eq!(ours["apiKey"], "sk");
        assert_eq!(
            root["sessionDefaultSettings"]["model"],
            "custom:Atomic-Chat-0"
        );
        assert!(root.get("model").is_none());
    }

    #[test]
    fn an_unknown_window_writes_no_limits() {
        let (_dir, path) = setup(None);
        configure_in(&path, URL, MODEL, None, None).unwrap();
        let ours = &read(&path)["customModels"][0];
        assert!(ours.get("maxOutputTokens").is_none());
        assert!(ours.get("maxContextLimit").is_none());
        assert_eq!(ours["apiKey"], "atomic");
    }

    #[test]
    fn our_entry_keeps_its_place_after_the_users_models() {
        let (_dir, path) = setup(Some(
            r#"{"customModels":[{"model":"m1","displayName":"Mine","baseUrl":"u","apiKey":"k","provider":"openai"}],
                "sessionDefaultSettings":{"model":"custom:Mine-0","reasoningEffort":"high"}}"#,
        ));
        configure_in(&path, URL, MODEL, None, Some(65536)).unwrap();
        configure_in(&path, URL, "other", None, Some(65536)).unwrap();
        let root = read(&path);
        let models = root["customModels"].as_array().unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["displayName"], "Mine");
        assert_eq!(models[1]["model"], "other");
        assert_eq!(models[1]["id"], "custom:Atomic-Chat-1");
        assert_eq!(models[1]["index"], 1);
        assert_eq!(
            root["sessionDefaultSettings"]["model"],
            "custom:Atomic-Chat-1"
        );
        assert_eq!(root["sessionDefaultSettings"]["reasoningEffort"], "high");

        // Disconnect restores the user's default from before the first Connect.
        disconnect_in(&path).unwrap();
        let root = read(&path);
        assert_eq!(root["customModels"].as_array().unwrap().len(), 1);
        assert_eq!(root["sessionDefaultSettings"]["model"], "custom:Mine-0");
        assert_eq!(root["sessionDefaultSettings"]["reasoningEffort"], "high");
        assert!(!super::super::agent_files::sidecar_path(&path).exists());
    }

    #[test]
    fn a_default_the_user_picked_after_connect_survives_disconnect() {
        let (_dir, path) = setup(Some(
            r#"{"sessionDefaultSettings":{"model":"claude-opus"}}"#,
        ));
        configure_in(&path, URL, MODEL, None, None).unwrap();
        let mut root = read(&path);
        root["sessionDefaultSettings"]["model"] = json!("gpt-5.5");
        fs::write(&path, root.to_string()).unwrap();
        disconnect_in(&path).unwrap();
        let root = read(&path);
        assert_eq!(root["sessionDefaultSettings"]["model"], "gpt-5.5");
        assert_eq!(root["customModels"], json!([]));
    }

    #[test]
    fn disconnect_removes_what_a_fresh_connect_created() {
        let (_dir, path) = setup(Some(r#"{"theme":"dark"}"#));
        configure_in(&path, URL, MODEL, None, None).unwrap();
        disconnect_in(&path).unwrap();
        assert_eq!(read(&path), json!({"theme": "dark", "customModels": []}));
        // Nothing left to undo, or nothing ever connected, is fine.
        disconnect_in(&path).unwrap();
        let (_none, missing) = setup(None);
        disconnect_in(&missing).unwrap();
        assert!(!missing.exists());
    }

    #[test]
    fn the_legacy_top_level_selector_of_an_earlier_release_is_cleared() {
        let (_dir, path) = setup(Some(
            r#"{"customModels":[{"model":"old","displayName":"Atomic Chat","baseUrl":"u","apiKey":"atomic","provider":"generic-chat-completion-api","maxOutputTokens":16384}],
                "model":"custom:Atomic-Chat-0"}"#,
        ));
        configure_in(&path, URL, MODEL, None, None).unwrap();
        let root = read(&path);
        assert!(root.get("model").is_none());
        assert!(root["customModels"][0].get("maxOutputTokens").is_none());
        disconnect_in(&path).unwrap();
        // There was no default before: none is left behind.
        assert!(read(&path).get("sessionDefaultSettings").is_none());
    }

    #[test]
    fn a_file_that_is_not_json_is_refused_untouched() {
        let (_dir, path) = setup(Some("{ broken"));
        let err = configure_in(&path, URL, MODEL, None, None).unwrap_err();
        assert!(err.contains("Could not parse"), "{err}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ broken");
    }
}
