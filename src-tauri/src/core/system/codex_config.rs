//! Codex CLI: Atomic Chat's own profile, and the repair of the shared
//! `config.toml` that earlier releases wrote into.
//!
//! Earlier releases made Atomic the default provider by writing root `model` /
//! `model_provider` keys plus `[model_providers.atomic]` into
//! `~/.codex/config.toml`, between `# >>> Atomic Chat (managed) >>>` markers.
//! That file is shared with the ChatGPT app and every plain `codex` run: a user
//! who already had a root `model` got a `duplicate key` error that kept those
//! apps from starting, and removing the tool in Atomic Chat never undid it.
//!
//! Now Atomic Chat writes only `<codex home>/atomic-chat.config.toml`, which
//! Codex (0.134+) layers over the base config when started with
//! `--profile atomic-chat`, and the Launch page starts it that way. The base
//! config is touched only to take out what an earlier release put there: each
//! marked block must parse and hold nothing but settings Atomic Chat wrote, the
//! result must parse, the original is backed up first, and anything it cannot
//! vouch for is reported instead of guessed at.
//!
//! Byte-for-byte twin of `src/integrations/configure/codex.ts` in
//! atomic-chat-core, which the CLI's `launch codex` uses.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use super::commands::{
    agent_home_dir, tool_version_text, ATOMIC_MANAGED_BEGIN, ATOMIC_MANAGED_END,
};

/// What `codex --profile atomic-chat` reads.
const PROFILE_FILE: &str = "atomic-chat.config.toml";
/// Not `atomic`, the id earlier releases used: a profile's tables merge into
/// the base config's, so a user's own `[model_providers.atomic]` would mix
/// with ours.
const PROVIDER_ID: &str = "atomic-chat";
/// Codex reads the server's key from the variable named here, never inline.
const API_KEY_ENV: &str = "ATOMIC_CHAT_API_KEY";
/// A profile is ours only if it starts with this; anything else is the user's.
const OWNER_PREFIX: &str = "# Managed by Atomic Chat";
const PROFILE_HEADER: &str =
    "# Managed by Atomic Chat: `codex --profile atomic-chat` runs Codex on your local models.\n\
# Atomic Chat rewrites this file when Codex is connected again and deletes it on disconnect.\n";
/// `--profile <name>` reads `<name>.config.toml` from 0.134.0; 0.131–0.133
/// called that `--profile-v2` and kept `--profile` for `[profiles.<name>]`.
const MIN_CODEX_VERSION: (u64, u64, u64) = (0, 134, 0);
const BASE_CONFIG: &str = "config.toml";
const BACKUP_FILE: &str = "config.toml.atomic-chat-backup";

/// Codex's own directory: `$CODEX_HOME` when set (a leading `~` expanded),
/// else `<home>/.codex`.
pub(crate) fn codex_home(home: &Path, codex_home_env: Option<&str>) -> PathBuf {
    match codex_home_env.filter(|v| !v.is_empty()) {
        Some("~") => home.to_path_buf(),
        Some(v) if v.starts_with("~/") || v.starts_with("~\\") => home.join(&v[2..]),
        Some(v) => PathBuf::from(v),
        None => home.join(".codex"),
    }
}

pub(crate) fn resolve_codex_home() -> Result<PathBuf, String> {
    let home = agent_home_dir()?;
    Ok(codex_home(
        Path::new(&home),
        std::env::var("CODEX_HOME").ok().as_deref(),
    ))
}

pub(crate) fn profile_path(codex_home: &Path) -> PathBuf {
    codex_home.join(PROFILE_FILE)
}

