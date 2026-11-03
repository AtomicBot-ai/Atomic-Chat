//! Restorable edits to an agent's own JSON config.
//!
//! Connect overwrites a handful of keys in a file the user also edits (the
//! model an agent opens on, a gateway mode, an allow-list). Before writing, it
//! records what each of those keys held — and the value it put there — in a
//! sidecar `<config>.atomic-chat-backup.json` next to the file. Disconnect puts
//! a key back only while it still holds our value: a key the user changed after
//! Connect is theirs and stays as they set it.
//!
//! Mirrors `src/integrations/configure/json-key-backup.ts` in atomic-chat-core,
//! byte for byte: the CLI's writers record the same sidecar, so a connection
//! made from the terminal is undone by the app's Disconnect too.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

/// Appended to the config file's name to name its sidecar.
pub(crate) const BACKUP_SUFFIX: &str = ".atomic-chat-backup.json";

/// `<config>.atomic-chat-backup.json`.
pub(crate) fn backup_path(config: &Path) -> PathBuf {
    let mut name = config.as_os_str().to_owned();
    name.push(BACKUP_SUFFIX);
    PathBuf::from(name)
}

/// One key Connect changed: where it is, what it held before (`None`: it was
/// absent) and what Connect wrote (`None`: Connect removed it).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct KeyBackup {
    pub path: Vec<String>,
    pub before: Option<Value>,
    pub ours: Option<Value>,
}

/// Everything one sidecar holds. `seeded` is agent-specific: values Connect
/// added that are not a key of their own (Atomic Agent's `local-llama`
/// provider entry).
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Backup {
    pub keys: Vec<KeyBackup>,
    pub seeded: Vec<Value>,
}

pub(crate) fn path_of(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|p| p.to_string()).collect()
}

/// The value at `path`, when every step on the way is an object.
pub(crate) fn get<'a>(root: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter()
        .try_fold(root, |node, key| node.as_object()?.get(key))
}

/// Set `path` to `value`, creating (or replacing non-object) parents.
pub(crate) fn set(root: &mut Value, path: &[String], value: Value) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut node = root;
    for key in parents {
        if !node.is_object() {
            *node = Value::Object(Map::new());
        }
        node = node
            .as_object_mut()
            .unwrap()
            .entry(key.clone())
            .or_insert_with(|| Value::Object(Map::new()));
    }
    if !node.is_object() {
        *node = Value::Object(Map::new());
    }
    node.as_object_mut().unwrap().insert(last.clone(), value);
}

/// Remove `path`, then every parent object the removal left empty (never the
/// root itself).
pub(crate) fn remove(root: &mut Value, path: &[String]) {
    fn walk(node: &mut Value, path: &[String]) -> bool {
        let Some(obj) = node.as_object_mut() else {
            return false;
        };
        let Some((first, rest)) = path.split_first() else {
            return false;
        };
        if rest.is_empty() {
            obj.remove(first);
        } else {
            let Some(child) = obj.get_mut(first) else {
                return false;
            };
            if walk(child, rest) && child.as_object().is_some_and(Map::is_empty) {
                obj.remove(first);
            }
        }
        true
    }
    walk(root, path);
}

/// The backup of a Connect that turned `before` into `after`, for the keys at
/// `paths`. A key Connect left as it found it gets no entry. A key an earlier
/// Connect already recorded keeps that earlier `before` while it still held
/// the earlier `ours` — otherwise the user changed it in between, and what
/// they set is what Disconnect returns to. Earlier entries for keys this
/// Connect does not touch (the previous model's settings row) are carried
/// over, so Disconnect still finds them.
pub(crate) fn track(
    before: &Value,
    after: &Value,
    paths: &[Vec<String>],
    previous: &[KeyBackup],
) -> Vec<KeyBackup> {
    let mut out: Vec<KeyBackup> = Vec::new();
    for path in paths {
        let now = get(before, path).cloned();
        let ours = get(after, path).cloned();
        let earlier = previous.iter().find(|entry| &entry.path == path);
        let original = match earlier {
            Some(entry) if entry.ours == now => entry.before.clone(),
            _ => now,
        };
        if original != ours {
            out.push(KeyBackup {
                path: path.clone(),
                before: original,
                ours,
            });
        }
    }
    for entry in previous {
        if !paths.contains(&entry.path) {
            out.push(entry.clone());
        }
    }
    out
}

