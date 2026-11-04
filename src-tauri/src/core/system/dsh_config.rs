//! DeepSeek Harness (`dsh`) 0.2+: our route and the default model, written
//! into the `web` profile's patch layer.
//!
//! dsh 0.2 dropped the live `$DSH_HOME/settings.yaml`: its settings now live in
//! the active profile's `cordis.patch.yml`, a YAML list of entry overrides
//! (`- id: llm-pi-ai` / `config: …`), and a leftover `settings.yaml` is merged
//! into that profile once and renamed `settings.yaml.imported`. `dsh web`, the
//! command the Launch page runs, boots the `web` profile, so that is the file
//! written here: the `atomic` route under the `llm-pi-ai` row's `providers`, and
//! the `agent-default-model` row set to it, so new sessions open on the local
//! model instead of DeepSeek's.
//!
//! The file is the user's (dsh's Settings page edits it, keeping comments and
//! `!!js` expressions), so only our two rows are re-serialized; every other row,
//! comment and blank line is kept byte for byte. A file whose rows cannot be
//! told apart that way is rewritten whole only when nothing would be lost but
//! comments, and refused when it holds `!!js` expressions.
//!
//! The default model the user had is kept in the backup sidecar and restored
//! on Disconnect, unless they chose another one meanwhile.
//!
//! Twin of `src/integrations/configure/dsh.ts` in atomic-chat-core.

use std::path::{Path, PathBuf};

use serde_json::json;
use serde_yaml::{Mapping, Value};

use super::agent_files::{
    read_sidecar, read_text, remove_sidecar, write_atomically, write_sidecar,
};

/// The profile `dsh web` boots.
pub(crate) const PROFILE: &str = "web";
const PATCH_FILE: &str = "cordis.patch.yml";
const ROUTES_ID: &str = "llm-pi-ai";
const ROUTES_NAME: &str = "@deepseek-ai/dsh-llm-pi-ai";
const DEFAULT_ID: &str = "agent-default-model";
const DEFAULT_NAME: &str = "@deepseek-ai/dsh-agent-default-model";

pub(crate) fn profile_patch_path(dsh_home: &Path) -> PathBuf {
    dsh_home.join("profiles").join(PROFILE).join(PATCH_FILE)
}

fn ykey(s: &str) -> Value {
    Value::String(s.to_string())
}

/// What `agent-default-model` is set to: our route and the model.
pub(crate) fn default_selection(route_id: &str, model: &str) -> Value {
    let mut m = Mapping::new();
    m.insert(ykey("provider"), ykey(route_id));
    m.insert(ykey("model"), ykey(model));
    Value::Mapping(m)
}

/// One top-level row of the patch list.
struct Row {
    /// Its own lines: the `- ` line and what is indented under it. `None` for
    /// a row this edit created.
    text: Option<String>,
    /// Comment and blank lines after it, before the next row.
    trailer: String,
    value: Mapping,
    touched: bool,
}

struct PatchDoc {
    /// Text before the first row, minus the empty `[]` a new profile starts with.
    head: String,
    rows: Vec<Row>,
    /// The text could not be split into rows; it is rewritten whole.
    whole: bool,
}

/// A YAML tag such as `!!js`: serde_yaml drops tags, so text carrying one must
/// never be re-serialized.
fn has_tag(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim_start();
        if line.starts_with('#') {
            return false;
        }
        line.split(|c: char| c.is_whitespace() || matches!(c, '[' | '{' | ','))
            .any(|token| token.starts_with('!'))
    })
}

fn is_row_start(line: &str) -> bool {
    line == "-" || line.starts_with("- ") || line.starts_with("-\n") || line.starts_with("-\r")
}

fn is_gap(line: &str) -> bool {
    let t = line.trim();
    t.is_empty() || line.starts_with('#')
}