/// A TOML basic string, quotes included. Unlike the escaping the other
/// writers share, control characters are escaped too, so no model id can
/// break the file.
pub(crate) fn toml_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 || c == '\u{7f}' => {
                out.push_str(&format!("\\u{:04X}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub(crate) fn render_profile(api_url: &str, model: &str, keyed: bool) -> String {
    let mut out = String::from(PROFILE_HEADER);
    out.push_str(&format!("model = {}\n", toml_string(model)));
    out.push_str(&format!("model_provider = \"{PROVIDER_ID}\"\n\n"));
    out.push_str(&format!("[model_providers.{PROVIDER_ID}]\n"));
    out.push_str("name = \"Atomic Chat\"\n");
    out.push_str(&format!("base_url = {}\n", toml_string(api_url)));
    if keyed {
        out.push_str(&format!("env_key = \"{API_KEY_ENV}\"\n"));
    }
    out
}

/// `None` only when the file does not exist: a file we cannot read is never
/// taken for an empty one.
fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

/// Write beside the target and rename over it, so a crash leaves either the
/// old file or the new one, never half of either. A symlink (dotfile managers
/// link `config.toml`) is written through: renaming over the link itself would
/// swap it for a plain file and cut it off from what it points at.
fn write_atomically(
    path: &Path,
    contents: &str,
    permissions: Option<&fs::Permissions>,
) -> Result<(), String> {
    let resolved = match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => fs::canonicalize(path)
            .map_err(|e| format!("Could not follow the link {}: {e}", path.display()))?,
        _ => path.to_path_buf(),
    };
    let path = resolved.as_path();
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{name}.atomic-chat-tmp"));
    let written = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        if let Some(permissions) = permissions {
            fs::set_permissions(&tmp, permissions.clone())?;
        }
        fs::rename(&tmp, path)
    })();
    written.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Could not write {}: {e}", path.display())
    })
}

/// Line and message only: the parser's own rendering quotes the offending
/// line, and the user's config can hold tokens that must not reach a toast or
/// the log.
fn describe_toml_error(err: &toml::de::Error, text: &str) -> String {
    match err.span() {
        Some(span) => {
            let line = text[..span.start.min(text.len())].matches('\n').count() + 1;
            format!("line {line}: {}", err.message())
        }
        None => err.message().to_string(),
    }
}

/// Write (or rewrite) our profile. A profile of the same name that Atomic
/// Chat did not write is left alone.
pub(crate) fn write_profile(
    codex_home: &Path,
    api_url: &str,
    model: &str,
    keyed: bool,
) -> Result<PathBuf, String> {
    let path = profile_path(codex_home);
    if let Some(existing) = read_optional(&path)? {
        if !existing.starts_with(OWNER_PREFIX) {
            return Err(format!(
                "{} already exists and was not written by Atomic Chat. Rename or remove it, then connect Codex again.",
                path.display()
            ));
        }
    }
    let contents = render_profile(api_url, model, keyed);
    contents.parse::<toml::Table>().map_err(|e| {
        format!(
            "Atomic Chat built an invalid Codex profile ({})",
            describe_toml_error(&e, &contents)
        )
    })?;
    write_atomically(&path, &contents, None)?;
    Ok(path)
}

