use std::{collections::VecDeque, time::SystemTime};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::registry::SkillRegistry;
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
    pub fn restore(entries: &[LoadedSkillState], registry: &SkillRegistry) -> Self {
        let entries = entries
            .iter()
            .filter(|entry| {
                registry.get_enabled(&entry.name).is_some_and(|record| {
                    record.manifest.version == entry.version
                        && entry.body.chars().count() <= LOADED_SKILL_BODY_MAX_CHARS
                })
            })
            .take(LOADED_SKILLS_CAP)
            .cloned()
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
        let body = truncate_chars(
            &format!("{execution_contract}\n\n{}", record.body),
            LOADED_SKILL_BODY_MAX_CHARS,
        );
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
