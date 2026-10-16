mod authoring;
pub mod commands;
mod discovery;
pub mod loaded;
mod manifest;
pub mod organization;
mod registry;
mod seeding;

use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

pub use manifest::{parse_skill_file, SkillManifest, SkillPlatform};
pub(crate) use registry::atomic_replace;
pub use registry::{SkillListEntry, SkillRecord, SkillRegistry};
pub use seeding::{
    list_starter_skill_names, list_starter_skills, seed_starter_skills,
    seed_starter_skills_following, SeedStarterSkillsResult,
};

pub const AGENT_SKILLS_DIR: &str = "agent-skills";
pub const BUNDLED_AGENT_SKILLS_RESOURCE_DIR: &str = "resources/agent-skills";
const BUNDLED_SKILLS_STATE_FILE: &str = ".bundled.json";

pub fn global_skills_dir(data_folder: &Path) -> PathBuf {
    data_folder.join(AGENT_SKILLS_DIR)
}

/// Whether the bundled skills have been copied into this data folder before.
/// Startup re-seeds only when this is false or the app version changed:
/// copying every bundled skill on every launch held the window back for
/// seconds before it could appear.
pub fn bundled_skills_seeded(data_folder: &Path) -> bool {
    global_skills_dir(data_folder)
        .join(BUNDLED_SKILLS_STATE_FILE)
        .is_file()
}

pub fn ensure_global_skills_dir(data_folder: &Path) -> Result<PathBuf, String> {
    let root = global_skills_dir(data_folder);
    std::fs::create_dir_all(&root).map_err(|error| {
        format!(
            "Failed to create Agent skills directory '{}': {error}",
            root.display()
        )
    })?;
    Ok(root)
}

pub fn available_tool_names() -> BTreeSet<String> {
    crate::core::agent::prompt::ITERATION_ONE_TOOLS
        .iter()
        .map(|descriptor| descriptor.name.to_string())
        .collect()
}

pub fn initialize_skills(
    data_folder: &Path,
    bundled_skills_root: &Path,
) -> Result<SeedStarterSkillsResult, String> {
    let root = ensure_global_skills_dir(data_folder)?;
    // A bundled skill the user has moved into a category folder is updated
    // where it is; this is the list that says which folders were bundled.
    let previously_bundled = read_bundled_names(&root).unwrap_or_default();
    let result = seed_starter_skills_following(bundled_skills_root, &root, &previously_bundled)?;
    let state = serde_json::to_vec_pretty(&result.installed)
        .map_err(|error| format!("Failed to serialize bundled skill names: {error}"))?;
    std::fs::write(root.join(BUNDLED_SKILLS_STATE_FILE), state)
        .map_err(|error| format!("Failed to persist bundled skill names: {error}"))?;
    Ok(result)
}

fn read_bundled_names(root: &Path) -> Result<BTreeSet<String>, String> {
    let reserved_path = root.join(BUNDLED_SKILLS_STATE_FILE);
    if !reserved_path.exists() {
        return Ok(BTreeSet::new());
    }
    let bytes = std::fs::read(&reserved_path)
        .map_err(|error| format!("Failed to read bundled skill names: {error}"))?;
    serde_json::from_slice::<BTreeSet<String>>(&bytes)
        .map_err(|error| format!("Invalid bundled skill names state: {error}"))
}

pub fn load_registry(data_folder: &Path) -> Result<SkillRegistry, String> {
    let root = ensure_global_skills_dir(data_folder)?;
    let reserved = read_bundled_names(&root)?;
    SkillRegistry::load(root, &reserved, &available_tool_names())
}
