use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Runtime};

use super::{
    authoring::{
        create_custom_skill, export_skill_archive, import_custom_skill, update_custom_skill,
        CreateAgentSkillRequest, UpdateAgentSkillRequest,
    },
    global_skills_dir, load_registry, SkillListEntry,
};
use crate::core::app::commands::get_jan_data_folder_path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillDetail {
    #[serde(flatten)]
    pub entry: SkillListEntry,
    pub body: String,
    /// The files that come with the skill besides SKILL.md, for Preview.
    pub files: Vec<AgentSkillFile>,
}

/// The largest part of one bundled file shown in Preview.
pub(crate) const PREVIEW_FILE_MAX_BYTES: usize = 64 * 1024;
/// Preview lists at most this many bundled files.
const PREVIEW_MAX_FILES: usize = 50;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillFile {
    pub path: String,
    pub content: String,
    /// Cut to PREVIEW_FILE_MAX_BYTES because the file is larger.
    pub truncated: bool,
}

#[tauri::command]
pub async fn agent_list_skills<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<Vec<SkillListEntry>, String> {
    let data_folder = get_jan_data_folder_path(app_handle);
    Ok(load_registry(&data_folder)?.list_all())
}

#[tauri::command]
pub async fn agent_get_skill<R: Runtime>(
    app_handle: AppHandle<R>,
    name: String,
) -> Result<AgentSkillDetail, String> {
    let data_folder = get_jan_data_folder_path(app_handle);
    let registry = load_registry(&data_folder)?;
    let entry = registry
        .list_all()
        .into_iter()
        .find(|entry| entry.name == name)
        .ok_or_else(|| format!("Skill `{name}` was not found"))?;
    let record = registry.get(&name);
    let files = match record {
        Some(record) => collect_skill_files(&record.root)?,
        None => Vec::new(),
    };
    Ok(AgentSkillDetail {
        entry,
        body: record.map(|record| record.body.clone()).unwrap_or_default(),
        files,
    })
}

#[tauri::command]
pub async fn agent_set_skill_enabled<R: Runtime>(
    app_handle: AppHandle<R>,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    let data_folder = get_jan_data_folder_path(app_handle);
    let mut registry = load_registry(&data_folder)?;
    registry.set_enabled(&name, enabled)
}

/// The user reviewed this skill and chose Allow (Task 28, D36): record it as
/// reviewed exactly as it is now, and switch it on.
#[tauri::command]
pub async fn agent_approve_skill<R: Runtime>(
    app_handle: AppHandle<R>,
    name: String,
) -> Result<AgentSkillDetail, String> {
    let data_folder = get_jan_data_folder_path(app_handle.clone());
    let mut registry = load_registry(&data_folder)?;
    registry.approve(&name)?;
    registry.set_enabled(&name, true)?;
    agent_get_skill(app_handle, name).await
}

#[tauri::command]
pub async fn agent_create_skill<R: Runtime>(
    app_handle: AppHandle<R>,
    request: CreateAgentSkillRequest,
) -> Result<AgentSkillDetail, String> {
    let data_folder = get_jan_data_folder_path(app_handle.clone());
    let name = request.name.trim().to_string();
    tokio::task::spawn_blocking(move || create_custom_skill(&data_folder, request))
        .await
        .map_err(|error| format!("Agent skill creation task failed: {error}"))??;
    agent_get_skill(app_handle, name).await
}

#[tauri::command]
pub async fn agent_import_skill<R: Runtime>(
    app_handle: AppHandle<R>,
    source_path: String,
) -> Result<AgentSkillDetail, String> {
    let data_folder = get_jan_data_folder_path(app_handle.clone());
    let source = PathBuf::from(source_path);
    let name = tokio::task::spawn_blocking(move || import_custom_skill(&data_folder, &source))
        .await
        .map_err(|error| format!("Agent skill import task failed: {error}"))??;
    agent_get_skill(app_handle, name).await
}

