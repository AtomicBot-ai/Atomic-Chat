use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Deserialize;

use super::{
    global_skills_dir,
    manifest::{is_valid_skill_name, parse_skill_file},
};

const MAX_INSTRUCTIONS_CHARS: usize = 100_000;
const MAX_IMPORTED_ENTRIES: usize = 512;
const MAX_IMPORTED_FILES: usize = 256;
const MAX_IMPORTED_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentSkillRequest {
    pub name: String,
    pub description: String,
    pub instructions: String,
}

pub fn create_custom_skill(
    data_folder: &Path,
    request: CreateAgentSkillRequest,
) -> Result<String, String> {
    let name = request.name.trim().to_string();
    if !is_valid_skill_name(&name) {
        return Err(
            "Skill name must be kebab-case (a-z, 0-9, '-'), 2-64 chars, not start/end with '-'"
                .into(),
        );
    }
    let instructions = request.instructions.trim();
    if instructions.is_empty() {
        return Err("Skill instructions must not be empty".into());
    }
    if instructions.chars().count() > MAX_INSTRUCTIONS_CHARS {
        return Err(format!(
            "Skill instructions must be at most {MAX_INSTRUCTIONS_CHARS} characters"
        ));
    }
    let description = request.description.trim();
    let skill_file = format!(
        "---\nname: {}\ndescription: {}\nversion: 0.0.0\n---\n{}\n",
        name,
        yaml_string(description)?,
        instructions
    );
    parse_skill_file(&skill_file)?;

    let destination = reserve_destination(data_folder, &name)?;
    let result = fs::write(destination.join("SKILL.md"), skill_file)
        .map_err(|error| format!("Failed to write skill `{name}`: {error}"));
    if result.is_err() {
        let _ = fs::remove_dir_all(&destination);
    }
    result.map(|_| name)
}

pub fn import_custom_skill(data_folder: &Path, source: &Path) -> Result<String, String> {
    let source = source
        .canonicalize()
        .map_err(|error| format!("Failed to resolve the selected skill folder: {error}"))?;
    if !source.is_dir() {
        return Err("The selected skill path must be a directory".into());
    }
    let manifest_path = source.join("SKILL.md");
    let metadata = fs::symlink_metadata(&manifest_path)
        .map_err(|_| "The selected folder must contain a SKILL.md file".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Imported SKILL.md must be a regular file, not a symbolic link".into());
    }
    let content = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Failed to read imported SKILL.md: {error}"))?;
    let parsed = parse_skill_file(&content)?;
    let name = parsed.manifest.name;
    let destination = reserve_destination(data_folder, &name)?;
    let destination_canonical = fs::canonicalize(&destination).map_err(|error| {
        let _ = fs::remove_dir_all(&destination);
        format!("Failed to resolve imported skill destination: {error}")
    })?;
    if destination_canonical.starts_with(&source) {
        let _ = fs::remove_dir_all(&destination);
        return Err("The Agent skills root cannot be imported as a skill".into());
    }
    let mut budget = ImportBudget::default();
    let result = copy_directory_contents(&source, &destination, &mut budget);
    if result.is_err() {
        let _ = fs::remove_dir_all(&destination);
    }
    result.map(|_| name)
}

fn yaml_string(value: &str) -> Result<String, String> {
    serde_yaml::to_string(value)
        .map(|serialized| serialized.trim().to_string())
        .map_err(|error| format!("Failed to serialize skill description: {error}"))
}

fn reserve_destination(data_folder: &Path, name: &str) -> Result<PathBuf, String> {
    let root = global_skills_dir(data_folder);
    fs::create_dir_all(&root)
        .map_err(|error| format!("Failed to create Agent skills directory: {error}"))?;
    let destination = root.join(name);
    fs::create_dir(&destination).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            format!("A skill named `{name}` already exists")
        } else {
            format!("Failed to create skill `{name}`: {error}")
        }
    })?;
    Ok(destination)
}

