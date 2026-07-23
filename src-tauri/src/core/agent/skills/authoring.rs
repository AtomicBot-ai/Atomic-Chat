use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
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
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentSkillRequest {
    pub name: String,
    pub description: String,
    pub instructions: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAgentSkillRequest {
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

pub fn update_custom_skill(
    skill_dir: &Path,
    request: UpdateAgentSkillRequest,
) -> Result<(), String> {
    let manifest_path = skill_dir.join("SKILL.md");
    let content = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("Failed to read skill `{}`: {error}", request.name))?;
    let parsed = parse_skill_file(&content)?;
    if parsed.manifest.name != request.name {
        return Err("Skill update name does not match its manifest".into());
    }
    let description = request.description.trim();
    let instructions = request.instructions.trim();
    if description.is_empty() {
        return Err("Skill description must not be empty".into());
    }
    if instructions.is_empty() {
        return Err("Skill instructions must not be empty".into());
    }
    if instructions.chars().count() > MAX_INSTRUCTIONS_CHARS {
        return Err(format!(
            "Skill instructions must be at most {MAX_INSTRUCTIONS_CHARS} characters"
        ));
    }

    let mut manifest = parsed.manifest;
    manifest.description = description.to_string();
    let yaml = serde_yaml::to_string(&manifest)
        .map_err(|error| format!("Failed to serialize skill manifest: {error}"))?;
    let updated = format!("---\n{}---\n{}\n", yaml, instructions);
    parse_skill_file(&updated)?;
    atomic_write(&manifest_path, updated.as_bytes())
}

pub fn export_skill_archive(skill_dir: &Path, target: &Path) -> Result<(), String> {
    if !target
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("skill"))
    {
        return Err("Exported skills must use the .skill extension".into());
    }
    let metadata = fs::symlink_metadata(skill_dir)
        .map_err(|error| format!("Failed to inspect skill for export: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Skill export source must be a regular directory".into());
    }
    let mut files = Vec::new();
    collect_export_files(skill_dir, skill_dir, &mut files)?;
    if !files.iter().any(|path| path == Path::new("SKILL.md")) {
        return Err("Skill export source must contain SKILL.md".into());
    }

    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if !parent.is_dir() {
        return Err("Skill export destination directory does not exist".into());
    }
    let temp = temporary_sibling_path(target);
    let result = write_skill_archive(skill_dir, &temp, &files);
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    if target.exists() {
        fs::remove_file(target)
            .map_err(|error| format!("Failed to replace existing skill archive: {error}"))?;
    }
    fs::rename(&temp, target).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("Failed to finalize skill archive: {error}")
    })
}

pub fn import_custom_skill(data_folder: &Path, source: &Path) -> Result<String, String> {
    let source = source
        .canonicalize()
        .map_err(|error| format!("Failed to resolve the selected skill: {error}"))?;
    if source.is_dir() {
        return import_skill_directory(data_folder, &source);
    }
    if !source.is_file() {
        return Err("The selected skill must be a regular file or directory".into());
    }
    let extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();
    if extension.eq_ignore_ascii_case("md") {
        return import_skill_markdown(data_folder, &source);
    }
    if extension.eq_ignore_ascii_case("zip") || extension.eq_ignore_ascii_case("skill") {
        return import_skill_archive(data_folder, &source);
    }
    Err("Upload a .md, .zip, or .skill file".into())
}

fn import_skill_directory(data_folder: &Path, source: &Path) -> Result<String, String> {
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

fn import_skill_markdown(data_folder: &Path, source: &Path) -> Result<String, String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("Failed to inspect uploaded skill file: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Uploaded skill markdown must be a regular file".into());
    }
    if metadata.len() > MAX_IMPORTED_BYTES {
        return Err(format!(
            "Uploaded skill exceeds the limit of {} MiB",
            MAX_IMPORTED_BYTES / 1024 / 1024
        ));
    }
    let content = fs::read_to_string(source)
        .map_err(|error| format!("Failed to read uploaded skill markdown: {error}"))?;
    let parsed = parse_skill_file(&content)?;
    let name = parsed.manifest.name;
    let destination = reserve_destination(data_folder, &name)?;
    let result = fs::write(destination.join("SKILL.md"), content)
        .map_err(|error| format!("Failed to import skill `{name}`: {error}"));
    if result.is_err() {
        let _ = fs::remove_dir_all(&destination);
    }
    result.map(|_| name)
}