/// Put back every recorded key that still holds the value Connect wrote.
/// Returns whether anything changed.
pub(crate) fn restore(root: &mut Value, keys: &[KeyBackup]) -> bool {
    let mut changed = false;
    for entry in keys {
        if get(root, &entry.path).cloned() != entry.ours {
            continue;
        }
        match &entry.before {
            Some(value) => set(root, &entry.path, value.clone()),
            None => remove(root, &entry.path),
        }
        changed = true;
    }
    changed
}

fn key_to_json(entry: &KeyBackup) -> Value {
    let mut obj = Map::new();
    obj.insert(
        "path".to_string(),
        Value::Array(entry.path.iter().cloned().map(Value::String).collect()),
    );
    if let Some(before) = &entry.before {
        obj.insert("before".to_string(), before.clone());
    }
    if let Some(ours) = &entry.ours {
        obj.insert("ours".to_string(), ours.clone());
    }
    Value::Object(obj)
}

fn key_from_json(value: &Value) -> Option<KeyBackup> {
    let path = value
        .get("path")?
        .as_array()?
        .iter()
        .map(|p| p.as_str().map(str::to_string))
        .collect::<Option<Vec<_>>>()?;
    Some(KeyBackup {
        path,
        before: value.get("before").cloned(),
        ours: value.get("ours").cloned(),
    })
}

/// The sidecar's text: pretty JSON with sorted keys and a final newline, the
/// format every JSON writer here uses.
pub(crate) fn render(backup: &Backup) -> String {
    let mut obj = Map::new();
    obj.insert(
        "keys".to_string(),
        Value::Array(backup.keys.iter().map(key_to_json).collect()),
    );
    if !backup.seeded.is_empty() {
        obj.insert("seeded".to_string(), Value::Array(backup.seeded.clone()));
    }
    serde_json::to_string_pretty(&Value::Object(obj)).unwrap_or_default() + "\n"
}

/// Parse a sidecar; `None` for anything that is not one.
pub(crate) fn parse(text: &str) -> Option<Backup> {
    let root: Value = serde_json::from_str(text).ok()?;
    let keys = root
        .get("keys")?
        .as_array()?
        .iter()
        .map(key_from_json)
        .collect::<Option<Vec<_>>>()?;
    let seeded = root
        .get("seeded")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Some(Backup { keys, seeded })
}

/// The sidecar of `config`, when there is a readable one.
pub(crate) fn read(config: &Path) -> Option<Backup> {
    let text = std::fs::read_to_string(backup_path(config)).ok()?;
    let parsed = parse(&text);
    if parsed.is_none() {
        log::warn!("Ignoring an unreadable {}", backup_path(config).display());
    }
    parsed
}

/// Write the sidecar of `config` with the config's own permissions: it holds
/// the same values, keys included.
pub(crate) fn write_text(config: &Path, text: &str) -> Result<(), String> {
    let path = backup_path(config);
    std::fs::write(&path, text)
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    if let Ok(meta) = std::fs::metadata(config) {
        let _ = std::fs::set_permissions(&path, meta.permissions());
    }
    Ok(())
}

pub(crate) fn write(config: &Path, backup: &Backup) -> Result<(), String> {
    write_text(config, &render(backup))
}