/// Delete our profile; one that is not ours stays. Whether one was deleted.
pub(crate) fn remove_profile(codex_home: &Path) -> Result<bool, String> {
    let path = profile_path(codex_home);
    match read_optional(&path)? {
        Some(text) if text.starts_with(OWNER_PREFIX) => {
            fs::remove_file(&path)
                .map_err(|e| format!("Could not delete {}: {e}", path.display()))?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Whether our profile is in place (Launch page detection).
pub(crate) fn profile_is_ours(codex_home: &Path) -> bool {
    read_optional(&profile_path(codex_home))
        .ok()
        .flatten()
        .is_some_and(|text| text.starts_with(OWNER_PREFIX))
}

/// What an earlier release had pointed Codex at.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct LegacySettings {
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub keyed: bool,
}

#[derive(Debug, PartialEq)]
pub(crate) enum Repair {
    /// No file, or nothing of ours in it.
    Clean,
    /// Our blocks are gone; `backup` holds the file as it was.
    Repaired {
        backup: PathBuf,
        legacy: LegacySettings,
    },
    /// Left exactly as it was, for the reason given (a sentence for the user).
    Conflict(String),
}

enum Plan {
    Clean,
    /// Something about our blocks we cannot vouch for.
    Blocks(String),
    /// Our blocks are fine, but what would remain still does not parse.
    Invalid(String),
    Rewrite {
        text: String,
        legacy: LegacySettings,
    },
}

const UNKNOWN_SETTINGS: &str = "has settings Atomic Chat never writes";

/// The two shapes earlier releases wrote, and nothing else: a head with
/// `model` / `model_provider = "atomic"`, `[model_providers.atomic]` with our
/// name, a URL and our key variable, and (first release) `[profiles.atomic]`.
fn recognise_block(block: &toml::Table, legacy: &mut LegacySettings) -> Result<(), &'static str> {
    use toml::Value;
    if block.is_empty() {
        return Err("is empty");
    }
    let only_atomic = |table: &toml::Table| match (table.len(), table.get("atomic")) {
        (1, Some(Value::Table(inner))) => Ok(inner.clone()),
        _ => Err(UNKNOWN_SETTINGS),
    };
    for (key, value) in block {
        match (key.as_str(), value) {
            ("model", Value::String(model)) => legacy.model = Some(model.clone()),
            ("model_provider", Value::String(p)) if p == "atomic" => {}
            ("model_providers", Value::Table(t)) => {
                for (key, value) in only_atomic(t)? {
                    match (key.as_str(), &value) {
                        ("name", Value::String(n)) if n == "Atomic Chat" => {}
                        ("base_url", Value::String(url)) => legacy.base_url = Some(url.clone()),
                        ("env_key", Value::String(k)) if k == API_KEY_ENV => legacy.keyed = true,
                        _ => return Err(UNKNOWN_SETTINGS),
                    }
                }
            }
            ("profiles", Value::Table(t)) => {
                for (key, value) in only_atomic(t)? {
                    match (key.as_str(), &value) {
                        ("model", Value::String(model)) => legacy.model = Some(model.clone()),
                        ("model_provider", Value::String(p)) if p == "atomic" => {}
                        _ => return Err(UNKNOWN_SETTINGS),
                    }
                }
            }
            _ => return Err(UNKNOWN_SETTINGS),
        }
    }
    Ok(())
}

fn plan_repair(text: &str) -> Plan {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let is = |line: &str, marker: &str| {
        line.strip_suffix('\n')
            .map(|l| l.strip_suffix('\r').unwrap_or(l))
            .unwrap_or(line)
            == marker
    };
    let mentions =
        text.matches(ATOMIC_MANAGED_BEGIN).count() + text.matches(ATOMIC_MANAGED_END).count();
    if mentions == 0 {
        return Plan::Clean;
    }
    let marker_lines = lines
        .iter()
        .filter(|l| is(l, ATOMIC_MANAGED_BEGIN) || is(l, ATOMIC_MANAGED_END))
        .count();
    if marker_lines != mentions {
        return Plan::Blocks("an Atomic Chat marker is part of another line".into());
    }

    let mut regions: Vec<(usize, usize)> = Vec::new();
    let mut open: Option<usize> = None;
    for (i, line) in lines.iter().enumerate() {
        if is(line, ATOMIC_MANAGED_BEGIN) {
            if open.is_some() {
                return Plan::Blocks("a block opens inside another one".into());
            }
            open = Some(i);
        } else if is(line, ATOMIC_MANAGED_END) {
            match open.take() {
                Some(begin) => regions.push((begin, i)),
                None => return Plan::Blocks("a block closes without opening".into()),
            }
        }
    }
    if open.is_some() {
        return Plan::Blocks("a block is never closed".into());
    }

    let mut legacy = LegacySettings::default();
    for (n, &(begin, end)) in regions.iter().enumerate() {
        let inner = lines[begin + 1..end].concat();
        let block = match inner.parse::<toml::Table>() {
            Ok(block) => block,
            Err(e) => {
                return Plan::Blocks(format!(
                    "block {} is not valid TOML ({})",
                    n + 1,
                    describe_toml_error(&e, &inner)
                ))
            }
        };
        if let Err(why) = recognise_block(&block, &mut legacy) {
            return Plan::Blocks(format!("block {} {why}", n + 1));
        }
    }

    let inside = |i: usize| regions.iter().any(|&(b, e)| (b..=e).contains(&i));
    // The head block sat at the very top with a blank separator under it.
    let mut at_top = regions.first().is_some_and(|&(begin, _)| begin == 0);
    let mut kept = String::with_capacity(text.len());
    for (i, line) in lines.iter().enumerate() {
        if inside(i) {
            continue;
        }
        if at_top && line.trim().is_empty() {
            continue;
        }
        at_top = false;
        kept.push_str(line);
    }
    let trimmed = kept.trim_end();
    let text = if trimmed.is_empty() {
        String::new()
    } else {
        format!("{trimmed}\n")
    };
    if let Err(e) = text.parse::<toml::Table>() {
        return Plan::Invalid(describe_toml_error(&e, &text));
    }
    Plan::Rewrite { text, legacy }
}

/// Copy the original next to it under a name no earlier backup has.
fn write_backup(
    codex_home: &Path,
    original: &str,
    permissions: Option<&fs::Permissions>,
) -> Result<PathBuf, String> {
    for n in 1..1000 {
        let name = if n == 1 {
            BACKUP_FILE.to_string()
        } else {
            format!("{BACKUP_FILE}-{n}")
        };
        let path = codex_home.join(name);
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => file,
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Could not back up Codex's config.toml: {e}")),
        };
        let written = file
            .write_all(original.as_bytes())
            .and_then(|_| file.sync_all())
            .and_then(|_| match permissions {
                Some(p) => fs::set_permissions(&path, p.clone()),
                None => Ok(()),
            });
        return match written {
            Ok(()) => Ok(path),
            Err(e) => {
                drop(file);
                let _ = fs::remove_file(&path);
                Err(format!("Could not back up Codex's config.toml: {e}"))
            }
        };
    }
    Err("Could not back up Codex's config.toml: too many earlier backups".into())
}