#[tauri::command]
pub async fn agent_update_skill<R: Runtime>(
    app_handle: AppHandle<R>,
    request: UpdateAgentSkillRequest,
) -> Result<AgentSkillDetail, String> {
    let data_folder = get_jan_data_folder_path(app_handle.clone());
    let name = request.name.trim().to_string();
    let registry = load_registry(&data_folder)?;
    let record = registry
        .get(&name)
        .ok_or_else(|| format!("Skill `{name}` was not found or is invalid"))?;
    ensure_skill_can_be_edited(&name, record.reserved)?;
    let skill_dir = resolve_skill_directory(&data_folder, &name).await?;
    tokio::task::spawn_blocking(move || update_custom_skill(&skill_dir, request))
        .await
        .map_err(|error| format!("Agent skill update task failed: {error}"))??;
    agent_get_skill(app_handle, name).await
}

#[tauri::command]
pub async fn agent_export_skill<R: Runtime>(
    app_handle: AppHandle<R>,
    name: String,
    target_path: String,
) -> Result<(), String> {
    let data_folder = get_jan_data_folder_path(app_handle);
    let registry = load_registry(&data_folder)?;
    if registry.get(&name).is_none() {
        return Err(format!("Skill `{name}` was not found or is invalid"));
    }
    let skill_dir = resolve_skill_directory(&data_folder, &name).await?;
    let target = PathBuf::from(target_path);
    tokio::task::spawn_blocking(move || export_skill_archive(&skill_dir, &target))
        .await
        .map_err(|error| format!("Agent skill export task failed: {error}"))?
}

#[tauri::command]
pub async fn agent_delete_skill<R: Runtime>(
    app_handle: AppHandle<R>,
    name: String,
) -> Result<(), String> {
    let data_folder = get_jan_data_folder_path(app_handle);
    let registry = load_registry(&data_folder)?;
    let entry = registry
        .list_all()
        .into_iter()
        .find(|entry| entry.name == name)
        .ok_or_else(|| format!("Skill `{name}` was not found"))?;
    ensure_skill_can_be_deleted(&name, entry.reserved)?;
    if !is_direct_child_name(&name) {
        return Err("Skill deletion target must be a direct child name".into());
    }
    let root = global_skills_dir(&data_folder);
    let canonical_root = tokio::fs::canonicalize(&root)
        .await
        .map_err(|error| format!("Failed to resolve Agent skills directory: {error}"))?;
    let canonical_target = tokio::fs::canonicalize(root.join(&name))
        .await
        .map_err(|error| format!("Failed to resolve skill `{name}`: {error}"))?;
    if canonical_target.parent() != Some(canonical_root.as_path()) {
        return Err("Skill deletion target is not a direct child of the skills root".into());
    }
    tokio::fs::remove_dir_all(&canonical_target)
        .await
        .map_err(|error| format!("Failed to delete skill `{name}`: {error}"))
}

/// The files that come with a skill besides its SKILL.md, for the review
/// screen's Preview (Task 28, D36): relative paths with `/` separators in a
/// fixed order, contents as text, each cut to PREVIEW_FILE_MAX_BYTES. A symbolic
/// link is shown as a link and never followed, so Preview cannot read outside
/// the skill.
fn collect_skill_files(skill_root: &Path) -> Result<Vec<AgentSkillFile>, String> {
    let mut entries = Vec::new();
    collect_preview_entries(skill_root, skill_root, &mut entries)?;
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let mut files = Vec::new();
    for (relative, is_link) in entries
        .into_iter()
        .filter(|(relative, _)| relative != "SKILL.md")
        .take(PREVIEW_MAX_FILES)
    {
        let path = skill_root.join(&relative);
        if is_link {
            let target = std::fs::read_link(&path)
                .map_err(|error| format!("Failed to read link `{relative}`: {error}"))?;
            files.push(AgentSkillFile {
                path: relative,
                content: format!("(symbolic link to {})", target.display()),
                truncated: false,
            });
            continue;
        }
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("Failed to read skill file `{relative}`: {error}"))?;
        let truncated = bytes.len() > PREVIEW_FILE_MAX_BYTES;
        let shown = &bytes[..bytes.len().min(PREVIEW_FILE_MAX_BYTES)];
        files.push(AgentSkillFile {
            path: relative,
            content: String::from_utf8_lossy(shown).into_owned(),
            truncated,
        });
    }
    Ok(files)
}

