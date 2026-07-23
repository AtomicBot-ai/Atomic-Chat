use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use super::manifest::parse_skill_file;

const REMOVED_STARTER_SKILLS: &[&str] = &["ddgr-web-search", "exa-web-search"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedStarterSkillsResult {
    pub installed: Vec<String>,
    pub removed: Vec<String>,
}

pub fn list_starter_skill_names(source_root: &Path) -> BTreeSet<String> {
    let Ok(entries) = fs::read_dir(source_root) else {
        return BTreeSet::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().join("SKILL.md").is_file())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect()
}

pub fn seed_starter_skills(
    source_root: &Path,
    destination_root: &Path,
) -> Result<SeedStarterSkillsResult, String> {
    fs::create_dir_all(destination_root)
        .map_err(|error| format!("Failed to create agent skills directory: {error}"))?;
    let mut removed = Vec::new();
    for name in REMOVED_STARTER_SKILLS {
        let destination = destination_root.join(name);
        if destination.exists() {
            fs::remove_dir_all(&destination)
                .map_err(|error| format!("Failed to prune starter skill `{name}`: {error}"))?;
            removed.push((*name).to_string());
        }
    }
    if !source_root.is_dir() {
        return Ok(SeedStarterSkillsResult {
            installed: Vec::new(),
            removed,
        });
    }
    let mut names = list_starter_skill_names(source_root)
        .into_iter()
        .collect::<Vec<_>>();
    names.sort();
    let mut installed = Vec::new();
    for name in names {
        let source = source_root.join(&name);
        let manifest_content = fs::read_to_string(source.join("SKILL.md"))
            .map_err(|error| format!("Failed to read bundled skill `{name}`: {error}"))?;
        let parsed = parse_skill_file(&manifest_content)
            .map_err(|error| format!("Invalid bundled skill `{name}`: {error}"))?;
        if parsed.manifest.name != name {
            return Err(format!(
                "Bundled skill `{name}` declares name `{}`",
                parsed.manifest.name
            ));
        }
        let destination = destination_root.join(&name);
        let temporary = temporary_seed_path(destination_root, &name);
        if temporary.exists() {
            fs::remove_dir_all(&temporary).map_err(|error| {
                format!("Failed to clear temporary starter skill `{name}`: {error}")
            })?;
        }
        copy_tree(&source, &temporary)?;
        if destination.exists() {
            fs::remove_dir_all(&destination)
                .map_err(|error| format!("Failed to replace starter skill `{name}`: {error}"))?;
        }
        fs::rename(&temporary, &destination)
            .map_err(|error| format!("Failed to install starter skill `{name}`: {error}"))?;
        installed.push(name);
    }
    Ok(SeedStarterSkillsResult { installed, removed })
}

fn temporary_seed_path(root: &Path, name: &str) -> PathBuf {
    root.join(format!(".{name}.seed-tmp"))
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("Failed to create bundled skill directory: {error}"))?;
    let mut entries = fs::read_dir(source)
        .map_err(|error| format!("Failed to scan bundled skill directory: {error}"))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect bundled skill entry: {error}"))?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target)
                .map_err(|error| format!("Failed to copy bundled skill file: {error}"))?;
        } else {
            return Err(format!(
                "Bundled skill entry `{}` must not be a symlink",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::core::agent::skills::SkillPlatform;
    use tempfile::TempDir;

    fn write_skill(root: &Path, name: &str, body: &str) {
        let directory = root.join(name);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: Test\n---\n{body}"),
        )
        .unwrap();
    }

    #[test]
    fn replaces_reserved_skills_and_preserves_custom_directories() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        write_skill(&source, "starter", "new");
        write_skill(&destination, "starter", "old");
        write_skill(&destination, "custom", "custom");
        let result = seed_starter_skills(&source, &destination).unwrap();
        assert_eq!(result.installed, ["starter"]);
        assert!(fs::read_to_string(destination.join("starter/SKILL.md"))
            .unwrap()
            .ends_with("new"));
        assert!(destination.join("custom/SKILL.md").exists());
    }

    #[test]
    fn prunes_explicit_tombstones() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        fs::create_dir_all(&source).unwrap();
        write_skill(&destination, REMOVED_STARTER_SKILLS[0], "old");
        let result = seed_starter_skills(&source, &destination).unwrap();
        assert_eq!(result.removed, [REMOVED_STARTER_SKILLS[0]]);
        assert!(!destination.join(REMOVED_STARTER_SKILLS[0]).exists());
    }

    #[test]
    fn bundled_skills_follow_explicit_platform_metadata_policy() {
        use SkillPlatform::{Darwin, Linux, Win32};

        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/agent-skills");
        let expected = BTreeMap::from([
            ("apple-calendar", vec![Darwin]),
            ("apple-notes", vec![Darwin]),
            ("apple-reminders", vec![Darwin]),
            ("audio-transcribe", vec![Darwin, Linux]),
            ("currency", vec![Darwin, Linux, Win32]),
            ("docker", vec![Darwin, Linux, Win32]),
            ("ffmpeg", vec![Darwin, Linux, Win32]),
            ("github", vec![Darwin, Linux, Win32]),
            ("gog-workspace", vec![Darwin, Linux]),
            ("imagemagick", vec![Darwin, Linux, Win32]),
            ("notion", vec![Darwin, Linux]),
            ("obsidian", vec![Darwin, Linux]),
            ("pandoc", vec![Darwin, Linux, Win32]),
            ("pdf", vec![Darwin, Linux, Win32]),
            ("skill-creator", vec![Darwin, Linux, Win32]),
            ("wttr-weather", vec![Darwin, Linux, Win32]),
            ("xlsx", vec![Darwin, Linux]),
        ]);

        let names = list_starter_skill_names(&source);
        assert_eq!(
            names.len(),
            expected.len(),
            "every bundled skill must have an explicit reviewed platform policy"
        );

        for name in names {
            let skill_root = source.join(&name);
            let content = fs::read_to_string(skill_root.join("SKILL.md")).unwrap();
            let parsed = parse_skill_file(&content).unwrap();
            assert_eq!(
                parsed.manifest.platforms.as_ref(),
                expected.get(name.as_str()),
                "platform metadata changed for bundled skill `{name}`; review and update the policy explicitly"
            );
            for script in &parsed.manifest.requires_scripts {
                assert!(
                    skill_root.join("scripts").join(script).is_file(),
                    "bundled skill `{name}` declares missing script `{script}`"
                );
            }
        }
    }
}