/// Take the settings an earlier release wrote out of `<codex home>/config.toml`.
pub(crate) fn repair_legacy_config(codex_home: &Path) -> Result<Repair, String> {
    let path = codex_home.join(BASE_CONFIG);
    let Some(original) = read_optional(&path)? else {
        return Ok(Repair::Clean);
    };
    let (text, legacy) = match plan_repair(&original) {
        Plan::Clean => return Ok(Repair::Clean),
        Plan::Blocks(why) => {
            return Ok(Repair::Conflict(format!(
                "{} still has settings an earlier Atomic Chat wrote, and they could not be removed safely: {why}. \
                 Nothing was changed. Delete the lines from \"{ATOMIC_MANAGED_BEGIN}\" to \"{ATOMIC_MANAGED_END}\" by hand, then try again.",
                path.display()
            )))
        }
        Plan::Invalid(why) => {
            return Ok(Repair::Conflict(format!(
                "{} would still not be valid TOML after removing Atomic Chat's settings ({why}). \
                 Nothing was changed. Fix that line, then try again.",
                path.display()
            )))
        }
        Plan::Rewrite { text, legacy } => (text, legacy),
    };
    // Someone else (the user, Codex, another app) may have saved it meanwhile.
    if read_optional(&path)?.as_deref() != Some(original.as_str()) {
        return Ok(Repair::Conflict(format!(
            "{} changed while Atomic Chat was repairing it. Nothing was changed; try again.",
            path.display()
        )));
    }
    let permissions = fs::metadata(&path).map(|m| m.permissions()).ok();
    let backup = write_backup(codex_home, &original, permissions.as_ref())?;
    write_atomically(&path, &text, permissions.as_ref())?;
    Ok(Repair::Repaired { backup, legacy })
}

/// `codex --version` prints `codex-cli 0.146.0`.
fn installed_codex_version() -> Option<(u64, u64, u64)> {
    let text = tool_version_text("codex")?;
    super::commands::parse_version(text.split_whitespace().last()?)
}

