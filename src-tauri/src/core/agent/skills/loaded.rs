use std::{collections::VecDeque, time::SystemTime};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::registry::{SkillRecord, SkillRegistry};
use crate::core::agent::types::ToolOutcome;

pub const LOADED_SKILLS_CAP: usize = 6;
pub const LOADED_SKILL_BODY_MAX_CHARS: usize = 16_000;
pub const LOADED_SKILLS_PROMPT_MAX_CHARS: usize = 32_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LoadedSkillState {
    pub name: String,
    pub version: String,
    pub body: String,
    pub loaded_at: u64,
}

#[derive(Default)]
pub struct LoadedSkills {
    entries: Mutex<VecDeque<LoadedSkillState>>,
}

impl LoadedSkills {
    /// Rebuild the loaded set for a new turn from the session's persisted
    /// entries. The persisted body is only a record of what was loaded: the
    /// body the model sees is read from the registry again, so an edit to
    /// `SKILL.md` between turns reaches the model on the next message whether
    /// or not `version` was bumped. A skill that is gone, disabled, or no
    /// longer compatible drops out of the set.
    pub fn restore(entries: &[LoadedSkillState], registry: &SkillRegistry) -> Self {
        let entries = entries
            .iter()
            .filter_map(|entry| {
                let record = registry.get_enabled(&entry.name)?;
                Some(LoadedSkillState {
                    name: record.manifest.name.clone(),
                    version: record.manifest.version.clone(),
                    body: loaded_body(record),
                    loaded_at: entry.loaded_at,
                })
            })
            .take(LOADED_SKILLS_CAP)
            .collect();
        Self {
            entries: Mutex::new(entries),
        }
    }

    pub async fn view(&self, name: &str, registry: &SkillRegistry) -> ToolOutcome {
        let Some(record) = registry.get_enabled(name) else {
            return ToolOutcome::error(format!(
                "Skill `{name}` is missing, disabled, incompatible, or unavailable"
            ));
        };
        let body = loaded_body(record);
        let entry = LoadedSkillState {
            name: record.manifest.name.clone(),
            version: record.manifest.version.clone(),
            body: body.clone(),
            loaded_at: SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        };
        let mut entries = self.entries.lock().await;
        let previous = entries.iter().position(|loaded| loaded.name == name);
        if let Some(index) = previous {
            entries.remove(index);
        }
        entries.push_back(entry);
        while entries.len() > LOADED_SKILLS_CAP {
            entries.pop_front();
        }
        drop(entries);
        let state = if previous.is_some() {
            "already loaded; refreshed LRU position"
        } else {
            "loaded"
        };
        ToolOutcome::ok(format!(
            "{state}: # skill: {} (v{})\n{}",
            record.manifest.name, record.manifest.version, body
        ))
    }

    pub async fn snapshot(&self) -> Vec<LoadedSkillState> {
        self.entries.lock().await.iter().cloned().collect()
    }
}

/// The text a loaded skill contributes to the prompt: the runtime execution
/// contract derived from its manifest, then the `SKILL.md` body, bounded.
fn loaded_body(record: &SkillRecord) -> String {
    let execution_contract = if record.manifest.requires_scripts.is_empty() {
        "## Runtime execution contract\n\
         This skill declares no bundled scripts. Never call `skill.run_script` for it. \
         Use its declared tools directly; external CLI commands use `os.shell.run` with \
         the executable in `cmd` and command-line tokens in the separate `args` array."
            .to_string()
    } else {
        format!(
            "## Runtime execution contract\n\
             `skill.run_script.script` must be exactly one of these bundled filenames: {}. \
             Put command-line arguments in the separate `args` array; never put a command \
             line in `script`.",
            record.manifest.requires_scripts.join(", ")
        )
    };
    truncate_chars(
        &format!("{execution_contract}\n\n{}", record.body),
        LOADED_SKILL_BODY_MAX_CHARS,
    )
}

