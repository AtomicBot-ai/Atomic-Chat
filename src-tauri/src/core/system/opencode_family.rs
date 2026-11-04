//! Kilo Code, OpenCode, MiMo Code and pi: where each reads its config, what
//! Connect writes there and what Disconnect puts back.
//!
//! Kilo and MiMo are forks of OpenCode and share its config: a `provider`
//! map with our `atomic` entry (an `@ai-sdk/openai-compatible` endpoint) and a
//! top-level `model` that selects `atomic/<id>`. pi splits the same two halves
//! across `models.json` and `settings.json`.
//!
//! Connect keeps what it replaces: before a key is overwritten, its value
//! goes to `<config file>.atomic-chat-backup.json` next to the file, unless
//! the value is already ours (a reconnect keeps the value saved the first
//! time). Disconnect puts each saved value back, or removes the key when there
//! was none — but only while the key still holds what Connect wrote, so a
//! choice the user made after Connect stays.
//!
//! Byte-for-byte twin of `src/integrations/configure/{opencode-style,pi}.ts`
//! in atomic-chat-core, which `atomic-chat launch` uses.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::commands::agent_home_dir;

/// The provider id these agents get, so the model reads `atomic/<id>`.
pub(crate) const PROVIDER_ID: &str = "atomic";
/// The display name of our provider entry, which is also how an entry is
/// recognised as ours.
const PROVIDER_NAME: &str = "Atomic Chat";
const BACKUP_SUFFIX: &str = ".atomic-chat-backup.json";
const BACKUP_ABOUT: &str = "Atomic Chat keeps the settings its connection replaced here \
and puts them back on Disconnect.";
/// The longest reply an agent asks for: a quarter of the window, at most
/// this. More leaves too little room for the conversation itself.
const OUTPUT_CAP: u32 = 8192;
/// pi summarizes no more than its default 20K most recent tokens.
const PI_KEEP_RECENT_TOKENS: u32 = 20_000;

/// Reads one variable of the environment the agent will run in.
pub(crate) type EnvLookup<'a> = &'a dyn Fn(&str) -> Option<String>;

/// The output cap for a `context_length` window.
pub(crate) fn output_cap(context_length: u32) -> u32 {
    (context_length / 4).min(OUTPUT_CAP)
}

fn env_value(env: EnvLookup, name: &str) -> Option<String> {
    env(name).filter(|v| !v.trim().is_empty())
}

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// `$XDG_CONFIG_HOME`, else `<home>/.config` — on every OS, the way the
/// `xdg-basedir` package these agents use resolves it.
fn xdg_config_home(home: &Path, env: EnvLookup) -> PathBuf {
    env_value(env, "XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"))
}

/// One agent's config file, and the files beside it an earlier release may
/// have put our entries into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConfigTarget {
    /// The file Connect writes.
    pub file: PathBuf,
    /// Read before `file`, so whatever of ours is left there is overridden
    /// while connected and would come back after Disconnect: it is removed.
    pub others: Vec<PathBuf>,
}

impl ConfigTarget {
    /// Every file that may hold our entries.
    pub(crate) fn files(&self) -> impl Iterator<Item = &PathBuf> {
        std::iter::once(&self.file).chain(self.others.iter())
    }
}

/// `<stem>.jsonc` when it exists — the agent reads it after `<stem>.json`,
/// so a `model` there wins — else `<stem>.json`.
fn dir_target(dir: &Path, stem: &str) -> ConfigTarget {
    let json = dir.join(format!("{stem}.json"));
    let jsonc = dir.join(format!("{stem}.jsonc"));
    if jsonc.is_file() {
        ConfigTarget {
            file: jsonc,
            others: vec![json],
        }
    } else {
        ConfigTarget {
            file: json,
            others: Vec::new(),
        }
    }
}

/// Where the four agents read their user config, given the environment
/// they start with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FamilyPaths {
    pub kilo: ConfigTarget,
    pub opencode: ConfigTarget,
    pub mimo: ConfigTarget,
    /// pi's agent directory (`models.json`, `settings.json`).
    pub pi_dir: PathBuf,
}

