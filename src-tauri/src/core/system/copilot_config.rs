//! GitHub Copilot CLI: an `atomic-chat` provider and its model in Copilot's
//! `providers.json`, started with `copilot --model atomic-chat/<model>` (the
//! Launch page; `--model <provider>/<id>` is Copilot's documented form).
//!
//! Earlier releases persisted `COPILOT_PROVIDER_*`, `COPILOT_MODEL` and
//! `COPILOT_OFFLINE=true` user-wide (a marked block in the shell rc, `setx` on
//! Windows). That put every `copilot` the user ran — and every terminal the
//! app opened on Windows and Linux, which never saw those values — on the
//! local server or on nothing, and a `providers.json` with any provider in it
//! overrides those variables anyway. The file is Copilot's documented home for
//! named providers, holds the window limits the variables could not, and lists
//! the model in `/model` beside the user's own; Connect writes our entries
//! there and removes exactly what an earlier release persisted.
//!
//! Twin of `src/integrations/configure/copilot.ts` in atomic-chat-core.

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::agent_files::{output_cap, read_json_object, read_text, write_atomically, write_json};
use super::agent_user_env::{agent_env_var, expand_home};

/// Our provider's `name`; a model is addressed as `<name>/<model id>`.
pub(crate) const PROVIDER_NAME: &str = "atomic-chat";
/// The rc marker that opened and closed the block earlier releases wrote.
const LEGACY_MARKER: &str = "# Atomic Chat - Copilot CLI Config";
/// The variables earlier releases persisted (`copilot_env_vars`).
#[cfg_attr(not(windows), allow(dead_code))]
const LEGACY_VARS: [&str; 5] = [
    "COPILOT_PROVIDER_BASE_URL",
    "COPILOT_PROVIDER_TYPE",
    "COPILOT_MODEL",
    "COPILOT_OFFLINE",
    "COPILOT_PROVIDER_API_KEY",
];
/// Every rc file `detect_shell_env_file` could have picked.
const LEGACY_RC_FILES: [&str; 3] = [".zshenv", ".bash_profile", ".bashrc"];

/// `providers.json` where Copilot reads it: `$COPILOT_PROVIDERS_CONFIG`, else
/// `$COPILOT_HOME/providers.json`, else `~/.copilot/providers.json`.
pub(crate) fn providers_path(home: &Path, env: impl Fn(&str) -> Option<String>) -> PathBuf {
    if let Some(path) = env("COPILOT_PROVIDERS_CONFIG") {
        return expand_home(&path, home);
    }
    match env("COPILOT_HOME") {
        Some(dir) => expand_home(&dir, home).join("providers.json"),
        None => home.join(".copilot").join("providers.json"),
    }
}

pub(crate) fn resolve_providers_path() -> Result<PathBuf, String> {
    let home = super::commands::agent_home_dir()?;
    Ok(providers_path(Path::new(&home), agent_env_var))
}

/// `root[key]` as a list, created when absent or `null` (Copilot reads both as
/// empty). Anything else is the user's and refused.
fn list<'a>(
    root: &'a mut Map<String, Value>,
    key: &str,
    path: &Path,
) -> Result<&'a mut Vec<Value>, String> {
    if root.get(key).map_or(true, Value::is_null) {
        root.insert(key.into(), json!([]));
    }
    root.get_mut(key)
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            format!(
                "`{key}` in {} is not a list. Fix or remove it and try again.",
                path.display()
            )
        })
}

fn named(entry: &Value, field: &str) -> bool {
    entry.get(field).and_then(Value::as_str) == Some(PROVIDER_NAME)
}

fn provider_entry(api_url: &str, api_key: Option<&str>) -> Value {
    let mut entry = json!({ "name": PROVIDER_NAME, "type": "openai", "baseUrl": api_url });
    // Copilot reads the key literally (no variable references); a keyless
    // server gets no key at all, as Copilot allows for a local one.
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        entry["apiKey"] = json!(key);
    }
    entry
}

