//! Claude Code and OpenClaude: what Atomic Chat writes into their own config
//! files, and the backup that lets Disconnect put the user's values back.
//!
//! Connect upserts our settings into each agent's files (users also start
//! these agents themselves, so the files are the connection) and records, in a
//! sidecar `<config file>.atomic-chat-backup.json`, the value every key held
//! before. Disconnect puts those values back and takes our entries out, except
//! where the user changed a key after Connect: that value is theirs now. A
//! reconnect first undoes the previous Connect in memory, so the sidecar keeps
//! describing the user's own values, never an earlier Atomic Chat write.
//! Settings an earlier release wrote without a sidecar are recognised by
//! pointing at this server and taken out instead of being "restored".
//!
//! Files are read past a UTF-8 byte-order mark (PowerShell 5 writes one, and
//! both agents strip it) and replaced atomically through a temp file in the
//! same directory: both agents watch these files and must never read half of
//! one.
//!
//! Twin of `src/integrations/configure/{claude-code,openclaude,json-backup}.ts`
//! in atomic-chat-core, which the CLI's `launch` uses.

use std::collections::HashMap;
use std::io::{ErrorKind, Write as _};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::commands::agent_home_dir;

/// Appended to a config file's name for the sidecar holding what Connect replaced.
pub(crate) const BACKUP_SUFFIX: &str = ".atomic-chat-backup.json";
const BACKUP_VERSION: u32 = 1;
const BACKUP_ABOUT: &str =
    "Atomic Chat keeps the values it replaced here and puts them back when you disconnect.";

/// `id` of the OpenClaude provider profile Atomic Chat owns.
pub(crate) const OPENCLAUDE_PROFILE_ID: &str = "provider_atomic_chat";
/// OpenClaude's provider preset for Atomic Chat, and the `profile` of its startup file.
pub(crate) const OPENCLAUDE_PROVIDER: &str = "atomic-chat";

/// Shell-rc block the old Claude Code settings page wrote (`launch_claude_code_with_config`).
pub(crate) const LEGACY_CLAUDE_CODE_SHELL_MARKER: &str =
    "# Jan Local API Server - Claude Code Config";

const CLAUDE_MODEL_KEYS: [&str; 4] = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];
/// Provider switches a shell can export that Claude Code would follow instead
/// of our endpoint. An empty value is Claude Code's documented way to unset one,
/// and the settings `env` wins over the shell.
const CLAUDE_PROVIDER_SWITCHES: [&str; 3] = [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
];
/// Shell variables that make OpenClaude skip its active profile: with
/// `CLAUDE_CODE_USE_OPENAI` plus a base URL or model (or a complete
/// `ANTHROPIC_*` trio) in the environment it treats the shell as the user's
/// choice (`hasCompleteProviderSelection` in its `providerProfiles.ts`).
/// OpenClaude applies its global config's `env` before that check, so empty
/// values there take a shell's leftovers out of the decision; once our profile
/// applies, OpenClaude clears and sets these itself.
const OPENCLAUDE_SHELL_OVERRIDES: [&str; 6] = [
    "CLAUDE_CODE_USE_OPENAI",
    "OPENAI_BASE_URL",
    "OPENAI_API_BASE",
    "OPENAI_MODEL",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_GEMINI_VERTEX",
];

/// The output cap written beside a known window: a quarter of it, at most 8192.
pub(crate) fn output_cap(context_length: u32) -> u32 {
    (context_length / 4).min(8192)
}

fn key_or_placeholder(api_key: Option<&str>) -> &str {
    api_key.filter(|k| !k.is_empty()).unwrap_or("atomic")
}

// ── Where the files are ────────────────────────────────────────────────────

/// A config-directory variable the way the agents take it: absolute, or
/// `~`-relative (expanded against `home`). Anything else is ignored.
fn config_dir_from(home: &Path, value: Option<&str>) -> Option<PathBuf> {
    let value = value.map(str::trim).filter(|v| !v.is_empty())?;
    if value == "~" {
        return Some(home.to_path_buf());
    }
    if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return Some(home.join(rest));
    }
    let path = PathBuf::from(value);
    path.is_absolute().then_some(path)
}

/// Claude Code's config directory: `$CLAUDE_CONFIG_DIR`, else `<home>/.claude`.
pub(crate) fn claude_config_dir(home: &Path, env_value: Option<&str>) -> PathBuf {
    config_dir_from(home, env_value).unwrap_or_else(|| home.join(".claude"))
}

pub(crate) fn claude_settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OpenClaudePaths {
    /// The global config holding `providerProfiles`.
    pub config: PathBuf,
    /// The startup profile, `.openclaude-profile.json`.
    pub profile: PathBuf,
}

/// OpenClaude's files, resolved as OpenClaude 0.34 does (`envUtils.ts`,
/// `env.ts`): its config home is `$OPENCLAUDE_CONFIG_DIR`, else
/// `~/.openclaude`; a `.config.json` there is the global config, else
/// `.openclaude.json` in `$OPENCLAUDE_CONFIG_DIR` or the home directory.
pub(crate) fn openclaude_paths(home: &Path, env_value: Option<&str>) -> OpenClaudePaths {
    let dir = config_dir_from(home, env_value);
    let config_home = dir.clone().unwrap_or_else(|| home.join(".openclaude"));
    let legacy = config_home.join(".config.json");
    let config = if legacy.exists() {
        legacy
    } else {
        dir.unwrap_or_else(|| home.to_path_buf())
            .join(".openclaude.json")
    };
    OpenClaudePaths {
        config,
        profile: config_home.join(".openclaude-profile.json"),
    }
}

/// `name` from the app's environment, else from the user's login shell: an
/// app started from the Dock does not see what `~/.zshrc` exports, and the
/// terminal the agent runs in does.
fn user_env_var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| login_shell_config_vars().get(name).cloned())
}

/// `$CLAUDE_CONFIG_DIR` / `$OPENCLAUDE_CONFIG_DIR` as an interactive login
/// shell sets them, probed once per run (the spawn is slow).
#[cfg(not(windows))]
fn login_shell_config_vars() -> &'static HashMap<String, String> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<HashMap<String, String>> = OnceLock::new();
    CACHE.get_or_init(|| {
        const NAMES: [&str; 2] = ["CLAUDE_CONFIG_DIR", "OPENCLAUDE_CONFIG_DIR"];
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let script = NAMES
            .iter()
            .map(|name| format!("printf '__ACCFG_{name}=%s__ACEND__' \"${name}\""))
            .collect::<Vec<_>>()
            .join("; ");
        let mut command = std::process::Command::new(shell);
        command.args(["-lic", &script]);
        crate::core::process_env::sanitize_std_command(&mut command);
        let Ok(out) = command.output() else {
            return HashMap::new();
        };
        let stdout = String::from_utf8_lossy(&out.stdout);
        NAMES
            .iter()
            .filter_map(|name| {
                let open = format!("__ACCFG_{name}=");
                let start = stdout.find(&open)? + open.len();
                let end = stdout[start..].find("__ACEND__")? + start;
                let value = stdout[start..end].trim();
                (!value.is_empty()).then(|| (name.to_string(), value.to_string()))
            })
            .collect()
    })
}

