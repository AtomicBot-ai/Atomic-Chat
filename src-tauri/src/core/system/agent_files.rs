//! File plumbing the agent writers that restore on Disconnect share: strict
//! JSON in and out, atomic replacement, and the backup sidecar.
//!
//! A sidecar `<config file>.atomic-chat-backup.json` sits next to the config
//! an agent writer edits. It records what the keys Atomic Chat overwrites
//! held before the first Connect (`previous`) and what Atomic Chat wrote
//! (`written`), so Disconnect can put the user's values back — and only while
//! the file still holds ours: a key the user changed after Connect is theirs.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;

/// `None` only when the file does not exist: a file we cannot read is never
/// taken for an empty one.
pub(crate) fn read_text(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) if e.kind() == ErrorKind::InvalidData => Err(format!(
            "{} is not valid UTF-8. Fix or remove the file and try again.",
            path.display()
        )),
        Err(e) => Err(format!("Could not read {}: {e}", path.display())),
    }
}

/// A JSON object file: `None` when it does not exist, `{}` when it is blank.
/// Anything that is not a JSON object is refused, never replaced.
pub(crate) fn read_json_object(
    path: &Path,
) -> Result<Option<serde_json::Map<String, Value>>, String> {
    let Some(text) = read_text(path)? else {
        return Ok(None);
    };
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    if text.trim().is_empty() {
        return Ok(Some(serde_json::Map::new()));
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Ok(Some(map)),
        Ok(_) => Err(format!(
            "{} is not a JSON object. Fix or remove the file and try again.",
            path.display()
        )),
        Err(e) => Err(format!(
            "Could not parse {}: {e}. Fix or remove the file and try again.",
            path.display()
        )),
    }
}

/// Write beside the target and rename over it, so a crash leaves either the
/// old file or the new one. A symlink (dotfile managers link config files) is
/// written through rather than replaced. `owner_only` makes the result 0600
/// on unix, for files that hold a key.
pub(crate) fn write_atomically(
    path: &Path,
    contents: &str,
    owner_only: bool,
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
    let permissions = fs::metadata(path).map(|m| m.permissions()).ok();
    let written = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        if let Some(permissions) = &permissions {
            fs::set_permissions(&tmp, permissions.clone())?;
        }
        #[cfg(unix)]
        if owner_only {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
        }
        fs::rename(&tmp, path)
    })();
    let _ = owner_only;
    written.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Could not write {}: {e}", path.display())
    })
}

/// Pretty JSON with the newline every writer here appends.
pub(crate) fn write_json(path: &Path, value: &Value, owner_only: bool) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    write_atomically(path, &(text + "\n"), owner_only)
}

pub(crate) fn sidecar_path(config: &Path) -> PathBuf {
    let mut name = config
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".atomic-chat-backup.json");
    config.with_file_name(name)
}

/// The sidecar of `config`, when there is one. One we cannot parse is treated
/// as absent: it only ever narrows what Disconnect restores.
pub(crate) fn read_sidecar(config: &Path) -> Option<serde_json::Map<String, Value>> {
    read_json_object(&sidecar_path(config)).ok().flatten()
}

/// Owner-only: the previous values can include another provider's key.
pub(crate) fn write_sidecar(config: &Path, backup: &Value) -> Result<(), String> {
    write_json(&sidecar_path(config), backup, true)
}

pub(crate) fn remove_sidecar(config: &Path) -> Result<(), String> {
    let path = sidecar_path(config);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not delete {}: {e}", path.display())),
    }
}

/// `value` as a JSON optional: absent becomes `null`.
pub(crate) fn or_null(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

/// Put `previous` (as recorded by [`or_null`]) back under `key`: `null` means
/// the key was absent, so it is removed.
pub(crate) fn restore_key(map: &mut serde_json::Map<String, Value>, key: &str, previous: &Value) {
    if previous.is_null() {
        map.remove(key);
    } else {
        map.insert(key.to_string(), previous.clone());
    }
}

/// The output cap written beside a known window of `context` tokens: a
/// quarter of the window, and never more than 8192.
pub(crate) fn output_cap(context: u32) -> u32 {
    (context / 4).min(8192)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_cap_is_a_quarter_up_to_8k() {
        assert_eq!(output_cap(16384), 4096);
        assert_eq!(output_cap(32768), 8192);
        assert_eq!(output_cap(262144), 8192);
        assert_eq!(output_cap(1000), 250);
    }

    #[test]
    fn json_objects_are_read_strictly() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        assert_eq!(read_json_object(&path).unwrap(), None);
        fs::write(&path, "  \n").unwrap();
        assert!(read_json_object(&path).unwrap().unwrap().is_empty());
        fs::write(&path, "\u{feff}{\"a\": 1}").unwrap();
        assert_eq!(read_json_object(&path).unwrap().unwrap()["a"], 1);
        fs::write(&path, "[1]").unwrap();
        assert!(read_json_object(&path)
            .unwrap_err()
            .contains("not a JSON object"));
        fs::write(&path, "{ // no\n}").unwrap();
        assert!(read_json_object(&path)
            .unwrap_err()
            .contains("Could not parse"));
    }

    #[test]
    fn sidecar_sits_next_to_the_config() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("settings.json");
        assert_eq!(
            sidecar_path(&config),
            dir.path().join("settings.json.atomic-chat-backup.json")
        );
        assert!(read_sidecar(&config).is_none());
        write_sidecar(&config, &serde_json::json!({"previous": {"model": null}})).unwrap();
        assert_eq!(
            read_sidecar(&config).unwrap()["previous"]["model"],
            Value::Null
        );
        remove_sidecar(&config).unwrap();
        remove_sidecar(&config).unwrap();
        assert!(!sidecar_path(&config).exists());
    }

    #[cfg(unix)]
    #[test]
    fn owner_only_files_are_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("k.json");
        write_json(&path, &serde_json::json!({}), true).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn restore_key_removes_what_was_absent() {
        let mut map = serde_json::Map::new();
        map.insert("a".into(), Value::from(1));
        restore_key(&mut map, "a", &Value::Null);
        assert!(map.is_empty());
        restore_key(&mut map, "b", &Value::from("x"));
        assert_eq!(map["b"], "x");
    }
}