/// Point Codex's profile at the local server. `version` is the installed
/// Codex, when known.
pub(crate) fn configure_in(
    codex_home: &Path,
    api_url: &str,
    model: &str,
    keyed: bool,
    version: Option<(u64, u64, u64)>,
) -> Result<PathBuf, String> {
    if let Some((major, minor, patch)) = version.filter(|v| *v < MIN_CODEX_VERSION) {
        return Err(format!(
            "Codex CLI {major}.{minor}.{patch} is too old for Atomic Chat. Update it to 0.134 or newer and connect again."
        ));
    }
    if let Repair::Conflict(why) = repair_legacy_config(codex_home)? {
        return Err(why);
    }
    write_profile(codex_home, api_url, model, keyed)
}

pub(crate) fn configure(api_url: &str, model: &str, keyed: bool) -> Result<PathBuf, String> {
    configure_in(
        &resolve_codex_home()?,
        api_url,
        model,
        keyed,
        installed_codex_version(),
    )
}

pub(crate) fn disconnect_in(codex_home: &Path) -> Result<(), String> {
    remove_profile(codex_home)?;
    match repair_legacy_config(codex_home)? {
        Repair::Conflict(why) => Err(why),
        Repair::Clean | Repair::Repaired { .. } => Ok(()),
    }
}

/// Once per start: take an earlier release's settings out of the shared
/// config, and carry them into the profile so `codex --profile atomic-chat`
/// keeps working. Only logs; a start never fails over Codex.
pub(crate) fn migrate_in(codex_home: &Path) {
    match repair_legacy_config(codex_home) {
        Ok(Repair::Clean) => {}
        Ok(Repair::Repaired { backup, legacy }) => {
            log::info!(
                "Removed Atomic Chat's earlier settings from Codex's config.toml; the previous file is {}",
                backup.display()
            );
            let profile_missing = matches!(read_optional(&profile_path(codex_home)), Ok(None));
            if let (true, Some(model), Some(url)) = (profile_missing, legacy.model, legacy.base_url)
            {
                match write_profile(codex_home, &url, &model, legacy.keyed) {
                    Ok(path) => log::info!("Moved them to the Codex profile {}", path.display()),
                    Err(e) => log::warn!("Could not write the Codex profile: {e}"),
                }
            }
        }
        Ok(Repair::Conflict(why)) => log::warn!("{why}"),
        Err(e) => log::warn!("Could not check Codex's config.toml: {e}"),
    }
}

pub(crate) fn migrate_on_startup() {
    match resolve_codex_home() {
        Ok(codex_home) => migrate_in(&codex_home),
        Err(e) => log::warn!("Could not resolve Codex's directory: {e}"),
    }
}