impl FamilyPaths {
    pub(crate) fn resolve_with(home: &Path, env: EnvLookup) -> Self {
        let config = xdg_config_home(home, env);

        // `KILO_CONFIG_DIR` is read after the global directory.
        let kilo_dir = env_value(env, "KILO_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| config.join("kilo"));

        // `OPENCODE_CONFIG_DIR` is read last, an `OPENCODE_CONFIG` file
        // after the global directory.
        let opencode = if let Some(dir) = env_value(env, "OPENCODE_CONFIG_DIR") {
            dir_target(Path::new(&dir), "opencode")
        } else if let Some(file) = env_value(env, "OPENCODE_CONFIG") {
            ConfigTarget {
                file: PathBuf::from(file),
                others: Vec::new(),
            }
        } else {
            dir_target(&config.join("opencode"), "opencode")
        };

        // An absolute `MIMOCODE_HOME` holds `config/` (MiMo refuses to start
        // on a relative one).
        let mimo_dir = env_value(env, "MIMOCODE_HOME")
            .filter(|v| Path::new(v).is_absolute())
            .map(|v| PathBuf::from(v).join("config"))
            .unwrap_or_else(|| config.join("mimocode"));

        let pi_dir = match env_value(env, "PI_CODING_AGENT_DIR").as_deref() {
            Some("~") => home.to_path_buf(),
            Some(v) if v.starts_with("~/") || v.starts_with("~\\") => home.join(&v[2..]),
            Some(v) => PathBuf::from(v),
            None => home.join(".pi").join("agent"),
        };

        Self {
            kilo: ConfigTarget {
                file: kilo_dir.join("kilo.jsonc"),
                others: Vec::new(),
            },
            opencode,
            mimo: dir_target(&mimo_dir, "mimocode"),
            pi_dir,
        }
    }

    /// The locations for this user and the app's own environment.
    pub(crate) fn resolve() -> Result<Self, String> {
        let home = agent_home_dir()?;
        Ok(Self::resolve_with(Path::new(&home), &process_env))
    }
}

// ---------------------------------------------------------------------------
// JSON in place
// ---------------------------------------------------------------------------

/// The file as JSON, `None` when it does not exist. Blank is `{}`. `lenient`
/// accepts JSON5 (comments, trailing commas), as these agents do for their
/// own config; the file is written back as strict JSON, so comments are lost.
fn read_json(path: &Path, lenient: bool) -> Result<Option<Value>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Could not read {}: {}", path.display(), e)),
    };
    if text.trim().is_empty() {
        return Ok(Some(json!({})));
    }
    let parsed = if lenient {
        json5::from_str(&text).map_err(|e| e.to_string())
    } else {
        serde_json::from_str(&text).map_err(|e| e.to_string())
    };
    parsed.map(Some).map_err(|e| {
        format!(
            "Could not parse {}: {}. Fix the reported location and try again.",
            path.display(),
            e
        )
    })
}

/// A config root, which must be an object.
fn read_root(path: &Path, lenient: bool) -> Result<Value, String> {
    let root = read_json(path, lenient)?.unwrap_or_else(|| json!({}));
    if root.is_object() {
        Ok(root)
    } else {
        Err(format!("{} is not a JSON object", path.display()))
    }
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let pretty = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, pretty + "\n")
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

fn at<'a>(root: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().try_fold(root, |v, k| v.get(*k))
}

/// Set `keys` to `value`, making objects of whatever is missing or not an
/// object on the way.
fn set_at(root: &mut Value, keys: &[&str], value: Value) {
    let Some((last, parents)) = keys.split_last() else {
        return;
    };
    let mut node = root;
    for key in parents {
        if !node.is_object() {
            *node = json!({});
        }
        node = node
            .as_object_mut()
            .expect("made an object above")
            .entry(key.to_string())
            .or_insert_with(|| json!({}));
    }
    if !node.is_object() {
        *node = json!({});
    }
    node.as_object_mut()
        .expect("made an object above")
        .insert(last.to_string(), value);
}

fn remove_at(root: &mut Value, keys: &[&str]) -> Option<Value> {
    let (last, parents) = keys.split_last()?;
    let mut node = root;
    for key in parents {
        node = node.get_mut(*key)?;
    }
    node.as_object_mut()?.remove(*last)
}

fn str_at<'a>(root: &'a Value, keys: &[&str]) -> Option<&'a str> {
    at(root, keys).and_then(Value::as_str)
}

// ---------------------------------------------------------------------------
// Backup of the replaced values
// ---------------------------------------------------------------------------

/// A key Connect overwrites, and how to tell that what it holds is ours.
struct Managed {
    keys: &'static [&'static str],
    /// Asked of the whole root, so a pair of keys can be judged together.
    ours: fn(&Value) -> bool,
}

pub(crate) fn backup_path(config: &Path) -> PathBuf {
    let name = config
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    config.with_file_name(format!("{name}{BACKUP_SUFFIX}"))
}

/// The values a previous Connect saved, mirrored at their own paths.
fn saved_values(config: &Path) -> Value {
    read_json(&backup_path(config), false)
        .ok()
        .flatten()
        .and_then(|backup| backup.get("previous").cloned())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

/// Before Connect writes `managed` into `root` (the file at `config` as it
/// is now), save what they hold that is not ours. Nothing to save removes an
/// earlier backup.
fn save_replaced(root: &Value, config: &Path, managed: &[Managed]) -> Result<(), String> {
    let saved = saved_values(config);
    let mut previous = json!({});
    for m in managed {
        let kept = match at(root, m.keys) {
            None => None,
            Some(current) if !(m.ours)(root) => Some(current.clone()),
            // Ours from an earlier Connect: what that one saved still stands.
            Some(_) => at(&saved, m.keys).cloned(),
        };
        if let Some(value) = kept {
            set_at(&mut previous, m.keys, value);
        }
    }
    let path = backup_path(config);
    if previous.as_object().is_some_and(|o| o.is_empty()) {
        return remove_file_if_present(&path);
    }
    write_json(
        &path,
        &json!({ "about": BACKUP_ABOUT, "previous": previous }),
    )
}

/// Put back what Connect replaced in `root`, for each key that is still
/// ours; a key the user changed since stays. Whether anything changed.
fn restore_replaced(root: &mut Value, config: &Path, managed: &[Managed]) -> bool {
    let saved = saved_values(config);
    // Judge every key before touching any: a pair is judged together.
    let ours: Vec<bool> = managed
        .iter()
        .map(|m| at(root, m.keys).is_some() && (m.ours)(root))
        .collect();
    let mut changed = false;
    for (m, ours) in managed.iter().zip(ours) {
        if !ours {
            continue;
        }
        match at(&saved, m.keys) {
            Some(previous) => set_at(root, m.keys, previous.clone()),
            None => {
                remove_at(root, m.keys);
            }
        }
        changed = true;
    }
    changed
}

fn remove_file_if_present(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to remove {}: {}", path.display(), e)),
    }
}