fn import_skill_archive(data_folder: &Path, source: &Path) -> Result<String, String> {
    let file =
        File::open(source).map_err(|error| format!("Failed to open uploaded skill: {error}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("Uploaded skill is not a valid ZIP archive: {error}"))?;
    let manifest_index = find_archive_manifest(&mut archive)?;
    let (name, root) = {
        let mut manifest = archive
            .by_index(manifest_index)
            .map_err(|error| format!("Failed to open archived SKILL.md: {error}"))?;
        if manifest.size() > MAX_IMPORTED_BYTES {
            return Err(format!(
                "Uploaded skill exceeds the limit of {} MiB",
                MAX_IMPORTED_BYTES / 1024 / 1024
            ));
        }
        let manifest_path = manifest
            .enclosed_name()
            .ok_or_else(|| "Archive contains an unsafe SKILL.md path".to_string())?
            .to_owned();
        let root = manifest_path.parent().unwrap_or(Path::new("")).to_owned();
        let mut content = String::new();
        manifest
            .take(MAX_IMPORTED_BYTES + 1)
            .read_to_string(&mut content)
            .map_err(|error| format!("Failed to read archived SKILL.md: {error}"))?;
        let parsed = parse_skill_file(&content)?;
        (parsed.manifest.name, root)
    };

    let destination = reserve_destination(data_folder, &name)?;
    let result = extract_skill_archive(&mut archive, &root, &destination);
    if result.is_err() {
        let _ = fs::remove_dir_all(&destination);
    }
    result.map(|_| name)
}

fn find_archive_manifest(archive: &mut zip::ZipArchive<File>) -> Result<usize, String> {
    let mut manifest_index = None;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to inspect uploaded skill archive: {error}"))?;
        let path = entry
            .enclosed_name()
            .ok_or_else(|| "Archive contains an unsafe path".to_string())?;
        if !entry.is_dir() && path.file_name().is_some_and(|name| name == "SKILL.md") {
            if manifest_index.replace(index).is_some() {
                return Err("Archive must contain exactly one SKILL.md file".into());
            }
        }
    }
    manifest_index.ok_or_else(|| "Archive must include a SKILL.md file".into())
}

fn extract_skill_archive(
    archive: &mut zip::ZipArchive<File>,
    root: &Path,
    destination: &Path,
) -> Result<(), String> {
    let mut budget = ImportBudget::default();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to inspect uploaded skill archive: {error}"))?;
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| "Archive contains an unsafe path".to_string())?
            .to_owned();
        let Ok(relative) = enclosed.strip_prefix(root) else {
            continue;
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!(
                "Uploaded skills must not contain symbolic links: {}",
                enclosed.display()
            ));
        }
        budget.entries += 1;
        if budget.entries > MAX_IMPORTED_ENTRIES {
            return Err(format!(
                "Imported skill exceeds the limit of {MAX_IMPORTED_ENTRIES} files and directories"
            ));
        }
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)
                .map_err(|error| format!("Failed to create imported skill directory: {error}"))?;
            continue;
        }
        budget.files += 1;
        budget.bytes = budget.bytes.saturating_add(entry.size());
        if budget.files > MAX_IMPORTED_FILES || budget.bytes > MAX_IMPORTED_BYTES {
            return Err(format!(
                "Imported skill exceeds the limit of {MAX_IMPORTED_FILES} files or {} MiB",
                MAX_IMPORTED_BYTES / 1024 / 1024
            ));
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create imported skill directory: {error}"))?;
        }
        let mut target = File::create(&output)
            .map_err(|error| format!("Failed to create imported skill file: {error}"))?;
        std::io::copy(&mut entry, &mut target)
            .map_err(|error| format!("Failed to extract imported skill file: {error}"))?;
        target
            .flush()
            .map_err(|error| format!("Failed to flush imported skill file: {error}"))?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&output, fs::Permissions::from_mode(mode & 0o777))
                .map_err(|error| format!("Failed to set imported skill permissions: {error}"))?;
        }
    }
    Ok(())
}