#[cfg(windows)]
fn login_shell_config_vars() -> &'static HashMap<String, String> {
    use std::sync::OnceLock;
    static EMPTY: OnceLock<HashMap<String, String>> = OnceLock::new();
    EMPTY.get_or_init(HashMap::new)
}

/// `settings.json` in the Claude Code config directory this user's terminal sees.
pub(crate) fn resolve_claude_settings_path() -> Result<PathBuf, String> {
    let home = PathBuf::from(agent_home_dir()?);
    let dir = claude_config_dir(&home, user_env_var("CLAUDE_CONFIG_DIR").as_deref());
    Ok(claude_settings_path(&dir))
}

/// The OpenClaude files this user's terminal sees.
pub(crate) fn resolve_openclaude_paths() -> Result<OpenClaudePaths, String> {
    let home = PathBuf::from(agent_home_dir()?);
    Ok(openclaude_paths(
        &home,
        user_env_var("OPENCLAUDE_CONFIG_DIR").as_deref(),
    ))
}

// ── This server ────────────────────────────────────────────────────────────

/// The Local API Server's address as agents dial it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OurServer {
    host: String,
    port: u16,
}

impl OurServer {
    pub(crate) fn new(host: &str, port: u16) -> Self {
        let host = host
            .trim()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_ascii_lowercase();
        // A bind-all address is not one a client dials; agents get loopback.
        let host = if host == "0.0.0.0" || host == "::" || host.is_empty() {
            "127.0.0.1".to_string()
        } else {
            host
        };
        Self { host, port }
    }

    /// The server a URL we are about to write points at.
    pub(crate) fn from_url(raw: &str) -> Option<Self> {
        let (host, port) = host_and_port(raw)?;
        Some(Self::new(&host, port))
    }

    /// The server the app runs, from the state file it mirrors on start.
    pub(crate) fn from_app_state() -> Self {
        let state = crate::core::server::state_file::read_state();
        Self::new(&state.host, state.port)
    }

    /// Whether `raw` points at this server: its exact host and port, or a
    /// loopback address with its port. A LAN address with another port, or a
    /// gateway, is someone else's.
    pub(crate) fn is_url(&self, raw: &str) -> bool {
        host_and_port(raw).is_some_and(|(host, port)| {
            port == self.port && (host == self.host || is_loopback_host(&host))
        })
    }
}

/// Host (lower-case, IPv6 without brackets) and port of a URL; a scheme-less
/// `host:port` is accepted, and a missing port is the scheme's default.
fn host_and_port(raw: &str) -> Option<(String, u16)> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let parsed = url::Url::parse(raw)
        .ok()
        .filter(url::Url::has_host)
        .or_else(|| url::Url::parse(&format!("http://{raw}")).ok())?;
    let host = match parsed.host()? {
        url::Host::Domain(d) => d.trim_end_matches('.').to_ascii_lowercase(),
        url::Host::Ipv4(ip) => ip.to_string(),
        url::Host::Ipv6(ip) => ip.to_string(),
    };
    Some((host, parsed.port_or_known_default()?))
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback() || ip.is_unspecified())
}

// ── JSON files ─────────────────────────────────────────────────────────────

/// A JSON config's text as a value: a leading UTF-8 byte-order mark is
/// skipped and blank text is an empty object.
pub(crate) fn parse_json_text(text: &str) -> Result<Value, serde_json::Error> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(text)
}

/// A JSON config file, or `None` when there is none.
pub(crate) fn read_json_file(path: &Path) -> Result<Option<Value>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Could not read {}: {}", path.display(), e)),
    };
    parse_json_text(&text).map(Some).map_err(|e| {
        format!(
            "Could not parse {}: {}. Fix or remove the file and try again.",
            path.display(),
            e
        )
    })
}

/// Replace `path` with `value` as pretty JSON plus a newline.
pub(crate) fn write_json_file(path: &Path, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())? + "\n";
    write_file_atomically(path, text.as_bytes())
}

/// Write through a temp file in the same directory and a rename, so a reader
/// never sees half a file. A symlinked file (stow, chezmoi) is written at its
/// target and stays a link; an existing file keeps its permissions, a new one
/// is readable by its owner only (these files carry keys).
fn write_file_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }
    let name = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("config");
    let tmp = target.with_file_name(format!(".{}.atomic-tmp-{}", name, std::process::id()));
    let existing = std::fs::metadata(&target).ok().map(|m| m.permissions());

    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        match existing {
            Some(permissions) => std::fs::set_permissions(&tmp, permissions)?,
            None => restrict_to_owner(&tmp)?,
        }
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map_err(|e| format!("Failed to write {}: {}", target.display(), e))
}

#[cfg(unix)]
fn restrict_to_owner(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict_to_owner(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

fn remove_file_if_present(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to remove {}: {}", path.display(), e)),
    }
}

// ── The backup ─────────────────────────────────────────────────────────────

/// What Connect replaced in one config file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Backup {
    #[serde(default)]
    about: String,
    version: u32,
    /// Whether the config file existed before the first Connect.
    file_existed: bool,
    /// Objects and arrays Connect had to create; Disconnect drops them again
    /// once they are empty.
    #[serde(default)]
    created: Vec<Vec<Value>>,
    #[serde(default)]
    entries: Vec<BackupEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupEntry {
    /// Object keys, or `{"id": X}` for the element of an array whose `id` is
    /// X — an element that is ours by that id. Empty for the whole file.
    path: Vec<Value>,
    /// Whether something was there before; `previous` is what it was.
    existed: bool,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    previous: Value,
    written: Value,
}

/// A key Connect sets: its path and value.
type Write = (Vec<Value>, Value);

fn key_path(keys: &[&str]) -> Vec<Value> {
    keys.iter().map(|k| json!(k)).collect()
}

pub(crate) fn backup_path(config: &Path) -> PathBuf {
    let name = config
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    config.with_file_name(format!("{name}{BACKUP_SUFFIX}"))
}

/// The sidecar next to `config`. One that cannot be read counts as none: the
/// earlier-release check then still recognises our values by their endpoint.
fn read_backup(config: &Path) -> Option<Backup> {
    let path = backup_path(config);
    match read_json_file(&path) {
        Ok(Some(value)) => match serde_json::from_value(value) {
            Ok(backup) => Some(backup),
            Err(e) => {
                log::warn!("Ignoring {}: {}", path.display(), e);
                None
            }
        },
        Ok(None) => None,
        Err(e) => {
            log::warn!("Ignoring {e}");
            None
        }
    }
}

fn write_backup(config: &Path, backup: &Backup) -> Result<(), String> {
    let value = serde_json::to_value(backup).map_err(|e| e.to_string())?;
    write_json_file(&backup_path(config), &value)
}

fn id_selector(segment: &Value) -> Option<&str> {
    segment.as_object()?.get("id")?.as_str()
}

fn has_id(value: &Value, id: &str) -> bool {
    value.get("id").and_then(Value::as_str) == Some(id)
}

fn ends_in_id(path: &[Value]) -> bool {
    path.last().and_then(id_selector).is_some()
}

fn get_at<'a>(root: &'a Value, path: &[Value]) -> Option<&'a Value> {
    path.iter()
        .try_fold(root, |node, segment| match id_selector(segment) {
            Some(id) => node.as_array()?.iter().find(|e| has_id(e, id)),
            None => node.as_object()?.get(segment.as_str()?),
        })
}