// ---------------------------------------------------------------------------
// Kilo Code, OpenCode, MiMo Code
// ---------------------------------------------------------------------------

/// What differs between the three OpenCode-style agents.
pub(crate) struct OpencodeStyle {
    /// `$schema` seeded into a config that has none.
    pub schema: &'static str,
    /// A `$schema` an earlier release wrote by mistake; replaced by `schema`.
    pub stale_schema: Option<&'static str>,
}

pub(crate) const KILO: OpencodeStyle = OpencodeStyle {
    schema: "https://app.kilo.ai/config.json",
    stale_schema: None,
};
pub(crate) const OPENCODE: OpencodeStyle = OpencodeStyle {
    schema: "https://opencode.ai/config.json",
    stale_schema: None,
};
pub(crate) const MIMO: OpencodeStyle = OpencodeStyle {
    schema: "https://mimo.xiaomi.com/mimocode/config.json",
    stale_schema: Some("https://mimo.xiaomi.com/config.json"),
};

fn model_is_ours(root: &Value) -> bool {
    str_at(root, &["model"]).is_some_and(|m| m.starts_with("atomic/"))
}

fn opencode_provider_is_ours(root: &Value) -> bool {
    str_at(root, &["provider", PROVIDER_ID, "name"]) == Some(PROVIDER_NAME)
}

const OPENCODE_MANAGED: [Managed; 2] = [
    Managed {
        keys: &["model"],
        ours: model_is_ours,
    },
    Managed {
        keys: &["provider", PROVIDER_ID],
        ours: opencode_provider_is_ours,
    },
];

/// The `models.<id>` entry: thinking models answer in `reasoning_content`,
/// which the agent then shows as thoughts and sends back within a tool loop
/// (a model that does not think sends an empty one, which servers drop); the
/// window and output cap when known, without which the agent never compacts
/// and asks for 32K tokens per reply.
fn opencode_model_entry(model: &str, context_length: Option<u32>) -> Value {
    let mut entry = json!({
        "name": model,
        "reasoning": true,
        "interleaved": { "field": "reasoning_content" },
    });
    if let Some(ctx) = context_length.filter(|c| *c > 0) {
        entry["limit"] = json!({ "context": ctx, "output": output_cap(ctx) });
    }
    entry
}

pub(crate) fn opencode_provider_entry(
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
    context_length: Option<u32>,
) -> Value {
    let key = api_key.filter(|k| !k.is_empty()).unwrap_or("atomic");
    let mut models = serde_json::Map::new();
    models.insert(
        model.to_string(),
        opencode_model_entry(model, context_length),
    );
    json!({
        "name": PROVIDER_NAME,
        "npm": "@ai-sdk/openai-compatible",
        // A local model can read a long prompt for longer than the 5 minutes
        // these agents wait for the first byte, and then they give up.
        "options": {
            "baseURL": api_url,
            "apiKey": key,
            "timeout": false,
            "headerTimeout": false,
        },
        "models": Value::Object(models),
    })
}

/// Point an OpenCode-style agent at the server and select the model.
pub(crate) fn connect_opencode_style(
    target: &ConfigTarget,
    style: &OpencodeStyle,
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
    context_length: Option<u32>,
) -> Result<(), String> {
    let path = &target.file;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
    }
    let mut root = read_root(path, true)?;
    save_replaced(&root, path, &OPENCODE_MANAGED)?;

    let obj = root.as_object_mut().expect("read_root returns an object");
    let schema_is_stale = match obj.get("$schema") {
        None => true,
        Some(v) => style.stale_schema.is_some() && v.as_str() == style.stale_schema,
    };
    if schema_is_stale {
        obj.insert("$schema".to_string(), json!(style.schema));
    }
    set_at(
        &mut root,
        &["provider", PROVIDER_ID],
        opencode_provider_entry(api_url, model, api_key, context_length),
    );
    // Run is an explicit "use this", so any earlier selection is replaced —
    // and kept in the backup for Disconnect.
    set_at(&mut root, &["model"], json!(format!("atomic/{model}")));
    write_json(path, &root)?;

    for other in &target.others {
        if let Err(e) = remove_ours(other) {
            log::warn!("Left {} as it was: {}", other.display(), e);
        }
    }
    Ok(())
}

/// Take our entries out of a file Connect does not write.
fn remove_ours(path: &Path) -> Result<(), String> {
    let Some(mut root) = read_json(path, true)? else {
        return Ok(());
    };
    if restore_replaced(&mut root, path, &OPENCODE_MANAGED) {
        write_json(path, &root)?;
    }
    Ok(())
}