pub fn render_loaded_skills(entries: &[LoadedSkillState]) -> Option<String> {
    let mut rendered = String::new();
    for entry in entries.iter().take(LOADED_SKILLS_CAP) {
        let body = truncate_chars(&entry.body, LOADED_SKILL_BODY_MAX_CHARS);
        let value = format!("# skill: {} (v{})\n{}", entry.name, entry.version, body);
        let separator = if rendered.is_empty() { 0 } else { 2 };
        if rendered.chars().count() + separator + value.chars().count()
            > LOADED_SKILLS_PROMPT_MAX_CHARS
        {
            if !rendered.is_empty() {
                rendered.push_str("\n\n[truncated]");
            }
            break;
        }
        if !rendered.is_empty() {
            rendered.push_str("\n\n");
        }
        rendered.push_str(&value);
    }
    (!rendered.is_empty()).then_some(rendered)
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut result = value
        .chars()
        .take(max_chars.saturating_sub(12))
        .collect::<String>();
    result.push_str("[truncated]");
    result
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeSet, fs};

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn loaded_skill_prompt_is_bounded() {
        let entries = vec![LoadedSkillState {
            name: "test-skill".into(),
            version: "1.0.0".into(),
            body: "x".repeat(LOADED_SKILL_BODY_MAX_CHARS + 100),
            loaded_at: 1,
        }];
        let rendered = render_loaded_skills(&entries).unwrap();
        assert!(rendered.chars().count() <= LOADED_SKILLS_PROMPT_MAX_CHARS);
        assert!(rendered.ends_with("[truncated]"));
    }

    fn write_skill(root: &std::path::Path, name: &str, version: &str, body: &str) {
        let skill_root = root.join(name);
        fs::create_dir_all(&skill_root).unwrap();
        fs::write(
            skill_root.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: Test\nversion: {version}\n---\n{body}"),
        )
        .unwrap();
    }

    fn load_registry(root: &std::path::Path) -> SkillRegistry {
        SkillRegistry::load(root.to_path_buf(), &BTreeSet::new(), &BTreeSet::new()).unwrap()
    }

    #[tokio::test]
    async fn a_restored_skill_follows_the_body_on_disk_not_the_persisted_copy() {
        let temp = TempDir::new().unwrap();
        let skills = temp.path().join("skills");
        write_skill(&skills, "notes", "1.0.0", "Old instructions.");
        let loaded = LoadedSkills::default();
        loaded.view("notes", &load_registry(&skills)).await;
        let persisted = loaded.snapshot().await;
        assert!(persisted[0].body.contains("Old instructions."));

        // The user edits SKILL.md without touching `version` (the documented
        // "edits take effect on your next message" path), then sends again.
        write_skill(&skills, "notes", "1.0.0", "New instructions.");
        let restored = LoadedSkills::restore(&persisted, &load_registry(&skills));

        let rendered = render_loaded_skills(&restored.snapshot().await).unwrap();
        assert!(rendered.contains("New instructions."), "{rendered}");
        assert!(!rendered.contains("Old instructions."), "{rendered}");
    }

    #[tokio::test]
    async fn a_version_bump_refreshes_a_loaded_skill_instead_of_evicting_it() {
        let temp = TempDir::new().unwrap();
        let skills = temp.path().join("skills");
        write_skill(&skills, "notes", "1.0.0", "First edition.");
        let loaded = LoadedSkills::default();
        loaded.view("notes", &load_registry(&skills)).await;
        let persisted = loaded.snapshot().await;

        write_skill(&skills, "notes", "2.0.0", "Second edition.");
        let restored = LoadedSkills::restore(&persisted, &load_registry(&skills));

        let entries = restored.snapshot().await;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].loaded_at, persisted[0].loaded_at);
        let rendered = render_loaded_skills(&entries).unwrap();
        assert!(rendered.contains("# skill: notes (v2.0.0)"), "{rendered}");
        assert!(rendered.contains("Second edition."), "{rendered}");
    }

    #[tokio::test]
    async fn a_restored_skill_is_dropped_when_it_left_the_registry() {
        let temp = TempDir::new().unwrap();
        let skills = temp.path().join("skills");
        write_skill(&skills, "notes", "1.0.0", "Instructions.");
        let loaded = LoadedSkills::default();
        loaded.view("notes", &load_registry(&skills)).await;
        let persisted = loaded.snapshot().await;

        fs::remove_dir_all(skills.join("notes")).unwrap();
        let restored = LoadedSkills::restore(&persisted, &load_registry(&skills));

        assert!(restored.snapshot().await.is_empty());
    }

    #[tokio::test]
    async fn loaded_skill_includes_the_manifest_derived_execution_contract() {
        let temp = TempDir::new().unwrap();
        let skill_root = temp.path().join("skills").join("cli-skill");
        fs::create_dir_all(&skill_root).unwrap();
        fs::write(
            skill_root.join("SKILL.md"),
            "---\nname: cli-skill\ndescription: Test\nrequires_tools: [os.shell.run]\n---\nRun `memo notes`.",
        )
        .unwrap();
        let available_tools = BTreeSet::from(["os.shell.run".to_string()]);
        let registry = SkillRegistry::load(
            temp.path().join("skills"),
            &BTreeSet::new(),
            &available_tools,
        )
        .unwrap();
        let loaded = LoadedSkills::default();

        loaded.view("cli-skill", &registry).await;

        let rendered = render_loaded_skills(&loaded.snapshot().await).unwrap();
        assert!(rendered.contains("This skill declares no bundled scripts"));
        assert!(rendered.contains("Never call `skill.run_script`"));
        assert!(rendered.contains("the separate `args` array"));
    }
}