fn parse_doc(text: &str, path: &Path) -> Result<PatchDoc, String> {
    let whole: Value = serde_yaml::from_str(text).map_err(|e| {
        format!(
            "Could not parse {}: {e}. Fix or remove the file and try again.",
            path.display()
        )
    })?;
    let items = match whole {
        Value::Null => Vec::new(),
        Value::Sequence(items) => items,
        _ => {
            return Err(format!(
                "{} is not a YAML list of patches. Fix or remove it and try again.",
                path.display()
            ))
        }
    };
    let mappings = || -> Result<Vec<Mapping>, String> {
        items
            .iter()
            .map(|item| {
                item.as_mapping().cloned().ok_or_else(|| {
                    format!(
                        "{} has a patch that is not a mapping. Fix or remove it and try again.",
                        path.display()
                    )
                })
            })
            .collect()
    };
    let rewrite_whole = || -> Result<PatchDoc, String> {
        if has_tag(text) {
            return Err(format!(
                "{} uses `!!js` expressions in a layout Atomic Chat cannot edit without losing them. \
                 Add the Atomic Chat provider in DeepSeek Harness's Settings → Models instead.",
                path.display()
            ));
        }
        let rows = mappings()?
            .into_iter()
            .map(|value| Row {
                text: None,
                trailer: String::new(),
                value,
                touched: true,
            })
            .collect();
        Ok(PatchDoc {
            head: String::new(),
            rows,
            whole: true,
        })
    };

    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let starts: Vec<usize> = (0..lines.len())
        .filter(|&i| is_row_start(lines[i]))
        .collect();
    let first = starts.first().copied().unwrap_or(lines.len());
    let mut head = String::new();
    for line in &lines[..first] {
        let t = line.trim();
        if t == "[]" && items.is_empty() {
            continue;
        }
        if !is_gap(line) && t != "---" {
            // A flow list, or something before the first row.
            return rewrite_whole();
        }
        head.push_str(line);
    }
    if starts.len() != items.len() {
        return rewrite_whole();
    }
    let mut rows = Vec::with_capacity(starts.len());
    for (n, &start) in starts.iter().enumerate() {
        let end = starts.get(n + 1).copied().unwrap_or(lines.len());
        let mut body_end = end;
        while body_end > start + 1 && is_gap(lines[body_end - 1]) {
            body_end -= 1;
        }
        let row_text: String = lines[start..body_end].concat();
        let parsed = serde_yaml::from_str::<Value>(&row_text).ok();
        let Some(Value::Sequence(mut one)) = parsed else {
            return rewrite_whole();
        };
        let (Some(Value::Mapping(value)), true) = (one.pop(), one.is_empty()) else {
            return rewrite_whole();
        };
        rows.push(Row {
            text: Some(row_text),
            trailer: lines[body_end..end].concat(),
            value,
            touched: false,
        });
    }
    Ok(PatchDoc {
        head,
        rows,
        whole: false,
    })
}

impl PatchDoc {
    /// The last override of entry `id`, as dsh's own editor picks it: no
    /// `insert`, and no `name` or the entry's own.
    fn find(&self, id: &str, name: &str) -> Option<usize> {
        self.rows.iter().rposition(|row| {
            let v = &row.value;
            v.get("id").and_then(Value::as_str) == Some(id)
                && v.get("insert").is_none()
                && v.get("name").map_or(true, |n| n.as_str() == Some(name))
        })
    }

    /// The row to edit; refused when its text holds a tag we would drop.
    fn edit(&mut self, index: usize, path: &Path) -> Result<&mut Mapping, String> {
        let row = &mut self.rows[index];
        if row.text.as_deref().is_some_and(has_tag) {
            return Err(format!(
                "The `{}` patch in {} uses `!!js` expressions Atomic Chat cannot keep. \
                 Edit it in DeepSeek Harness's Settings instead.",
                row.value.get("id").and_then(Value::as_str).unwrap_or("?"),
                path.display()
            ));
        }
        row.touched = true;
        Ok(&mut row.value)
    }

    fn push(&mut self, value: Mapping) {
        self.rows.push(Row {
            text: None,
            trailer: String::new(),
            value,
            touched: true,
        });
    }

    fn render(&self) -> Result<String, String> {
        let row_yaml = |value: &Mapping| {
            serde_yaml::to_string(&Value::Sequence(vec![Value::Mapping(value.clone())]))
                .map_err(|e| e.to_string())
        };
        if self.whole {
            let all = Value::Sequence(
                self.rows
                    .iter()
                    .map(|r| Value::Mapping(r.value.clone()))
                    .collect(),
            );
            return serde_yaml::to_string(&all).map_err(|e| e.to_string());
        }
        let mut out = self.head.clone();
        for row in &self.rows {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            match (&row.text, row.touched) {
                (Some(text), false) => out.push_str(text),
                _ => out.push_str(&row_yaml(&row.value)?),
            }
            out.push_str(&row.trailer);
        }
        if self.rows.is_empty() {
            out.push_str("[]\n");
        }
        Ok(out)
    }
}