/// Forget the sidecar of `config`; a missing one is fine.
pub(crate) fn discard(config: &Path) -> Result<(), String> {
    let path = backup_path(config);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to remove {}: {}", path.display(), e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(parts: &[&str]) -> Vec<String> {
        path_of(parts)
    }

    #[test]
    fn track_records_only_what_changed_and_keeps_the_first_original() {
        let before = json!({ "a": { "b": 1 }, "same": true });
        let after = json!({ "a": { "b": 2 }, "same": true, "new": "x" });
        let paths = [p(&["a", "b"]), p(&["same"]), p(&["new"])];
        let first = track(&before, &after, &paths, &[]);
        assert_eq!(
            first,
            vec![
                KeyBackup {
                    path: p(&["a", "b"]),
                    before: Some(json!(1)),
                    ours: Some(json!(2)),
                },
                KeyBackup {
                    path: p(&["new"]),
                    before: None,
                    ours: Some(json!("x")),
                },
            ]
        );

        // A second Connect over our own values keeps the user's originals.
        let again = json!({ "a": { "b": 3 }, "same": true, "new": "x" });
        let second = track(&after, &again, &paths, &first);
        assert_eq!(second[0].before, Some(json!(1)));
        assert_eq!(second[0].ours, Some(json!(3)));
        assert_eq!(second[1].before, None);

        // A value the user changed in between becomes the new original.
        let edited = json!({ "a": { "b": 9 }, "same": true, "new": "x" });
        let third = track(&edited, &again, &paths, &second);
        assert_eq!(third[0].before, Some(json!(9)));
    }

    #[test]
    fn track_carries_over_keys_this_connect_did_not_touch() {
        let earlier = vec![KeyBackup {
            path: p(&["models", "old"]),
            before: None,
            ours: Some(json!({})),
        }];
        let root = json!({ "models": { "old": {} } });
        let out = track(&root, &root, &[p(&["models", "new"])], &earlier);
        assert_eq!(out, earlier);
    }

    #[test]
    fn restore_puts_back_only_keys_that_still_hold_our_value() {
        let keys = vec![
            KeyBackup {
                path: p(&["a", "b"]),
                before: Some(json!(1)),
                ours: Some(json!(2)),
            },
            KeyBackup {
                path: p(&["user", "changed"]),
                before: Some(json!("theirs")),
                ours: Some(json!("ours")),
            },
            KeyBackup {
                path: p(&["created", "deep", "leaf"]),
                before: None,
                ours: Some(json!(true)),
            },
        ];
        let mut root = json!({
            "a": { "b": 2 },
            "user": { "changed": "later" },
            "created": { "deep": { "leaf": true } },
            "kept": {}
        });
        assert!(restore(&mut root, &keys));
        assert_eq!(
            root,
            json!({ "a": { "b": 1 }, "user": { "changed": "later" }, "kept": {} })
        );
    }

    #[test]
    fn the_sidecar_round_trips_with_sorted_keys() {
        let backup = Backup {
            keys: vec![KeyBackup {
                path: p(&["x"]),
                before: None,
                ours: Some(json!("y")),
            }],
            seeded: vec![],
        };
        let text = render(&backup);
        assert_eq!(
            text,
            "{\n  \"keys\": [\n    {\n      \"ours\": \"y\",\n      \"path\": [\n        \"x\"\n      ]\n    }\n  ]\n}\n"
        );
        assert_eq!(parse(&text), Some(backup));
        assert_eq!(parse("not json"), None);
    }

    #[test]
    fn the_sidecar_sits_next_to_its_config() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("openclaw.json");
        std::fs::write(&config, "{}").unwrap();
        assert_eq!(read(&config), None);
        write(&config, &Backup::default()).unwrap();
        assert!(dir
            .path()
            .join("openclaw.json.atomic-chat-backup.json")
            .exists());
        assert_eq!(read(&config), Some(Backup::default()));
        discard(&config).unwrap();
        discard(&config).unwrap();
        assert_eq!(read(&config), None);
    }
}