fn collect_preview_entries(
    root: &Path,
    directory: &Path,
    entries: &mut Vec<(String, bool)>,
) -> Result<(), String> {
    let listing = std::fs::read_dir(directory)
        .map_err(|error| format!("Failed to scan skill directory: {error}"))?;
    for entry in listing {
        let entry = entry.map_err(|error| format!("Failed to scan skill directory: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect skill file: {error}"))?;
        let path = entry.path();
        if file_type.is_dir() {
            collect_preview_entries(root, &path, entries)?;
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|error| format!("Skill file is outside its folder: {error}"))?
            .components()
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        entries.push((relative, file_type.is_symlink()));
    }
    Ok(())
}

fn is_direct_child_name(name: &str) -> bool {
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

fn ensure_skill_can_be_deleted(name: &str, reserved: bool) -> Result<(), String> {
    if reserved {
        Err(format!("Bundled skill `{name}` cannot be deleted"))
    } else {
        Ok(())
    }
}

fn ensure_skill_can_be_edited(name: &str, reserved: bool) -> Result<(), String> {
    if reserved {
        Err(format!("Bundled skill `{name}` cannot be edited"))
    } else {
        Ok(())
    }
}

async fn resolve_skill_directory(data_folder: &Path, name: &str) -> Result<PathBuf, String> {
    if !is_direct_child_name(name) {
        return Err("Skill target must be a direct child name".into());
    }
    let root = global_skills_dir(data_folder);
    let canonical_root = tokio::fs::canonicalize(&root)
        .await
        .map_err(|error| format!("Failed to resolve Agent skills directory: {error}"))?;
    let canonical_target = tokio::fs::canonicalize(root.join(name))
        .await
        .map_err(|error| format!("Failed to resolve skill `{name}`: {error}"))?;
    if canonical_target.parent() != Some(canonical_root.as_path()) {
        return Err("Skill target is not a direct child of the skills root".into());
    }
    Ok(canonical_target)
}

#[tauri::command]
pub async fn agent_refresh_skills<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<Vec<SkillListEntry>, String> {
    agent_list_skills(app_handle).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_a_skills_own_files_for_preview_but_not_its_manifest() {
        let temp = tempfile::TempDir::new().unwrap();
        let root = temp.path();
        std::fs::write(
            root.join("SKILL.md"),
            "---
name: x
description: y
---
Body",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("scripts")).unwrap();
        std::fs::write(root.join("scripts").join("run.sh"), "echo hi").unwrap();
        std::fs::write(
            root.join("notes.txt"),
            "a".repeat(PREVIEW_FILE_MAX_BYTES + 10),
        )
        .unwrap();

        let files = collect_skill_files(root).unwrap();

        assert_eq!(
            files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["notes.txt", "scripts/run.sh"]
        );
        assert_eq!(files[1].content, "echo hi");
        assert!(!files[1].truncated);
        assert!(files[0].truncated);
        assert_eq!(files[0].content.len(), PREVIEW_FILE_MAX_BYTES);
    }

    #[test]
    fn refuses_to_delete_bundled_skills() {
        assert_eq!(
            ensure_skill_can_be_deleted("bundled-skill", true).unwrap_err(),
            "Bundled skill `bundled-skill` cannot be deleted"
        );
        assert!(ensure_skill_can_be_deleted("custom-skill", false).is_ok());
    }

    #[test]
    fn refuses_to_edit_bundled_skills() {
        assert_eq!(
            ensure_skill_can_be_edited("bundled-skill", true).unwrap_err(),
            "Bundled skill `bundled-skill` cannot be edited"
        );
        assert!(ensure_skill_can_be_edited("custom-skill", false).is_ok());
    }

    #[test]
    fn deletion_names_must_be_direct_children() {
        assert!(is_direct_child_name("custom-skill"));
        assert!(!is_direct_child_name("../custom-skill"));
        assert!(!is_direct_child_name("nested/custom-skill"));
    }
}