/// `parent[key]` as a mapping, created when absent or empty; anything else is
/// the user's and refused.
fn child<'a>(parent: &'a mut Mapping, key: &str, label: &str) -> Result<&'a mut Mapping, String> {
    if parent.get(key).map_or(true, Value::is_null) {
        parent.insert(ykey(key), Value::Mapping(Mapping::new()));
    }
    parent
        .get_mut(key)
        .and_then(Value::as_mapping_mut)
        .ok_or_else(|| {
            format!(
                "`{label}` in the dsh profile is not a mapping. Fix or remove it and try again."
            )
        })
}

fn new_row(id: &str, name: &str, config: Value) -> Mapping {
    let mut row = Mapping::new();
    row.insert(ykey("id"), ykey(id));
    row.insert(ykey("name"), ykey(name));
    row.insert(ykey("config"), config);
    row
}

/// A row left holding only `id`/`name` overrides nothing.
fn is_bare(row: &Mapping) -> bool {
    row.keys()
        .all(|k| matches!(k.as_str(), Some("id") | Some("name")))
}

fn read_doc(path: &Path) -> Result<Option<PatchDoc>, String> {
    match read_text(path)? {
        Some(text) => parse_doc(&text, path).map(Some),
        None => Ok(None),
    }
}

/// Write our route and select it. `route` is the complete route node.
pub(crate) fn configure_profile(
    dsh_home: &Path,
    route_id: &str,
    route: Value,
    model: &str,
) -> Result<PathBuf, String> {
    let path = profile_patch_path(dsh_home);
    let mut doc = read_doc(&path)?.unwrap_or(PatchDoc {
        head: String::new(),
        rows: Vec::new(),
        whole: false,
    });

    let mut providers_entry = Mapping::new();
    providers_entry.insert(ykey(route_id), route.clone());
    match doc.find(ROUTES_ID, ROUTES_NAME) {
        Some(i) => {
            let row = doc.edit(i, &path)?;
            let config = child(row, "config", ROUTES_ID)?;
            let providers = child(config, "providers", &format!("{ROUTES_ID}.providers"))?;
            // Wholesale: a merge could keep a stale `apiKeyEnv` from a keyed run.
            providers.insert(ykey(route_id), route);
        }
        None => {
            let mut config = Mapping::new();
            config.insert(ykey("providers"), Value::Mapping(providers_entry));
            doc.push(new_row(ROUTES_ID, ROUTES_NAME, Value::Mapping(config)));
        }
    }

    let ours = default_selection(route_id, model);
    let current = doc
        .find(DEFAULT_ID, DEFAULT_NAME)
        .and_then(|i| doc.rows[i].value.get("config").cloned());
    match doc.find(DEFAULT_ID, DEFAULT_NAME) {
        Some(i) => {
            doc.edit(i, &path)?.insert(ykey("config"), ours.clone());
        }
        None => doc.push(new_row(DEFAULT_ID, DEFAULT_NAME, ours.clone())),
    }

    // The default from before the first Connect, kept while ours is in place.
    let as_json = |v: &Option<Value>| -> serde_json::Value {
        v.as_ref()
            .and_then(|v| serde_json::to_value(v).ok())
            .unwrap_or(serde_json::Value::Null)
    };
    let current_json = as_json(&current);
    let sidecar = read_sidecar(&path);
    let previous = match &sidecar {
        Some(backup)
            if backup.get("written").and_then(|w| w.get("defaultModel")) == Some(&current_json)
                && !current_json.is_null() =>
        {
            backup
                .get("previous")
                .and_then(|p| p.get("defaultModel"))
                .cloned()
                .unwrap_or(serde_json::Value::Null)
        }
        _ => current_json,
    };

    // Owner-only, as dsh writes it.
    write_atomically(&path, &doc.render()?, true)?;
    write_sidecar(
        &path,
        &json!({
            "previous": { "defaultModel": previous },
            "written": { "defaultModel": as_json(&Some(ours)) },
        }),
    )?;
    Ok(path)
}

/// Whether the profile has our route (Launch page detection).
pub(crate) fn profile_has_route(dsh_home: &Path, route_id: &str) -> bool {
    let Ok(Some(doc)) = read_doc(&profile_patch_path(dsh_home)) else {
        return false;
    };
    doc.find(ROUTES_ID, ROUTES_NAME).is_some_and(|i| {
        doc.rows[i]
            .value
            .get("config")
            .and_then(|c| c.get("providers"))
            .and_then(|p| p.get(route_id))
            .is_some_and(Value::is_mapping)
    })
}