/// Set `value` at `path` under `node` (an object, or an array when the first
/// segment selects by id). Missing containers on the way — or values of the
/// wrong kind — are replaced with empty ones and recorded in `created`.
fn set_at(
    node: &mut Value,
    path: &[Value],
    value: Value,
    prefix: &mut Vec<Value>,
    created: &mut Vec<Vec<Value>>,
) {
    let Some((segment, rest)) = path.split_first() else {
        *node = value;
        return;
    };
    let child = match id_selector(segment) {
        Some(id) => {
            let Some(items) = node.as_array_mut() else {
                return;
            };
            let index = match items.iter().position(|e| has_id(e, id)) {
                Some(index) => index,
                None => {
                    items.push(Value::Null);
                    items.len() - 1
                }
            };
            &mut items[index]
        }
        None => {
            let (Some(object), Some(key)) = (node.as_object_mut(), segment.as_str()) else {
                return;
            };
            object.entry(key.to_string()).or_insert(Value::Null)
        }
    };
    prefix.push(segment.clone());
    if let Some(next) = rest.first() {
        let wants_array = id_selector(next).is_some();
        let fits = if wants_array {
            child.is_array()
        } else {
            child.is_object()
        };
        if !fits {
            *child = if wants_array { json!([]) } else { json!({}) };
            if !created.contains(prefix) {
                created.push(prefix.clone());
            }
        }
    }
    set_at(child, rest, value, prefix, created);
    prefix.pop();
}

fn put(root: &mut Value, path: &[Value], value: Value, created: &mut Vec<Vec<Value>>) {
    set_at(root, path, value, &mut Vec::new(), created);
}

fn remove_at(node: &mut Value, path: &[Value]) {
    let Some((segment, rest)) = path.split_first() else {
        return;
    };
    if rest.is_empty() {
        match id_selector(segment) {
            Some(id) => {
                if let Some(items) = node.as_array_mut() {
                    items.retain(|e| !has_id(e, id));
                }
            }
            None => {
                if let (Some(object), Some(key)) = (node.as_object_mut(), segment.as_str()) {
                    remove_key(object, key);
                }
            }
        }
        return;
    }
    let child = match (id_selector(segment), segment.as_str()) {
        (Some(id), _) => match node.as_array_mut() {
            Some(items) => items.iter_mut().find(|e| has_id(e, id)),
            None => None,
        },
        (None, Some(key)) => match node.as_object_mut() {
            Some(object) => object.get_mut(key),
            None => None,
        },
        (None, None) => None,
    };
    if let Some(child) = child {
        remove_at(child, rest);
    }
}

/// Remove `key`, keeping the other keys in the order the user has them.
fn remove_key(object: &mut Map<String, Value>, key: &str) {
    if object.contains_key(key) {
        *object = std::mem::take(object)
            .into_iter()
            .filter(|(k, _)| k != key)
            .collect();
    }
}

fn is_empty_container(value: &Value) -> bool {
    value.as_object().is_some_and(Map::is_empty) || value.as_array().is_some_and(Vec::is_empty)
}

/// Put back what `backup` recorded wherever the value is still the one we
/// wrote; a value the user changed since stays theirs. An element that is ours
/// by its id goes whatever it holds now: the agent may have rewritten it.
fn restore(root: &mut Value, backup: &Backup) {
    for entry in backup.entries.iter().rev() {
        let Some(current) = get_at(root, &entry.path) else {
            continue;
        };
        let ours = ends_in_id(&entry.path) || *current == entry.written;
        if !ours {
            continue;
        }
        if entry.existed && !ends_in_id(&entry.path) {
            put(root, &entry.path, entry.previous.clone(), &mut Vec::new());
        } else {
            remove_at(root, &entry.path);
        }
    }
}

/// Undo a Connect in `root`. True when the file should go: it did not exist
/// before and nothing is left in it.
fn undo(root: &mut Value, backup: &Backup) -> bool {
    restore(root, backup);
    for path in backup.created.iter().rev() {
        if get_at(root, path).is_some_and(is_empty_container) {
            remove_at(root, path);
        }
    }
    !backup.file_existed && is_empty_container(root)
}

/// Apply `writes` to `root` and describe them. A previous Connect is undone
/// first, so `previous` is always the user's own value. `carry` lists paths
/// the previous Connect wrote that this one keeps as they are when it does not
/// write them itself (Claude Code's model keys while nothing is loaded).
/// `forget_legacy` runs only when there is no backup, to take out what an
/// earlier release wrote without one.
fn redo(
    root: &mut Value,
    previous: Option<Backup>,
    file_existed: bool,
    mut writes: Vec<Write>,
    carry: &[Vec<Value>],
    forget_legacy: impl FnOnce(&mut Value),
) -> Backup {
    let mut created = Vec::new();
    let file_existed = match previous {
        Some(backup) => {
            let kept: Vec<Write> = carry
                .iter()
                .filter(|path| !writes.iter().any(|(written, _)| written == *path))
                .filter_map(|path| backup.entries.iter().find(|e| &e.path == path))
                .filter(|e| get_at(root, &e.path) == Some(&e.written))
                .map(|e| (e.path.clone(), e.written.clone()))
                .collect();
            restore(root, &backup);
            writes.extend(kept);
            created = backup.created;
            backup.file_existed
        }
        None => {
            forget_legacy(root);
            file_existed
        }
    };

    let mut entries = Vec::with_capacity(writes.len());
    for (path, value) in writes {
        let before = if ends_in_id(&path) {
            None
        } else {
            get_at(root, &path).cloned()
        };
        put(root, &path, value.clone(), &mut created);
        entries.push(BackupEntry {
            path,
            existed: before.is_some(),
            previous: before.unwrap_or(Value::Null),
            written: value,
        });
    }
    Backup {
        about: BACKUP_ABOUT.to_string(),
        version: BACKUP_VERSION,
        file_existed,
        created,
        entries,
    }
}