#[derive(Default)]
struct ImportBudget {
    entries: usize,
    files: usize,
    bytes: u64,
}

fn copy_directory_contents(
    source: &Path,
    destination: &Path,
    budget: &mut ImportBudget,
) -> Result<(), String> {
    let entries = fs::read_dir(source)
        .map_err(|error| format!("Failed to read imported skill folder: {error}"))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Failed to inspect imported skill entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect imported skill entry: {error}"))?;
        budget.entries += 1;
        if budget.entries > MAX_IMPORTED_ENTRIES {
            return Err(format!(
                "Imported skill exceeds the limit of {MAX_IMPORTED_ENTRIES} files and directories"
            ));
        }
        if file_type.is_symlink() {
            return Err(format!(
                "Imported skills must not contain symbolic links: {}",
                entry.path().display()
            ));
        }
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            fs::create_dir(&target)
                .map_err(|error| format!("Failed to create imported skill directory: {error}"))?;
            copy_directory_contents(&entry.path(), &target, budget)?;
        } else if file_type.is_file() {
            let size = entry
                .metadata()
                .map_err(|error| format!("Failed to inspect imported skill file: {error}"))?
                .len();
            budget.files += 1;
            budget.bytes = budget.bytes.saturating_add(size);
            if budget.files > MAX_IMPORTED_FILES || budget.bytes > MAX_IMPORTED_BYTES {
                return Err(format!(
                    "Imported skill exceeds the limit of {MAX_IMPORTED_FILES} files or {} MiB",
                    MAX_IMPORTED_BYTES / 1024 / 1024
                ));
            }
            fs::copy(entry.path(), target)
                .map_err(|error| format!("Failed to copy imported skill file: {error}"))?;
        } else {
            return Err(format!(
                "Imported skills may contain only regular files and directories: {}",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn creates_a_valid_custom_skill() {
        let temp = TempDir::new().unwrap();
        let name = create_custom_skill(
            temp.path(),
            CreateAgentSkillRequest {
                name: "weekly-report".into(),
                description: "Summarizes weekly progress: wins & blockers".into(),
                instructions: "Use three concise sections.".into(),
            },
        )
        .unwrap();

        assert_eq!(name, "weekly-report");
        let content =
            fs::read_to_string(global_skills_dir(temp.path()).join(name).join("SKILL.md")).unwrap();
        let parsed = parse_skill_file(&content).unwrap();
        assert_eq!(
            parsed.manifest.description,
            "Summarizes weekly progress: wins & blockers"
        );
        assert_eq!(parsed.body, "Use three concise sections.\n");
    }

    #[test]
    fn imports_supporting_files_and_rejects_collisions() {
        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        fs::create_dir_all(source.join("scripts")).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: imported-skill\ndescription: Imported\n---\nInstructions",
        )
        .unwrap();
        fs::write(source.join("scripts").join("run.sh"), "echo ok").unwrap();

        assert_eq!(
            import_custom_skill(temp.path(), &source).unwrap(),
            "imported-skill"
        );
        assert!(global_skills_dir(temp.path())
            .join("imported-skill/scripts/run.sh")
            .is_file());
        assert!(import_custom_skill(temp.path(), &source)
            .unwrap_err()
            .contains("already exists"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_inside_imported_skills() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let source = temp.path().join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("SKILL.md"),
            "---\nname: linked-skill\ndescription: Imported\n---\nInstructions",
        )
        .unwrap();
        fs::write(temp.path().join("outside.txt"), "secret").unwrap();
        symlink(
            temp.path().join("outside.txt"),
            source.join("reference.txt"),
        )
        .unwrap();

        assert!(import_custom_skill(temp.path(), &source)
            .unwrap_err()
            .contains("symbolic links"));
        assert!(!global_skills_dir(temp.path()).join("linked-skill").exists());
    }
}