/// Undo `connect_opencode_style`: the saved `model` and `provider.atomic`
/// back, or removed when there were none.
pub(crate) fn disconnect_opencode_style(target: &ConfigTarget) -> Result<(), String> {
    let path = &target.file;
    if let Some(mut root) = read_json(path, true)? {
        if restore_replaced(&mut root, path, &OPENCODE_MANAGED) {
            write_json(path, &root)?;
        }
    }
    remove_file_if_present(&backup_path(path))?;
    for other in &target.others {
        if let Err(e) = remove_ours(other) {
            log::warn!("Left {} as it was: {}", other.display(), e);
        }
    }
    Ok(())
}

/// Whether one of `target`'s files holds our provider entry.
pub(crate) fn opencode_style_configured(target: &ConfigTarget) -> bool {
    target.files().any(|file| {
        read_json(file, true)
            .ok()
            .flatten()
            .is_some_and(|root| at(&root, &["provider", PROVIDER_ID]).is_some_and(Value::is_object))
    })
}

// ---------------------------------------------------------------------------
// pi
// ---------------------------------------------------------------------------

/// Ours by name, or the exact shape releases before the name wrote.
fn pi_provider_is_ours(root: &Value) -> bool {
    let Some(entry) = at(root, &["providers", PROVIDER_ID]).and_then(Value::as_object) else {
        return false;
    };
    match entry.get("name") {
        Some(name) => name.as_str() == Some(PROVIDER_NAME),
        None => {
            let mut keys: Vec<&str> = entry.keys().map(String::as_str).collect();
            keys.sort_unstable();
            keys == ["api", "apiKey", "baseUrl", "models"]
        }
    }
}

fn pi_default_is_ours(root: &Value) -> bool {
    str_at(root, &["defaultProvider"]) == Some(PROVIDER_ID)
}

const PI_MODELS_MANAGED: [Managed; 1] = [Managed {
    keys: &["providers", PROVIDER_ID],
    ours: pi_provider_is_ours,
}];

/// The default model is a provider/model pair, judged by its provider.
const PI_SETTINGS_MANAGED: [Managed; 2] = [
    Managed {
        keys: &["defaultProvider"],
        ours: pi_default_is_ours,
    },
    Managed {
        keys: &["defaultModel"],
        ours: pi_default_is_ours,
    },
];

fn pi_provider_entry(
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
    context_length: Option<u32>,
) -> Value {
    let key = api_key.filter(|k| !k.is_empty()).unwrap_or("atomic");
    let mut entry = json!({ "id": model });
    if let Some(ctx) = context_length.filter(|c| *c > 0) {
        entry["contextWindow"] = json!(ctx);
        entry["maxTokens"] = json!(output_cap(ctx));
    }
    json!({
        "name": PROVIDER_NAME,
        "api": "openai-completions",
        "apiKey": key,
        "baseUrl": api_url,
        "models": [entry],
    })
}

/// Drop every `atomic/…` compaction override (ours, from any connection),
/// then add the one for `model` when its window is known: compaction starts
/// with a quarter of the window left, and keeps no more recent history than
/// that quarter, or a small window would have nothing to summarize.
fn set_pi_compaction(settings: &mut Value, model: &str, context_length: Option<u32>) {
    let removed = remove_pi_compaction(settings);
    let Some(ctx) = context_length.filter(|c| *c > 0) else {
        if removed {
            prune_pi_compaction(settings);
        }
        return;
    };
    let quarter = ctx / 4;
    let key = format!("{PROVIDER_ID}/{model}");
    set_at(
        settings,
        &["compaction", "modelOverrides", key.as_str()],
        json!({
            "reserveTokens": quarter,
            "keepRecentTokens": quarter.min(PI_KEEP_RECENT_TOKENS),
        }),
    );
}

/// Whether any override of ours was there.
fn remove_pi_compaction(settings: &mut Value) -> bool {
    let Some(overrides) = settings
        .pointer_mut("/compaction/modelOverrides")
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    let before = overrides.len();
    let prefix = format!("{PROVIDER_ID}/");
    overrides.retain(|key, _| !key.starts_with(&prefix));
    overrides.len() != before
}

/// Remove the objects our overrides left empty.
fn prune_pi_compaction(settings: &mut Value) {
    let empty = |v: Option<&Value>| v.and_then(Value::as_object).is_some_and(|o| o.is_empty());
    if empty(at(settings, &["compaction", "modelOverrides"])) {
        remove_at(settings, &["compaction", "modelOverrides"]);
        if empty(at(settings, &["compaction"])) {
            remove_at(settings, &["compaction"]);
        }
    }
}

/// Upsert our provider in `models.json` and make it pi's default in
/// `settings.json` (both strict JSON). `models.json` is written first, so a
/// broken `settings.json` leaves it updated.
pub(crate) fn connect_pi(
    dir: &Path,
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
    context_length: Option<u32>,
) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;

    let models_path = dir.join("models.json");
    let mut models = read_root(&models_path, false)?;
    save_replaced(&models, &models_path, &PI_MODELS_MANAGED)?;
    set_at(
        &mut models,
        &["providers", PROVIDER_ID],
        pi_provider_entry(api_url, model, api_key, context_length),
    );
    write_json(&models_path, &models)?;

    let settings_path = dir.join("settings.json");
    let mut settings = read_root(&settings_path, false)?;
    save_replaced(&settings, &settings_path, &PI_SETTINGS_MANAGED)?;
    set_at(&mut settings, &["defaultProvider"], json!(PROVIDER_ID));
    set_at(&mut settings, &["defaultModel"], json!(model));
    set_pi_compaction(&mut settings, model, context_length);
    write_json(&settings_path, &settings)
}