/// Read `config` for Connect: its value (an object) and whether it existed.
fn read_object_for_connect(config: &Path) -> Result<(Value, bool), String> {
    match read_json_file(config)? {
        Some(root) if root.is_object() => Ok((root, true)),
        Some(_) => Err(format!("{} is not a JSON object", config.display())),
        None => Ok((json!({}), false)),
    }
}

/// Connect one JSON file: sidecar first, so a crash between the two writes
/// leaves a backup whose values simply do not match yet.
fn connect_file(
    config: &Path,
    writes: Vec<Write>,
    carry: &[Vec<Value>],
    forget_legacy: impl FnOnce(&mut Value),
) -> Result<(), String> {
    let (mut root, file_existed) = read_object_for_connect(config)?;
    let backup = redo(
        &mut root,
        read_backup(config),
        file_existed,
        writes,
        carry,
        forget_legacy,
    );
    write_backup(config, &backup)?;
    write_json_file(config, &root)
}

/// Disconnect one JSON file: put back what its sidecar recorded (or take out
/// an earlier release's values when there is none), then drop the sidecar.
fn disconnect_file(config: &Path, forget_legacy: impl FnOnce(&mut Value)) -> Result<(), String> {
    let backup = read_backup(config);
    if let Some(mut root) = read_json_file(config)?.filter(Value::is_object) {
        let before = root.clone();
        let delete = match &backup {
            Some(backup) => undo(&mut root, backup),
            None => {
                forget_legacy(&mut root);
                false
            }
        };
        if delete {
            remove_file_if_present(config)?;
        } else if root != before {
            write_json_file(config, &root)?;
        }
    }
    remove_file_if_present(&backup_path(config))
}

// ── Claude Code ────────────────────────────────────────────────────────────

fn claude_env(key: &str) -> Vec<Value> {
    key_path(&["env", key])
}

fn claude_model_paths() -> Vec<Vec<Value>> {
    CLAUDE_MODEL_KEYS
        .iter()
        .map(|key| claude_env(key))
        .chain(std::iter::once(key_path(&["model"])))
        .collect()
}

/// What Connect writes into Claude Code's `settings.json`. Claude Code appends
/// its own `/v1`, so `api_url` is the bare `host:port`. Without a model the
/// model keys are left as they are.
fn claude_code_writes(
    api_url: &str,
    model: Option<&str>,
    api_key: Option<&str>,
    context_length: Option<u32>,
) -> Vec<Write> {
    let mut writes = vec![
        (claude_env("ANTHROPIC_BASE_URL"), json!(api_url)),
        (
            claude_env("ANTHROPIC_AUTH_TOKEN"),
            json!(key_or_placeholder(api_key)),
        ),
    ];
    for switch in CLAUDE_PROVIDER_SWITCHES {
        writes.push((claude_env(switch), json!("")));
    }
    // The tab title comes from a side request to the model; a local server
    // has better things to do.
    writes.push((claude_env("CLAUDE_CODE_DISABLE_TERMINAL_TITLE"), json!("1")));
    if let Some(window) = context_length.filter(|w| *w > 0) {
        // An unknown model is assumed to have 200K; told the real window,
        // Claude Code compacts before the server refuses.
        writes.push((
            claude_env("CLAUDE_CODE_MAX_CONTEXT_TOKENS"),
            json!(window.to_string()),
        ));
        writes.push((
            claude_env("CLAUDE_CODE_MAX_OUTPUT_TOKENS"),
            json!(output_cap(window).to_string()),
        ));
    }
    if let Some(model) = model.filter(|m| !m.is_empty()) {
        // ANTHROPIC_MODEL overrides the `model` setting; the tier aliases make
        // every Opus/Sonnet/Haiku request route to the single local model too.
        for key in CLAUDE_MODEL_KEYS {
            writes.push((claude_env(key), json!(model)));
        }
        writes.push((key_path(&["model"]), json!(model)));
    }
    writes
}

/// Settings an earlier release wrote without a backup: when the endpoint is
/// this server, the key and the model keys beside it were written with it.
fn forget_legacy_claude_code(root: &mut Value, server: Option<&OurServer>) {
    let ours = get_at(root, &claude_env("ANTHROPIC_BASE_URL"))
        .and_then(Value::as_str)
        .is_some_and(|url| server.is_some_and(|s| s.is_url(url)));
    if !ours {
        return;
    }
    let model = get_at(root, &claude_env("ANTHROPIC_MODEL")).cloned();
    for key in ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]
        .into_iter()
        .chain(CLAUDE_MODEL_KEYS)
    {
        remove_at(root, &claude_env(key));
    }
    if model.is_some() && get_at(root, &key_path(&["model"])) == model.as_ref() {
        remove_at(root, &key_path(&["model"]));
    }
}

/// Point Claude Code's `settings.json` at this server.
pub(crate) fn connect_claude_code(
    settings: &Path,
    api_url: &str,
    model: Option<&str>,
    api_key: Option<&str>,
    context_length: Option<u32>,
) -> Result<(), String> {
    let server = OurServer::from_url(api_url);
    connect_file(
        settings,
        claude_code_writes(api_url, model, api_key, context_length),
        &claude_model_paths(),
        |root| forget_legacy_claude_code(root, server.as_ref()),
    )
}

/// Undo [`connect_claude_code`] in `settings`.
pub(crate) fn disconnect_claude_code(settings: &Path, server: &OurServer) -> Result<(), String> {
    disconnect_file(settings, |root| {
        forget_legacy_claude_code(root, Some(server))
    })
}

/// `content` without the blocks between two `marker` lines; `None` when there
/// is no complete block.
fn strip_marked_blocks(content: &str, marker: &str) -> Option<String> {
    let lines: Vec<&str> = content.split_inclusive('\n').collect();
    let is_marker = |line: &str| line.starts_with(marker);
    let mut kept = String::with_capacity(content.len());
    let mut found = false;
    let mut i = 0;
    while i < lines.len() {
        if is_marker(lines[i]) {
            if let Some(offset) = lines[i + 1..].iter().position(|l| is_marker(l)) {
                found = true;
                i += offset + 2;
                continue;
            }
        }
        kept.push_str(lines[i]);
        i += 1;
    }
    found.then_some(kept)
}