/// A known window becomes Copilot's limits: the reply capped at a quarter of
/// it (8192 at most) and the prompt given the rest. Unknown, Copilot assumes
/// 128K for a model it does not know.
fn model_entry(model: &str, context: Option<u32>) -> Value {
    let mut entry = json!({ "id": model, "provider": PROVIDER_NAME });
    if let Some(context) = context.filter(|c| *c > 0) {
        let cap = output_cap(context);
        entry["maxContextWindowTokens"] = json!(context);
        entry["maxPromptTokens"] = json!(context - cap);
        entry["maxOutputTokens"] = json!(cap);
    }
    entry
}

/// Replace our provider and model entries in place (append the first time);
/// every other entry stays as it is.
pub(crate) fn configure_in(
    path: &Path,
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
    context: Option<u32>,
) -> Result<(), String> {
    let mut root = read_json_object(path)?.unwrap_or_default();

    let providers = list(&mut root, "providers", path)?;
    let ours = provider_entry(api_url, api_key);
    match providers.iter().position(|p| named(p, "name")) {
        Some(i) => {
            providers[i] = ours;
            let mut seen = false;
            providers.retain(|p| !named(p, "name") || !std::mem::replace(&mut seen, true));
        }
        None => providers.push(ours),
    }

    let models = list(&mut root, "models", path)?;
    let at = models.iter().position(|m| named(m, "provider"));
    models.retain(|m| !named(m, "provider"));
    let ours = model_entry(model, context);
    match at {
        Some(i) => models.insert(i.min(models.len()), ours),
        None => models.push(ours),
    }

    // Plain text keys, the user's own among them.
    write_json(path, &Value::Object(root), true)
}

/// Take our provider and its models out of `providers.json`.
pub(crate) fn remove_entries(path: &Path) -> Result<(), String> {
    let Some(mut root) = read_json_object(path)? else {
        return Ok(());
    };
    let before = root.clone();
    if let Some(providers) = root.get_mut("providers").and_then(Value::as_array_mut) {
        providers.retain(|p| !named(p, "name"));
    }
    if let Some(models) = root.get_mut("models").and_then(Value::as_array_mut) {
        models.retain(|m| !named(m, "provider"));
    }
    if root != before {
        write_json(path, &Value::Object(root), true)?;
    }
    Ok(())
}

/// `text` without the blocks an earlier release wrote, or `None` when there is
/// nothing it can vouch for: a block must open and close with our marker and
/// hold only `export COPILOT_…=` and blank lines, or the file stays as it is.
pub(crate) fn strip_legacy_block(text: &str) -> Option<String> {
    let is_marker = |line: &str| line.trim_end_matches('\r') == LEGACY_MARKER;
    if !text.lines().any(is_marker) {
        return None;
    }
    let mut kept: Vec<&str> = Vec::new();
    let mut open = false;
    for line in text.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\n', '\r']);
        if is_marker(bare) {
            open = !open;
            continue;
        }
        if open {
            let ours = bare.trim().is_empty() || bare.starts_with("export COPILOT_");
            if !ours {
                return None;
            }
            continue;
        }
        kept.push(line);
    }
    (!open).then(|| kept.concat())
}

/// Remove the rc blocks an earlier release wrote. Whether any was removed.
pub(crate) fn remove_legacy_rc_blocks(home: &Path) -> Result<bool, String> {
    let mut removed = false;
    for name in LEGACY_RC_FILES {
        let path = home.join(name);
        let Some(text) = read_text(&path)? else {
            continue;
        };
        if let Some(stripped) = strip_legacy_block(&text) {
            write_atomically(&path, &stripped, false)?;
            removed = true;
        }
    }
    Ok(removed)
}

/// Whether the persisted variables are the set an earlier release wrote: an
/// OpenAI-type provider in offline mode on this server's `port`, on this
/// machine or the local network.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn legacy_env_is_ours(get: impl Fn(&str) -> Option<String>, port: u16) -> bool {
    get("COPILOT_PROVIDER_TYPE").as_deref().map(str::trim) == Some("openai")
        && get("COPILOT_OFFLINE").as_deref().map(str::trim) == Some("true")
        && get("COPILOT_PROVIDER_BASE_URL")
            .is_some_and(|url| super::agent_config_detection::is_local_url(&url, port))
}