/// Undo `connect_pi`.
pub(crate) fn disconnect_pi(dir: &Path) -> Result<(), String> {
    let models_path = dir.join("models.json");
    if let Some(mut models) = read_json(&models_path, false)? {
        if restore_replaced(&mut models, &models_path, &PI_MODELS_MANAGED) {
            write_json(&models_path, &models)?;
        }
    }
    remove_file_if_present(&backup_path(&models_path))?;

    let settings_path = dir.join("settings.json");
    if let Some(mut settings) = read_json(&settings_path, false)? {
        let restored = restore_replaced(&mut settings, &settings_path, &PI_SETTINGS_MANAGED);
        let removed = remove_pi_compaction(&mut settings);
        if removed {
            prune_pi_compaction(&mut settings);
        }
        if restored || removed {
            write_json(&settings_path, &settings)?;
        }
    }
    remove_file_if_present(&backup_path(&settings_path))
}

/// Whether pi's `models.json` holds our provider.
pub(crate) fn pi_configured(dir: &Path) -> bool {
    read_json(&dir.join("models.json"), false)
        .ok()
        .flatten()
        .is_some_and(|root| at(&root, &["providers", PROVIDER_ID]).is_some_and(Value::is_object))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn read(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    const URL: &str = "http://127.0.0.1:1337/v1";

    fn target(file: &Path) -> ConfigTarget {
        ConfigTarget {
            file: file.to_path_buf(),
            others: Vec::new(),
        }
    }

    #[test]
    fn default_paths_follow_xdg_and_prefer_an_existing_jsonc() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        let paths = FamilyPaths::resolve_with(h, &no_env);
        assert_eq!(paths.kilo.file, h.join(".config/kilo/kilo.jsonc"));
        assert_eq!(
            paths.opencode.file,
            h.join(".config/opencode/opencode.json")
        );
        assert!(paths.opencode.others.is_empty());
        assert_eq!(paths.mimo.file, h.join(".config/mimocode/mimocode.json"));
        assert_eq!(paths.pi_dir, h.join(".pi/agent"));

        write(&h.join(".config/opencode/opencode.jsonc"), "{}");
        write(&h.join(".config/mimocode/mimocode.jsonc"), "{}");
        let paths = FamilyPaths::resolve_with(h, &no_env);
        assert_eq!(
            paths.opencode.file,
            h.join(".config/opencode/opencode.jsonc")
        );
        assert_eq!(
            paths.opencode.others,
            vec![h.join(".config/opencode/opencode.json")]
        );
        assert_eq!(paths.mimo.file, h.join(".config/mimocode/mimocode.jsonc"));
    }

    #[test]
    fn environment_overrides_move_every_config() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        let env: HashMap<&str, String> = HashMap::from([
            ("XDG_CONFIG_HOME", h.join("xdg").display().to_string()),
            ("KILO_CONFIG_DIR", h.join("kilo-dir").display().to_string()),
            (
                "OPENCODE_CONFIG",
                h.join("oc/custom.json").display().to_string(),
            ),
            ("MIMOCODE_HOME", h.join("mimo-home").display().to_string()),
            ("PI_CODING_AGENT_DIR", "~/pi-dir".to_string()),
        ]);
        let lookup = |name: &str| env.get(name).cloned();
        let paths = FamilyPaths::resolve_with(h, &lookup);
        assert_eq!(paths.kilo.file, h.join("kilo-dir/kilo.jsonc"));
        assert_eq!(paths.opencode.file, h.join("oc/custom.json"));
        assert_eq!(paths.mimo.file, h.join("mimo-home/config/mimocode.json"));
        assert_eq!(paths.pi_dir, h.join("pi-dir"));

        // The directory wins over the single file; XDG moves the defaults.
        let env2: HashMap<&str, String> = HashMap::from([
            ("XDG_CONFIG_HOME", h.join("xdg").display().to_string()),
            (
                "OPENCODE_CONFIG",
                h.join("oc/custom.json").display().to_string(),
            ),
            (
                "OPENCODE_CONFIG_DIR",
                h.join("oc-dir").display().to_string(),
            ),
            ("MIMOCODE_HOME", "relative/mimo".to_string()),
        ]);
        let lookup2 = |name: &str| env2.get(name).cloned();
        let paths = FamilyPaths::resolve_with(h, &lookup2);
        assert_eq!(paths.opencode.file, h.join("oc-dir/opencode.json"));
        assert_eq!(paths.kilo.file, h.join("xdg/kilo/kilo.jsonc"));
        assert_eq!(paths.mimo.file, h.join("xdg/mimocode/mimocode.json"));
    }

    #[test]
    fn connect_writes_window_thinking_and_no_timeouts() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join(".config/opencode/opencode.json");
        connect_opencode_style(
            &target(&file),
            &OPENCODE,
            URL,
            "qwen3",
            Some("sk"),
            Some(16384),
        )
        .unwrap();
        let root = read(&file);
        assert_eq!(root["$schema"], "https://opencode.ai/config.json");
        assert_eq!(root["model"], "atomic/qwen3");
        let entry = &root["provider"]["atomic"];
        assert_eq!(entry["name"], "Atomic Chat");
        assert_eq!(
            entry["options"],
            json!({ "baseURL": URL, "apiKey": "sk", "timeout": false, "headerTimeout": false })
        );
        assert_eq!(
            entry["models"]["qwen3"],
            json!({
                "name": "qwen3",
                "reasoning": true,
                "interleaved": { "field": "reasoning_content" },
                "limit": { "context": 16384, "output": 4096 },
            })
        );
        // Nothing was replaced, so nothing is kept.
        assert!(!backup_path(&file).exists());

        // An unknown window is not invented; a large one caps the output.
        connect_opencode_style(&target(&file), &OPENCODE, URL, "qwen3", None, None).unwrap();
        assert!(read(&file)["provider"]["atomic"]["models"]["qwen3"]
            .get("limit")
            .is_none());
        assert_eq!(
            read(&file)["provider"]["atomic"]["options"]["apiKey"],
            "atomic"
        );
        connect_opencode_style(&target(&file), &OPENCODE, URL, "qwen3", None, Some(131072))
            .unwrap();
        assert_eq!(
            read(&file)["provider"]["atomic"]["models"]["qwen3"]["limit"],
            json!({ "context": 131072, "output": 8192 })
        );
    }

    #[test]
    fn disconnect_restores_what_connect_replaced() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join(".config/kilo/kilo.jsonc");
        let original = r#"{
  // the user's
  "theme": "dracula",
  "model": "openrouter/anthropic/claude-sonnet-4",
  "provider": {
    "atomic": { "name": "Their own", "options": { "baseURL": "https://example.com" } },
    "openrouter": { "options": { "apiKey": "sk-or" } },
  },
}"#;
        write(&file, original);
        connect_opencode_style(&target(&file), &KILO, URL, "qwen3", None, None).unwrap();
        // A reconnect must not save our own values over the user's.
        connect_opencode_style(&target(&file), &KILO, URL, "gemma", None, Some(32768)).unwrap();
        assert_eq!(read(&file)["model"], "atomic/gemma");
        let backup = read(&backup_path(&file));
        assert_eq!(
            backup["previous"]["model"],
            "openrouter/anthropic/claude-sonnet-4"
        );
        assert_eq!(
            backup["previous"]["provider"]["atomic"]["name"],
            "Their own"
        );

        disconnect_opencode_style(&target(&file)).unwrap();
        let root = read(&file);
        assert_eq!(root["model"], "openrouter/anthropic/claude-sonnet-4");
        assert_eq!(root["provider"]["atomic"]["name"], "Their own");
        assert_eq!(root["provider"]["openrouter"]["options"]["apiKey"], "sk-or");
        assert_eq!(root["theme"], "dracula");
        assert!(!backup_path(&file).exists());

        // A second Disconnect has nothing to undo.
        let before = std::fs::read_to_string(&file).unwrap();
        disconnect_opencode_style(&target(&file)).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), before);
    }

    #[test]
    fn disconnect_removes_what_was_not_there_and_keeps_a_later_user_choice() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join("opencode.json");
        connect_opencode_style(&target(&file), &OPENCODE, URL, "qwen3", None, None).unwrap();
        disconnect_opencode_style(&target(&file)).unwrap();
        let root = read(&file);
        assert!(root.get("model").is_none());
        assert_eq!(root["provider"], json!({}));

        write(&file, r#"{"model":"anthropic/claude"}"#);
        connect_opencode_style(&target(&file), &OPENCODE, URL, "qwen3", None, None).unwrap();
        // The user picks another model after Connect.
        let mut root = read(&file);
        root["model"] = json!("openai/gpt-5");
        write(&file, &root.to_string());
        disconnect_opencode_style(&target(&file)).unwrap();
        let root = read(&file);
        assert_eq!(root["model"], "openai/gpt-5");
        assert!(root["provider"].get("atomic").is_none());
    }

    #[test]
    fn disconnect_of_nothing_is_a_no_op() {
        let home = tempfile::tempdir().unwrap();
        let paths = FamilyPaths::resolve_with(home.path(), &no_env);
        disconnect_opencode_style(&paths.opencode).unwrap();
        disconnect_opencode_style(&paths.kilo).unwrap();
        disconnect_pi(&paths.pi_dir).unwrap();
        assert!(std::fs::read_dir(home.path()).unwrap().next().is_none());
    }

    #[test]
    fn jsonc_is_written_and_our_leftovers_leave_the_json_beside_it() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".config/opencode");
        // What an earlier release wrote, and the file OpenCode seeds itself.
        write(
            &dir.join("opencode.json"),
            r#"{"theme":"x","model":"atomic/old","provider":{"atomic":{"name":"Atomic Chat"},"ollama":{}}}"#,
        );
        write(
            &dir.join("opencode.jsonc"),
            "{\n  // seeded\n  \"$schema\": \"https://opencode.ai/config.json\",\n}\n",
        );
        let paths = FamilyPaths::resolve_with(home.path(), &no_env);
        connect_opencode_style(&paths.opencode, &OPENCODE, URL, "qwen3", None, None).unwrap();
        assert_eq!(read(&dir.join("opencode.jsonc"))["model"], "atomic/qwen3");
        assert_eq!(
            read(&dir.join("opencode.json")),
            json!({ "theme": "x", "provider": { "ollama": {} } })
        );
        assert!(opencode_style_configured(&paths.opencode));

        disconnect_opencode_style(&paths.opencode).unwrap();
        assert!(!opencode_style_configured(&paths.opencode));
        assert!(read(&dir.join("opencode.jsonc")).get("model").is_none());
    }

    #[test]
    fn mimo_schema_is_corrected_and_others_are_kept() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join("mimocode.json");
        write(
            &file,
            r#"{"$schema":"https://mimo.xiaomi.com/config.json"}"#,
        );
        connect_opencode_style(&target(&file), &MIMO, URL, "m", None, None).unwrap();
        assert_eq!(
            read(&file)["$schema"],
            "https://mimo.xiaomi.com/mimocode/config.json"
        );

        write(&file, r#"{"$schema":"https://example.com/mine.json"}"#);
        connect_opencode_style(&target(&file), &MIMO, URL, "m", None, None).unwrap();
        assert_eq!(read(&file)["$schema"], "https://example.com/mine.json");
    }

    #[test]
    fn unparsable_config_is_refused_and_left_alone() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join("opencode.json");
        write(&file, "{ not json");
        assert!(connect_opencode_style(&target(&file), &OPENCODE, URL, "m", None, None).is_err());
        assert!(disconnect_opencode_style(&target(&file)).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ not json");
        write(&file, "[1]");
        assert!(connect_opencode_style(&target(&file), &OPENCODE, URL, "m", None, None).is_err());
    }

    #[test]
    fn pi_gets_window_cap_and_compaction_and_gives_them_back() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".pi/agent");
        write(
            &dir.join("settings.json"),
            r#"{"defaultProvider":"anthropic","defaultModel":"claude-sonnet","compaction":{"reserveTokens":9000,"modelOverrides":{"x/y":{"reserveTokens":1}}}}"#,
        );
        connect_pi(&dir, URL, "qwen3", None, Some(16384)).unwrap();
        connect_pi(&dir, URL, "qwen3.5", None, Some(16384)).unwrap();

        let models = read(&dir.join("models.json"));
        assert_eq!(
            models["providers"]["atomic"],
            json!({
                "name": "Atomic Chat",
                "api": "openai-completions",
                "apiKey": "atomic",
                "baseUrl": URL,
                "models": [{ "id": "qwen3.5", "contextWindow": 16384, "maxTokens": 4096 }],
            })
        );
        let settings = read(&dir.join("settings.json"));
        assert_eq!(settings["defaultProvider"], "atomic");
        assert_eq!(settings["defaultModel"], "qwen3.5");
        assert_eq!(
            settings["compaction"]["modelOverrides"],
            json!({
                "x/y": { "reserveTokens": 1 },
                "atomic/qwen3.5": { "reserveTokens": 4096, "keepRecentTokens": 4096 },
            })
        );
        assert!(pi_configured(&dir));

        disconnect_pi(&dir).unwrap();
        assert!(!pi_configured(&dir));
        assert_eq!(
            read(&dir.join("settings.json")),
            json!({
                "defaultProvider": "anthropic",
                "defaultModel": "claude-sonnet",
                "compaction": { "reserveTokens": 9000, "modelOverrides": { "x/y": { "reserveTokens": 1 } } },
            })
        );
        assert!(!backup_path(&dir.join("settings.json")).exists());
    }

    #[test]
    fn pi_keeps_a_users_own_atomic_provider_and_drops_an_old_one_of_ours() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("agent");
        let theirs =
            json!({ "api": "anthropic-messages", "baseUrl": "https://atomic.example.com" });
        write(
            &dir.join("models.json"),
            &json!({ "providers": { "atomic": theirs } }).to_string(),
        );
        connect_pi(&dir, URL, "m", None, Some(131072)).unwrap();
        let settings = read(&dir.join("settings.json"));
        assert_eq!(
            settings["compaction"]["modelOverrides"]["atomic/m"],
            json!({ "reserveTokens": 32768, "keepRecentTokens": 20000 })
        );
        disconnect_pi(&dir).unwrap();
        assert_eq!(
            read(&dir.join("models.json"))["providers"]["atomic"],
            theirs
        );
        assert_eq!(read(&dir.join("settings.json")), json!({}));

        // The shape releases before the name wrote is ours: nothing to keep.
        let old = json!({ "api": "openai-completions", "apiKey": "atomic", "baseUrl": URL, "models": [{ "id": "m" }] });
        write(
            &dir.join("models.json"),
            &json!({ "providers": { "atomic": old } }).to_string(),
        );
        connect_pi(&dir, URL, "m", None, None).unwrap();
        assert!(!backup_path(&dir.join("models.json")).exists());
        disconnect_pi(&dir).unwrap();
        assert_eq!(read(&dir.join("models.json")), json!({ "providers": {} }));
    }

    #[test]
    fn pi_default_changed_by_the_user_after_connect_stays() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("agent");
        write(
            &dir.join("settings.json"),
            r#"{"defaultProvider":"openai","defaultModel":"gpt-5"}"#,
        );
        connect_pi(&dir, URL, "m", None, None).unwrap();
        write(
            &dir.join("settings.json"),
            r#"{"defaultProvider":"google","defaultModel":"gemini"}"#,
        );
        disconnect_pi(&dir).unwrap();
        assert_eq!(
            read(&dir.join("settings.json")),
            json!({ "defaultProvider": "google", "defaultModel": "gemini" })
        );
    }
}