fn yaml_string(value: &str) -> Result<String, String> {
    serde_yaml::to_string(value)
        .map(|serialized| serialized.trim().to_string())
        .map_err(|error| format!("Failed to serialize skill description: {error}"))
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let temp = temporary_sibling_path(path);
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|error| format!("Failed to create temporary skill file: {error}"))?;
        file.write_all(content)
            .map_err(|error| format!("Failed to write temporary skill file: {error}"))?;
        file.flush()
            .map_err(|error| format!("Failed to flush temporary skill file: {error}"))?;
        fs::rename(&temp, path)
            .map_err(|error| format!("Failed to replace skill manifest: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn temporary_sibling_path(path: &Path) -> PathBuf {
    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("skill");
    path.with_file_name(format!(
        ".{file_name}.tmp-{}-{sequence}",
        std::process::id()
    ))
}

fn collect_export_files(
    root: &Path,
    current: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let mut entries = fs::read_dir(current)
        .map_err(|error| format!("Failed to read skill for export: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to inspect skill for export: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect skill export entry: {error}"))?;
        if file_type.is_symlink() {
            return Err(format!(
                "Exported skills must not contain symbolic links: {}",
                entry.path().display()
            ));
        }
        if file_type.is_dir() {
            collect_export_files(root, &entry.path(), files)?;
        } else if file_type.is_file() {
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|_| "Skill export entry escaped its root".to_string())?
                .to_owned();
            files.push(relative);
        } else {
            return Err(format!(
                "Exported skills may contain only regular files and directories: {}",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

fn write_skill_archive(root: &Path, target: &Path, files: &[PathBuf]) -> Result<(), String> {
    let file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target)
        .map_err(|error| format!("Failed to create skill archive: {error}"))?;
    let mut archive = zip::ZipWriter::new(file);
    let options =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for relative in files {
        let archive_path = relative
            .iter()
            .map(|component| component.to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        archive
            .start_file(archive_path, options)
            .map_err(|error| format!("Failed to add file to skill archive: {error}"))?;
        let mut source = File::open(root.join(relative))
            .map_err(|error| format!("Failed to open skill export file: {error}"))?;
        std::io::copy(&mut source, &mut archive)
            .map_err(|error| format!("Failed to write skill archive: {error}"))?;
    }
    archive
        .finish()
        .map_err(|error| format!("Failed to finish skill archive: {error}"))?;
    Ok(())
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
    use crate::core::agent::skills::SkillPlatform;
    use tempfile::TempDir;
    use zip::write::FileOptions;

    #[cfg(windows)]
    fn create_junction(link: &Path, target: &Path) {
        let output = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("run mklink /J");
        assert!(
            output.status.success(),
            "mklink /J failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(windows)]
    fn create_file_symlink_if_allowed(link: &Path, target: &Path) -> bool {
        match std::os::windows::fs::symlink_file(target, link) {
            Ok(()) => true,
            Err(error)
                if error.kind() == std::io::ErrorKind::PermissionDenied
                    || error.raw_os_error() == Some(1314) =>
            {
                false
            }
            Err(error) => panic!("create file symlink: {error}"),
        }
    }

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
    fn updates_only_editable_skill_fields() {
        let temp = TempDir::new().unwrap();
        let skill_dir = global_skills_dir(temp.path()).join("editable-skill");
        fs::create_dir_all(skill_dir.join("scripts")).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: editable-skill\ndescription: Before\nversion: 1.2.3\nrequires_tools:\n  - os.fs.read\nrequires_scripts:\n  - scripts/run.sh\ndangerous: true\nplatforms:\n  - darwin\n---\nOld instructions",
        )
        .unwrap();
        fs::write(skill_dir.join("scripts/run.sh"), "echo preserved").unwrap();

        update_custom_skill(
            &skill_dir,
            UpdateAgentSkillRequest {
                name: "editable-skill".into(),
                description: "After".into(),
                instructions: "New instructions".into(),
            },
        )
        .unwrap();

        let parsed =
            parse_skill_file(&fs::read_to_string(skill_dir.join("SKILL.md")).unwrap()).unwrap();
        assert_eq!(parsed.manifest.name, "editable-skill");
        assert_eq!(parsed.manifest.description, "After");
        assert_eq!(parsed.manifest.version, "1.2.3");
        assert_eq!(parsed.manifest.requires_tools, ["os.fs.read"]);
        assert_eq!(parsed.manifest.requires_scripts, ["scripts/run.sh"]);
        assert!(parsed.manifest.dangerous);
        assert_eq!(parsed.manifest.platforms, Some(vec![SkillPlatform::Darwin]));
        assert_eq!(parsed.body, "New instructions\n");
        assert_eq!(
            fs::read_to_string(skill_dir.join("scripts/run.sh")).unwrap(),
            "echo preserved"
        );
    }

    #[test]
    fn exports_and_reimports_skill_archives_with_supporting_files() {
        let temp = TempDir::new().unwrap();
        let source_data = temp.path().join("source-data");
        let skill_dir = global_skills_dir(&source_data).join("portable-skill");
        fs::create_dir_all(skill_dir.join("references")).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: portable-skill\ndescription: Portable\nversion: 2.0.0\nrequires_tools:\n  - os.fs.read\ndangerous: false\n---\nPortable instructions",
        )
        .unwrap();
        fs::write(skill_dir.join("references/guide.md"), "Keep this file").unwrap();
        let archive = temp.path().join("portable-skill.skill");

        export_skill_archive(&skill_dir, &archive).unwrap();
        let imported_data = temp.path().join("imported-data");
        assert_eq!(
            import_custom_skill(&imported_data, &archive).unwrap(),
            "portable-skill"
        );
        let imported_dir = global_skills_dir(&imported_data).join("portable-skill");
        let parsed =
            parse_skill_file(&fs::read_to_string(imported_dir.join("SKILL.md")).unwrap()).unwrap();
        assert_eq!(parsed.manifest.version, "2.0.0");
        assert_eq!(parsed.manifest.requires_tools, ["os.fs.read"]);
        assert_eq!(
            fs::read_to_string(imported_dir.join("references/guide.md")).unwrap(),
            "Keep this file"
        );
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

    #[test]
    fn imports_markdown_and_archived_skills() {
        let temp = TempDir::new().unwrap();
        let markdown = temp.path().join("standalone.md");
        fs::write(
            &markdown,
            "---\nname: standalone-skill\ndescription: Standalone\n---\nInstructions",
        )
        .unwrap();

        assert_eq!(
            import_custom_skill(temp.path(), &markdown).unwrap(),
            "standalone-skill"
        );
        assert!(global_skills_dir(temp.path())
            .join("standalone-skill/SKILL.md")
            .is_file());

        let archive_path = temp.path().join("archived.skill");
        let archive_file = File::create(&archive_path).unwrap();
        let mut archive = zip::ZipWriter::new(archive_file);
        archive
            .start_file("archived/SKILL.md", FileOptions::default())
            .unwrap();
        archive
            .write_all(b"---\nname: archived-skill\ndescription: Archived\n---\nInstructions")
            .unwrap();
        archive
            .start_file("archived/scripts/run.sh", FileOptions::default())
            .unwrap();
        archive.write_all(b"echo ok").unwrap();
        archive.finish().unwrap();

        assert_eq!(
            import_custom_skill(temp.path(), &archive_path).unwrap(),
            "archived-skill"
        );
        assert!(global_skills_dir(temp.path())
            .join("archived-skill/scripts/run.sh")
            .is_file());
    }

    #[test]
    fn rejects_archives_with_ambiguous_manifests() {
        let temp = TempDir::new().unwrap();
        let archive_path = temp.path().join("ambiguous.zip");
        let archive_file = File::create(&archive_path).unwrap();
        let mut archive = zip::ZipWriter::new(archive_file);
        for path in ["one/SKILL.md", "two/SKILL.md"] {
            archive.start_file(path, FileOptions::default()).unwrap();
            archive
                .write_all(b"---\nname: duplicate\ndescription: Duplicate\n---\nBody")
                .unwrap();
        }
        archive.finish().unwrap();

        assert!(import_custom_skill(temp.path(), &archive_path)
            .unwrap_err()
            .contains("exactly one"));
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

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_inside_exported_skills() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let skill_dir = temp.path().join("linked-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: linked-skill\ndescription: Linked\n---\nInstructions",
        )
        .unwrap();
        fs::write(temp.path().join("outside.txt"), "secret").unwrap();
        symlink(
            temp.path().join("outside.txt"),
            skill_dir.join("outside.txt"),
        )
        .unwrap();

        let target = temp.path().join("linked-skill.skill");
        assert!(export_skill_archive(&skill_dir, &target)
            .unwrap_err()
            .contains("symbolic links"));
        assert!(!target.exists());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_windows_reparse_points_inside_imported_and_exported_skills() {
        let temp = TempDir::new().unwrap();
        let outside_dir = temp.path().join("outside-directory");
        fs::create_dir_all(&outside_dir).unwrap();
        fs::write(outside_dir.join("secret.txt"), "secret").unwrap();

        let import_source = temp.path().join("junction-import-source");
        fs::create_dir_all(&import_source).unwrap();
        fs::write(
            import_source.join("SKILL.md"),
            "---\nname: junction-import\ndescription: Imported\n---\nInstructions",
        )
        .unwrap();
        let import_junction = import_source.join("references");
        create_junction(&import_junction, &outside_dir);
        assert!(import_custom_skill(temp.path(), &import_source)
            .unwrap_err()
            .contains("symbolic links"));
        assert!(!global_skills_dir(temp.path())
            .join("junction-import")
            .exists());
        fs::remove_dir(&import_junction).unwrap();

        let export_source = temp.path().join("junction-export-source");
        fs::create_dir_all(&export_source).unwrap();
        fs::write(
            export_source.join("SKILL.md"),
            "---\nname: junction-export\ndescription: Exported\n---\nInstructions",
        )
        .unwrap();
        let export_junction = export_source.join("references");
        create_junction(&export_junction, &outside_dir);
        let export_target = temp.path().join("junction-export.skill");
        assert!(export_skill_archive(&export_source, &export_target)
            .unwrap_err()
            .contains("symbolic links"));
        assert!(!export_target.exists());
        fs::remove_dir(&export_junction).unwrap();

        let outside_file = temp.path().join("outside.txt");
        fs::write(&outside_file, "secret").unwrap();
        let symlink_source = temp.path().join("symlink-import-source");
        fs::create_dir_all(&symlink_source).unwrap();
        fs::write(
            symlink_source.join("SKILL.md"),
            "---\nname: symlink-import\ndescription: Imported\n---\nInstructions",
        )
        .unwrap();
        let file_link = symlink_source.join("reference.txt");
        if create_file_symlink_if_allowed(&file_link, &outside_file) {
            assert!(import_custom_skill(temp.path(), &symlink_source)
                .unwrap_err()
                .contains("symbolic links"));
            assert!(!global_skills_dir(temp.path())
                .join("symlink-import")
                .exists());
            let symlink_export = temp.path().join("symlink-export.skill");
            assert!(export_skill_archive(&symlink_source, &symlink_export)
                .unwrap_err()
                .contains("symbolic links"));
            assert!(!symlink_export.exists());
            fs::remove_file(&file_link).unwrap();
        }
    }
}