/// Take out the environment the old Claude Code settings page wrote for every
/// program: its marked block in the shell rc files, and on Windows the
/// `ANTHROPIC_*` user variables `setx` stored — those only while they still
/// point at this server. A user's own exports outside our block stay.
pub(crate) fn forget_legacy_claude_code_env(home: &Path, server: &OurServer) -> Result<(), String> {
    for name in [".zshenv", ".zshrc", ".bash_profile", ".bashrc", ".profile"] {
        let path = home.join(name);
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Some(cleaned) = strip_marked_blocks(&content, LEGACY_CLAUDE_CODE_SHELL_MARKER) {
            write_file_atomically(&path, cleaned.as_bytes()).map_err(|e| {
                format!(
                    "{e}. Remove the \"{LEGACY_CLAUDE_CODE_SHELL_MARKER}\" block from {} by hand.",
                    path.display()
                )
            })?;
            log::info!("Removed the old Claude Code block from {}", path.display());
        }
    }
    forget_legacy_claude_code_user_env(server)
}

#[cfg(windows)]
fn forget_legacy_claude_code_user_env(server: &OurServer) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE};
    use winreg::RegKey;

    let Ok(env) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Environment", KEY_QUERY_VALUE | KEY_SET_VALUE)
    else {
        return Ok(());
    };
    let base_url: Option<String> = env.get_value("ANTHROPIC_BASE_URL").ok();
    if !base_url.is_some_and(|url| server.is_url(&url)) {
        return Ok(());
    }
    for name in [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ] {
        match env.delete_value(name) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Could not remove the user variable {name}: {e}")),
        }
    }
    log::info!("Removed the old Claude Code user variables");
    Ok(())
}

#[cfg(not(windows))]
fn forget_legacy_claude_code_user_env(_server: &OurServer) -> Result<(), String> {
    Ok(())
}

// ── OpenClaude ─────────────────────────────────────────────────────────────

fn openclaude_profile_path() -> Vec<Value> {
    vec![
        json!("providerProfiles"),
        json!({ "id": OPENCLAUDE_PROFILE_ID }),
    ]
}

/// What Connect writes into OpenClaude's global config: our provider profile
/// (matched by its id only — a profile the user made from OpenClaude's own
/// Atomic Chat preset is theirs), the active profile, and the env values that
/// keep a shell's provider variables from overriding it.
fn openclaude_writes(
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
    context_length: Option<u32>,
) -> Vec<Write> {
    let mut profile = json!({
        "id": OPENCLAUDE_PROFILE_ID,
        "name": "Atomic Chat",
        "provider": OPENCLAUDE_PROVIDER,
        "apiKey": key_or_placeholder(api_key),
        "baseUrl": api_url,
        "model": model,
    });
    let window = context_length.filter(|w| *w > 0);
    if let Some(window) = window {
        // OpenClaude turns this into its per-model context-window override.
        profile["maxContextLength"] = json!(window);
    }
    let mut writes = vec![
        (openclaude_profile_path(), profile),
        (
            key_path(&["activeProviderProfileId"]),
            json!(OPENCLAUDE_PROFILE_ID),
        ),
    ];
    for name in OPENCLAUDE_SHELL_OVERRIDES {
        writes.push((key_path(&["env", name]), json!("")));
    }
    if let Some(window) = window {
        // A profile has no output setting; without one OpenClaude asks for
        // 32000 tokens and reserves 20000 of a small window for compaction.
        let mut caps = Map::new();
        caps.insert(model.to_string(), json!(output_cap(window)));
        writes.push((
            key_path(&["env", "CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS"]),
            json!(Value::Object(caps).to_string()),
        ));
    }
    writes
}

/// What an earlier release wrote without a backup: our profile, and the
/// active-profile pointer at it.
fn forget_legacy_openclaude(root: &mut Value) {
    remove_at(root, &openclaude_profile_path());
    if get_at(root, &key_path(&["activeProviderProfileId"])) == Some(&json!(OPENCLAUDE_PROFILE_ID))
    {
        remove_at(root, &key_path(&["activeProviderProfileId"]));
    }
}

/// The startup profile OpenClaude falls back to without an active profile.
fn openclaude_startup_profile(
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
    created_at: &str,
) -> Value {
    json!({
        "profile": OPENCLAUDE_PROVIDER,
        "env": {
            "OPENAI_BASE_URL": api_url,
            "OPENAI_MODEL": model,
            "OPENAI_API_KEY": key_or_placeholder(api_key),
        },
        "createdAt": created_at,
    })
}

pub(crate) fn startup_profile_is_ours(doc: &Value, server: Option<&OurServer>) -> bool {
    doc.get("profile").and_then(Value::as_str) == Some(OPENCLAUDE_PROVIDER)
        && doc
            .pointer("/env/OPENAI_BASE_URL")
            .and_then(Value::as_str)
            .is_some_and(|url| server.is_some_and(|s| s.is_url(url)))
}

/// A startup profile file that cannot be parsed counts as absent: OpenClaude
/// ignores it too.
fn read_startup_profile(path: &Path) -> Option<Value> {
    read_json_file(path).unwrap_or_else(|e| {
        log::warn!("{e}");
        None
    })
}

/// Point OpenClaude at this server: its global config and its startup profile.
pub(crate) fn connect_openclaude(
    paths: &OpenClaudePaths,
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
    context_length: Option<u32>,
    created_at: &str,
) -> Result<(), String> {
    // Read everything before writing anything: a config we cannot parse
    // leaves both files as they were.
    read_object_for_connect(&paths.config)?;
    connect_file(
        &paths.config,
        openclaude_writes(api_url, model, api_key, context_length),
        &[],
        forget_legacy_openclaude,
    )?;

    let server = OurServer::from_url(api_url);
    let current = read_startup_profile(&paths.profile);
    let doc = openclaude_startup_profile(api_url, model, api_key, created_at);
    let (existed, previous) = match read_backup(&paths.profile) {
        Some(backup)
            if backup
                .entries
                .first()
                .is_some_and(|e| Some(&e.written) == current.as_ref()) =>
        {
            let entry = &backup.entries[0];
            (entry.existed, entry.previous.clone())
        }
        _ => match current {
            Some(doc) if !startup_profile_is_ours(&doc, server.as_ref()) => (true, doc),
            _ => (false, Value::Null),
        },
    };
    let backup = Backup {
        about: BACKUP_ABOUT.to_string(),
        version: BACKUP_VERSION,
        file_existed: existed,
        created: Vec::new(),
        entries: vec![BackupEntry {
            path: Vec::new(),
            existed,
            previous,
            written: doc.clone(),
        }],
    };
    write_backup(&paths.profile, &backup)?;
    write_json_file(&paths.profile, &doc)
}