/// The agent-config golden fixtures atomic-chat-core replays for these
/// writers (`tests/fixtures/core-contracts/agent-config/`), replayed here
/// too, so the two writers cannot drift apart.
#[cfg(test)]
mod golden_fixtures {
    use super::*;
    use std::collections::BTreeMap;

    const AGENTS: [&str; 5] = ["kilo", "opencode", "mimo", "pi", "goose"];

    fn fixture_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/core-contracts/agent-config")
    }

    fn cases() -> Vec<(PathBuf, Value)> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(fixture_dir()).unwrap() {
            let path = entry.unwrap().path();
            let Ok(case) = serde_json::from_str::<Value>(&std::fs::read_to_string(&path).unwrap())
            else {
                continue;
            };
            let agent = str_at(&case, &["input", "agent"]).unwrap_or_default();
            if AGENTS.contains(&agent) {
                out.push((path, case));
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// One writer call, as `configure_*` makes it: an empty key is no key.
    fn run(home: &Path, agent: &str, call: &Value) -> Result<(), String> {
        let paths = FamilyPaths::resolve_with(home, &|_| None);
        let api_url = str_at(call, &["api_url"]).unwrap_or_default();
        let model = str_at(call, &["model"]).unwrap_or_default();
        let api_key = str_at(call, &["api_key"]).filter(|k| !k.is_empty());
        let ctx = at(call, &["context_length"])
            .and_then(Value::as_u64)
            .map(|c| c as u32);
        match agent {
            "kilo" => connect_opencode_style(&paths.kilo, &KILO, api_url, model, api_key, ctx),
            "opencode" => {
                connect_opencode_style(&paths.opencode, &OPENCODE, api_url, model, api_key, ctx)
            }
            "mimo" => connect_opencode_style(&paths.mimo, &MIMO, api_url, model, api_key, ctx),
            "pi" => connect_pi(&paths.pi_dir, api_url, model, api_key, ctx),
            "goose" => super::super::goose_config::remove_legacy_shell_blocks(home).map(|_| ()),
            other => Err(format!("not ours: {other}")),
        }
    }

    fn tree(dir: &Path, root: &Path, out: &mut BTreeMap<String, String>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                tree(&path, root, out);
            } else {
                let rel = path.strip_prefix(root).unwrap();
                let key = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                let text = std::fs::read_to_string(&path).unwrap();
                out.insert(key, text.replace(&root.display().to_string(), "<home>"));
            }
        }
    }

    /// What the case leaves behind: `{files, ok[, error]}`.
    fn outcome(case: &Value) -> Value {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        let input = &case["input"];
        let agent = str_at(input, &["agent"]).unwrap();
        if let Some(seed) = input["seed_files"].as_object() {
            for (rel, text) in seed {
                let path = h.join(rel);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                let text = text
                    .as_str()
                    .unwrap()
                    .replace("<home>", &h.display().to_string());
                std::fs::write(path, text).unwrap();
            }
        }
        for prior in input["prior_runs"].as_array().into_iter().flatten() {
            run(h, agent, prior).unwrap();
        }
        let result = run(h, agent, input);
        let mut files = BTreeMap::new();
        tree(h, h, &mut files);
        let mut out = json!({ "files": files, "ok": result.is_ok() });
        if let Err(e) = result {
            out["error"] = json!(e);
        }
        out
    }

    #[test]
    fn the_core_fixtures_replay_against_these_writers() {
        let cases = cases();
        assert!(
            cases.len() >= 25,
            "fixtures for kilo/opencode/mimo/pi/goose missing"
        );
        for (path, case) in cases {
            let expected = &case["expected"];
            let actual = outcome(&case);
            assert_eq!(actual["files"], expected["files"], "{}", path.display());
            assert_eq!(actual["ok"], expected["ok"], "{}", path.display());
        }
    }

    /// Rewrites `expected` of these agents' cases from the writers above:
    /// `cargo test --lib golden_fixtures -- --ignored`, then copy the set to
    /// atomic-chat-core (`scripts/import-app-fixtures.mjs`).
    #[test]
    #[ignore]
    fn dump_family_fixtures() {
        for (path, mut case) in cases() {
            case["expected"] = outcome(&case);
            case["source"] = json!({
                "commit": "344cc5a42",
                "file": "src-tauri/src/core/system/opencode_family.rs",
            });
            let text = serde_json::to_string_pretty(&case).unwrap();
            std::fs::write(&path, text + "\n").unwrap();
        }
    }
}
