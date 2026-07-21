use std::path::{Component, Path};

use serde::Serialize;
use tauri::{AppHandle, Runtime};

use super::{global_skills_dir, load_registry, SkillListEntry};
use crate::core::app::commands::get_jan_data_folder_path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillDetail {
    #[serde(flatten)]
    pub entry: SkillListEntry,
    pub body: String,
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
    Ok(AgentSkillDetail {
        entry,
        body: registry
            .get(&name)
            .map(|record| record.body.clone())
            .unwrap_or_default(),
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
    fn refuses_to_delete_bundled_skills() {
        assert_eq!(
            ensure_skill_can_be_deleted("bundled-skill", true).unwrap_err(),
            "Bundled skill `bundled-skill` cannot be deleted"
        );
        assert!(ensure_skill_can_be_deleted("custom-skill", false).is_ok());
    }

    #[test]
    fn deletion_names_must_be_direct_children() {
        assert!(is_direct_child_name("custom-skill"));
        assert!(!is_direct_child_name("../custom-skill"));
        assert!(!is_direct_child_name("nested/custom-skill"));
    }
}