/// Undo [`connect_openclaude`].
pub(crate) fn disconnect_openclaude(
    paths: &OpenClaudePaths,
    server: &OurServer,
) -> Result<(), String> {
    disconnect_file(&paths.config, forget_legacy_openclaude)?;

    let current = read_startup_profile(&paths.profile);
    match (read_backup(&paths.profile), current) {
        (Some(backup), Some(current)) => {
            if let Some(entry) = backup.entries.first().filter(|e| e.written == current) {
                if entry.existed {
                    write_json_file(&paths.profile, &entry.previous)?;
                } else {
                    remove_file_if_present(&paths.profile)?;
                }
            }
        }
        (None, Some(current)) if startup_profile_is_ours(&current, Some(server)) => {
            remove_file_if_present(&paths.profile)?;
        }
        _ => {}
    }
    remove_file_if_present(&backup_path(&paths.profile))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const URL: &str = "http://127.0.0.1:1337";
    const MODEL: &str = "AtomicChat/Qwen3.5-9B-GGUF";

    fn read(path: &Path) -> Value {
        parse_json_text(&fs::read_to_string(path).unwrap()).unwrap()
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn server() -> OurServer {
        OurServer::new("127.0.0.1", 1337)
    }

    fn settings_in(dir: &Path) -> PathBuf {
        claude_settings_path(&claude_config_dir(dir, None))
    }

    #[test]
    fn claude_code_connect_writes_window_switches_and_title() {
        let home = tempfile::tempdir().unwrap();
        let settings = settings_in(home.path());
        connect_claude_code(&settings, URL, Some(MODEL), Some("sk-key"), Some(32768)).unwrap();
        let root = read(&settings);
        let env = &root["env"];
        assert_eq!(env["ANTHROPIC_BASE_URL"], URL);
        assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], "sk-key");
        assert_eq!(env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "32768");
        assert_eq!(env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], "8192");
        assert_eq!(env["CLAUDE_CODE_DISABLE_TERMINAL_TITLE"], "1");
        for switch in CLAUDE_PROVIDER_SWITCHES {
            assert_eq!(env[switch], "");
        }
        for key in CLAUDE_MODEL_KEYS {
            assert_eq!(env[key], MODEL);
        }
        assert_eq!(root["model"], MODEL);

        // A small window gets a quarter of it for output; an unknown one gets
        // neither value.
        connect_claude_code(&settings, URL, Some(MODEL), None, Some(16384)).unwrap();
        assert_eq!(
            read(&settings)["env"]["CLAUDE_CODE_MAX_OUTPUT_TOKENS"],
            "4096"
        );
        assert_eq!(read(&settings)["env"]["ANTHROPIC_AUTH_TOKEN"], "atomic");
        connect_claude_code(&settings, URL, Some(MODEL), None, None).unwrap();
        let env = read(&settings)["env"].clone();
        assert!(env.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS").is_none());
        assert!(env.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS").is_none());
    }

    #[test]
    fn claude_code_disconnect_restores_the_users_values() {
        let home = tempfile::tempdir().unwrap();
        let settings = settings_in(home.path());
        let original = r#"{
  "permissions": { "allow": ["Bash(git diff:*)"] },
  "env": { "MY_VAR": "keep", "ANTHROPIC_BASE_URL": "https://gateway.example.com", "CLAUDE_CODE_USE_BEDROCK": "1" },
  "model": "opus"
}"#;
        write(&settings, original);
        // Two connects in a row: the second must not take the first one's
        // values for the user's.
        connect_claude_code(&settings, URL, Some(MODEL), Some("k1"), Some(65536)).unwrap();
        connect_claude_code(&settings, URL, Some("other"), Some("k2"), Some(65536)).unwrap();
        assert_eq!(read(&settings)["model"], "other");
        assert!(backup_path(&settings).exists());

        disconnect_claude_code(&settings, &server()).unwrap();
        assert_eq!(
            read(&settings),
            serde_json::from_str::<Value>(original).unwrap()
        );
        assert!(!backup_path(&settings).exists());
        // A second disconnect has nothing left to do.
        disconnect_claude_code(&settings, &server()).unwrap();
        assert_eq!(
            read(&settings),
            serde_json::from_str::<Value>(original).unwrap()
        );
    }

    #[test]
    fn claude_code_disconnect_keeps_a_key_the_user_changed() {
        let home = tempfile::tempdir().unwrap();
        let settings = settings_in(home.path());
        write(
            &settings,
            r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"theirs"},"model":"opus"}"#,
        );
        connect_claude_code(&settings, URL, Some(MODEL), None, None).unwrap();
        let mut root = read(&settings);
        root["model"] = json!("sonnet");
        root["env"]["ANTHROPIC_BASE_URL"] = json!("https://elsewhere.example.com");
        write_json_file(&settings, &root).unwrap();

        disconnect_claude_code(&settings, &server()).unwrap();
        let root = read(&settings);
        assert_eq!(root["model"], "sonnet");
        assert_eq!(
            root["env"]["ANTHROPIC_BASE_URL"],
            "https://elsewhere.example.com"
        );
        assert_eq!(root["env"]["ANTHROPIC_AUTH_TOKEN"], "theirs");
        assert!(root["env"].get("ANTHROPIC_MODEL").is_none());
        assert!(root["env"].get("CLAUDE_CODE_USE_VERTEX").is_none());
    }

    #[test]
    fn claude_code_disconnect_deletes_a_file_it_created() {
        let home = tempfile::tempdir().unwrap();
        let settings = settings_in(home.path());
        connect_claude_code(&settings, URL, Some(MODEL), None, Some(8192)).unwrap();
        disconnect_claude_code(&settings, &server()).unwrap();
        assert!(!settings.exists());
        assert!(!backup_path(&settings).exists());
    }

    #[test]
    fn claude_code_rerun_without_a_model_keeps_the_last_one() {
        let home = tempfile::tempdir().unwrap();
        let settings = settings_in(home.path());
        write(&settings, r#"{"model":"opus"}"#);
        connect_claude_code(&settings, URL, Some(MODEL), None, None).unwrap();
        connect_claude_code(&settings, URL, None, None, None).unwrap();
        assert_eq!(read(&settings)["model"], MODEL);
        assert_eq!(read(&settings)["env"]["ANTHROPIC_MODEL"], MODEL);
        disconnect_claude_code(&settings, &server()).unwrap();
        assert_eq!(read(&settings), json!({"model": "opus"}));
    }

    #[test]
    fn claude_code_reads_past_a_byte_order_mark() {
        let home = tempfile::tempdir().unwrap();
        let settings = settings_in(home.path());
        write(&settings, "\u{feff}{\"theme\":\"dark\"}\n");
        connect_claude_code(&settings, URL, Some(MODEL), None, None).unwrap();
        let text = fs::read_to_string(&settings).unwrap();
        assert!(!text.starts_with('\u{feff}'));
        assert_eq!(read(&settings)["theme"], "dark");
        disconnect_claude_code(&settings, &server()).unwrap();
        assert_eq!(read(&settings), json!({"theme": "dark"}));
    }

    #[test]
    fn claude_code_earlier_release_values_are_taken_out_not_restored() {
        let home = tempfile::tempdir().unwrap();
        let settings = settings_in(home.path());
        let legacy = json!({
            "env": {
                "ANTHROPIC_BASE_URL": "http://localhost:1337",
                "ANTHROPIC_AUTH_TOKEN": "atomic",
                "ANTHROPIC_MODEL": "old",
                "ANTHROPIC_DEFAULT_OPUS_MODEL": "old",
                "MY_VAR": "keep"
            },
            "model": "old",
            "theme": "dark"
        });
        write(&settings, &legacy.to_string());
        connect_claude_code(&settings, URL, Some(MODEL), None, None).unwrap();
        disconnect_claude_code(&settings, &server()).unwrap();
        assert_eq!(
            read(&settings),
            json!({"env": {"MY_VAR": "keep"}, "theme": "dark"})
        );

        // Without a backup at all (connected by an earlier release).
        write(&settings, &legacy.to_string());
        disconnect_claude_code(&settings, &server()).unwrap();
        assert_eq!(
            read(&settings),
            json!({"env": {"MY_VAR": "keep"}, "theme": "dark"})
        );

        // A gateway on the LAN is the user's own.
        let theirs = json!({"env": {"ANTHROPIC_BASE_URL": "http://192.168.1.20:4000"}});
        write(&settings, &theirs.to_string());
        disconnect_claude_code(&settings, &server()).unwrap();
        assert_eq!(read(&settings), theirs);
    }

    #[test]
    fn claude_code_unparsable_settings_fail_and_stay() {
        let home = tempfile::tempdir().unwrap();
        let settings = settings_in(home.path());
        write(&settings, "{ not json");
        let err = connect_claude_code(&settings, URL, Some(MODEL), None, None).unwrap_err();
        assert!(err.contains("Could not parse"), "{err}");
        assert_eq!(fs::read_to_string(&settings).unwrap(), "{ not json");
        assert!(!backup_path(&settings).exists());
        write(&settings, "[]");
        assert!(connect_claude_code(&settings, URL, None, None, None)
            .unwrap_err()
            .contains("is not a JSON object"));
    }

    #[cfg(unix)]
    #[test]
    fn writes_keep_permissions_and_symlinks() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let real = home.path().join("dotfiles/settings.json");
        write(&real, "{}");
        fs::set_permissions(&real, fs::Permissions::from_mode(0o640)).unwrap();
        let settings = settings_in(home.path());
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&real, &settings).unwrap();

        connect_claude_code(&settings, URL, Some(MODEL), None, None).unwrap();
        assert!(fs::symlink_metadata(&settings)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(read(&real)["model"], MODEL);
        assert_eq!(
            fs::metadata(&real).unwrap().permissions().mode() & 0o777,
            0o640
        );
        let sidecar = fs::metadata(backup_path(&settings)).unwrap();
        assert_eq!(sidecar.permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn legacy_shell_block_goes_and_the_users_lines_stay() {
        let home = tempfile::tempdir().unwrap();
        let rc = home.path().join(".zshenv");
        let user = "export PATH=\"$HOME/bin:$PATH\"\nexport ANTHROPIC_API_KEY='mine'\n";
        write(
            &rc,
            &format!(
                "{user}{m}\nexport ANTHROPIC_BASE_URL='http://localhost:1337'\nexport ANTHROPIC_AUTH_TOKEN='jan'\n\n{m}\n",
                m = LEGACY_CLAUDE_CODE_SHELL_MARKER
            ),
        );
        forget_legacy_claude_code_env(home.path(), &server()).unwrap();
        assert_eq!(fs::read_to_string(&rc).unwrap(), user);
        // Nothing of ours: the file is not touched.
        let untouched = home.path().join(".bashrc");
        write(
            &untouched,
            &format!("{}\nexport X=1\n", LEGACY_CLAUDE_CODE_SHELL_MARKER),
        );
        forget_legacy_claude_code_env(home.path(), &server()).unwrap();
        assert_eq!(
            fs::read_to_string(&untouched).unwrap(),
            format!("{}\nexport X=1\n", LEGACY_CLAUDE_CODE_SHELL_MARKER)
        );
    }

    #[test]
    fn our_server_matches_exact_host_or_loopback_with_our_port() {
        let lan = OurServer::new("192.168.1.20", 1337);
        for url in [
            "http://192.168.1.20:1337",
            "http://127.0.0.1:1337/v1",
            "http://localhost:1337",
            "http://[::1]:1337",
            "localhost:1337",
        ] {
            assert!(lan.is_url(url), "{url}");
        }
        for url in [
            "http://192.168.1.21:1337",
            "http://192.168.1.20:4000",
            "http://127.0.0.1:1338",
            "http://localhost",
            "https://api.anthropic.com",
            "",
        ] {
            assert!(!lan.is_url(url), "{url}");
        }
        assert!(OurServer::new("0.0.0.0", 1337).is_url("http://127.0.0.1:1337"));
        assert_eq!(
            OurServer::from_url("http://127.0.0.1:1337/v1"),
            Some(OurServer::new("127.0.0.1", 1337))
        );
    }

    #[test]
    fn config_dirs_follow_the_agents_variables() {
        let home = Path::new("/home/u");
        assert_eq!(claude_config_dir(home, None), home.join(".claude"));
        assert_eq!(claude_config_dir(home, Some("")), home.join(".claude"));
        assert_eq!(
            claude_config_dir(home, Some("relative")),
            home.join(".claude")
        );
        assert_eq!(claude_config_dir(home, Some("~/cc")), home.join("cc"));
        let tmp = tempfile::tempdir().unwrap();
        let abs = tmp.path().to_str().unwrap();
        assert_eq!(claude_config_dir(home, Some(abs)), tmp.path());

        assert_eq!(
            openclaude_paths(tmp.path(), None),
            OpenClaudePaths {
                config: tmp.path().join(".openclaude.json"),
                profile: tmp.path().join(".openclaude/.openclaude-profile.json"),
            }
        );
        let custom = tmp.path().join("oc");
        assert_eq!(
            openclaude_paths(tmp.path(), custom.to_str()),
            OpenClaudePaths {
                config: custom.join(".openclaude.json"),
                profile: custom.join(".openclaude-profile.json"),
            }
        );
        // The legacy file in the config home wins, as in OpenClaude.
        write(&custom.join(".config.json"), "{}");
        assert_eq!(
            openclaude_paths(tmp.path(), custom.to_str()).config,
            custom.join(".config.json")
        );
    }

    fn openclaude_in(home: &Path) -> OpenClaudePaths {
        openclaude_paths(home, None)
    }

    #[test]
    fn openclaude_connect_writes_key_window_and_shell_overrides() {
        let home = tempfile::tempdir().unwrap();
        let paths = openclaude_in(home.path());
        write(
            &paths.config,
            r#"{"providerProfiles":[{"id":"personal","apiKey":"personal-key"},{"id":"mine","provider":"atomic-chat","baseUrl":"http://127.0.0.1:1337/v1","model":"m"}],"theme":"dark"}"#,
        );
        for key in [Some("first'key"), Some("rotated"), None, Some("")] {
            connect_openclaude(
                &paths,
                "http://127.0.0.1:1337/v1",
                MODEL,
                key,
                Some(32768),
                "t",
            )
            .unwrap();
            let root = read(&paths.config);
            let startup = read(&paths.profile);
            let expected = key.filter(|k| !k.is_empty()).unwrap_or("atomic");
            let profiles = root["providerProfiles"].as_array().unwrap();
            // The user's own Atomic Chat preset profile stays theirs.
            assert_eq!(profiles.len(), 3);
            assert_eq!(profiles[0]["apiKey"], "personal-key");
            assert_eq!(profiles[1]["id"], "mine");
            assert_eq!(profiles[2]["id"], OPENCLAUDE_PROFILE_ID);
            assert_eq!(profiles[2]["apiKey"], expected);
            assert_eq!(profiles[2]["maxContextLength"], 32768);
            assert_eq!(root["activeProviderProfileId"], OPENCLAUDE_PROFILE_ID);
            assert_eq!(root["env"]["CLAUDE_CODE_USE_OPENAI"], "");
            assert_eq!(root["env"]["OPENAI_BASE_URL"], "");
            assert_eq!(
                root["env"]["CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS"],
                format!("{{\"{MODEL}\":8192}}")
            );
            assert_eq!(root["theme"], "dark");
            assert_eq!(startup["env"]["OPENAI_API_KEY"], expected);
        }
    }

    #[test]
    fn openclaude_disconnect_restores_both_files() {
        let home = tempfile::tempdir().unwrap();
        let paths = openclaude_in(home.path());
        let config = json!({
            "providerProfiles": [{"id": "personal", "provider": "openai", "baseUrl": "https://api.openai.com/v1", "model": "gpt-5"}],
            "activeProviderProfileId": "personal",
            "env": {"OPENAI_MODEL": "gpt-5"},
            "numStartups": 3
        });
        let startup =
            json!({"profile": "openai", "env": {"OPENAI_MODEL": "gpt-5"}, "createdAt": "x"});
        write(&paths.config, &format!("\u{feff}{config}"));
        write(&paths.profile, &startup.to_string());

        connect_openclaude(
            &paths,
            "http://127.0.0.1:1337/v1",
            MODEL,
            None,
            Some(16384),
            "t1",
        )
        .unwrap();
        connect_openclaude(
            &paths,
            "http://127.0.0.1:1337/v1",
            "other",
            None,
            None,
            "t2",
        )
        .unwrap();
        // OpenClaude rewrites its config while connected, our entry included.
        let mut root = read(&paths.config);
        root["numStartups"] = json!(4);
        root["providerProfiles"][1]["baseUrl"] = json!("http://127.0.0.1:1337/v1/");
        write_json_file(&paths.config, &root).unwrap();

        disconnect_openclaude(&paths, &server()).unwrap();
        let mut expected = config.clone();
        expected["numStartups"] = json!(4);
        assert_eq!(read(&paths.config), expected);
        assert_eq!(read(&paths.profile), startup);
        assert!(!backup_path(&paths.config).exists());
        assert!(!backup_path(&paths.profile).exists());
    }

    #[test]
    fn openclaude_disconnect_of_a_fresh_connect_leaves_nothing() {
        let home = tempfile::tempdir().unwrap();
        let paths = openclaude_in(home.path());
        connect_openclaude(
            &paths,
            "http://127.0.0.1:1337/v1",
            MODEL,
            Some("k"),
            None,
            "t",
        )
        .unwrap();
        disconnect_openclaude(&paths, &server()).unwrap();
        assert!(!paths.config.exists());
        assert!(!paths.profile.exists());
        // Never connected: nothing to do, and it succeeds.
        disconnect_openclaude(&paths, &server()).unwrap();
    }

    #[test]
    fn openclaude_earlier_release_profile_is_taken_out() {
        let home = tempfile::tempdir().unwrap();
        let paths = openclaude_in(home.path());
        write(
            &paths.config,
            &json!({
                "providerProfiles": [
                    {"id": "personal", "provider": "openai"},
                    {"id": OPENCLAUDE_PROFILE_ID, "provider": "atomic-chat", "baseUrl": "http://127.0.0.1:1337/v1"}
                ],
                "activeProviderProfileId": OPENCLAUDE_PROFILE_ID
            })
            .to_string(),
        );
        write(
            &paths.profile,
            &openclaude_startup_profile("http://127.0.0.1:1337/v1", "m", None, "t").to_string(),
        );
        disconnect_openclaude(&paths, &server()).unwrap();
        assert_eq!(
            read(&paths.config),
            json!({"providerProfiles": [{"id": "personal", "provider": "openai"}]})
        );
        assert!(!paths.profile.exists());
    }

    #[test]
    fn openclaude_unparsable_config_writes_neither_file() {
        let home = tempfile::tempdir().unwrap();
        let paths = openclaude_in(home.path());
        write(&paths.config, "{\"providerProfiles\": [");
        assert!(connect_openclaude(&paths, URL, MODEL, None, None, "t")
            .unwrap_err()
            .contains("Could not parse"));
        assert!(!paths.profile.exists());
        assert!(!backup_path(&paths.config).exists());
    }

    #[test]
    fn marked_blocks_need_both_markers() {
        let m = "# M";
        assert_eq!(
            strip_marked_blocks("a\n# M\nx\n# M\nb\n", m).as_deref(),
            Some("a\nb\n")
        );
        assert_eq!(
            strip_marked_blocks("# M\nx\n# M\n# M\ny\n# M", m).as_deref(),
            Some("")
        );
        assert_eq!(strip_marked_blocks("a\n# M\nx\n", m), None);
        assert_eq!(strip_marked_blocks("a\n", m), None);
    }
}