/// Delete the User-scope variables an earlier release set with `setx`, and
/// drop them from this process so the terminals it opens no longer inherit
/// them. Whether any were removed.
#[cfg(windows)]
pub(crate) fn remove_legacy_user_env() -> Result<bool, String> {
    use std::os::windows::process::CommandExt;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let env = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Environment")
        .ok();
    let get = |name: &str| -> Option<String> { env.as_ref()?.get_value::<String, _>(name).ok() };
    let port = crate::core::server::state_file::read_state().port;
    if !legacy_env_is_ours(get, port) {
        return Ok(false);
    }
    let present: Vec<(&str, String)> = LEGACY_VARS
        .iter()
        .filter_map(|name| get(name).map(|v| (*name, v)))
        .collect();
    // .NET deletes the value and broadcasts WM_SETTINGCHANGE, as `setx` did.
    let script = present
        .iter()
        .map(|(name, _)| format!("[Environment]::SetEnvironmentVariable('{name}', $null, 'User')"))
        .collect::<Vec<_>>()
        .join("; ");
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .status()
        .map_err(|e| format!("Could not remove the Copilot variables Atomic Chat set: {e}"))?;
    if !status.success() {
        return Err("Could not remove the Copilot variables Atomic Chat set.".into());
    }
    for (name, value) in present {
        if std::env::var(name).ok().as_deref() == Some(value.as_str()) {
            std::env::remove_var(name);
        }
    }
    Ok(true)
}

#[cfg(not(windows))]
pub(crate) fn remove_legacy_user_env() -> Result<bool, String> {
    Ok(false)
}

/// Point Copilot at the local server and take out what earlier releases
/// persisted.
pub(crate) fn configure(
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
    context: Option<u32>,
) -> Result<PathBuf, String> {
    let path = resolve_providers_path()?;
    configure_in(&path, api_url, model, api_key, context)?;
    remove_legacy(Path::new(&super::commands::agent_home_dir()?))?;
    Ok(path)
}

fn remove_legacy(home: &Path) -> Result<(), String> {
    if remove_legacy_rc_blocks(home)? {
        log::info!("Removed the Copilot variables an earlier Atomic Chat put in the shell rc");
    }
    if remove_legacy_user_env()? {
        log::info!("Removed the Copilot variables an earlier Atomic Chat set for the user");
    }
    Ok(())
}