/// Undo the Codex connection: delete our profile and anything an earlier
/// release left in the shared config.
#[tauri::command]
pub async fn disconnect_codex() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| disconnect_in(&resolve_codex_home()?))
        .await
        .map_err(|e| e.to_string())??;
    log::info!("Codex disconnected from Atomic Chat");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN: &str = "# Managed by Atomic Chat: `codex --profile atomic-chat` runs Codex on your local models.\n\
# Atomic Chat rewrites this file when Codex is connected again and deletes it on disconnect.\n\
model = \"AtomicChat/Qwen3.5-9B-GGUF\"\n\
model_provider = \"atomic-chat\"\n\
\n\
[model_providers.atomic-chat]\n\
name = \"Atomic Chat\"\n\
base_url = \"http://127.0.0.1:1337/v1\"\n\
env_key = \"ATOMIC_CHAT_API_KEY\"\n";

    const URL: &str = "http://127.0.0.1:1337/v1";
    const MODEL: &str = "AtomicChat/Qwen3.5-9B-GGUF";

    /// What the release before this one wrote over a config that already had
    /// a root `model` — the file from the incident.
    const BROKEN_V2: &str = "# >>> Atomic Chat (managed) >>>\n\
model = \"local-model\"\n\
model_provider = \"atomic\"\n\
# <<< Atomic Chat (managed) <<<\n\
\n\
model = \"original-model\"\n\
approval_policy = \"on-request\"\n\
# >>> Atomic Chat (managed) >>>\n\
[model_providers.atomic]\n\
name = \"Atomic Chat\"\n\
base_url = \"http://127.0.0.1:1337/v1\"\n\
env_key = \"ATOMIC_CHAT_API_KEY\"\n\
# <<< Atomic Chat (managed) <<<\n";

    const V1: &str = "approval_policy = \"never\"\n\
# >>> Atomic Chat (managed) >>>\n\
[model_providers.atomic]\n\
name = \"Atomic Chat\"\n\
base_url = \"http://127.0.0.1:1337/v1\"\n\
\n\
[profiles.atomic]\n\
model = \"qwen3\"\n\
model_provider = \"atomic\"\n\
# <<< Atomic Chat (managed) <<<\n";

    fn seed(dir: &Path, name: &str, text: &str) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, text).unwrap();
        path
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn assert_conflict_unchanged(original: &str) {
        let dir = tempfile::tempdir().unwrap();
        let config = seed(dir.path(), BASE_CONFIG, original);
        let repair = repair_legacy_config(dir.path()).unwrap();
        assert!(matches!(repair, Repair::Conflict(_)), "{repair:?}");
        assert_eq!(fs::read(&config).unwrap(), original.as_bytes());
        assert_eq!(files(dir.path()), vec![BASE_CONFIG]);
    }

    #[test]
    fn profile_matches_the_golden_bytes() {
        assert_eq!(render_profile(URL, MODEL, true), GOLDEN);
        assert!(!render_profile(URL, MODEL, false).contains("env_key"));
    }

    #[test]
    fn strings_are_escaped_including_control_characters() {
        assert_eq!(
            toml_string("a\\b\"c\td\ne\r\u{1}\u{7f}"),
            "\"a\\\\b\\\"c\\td\\ne\\r\\u0001\\u007F\""
        );
        let profile = render_profile("http://h/v1?q=\"x\"", "line\nbreak", false);
        let table = profile.parse::<toml::Table>().unwrap();
        assert_eq!(table["model"].as_str(), Some("line\nbreak"));
    }

    #[test]
    fn configure_writes_only_the_profile() {
        let dir = tempfile::tempdir().unwrap();
        let config = seed(dir.path(), BASE_CONFIG, "model = \"mine\"\n");
        let path = configure_in(dir.path(), URL, MODEL, true, Some((0, 146, 0))).unwrap();
        assert_eq!(read(&path), GOLDEN);
        assert_eq!(read(&config), "model = \"mine\"\n");
        assert_eq!(
            files(dir.path()),
            vec!["atomic-chat.config.toml", BASE_CONFIG]
        );
        // A rerun only rewrites our own file.
        configure_in(dir.path(), URL, "other", false, None).unwrap();
        assert!(read(&path).contains("model = \"other\""));
        assert!(!read(&path).contains("env_key"));
    }

    #[test]
    fn a_profile_that_is_not_ours_is_never_overwritten_or_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let theirs = seed(dir.path(), PROFILE_FILE, "model = \"theirs\"\n");
        let err = configure_in(dir.path(), URL, MODEL, false, None).unwrap_err();
        assert!(err.contains("was not written by Atomic Chat"), "{err}");
        disconnect_in(dir.path()).unwrap();
        assert_eq!(read(&theirs), "model = \"theirs\"\n");
    }

    #[test]
    fn too_old_a_codex_is_refused_before_anything_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let err = configure_in(dir.path(), URL, MODEL, false, Some((0, 133, 9))).unwrap_err();
        assert!(err.contains("0.133.9") && err.contains("0.134"), "{err}");
        assert!(!dir.path().exists() || files(dir.path()).is_empty());
    }

    #[test]
    fn repairs_the_incident_file_and_keeps_the_users_settings() {
        let dir = tempfile::tempdir().unwrap();
        let config = seed(dir.path(), BASE_CONFIG, BROKEN_V2);
        assert!(
            BROKEN_V2.parse::<toml::Table>().is_err(),
            "the incident file is invalid"
        );
        let repair = repair_legacy_config(dir.path()).unwrap();
        let Repair::Repaired { backup, legacy } = repair else {
            panic!("{repair:?}")
        };
        assert_eq!(
            read(&config),
            "model = \"original-model\"\napproval_policy = \"on-request\"\n"
        );
        assert_eq!(read(&backup), BROKEN_V2);
        assert_eq!(
            legacy,
            LegacySettings {
                model: Some("local-model".into()),
                base_url: Some(URL.into()),
                keyed: true
            }
        );
        // Nothing of ours is left, so a second pass has nothing to do.
        assert_eq!(repair_legacy_config(dir.path()).unwrap(), Repair::Clean);
    }

    #[test]
    fn repairs_the_first_release_shape() {
        let dir = tempfile::tempdir().unwrap();
        let config = seed(dir.path(), BASE_CONFIG, V1);
        let Repair::Repaired { legacy, .. } = repair_legacy_config(dir.path()).unwrap() else {
            panic!()
        };
        assert_eq!(read(&config), "approval_policy = \"never\"\n");
        assert_eq!(legacy.model.as_deref(), Some("qwen3"));
        assert!(!legacy.keyed);
    }

    #[test]
    fn a_file_of_only_our_blocks_becomes_empty() {
        let dir = tempfile::tempdir().unwrap();
        let fresh = "# >>> Atomic Chat (managed) >>>\nmodel = \"m\"\nmodel_provider = \"atomic\"\n\
# <<< Atomic Chat (managed) <<<\n\n# >>> Atomic Chat (managed) >>>\n[model_providers.atomic]\n\
name = \"Atomic Chat\"\nbase_url = \"http://h/v1\"\n# <<< Atomic Chat (managed) <<<\n";
        let config = seed(dir.path(), BASE_CONFIG, fresh);
        assert!(matches!(
            repair_legacy_config(dir.path()).unwrap(),
            Repair::Repaired { .. }
        ));
        assert_eq!(read(&config), "");
    }

    #[test]
    fn crlf_files_are_recognised() {
        let dir = tempfile::tempdir().unwrap();
        let config = seed(dir.path(), BASE_CONFIG, &BROKEN_V2.replace('\n', "\r\n"));
        assert!(matches!(
            repair_legacy_config(dir.path()).unwrap(),
            Repair::Repaired { .. }
        ));
        let repaired = read(&config);
        assert!(repaired.parse::<toml::Table>().is_ok());
        assert!(repaired.contains("original-model") && !repaired.contains("Atomic Chat"));
    }

    #[test]
    fn anything_it_cannot_vouch_for_is_left_byte_for_byte() {
        let b = ATOMIC_MANAGED_BEGIN;
        let e = ATOMIC_MANAGED_END;
        // Nested, stray end, never closed, marker inside a line.
        assert_conflict_unchanged(&format!("{b}\n{b}\nmodel = \"m\"\n{e}\n{e}\n"));
        assert_conflict_unchanged(&format!("x = 1\n{e}\n"));
        assert_conflict_unchanged(&format!("{b}\nmodel = \"m\"\n"));
        assert_conflict_unchanged(&format!("  {b}\nmodel = \"m\"\n{e}\n"));
        // A setting we never write, edited into our block.
        assert_conflict_unchanged(&format!(
            "{b}\nmodel = \"m\"\napproval_policy = \"never\"\n{e}\n"
        ));
        assert_conflict_unchanged(&format!(
            "{b}\n[model_providers.atomic]\nname = \"Mine\"\nbase_url = \"http://h\"\n{e}\n"
        ));
        assert_conflict_unchanged(&format!("{b}\nmodel_provider = \"openai\"\n{e}\n"));
        // Not TOML inside our block.
        assert_conflict_unchanged(&format!("{b}\nmodel = \n{e}\n"));
        // Our block is fine, but the user's own text is broken: not ours to fix.
        assert_conflict_unchanged(&format!("{b}\nmodel = \"m\"\n{e}\nthis is = not [toml\n"));
    }

    #[test]
    fn earlier_backups_are_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), BACKUP_FILE, "older backup");
        seed(dir.path(), BASE_CONFIG, BROKEN_V2);
        let Repair::Repaired { backup, .. } = repair_legacy_config(dir.path()).unwrap() else {
            panic!()
        };
        assert_eq!(backup, dir.path().join(format!("{BACKUP_FILE}-2")));
        assert_eq!(read(&dir.path().join(BACKUP_FILE)), "older backup");
    }

    #[cfg(unix)]
    #[test]
    fn the_repaired_file_and_its_backup_keep_its_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let config = seed(dir.path(), BASE_CONFIG, BROKEN_V2);
        fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).unwrap();
        let Repair::Repaired { backup, .. } = repair_legacy_config(dir.path()).unwrap() else {
            panic!()
        };
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&config), 0o600);
        assert_eq!(mode(&backup), 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_config_is_repaired_through_the_link() {
        let dir = tempfile::tempdir().unwrap();
        let dotfiles = tempfile::tempdir().unwrap();
        let real = seed(dotfiles.path(), "codex.toml", BROKEN_V2);
        let link = dir.path().join(BASE_CONFIG);
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let Repair::Repaired { backup, .. } = repair_legacy_config(dir.path()).unwrap() else {
            panic!()
        };
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            read(&real),
            "model = \"original-model\"\napproval_policy = \"on-request\"\n"
        );
        assert_eq!(read(&backup), BROKEN_V2);
        assert_eq!(files(dotfiles.path()), vec!["codex.toml"]);
    }

    #[test]
    fn configure_repairs_an_old_config_before_writing_the_profile() {
        let dir = tempfile::tempdir().unwrap();
        let config = seed(dir.path(), BASE_CONFIG, BROKEN_V2);
        configure_in(dir.path(), URL, MODEL, true, None).unwrap();
        assert!(read(&config).parse::<toml::Table>().is_ok());
        assert_eq!(read(&profile_path(dir.path())), GOLDEN);
    }

    #[test]
    fn configure_reports_a_conflict_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let broken = format!("{ATOMIC_MANAGED_BEGIN}\nmodel = \"m\"\n");
        seed(dir.path(), BASE_CONFIG, &broken);
        let err = configure_in(dir.path(), URL, MODEL, false, None).unwrap_err();
        assert!(
            err.contains("never closed") && err.contains("by hand"),
            "{err}"
        );
        assert_eq!(files(dir.path()), vec![BASE_CONFIG]);
    }

    #[test]
    fn disconnect_removes_our_profile_and_our_old_settings() {
        let dir = tempfile::tempdir().unwrap();
        let config = seed(dir.path(), BASE_CONFIG, BROKEN_V2);
        write_profile(dir.path(), URL, MODEL, false).unwrap();
        disconnect_in(dir.path()).unwrap();
        assert!(!profile_path(dir.path()).exists());
        assert!(!read(&config).contains("Atomic Chat"));
        // Nothing left to undo is not an error.
        disconnect_in(dir.path()).unwrap();
        disconnect_in(&dir.path().join("missing")).unwrap();
    }

    #[test]
    fn startup_migration_carries_the_old_settings_into_the_profile() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), BASE_CONFIG, BROKEN_V2);
        migrate_in(dir.path());
        assert_eq!(
            read(&profile_path(dir.path())),
            render_profile(URL, "local-model", true)
        );
        // A profile already in place is newer than the old settings.
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), BASE_CONFIG, BROKEN_V2);
        write_profile(dir.path(), "http://new/v1", "new", false).unwrap();
        migrate_in(dir.path());
        assert!(read(&profile_path(dir.path())).contains("http://new/v1"));
    }

    #[test]
    fn startup_migration_leaves_a_clean_config_alone() {
        let dir = tempfile::tempdir().unwrap();
        let config = seed(dir.path(), BASE_CONFIG, "model = \"mine\"\n");
        migrate_in(dir.path());
        assert_eq!(read(&config), "model = \"mine\"\n");
        assert_eq!(files(dir.path()), vec![BASE_CONFIG]);
    }

    #[test]
    fn codex_home_honours_the_environment() {
        let home = Path::new("/home/u");
        assert_eq!(codex_home(home, None), home.join(".codex"));
        assert_eq!(codex_home(home, Some("")), home.join(".codex"));
        assert_eq!(
            codex_home(home, Some("/opt/codex")),
            PathBuf::from("/opt/codex")
        );
        assert_eq!(codex_home(home, Some("~/cx")), home.join("cx"));
    }
}