fn selects_route(config: Option<&Value>, route_id: &str) -> bool {
    config
        .and_then(|c| c.get("provider"))
        .and_then(Value::as_str)
        == Some(route_id)
}

/// Remove our route and, while it is still ours, the default; the default the
/// user had before comes back.
pub(crate) fn disconnect_profile(dsh_home: &Path, route_id: &str) -> Result<(), String> {
    let path = profile_patch_path(dsh_home);
    let sidecar = read_sidecar(&path);
    let Some(mut doc) = read_doc(&path)? else {
        return remove_sidecar(&path);
    };
    let mut changed = false;

    if let Some(i) = doc.find(ROUTES_ID, ROUTES_NAME) {
        let has_ours = doc.rows[i]
            .value
            .get("config")
            .and_then(|c| c.get("providers"))
            .and_then(Value::as_mapping)
            .is_some_and(|p| p.contains_key(route_id));
        if has_ours {
            let row = doc.edit(i, &path)?;
            if let Some(config) = row.get_mut("config").and_then(Value::as_mapping_mut) {
                if let Some(providers) = config.get_mut("providers").and_then(Value::as_mapping_mut)
                {
                    providers.remove(route_id);
                    if providers.is_empty() {
                        config.remove("providers");
                    }
                }
                if config.is_empty() {
                    row.remove("config");
                }
            }
            if is_bare(row) {
                doc.rows.remove(i);
            }
            changed = true;
        }
    }

    if let Some(i) = doc.find(DEFAULT_ID, DEFAULT_NAME) {
        if selects_route(doc.rows[i].value.get("config"), route_id) {
            let previous = sidecar
                .as_ref()
                .and_then(|b| b.get("previous"))
                .and_then(|p| p.get("defaultModel"))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let row = doc.edit(i, &path)?;
            if previous.is_null() {
                row.remove("config");
            } else {
                let value: Value = serde_yaml::to_value(&previous).map_err(|e| e.to_string())?;
                row.insert(ykey("config"), value);
            }
            if is_bare(row) {
                doc.rows.remove(i);
            }
            changed = true;
        }
    }

    if changed {
        write_atomically(&path, &doc.render()?, true)?;
    }
    remove_sidecar(&path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const TEMPLATE: &str =
        "# Your patch layer for this dsh profile, applied after every bundle layer:\n\
# a top-level YAML array of loader patch entries (id-targeted config\n\
# overrides, disables, and insert lists; `!!js` expressions allowed).\n\
[]\n";

    fn route(url: &str) -> Value {
        serde_yaml::from_str(&format!(
            "displayName: Atomic Chat\napi: openai-completions\nbaseURL: {url}\nmodels:\n- id: m\n"
        ))
        .unwrap()
    }

    fn seed(home: &Path, text: &str) -> PathBuf {
        let path = profile_patch_path(home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, text).unwrap();
        path
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn a_new_profile_template_keeps_its_comment() {
        let home = tempfile::tempdir().unwrap();
        let path = seed(home.path(), TEMPLATE);
        configure_profile(home.path(), "atomic", route("http://h/v1"), "m").unwrap();
        let text = read(&path);
        assert!(text.starts_with("# Your patch layer"), "{text}");
        assert!(!text.contains("[]"), "{text}");
        assert!(text.ends_with(
            "- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n  config:\n    provider: atomic\n    model: m\n"
        ), "{text}");
        assert!(profile_has_route(home.path(), "atomic"));
        let rows: Value = serde_yaml::from_str(&text).unwrap();
        assert_eq!(rows.as_sequence().unwrap().len(), 2);

        disconnect_profile(home.path(), "atomic").unwrap();
        assert_eq!(read(&path), TEMPLATE);
        assert!(!profile_has_route(home.path(), "atomic"));
    }

    #[test]
    fn a_missing_profile_patch_is_created() {
        let home = tempfile::tempdir().unwrap();
        let path = configure_profile(home.path(), "atomic", route("http://h/v1"), "m").unwrap();
        assert_eq!(path, home.path().join("profiles/web/cordis.patch.yml"));
        assert!(read(&path).starts_with("- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n"));
        disconnect_profile(home.path(), "atomic").unwrap();
        assert_eq!(read(&path), "[]\n");
    }

    #[test]
    fn other_rows_comments_and_js_expressions_stay_byte_for_byte() {
        let home = tempfile::tempdir().unwrap();
        let theirs = "# mine\n\
- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('elsewhere')\n\n\
# my gateway\n\
- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n    providers:\n      gw:\n        api: openai-completions\n        baseURL: https://gw.example/v1\n        models:\n          - id: x\n\
- id: agent-default-model\n  config:\n    provider: gw\n    model: x\n    reasoningEffort: high\n";
        let path = seed(home.path(), theirs);
        configure_profile(home.path(), "atomic", route("http://h/v1"), "m").unwrap();
        configure_profile(home.path(), "atomic", route("http://h2/v1"), "m").unwrap();
        let text = read(&path);
        assert!(text.starts_with(
            "# mine\n- id: session-persistence-jsonl\n  config:\n    root: !!js dshHomePath('elsewhere')\n\n# my gateway\n"
        ), "{text}");
        let rows: Value = serde_yaml::from_str(&text).unwrap();
        let providers = &rows[1]["config"]["providers"];
        assert_eq!(
            providers["gw"]["baseURL"].as_str(),
            Some("https://gw.example/v1")
        );
        assert_eq!(
            providers["atomic"]["baseURL"].as_str(),
            Some("http://h2/v1")
        );
        assert_eq!(rows[2]["config"]["provider"].as_str(), Some("atomic"));

        disconnect_profile(home.path(), "atomic").unwrap();
        let rows: Value = serde_yaml::from_str(&read(&path)).unwrap();
        assert!(rows[1]["config"]["providers"].get("atomic").is_none());
        assert_eq!(rows[2]["config"]["provider"].as_str(), Some("gw"));
        assert_eq!(rows[2]["config"]["reasoningEffort"].as_str(), Some("high"));
        assert!(read(&path).contains("root: !!js dshHomePath('elsewhere')"));
    }

    #[test]
    fn a_default_the_user_chose_after_connect_survives_disconnect() {
        let home = tempfile::tempdir().unwrap();
        let path = seed(home.path(), TEMPLATE);
        configure_profile(home.path(), "atomic", route("http://h/v1"), "m").unwrap();
        let text = read(&path).replace("provider: atomic", "provider: deepseek-official");
        fs::write(&path, text).unwrap();
        disconnect_profile(home.path(), "atomic").unwrap();
        let rows: Value = serde_yaml::from_str(&read(&path)).unwrap();
        assert_eq!(
            rows[0]["config"]["provider"].as_str(),
            Some("deepseek-official")
        );
    }

    #[test]
    fn a_js_expression_in_a_row_we_edit_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let theirs =
            "- id: llm-pi-ai\n  config:\n    providers:\n      gw:\n        baseURL: !!js env.GW\n";
        let path = seed(home.path(), theirs);
        let err = configure_profile(home.path(), "atomic", route("http://h/v1"), "m").unwrap_err();
        assert!(err.contains("!!js"), "{err}");
        assert_eq!(read(&path), theirs);
    }

    #[test]
    fn a_flow_list_is_rewritten_whole_without_tags() {
        let home = tempfile::tempdir().unwrap();
        let path = seed(home.path(), "[{id: web-app, config: {port: 4000}}]\n");
        configure_profile(home.path(), "atomic", route("http://h/v1"), "m").unwrap();
        let rows: Value = serde_yaml::from_str(&read(&path)).unwrap();
        assert_eq!(rows[0]["config"]["port"].as_u64(), Some(4000));
        assert_eq!(rows[1]["id"].as_str(), Some("llm-pi-ai"));
    }

    #[test]
    fn a_patch_that_is_not_a_list_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let path = seed(home.path(), "web-app: {}\n");
        let err = configure_profile(home.path(), "atomic", route("http://h/v1"), "m").unwrap_err();
        assert!(err.contains("not a YAML list"), "{err}");
        assert_eq!(read(&path), "web-app: {}\n");
    }

    #[test]
    fn disconnect_without_a_profile_is_a_no_op() {
        let home = tempfile::tempdir().unwrap();
        disconnect_profile(home.path(), "atomic").unwrap();
        assert!(!profile_patch_path(home.path()).exists());
    }

    #[test]
    fn tags_are_told_from_text() {
        assert!(has_tag("  root: !!js dshHomePath('x')\n"));
        assert!(has_tag("- !include x\n"));
        assert!(!has_tag("# `!!js` expressions allowed\nname: 'hi!'\n"));
    }
}