/// Undo the Copilot connection, including one an earlier release made.
pub(crate) fn disconnect() -> Result<(), String> {
    remove_entries(&resolve_providers_path()?)?;
    remove_legacy(Path::new(&super::commands::agent_home_dir()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const URL: &str = "http://127.0.0.1:1337/v1";
    const MODEL: &str = "AtomicChat/Qwen3.5-9B-GGUF";

    fn read(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn the_path_follows_copilots_variables() {
        let home = Path::new("/home/u");
        assert_eq!(
            providers_path(home, |_| None),
            PathBuf::from("/home/u/.copilot/providers.json")
        );
        let dir = |n: &str| (n == "COPILOT_HOME").then(|| "~/cp".to_string());
        assert_eq!(
            providers_path(home, dir),
            PathBuf::from("/home/u/cp/providers.json")
        );
        let file = |n: &str| match n {
            "COPILOT_HOME" => Some("/x".to_string()),
            "COPILOT_PROVIDERS_CONFIG" => Some("/p.json".to_string()),
            _ => None,
        };
        assert_eq!(providers_path(home, file), PathBuf::from("/p.json"));
    }

    #[test]
    fn a_fresh_file_gets_our_provider_and_limited_model() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        configure_in(&path, URL, MODEL, Some("sk"), Some(16384)).unwrap();
        assert_eq!(
            read(&path),
            json!({
                "providers": [{"name": "atomic-chat", "type": "openai", "baseUrl": URL, "apiKey": "sk"}],
                "models": [{"id": MODEL, "provider": "atomic-chat",
                            "maxContextWindowTokens": 16384, "maxPromptTokens": 12288, "maxOutputTokens": 4096}]
            })
        );
    }

    #[test]
    fn a_rerun_replaces_ours_and_keeps_the_users_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        let theirs = json!({
            "providers": [{"name": "ollama", "baseUrl": "http://localhost:11434/v1"}],
            "models": [{"id": "qwen3:8b", "provider": "ollama"}]
        });
        fs::write(&path, theirs.to_string()).unwrap();
        configure_in(&path, URL, MODEL, Some("sk"), Some(16384)).unwrap();
        configure_in(&path, URL, "other", None, None).unwrap();
        let root = read(&path);
        assert_eq!(root["providers"].as_array().unwrap().len(), 2);
        assert!(root["providers"][1].get("apiKey").is_none());
        assert_eq!(
            root["models"][1],
            json!({"id": "other", "provider": "atomic-chat"})
        );
        remove_entries(&path).unwrap();
        assert_eq!(read(&path), theirs);
        remove_entries(&dir.path().join("missing.json")).unwrap();
    }

    #[test]
    fn a_non_list_is_refused_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        fs::write(&path, r#"{"providers": {"a": 1}}"#).unwrap();
        let err = configure_in(&path, URL, MODEL, None, None).unwrap_err();
        assert!(err.contains("not a list"), "{err}");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"{"providers": {"a": 1}}"#
        );
    }

    #[test]
    fn only_the_legacy_block_leaves_the_rc_file() {
        let block = "# Atomic Chat - Copilot CLI Config\n\
                     export COPILOT_PROVIDER_BASE_URL='http://127.0.0.1:1337/v1'\n\
                     export COPILOT_PROVIDER_TYPE='openai'\n\
                     export COPILOT_MODEL='m'\n\
                     export COPILOT_OFFLINE='true'\n\
                     \n\
                     # Atomic Chat - Copilot CLI Config\n";
        let rc = format!("export EDITOR=nvim\n{block}export COPILOT_MODEL='mine'\n");
        assert_eq!(
            strip_legacy_block(&rc).unwrap(),
            "export EDITOR=nvim\nexport COPILOT_MODEL='mine'\n"
        );
        assert_eq!(strip_legacy_block("export A=1\n"), None);
        // A block holding anything else, or never closed, is left alone.
        let edited = block.replace("export COPILOT_MODEL='m'", "alias c=copilot");
        assert_eq!(strip_legacy_block(&edited), None);
        assert_eq!(
            strip_legacy_block("# Atomic Chat - Copilot CLI Config\nexport COPILOT_MODEL='m'\n"),
            None
        );
        assert_eq!(
            strip_legacy_block(&block.replace('\n', "\r\n")).unwrap(),
            ""
        );
    }

    #[test]
    fn legacy_rc_blocks_are_removed_from_every_rc_file() {
        let home = tempfile::tempdir().unwrap();
        let block = "# Atomic Chat - Copilot CLI Config\nexport COPILOT_OFFLINE='true'\n\n# Atomic Chat - Copilot CLI Config\n";
        fs::write(home.path().join(".zshenv"), format!("export A=1\n{block}")).unwrap();
        fs::write(home.path().join(".bashrc"), block).unwrap();
        fs::write(home.path().join(".bash_profile"), "export B=2\n").unwrap();
        assert!(remove_legacy_rc_blocks(home.path()).unwrap());
        assert_eq!(
            fs::read_to_string(home.path().join(".zshenv")).unwrap(),
            "export A=1\n"
        );
        assert_eq!(fs::read_to_string(home.path().join(".bashrc")).unwrap(), "");
        assert_eq!(
            fs::read_to_string(home.path().join(".bash_profile")).unwrap(),
            "export B=2\n"
        );
        assert!(!remove_legacy_rc_blocks(home.path()).unwrap());
    }

    #[test]
    fn only_the_exact_legacy_set_counts_as_ours() {
        let ours = |n: &str| match n {
            "COPILOT_PROVIDER_TYPE" => Some("openai".to_string()),
            "COPILOT_OFFLINE" => Some("true".to_string()),
            "COPILOT_PROVIDER_BASE_URL" => Some("http://127.0.0.1:1337/v1".to_string()),
            _ => None,
        };
        assert!(legacy_env_is_ours(ours, 1337));
        let remote = |n: &str| match n {
            "COPILOT_PROVIDER_BASE_URL" => Some("https://api.example.com/v1".to_string()),
            other => ours(other),
        };
        assert!(!legacy_env_is_ours(remote, 1337));
        let online = |n: &str| (n != "COPILOT_OFFLINE").then(|| ours(n)).flatten();
        assert!(!legacy_env_is_ours(online, 1337));
        // Another local server (Ollama on 11434) is the user's own.
        assert!(!legacy_env_is_ours(ours, 11434));
    }
}
