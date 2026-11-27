mod authoring;
pub mod commands;
mod manifest;
mod registry;
mod seeding;

use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

pub use manifest::{parse_skill_file, SkillManifest, SkillPlatform};
pub use registry::{SkillListEntry, SkillRecord, SkillRegistry};
pub use seeding::{list_starter_skill_names, seed_starter_skills, SeedStarterSkillsResult};

pub const AGENT_SKILLS_DIR: &str = "agent-skills";
pub const BUNDLED_AGENT_SKILLS_RESOURCE_DIR: &str = "resources/agent-skills";
const BUNDLED_SKILLS_STATE_FILE: &str = ".bundled.json";

pub fn global_skills_dir(data_folder: &Path) -> PathBuf {
    data_folder.join(AGENT_SKILLS_DIR)
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
    // Tool identifiers accepted by existing skill manifests.
    const TOOLS: &[&str] = &[
        "tool.view",
        "skill.view",
        "skill.run_script",
        "os.shell.run",
        "os.fs.read",
        "os.fs.write",
        "os.fs.mkdir",
        "os.fs.trash",
        "os.fs.list",
        "os.fs.glob",
        "os.fs.grep",
        "os.fs.edit",
        "os.fs.read_document",
        "os.fs.archive.list",
        "os.fs.archive.read_entry",
        "os.fs.archive.extract",
        "os.fs.hash",
        "os.fs.diff",
        "os.fs.patch",
        "os.git.status",
        "os.git.log",
        "os.git.diff",
        "os.git.show",
        "os.git.blame",
        "os.git.branch",
        "os.proc.list",
        "os.proc.kill",
        "os.code.symbols",
        "os.code.find",
        "os.code.refs",
        "os.proc.spawn",
        "os.proc.read",
        "os.proc.write",
        "os.proc.stop",
        "os.http.request",
        "os.web.search",
        "os.web.fetch",
        "docs.list",
        "docs.retrieve",
        "docs.chunks",
        "os.media.transcribe",
        "os.media.youtube",
        "vision.describe",
        "os.clipboard.read",
        "os.clipboard.write",
        "os.notify",
        "reply",
        "finish",
    ];
    TOOLS.iter().map(|name| (*name).to_owned()).collect()
}

pub fn initialize_skills(
    data_folder: &Path,
    bundled_skills_root: &Path,
) -> Result<SeedStarterSkillsResult, String> {
    let root = ensure_global_skills_dir(data_folder)?;
    let result = seed_starter_skills(bundled_skills_root, &root)?;
    let state = serde_json::to_vec_pretty(&result.installed)
        .map_err(|error| format!("Failed to serialize bundled skill names: {error}"))?;
    std::fs::write(root.join(BUNDLED_SKILLS_STATE_FILE), state)
        .map_err(|error| format!("Failed to persist bundled skill names: {error}"))?;
    Ok(result)
}

pub fn load_registry(data_folder: &Path) -> Result<SkillRegistry, String> {
    load_registry_with_tools(data_folder, &available_tool_names())
}

pub(crate) fn load_registry_with_tools(
    data_folder: &Path,
    tools: &BTreeSet<String>,
) -> Result<SkillRegistry, String> {
    let root = ensure_global_skills_dir(data_folder)?;
    let reserved_path = root.join(BUNDLED_SKILLS_STATE_FILE);
    let reserved = if reserved_path.exists() {
        let bytes = std::fs::read(&reserved_path)
            .map_err(|error| format!("Failed to read bundled skill names: {error}"))?;
        serde_json::from_slice::<BTreeSet<String>>(&bytes)
            .map_err(|error| format!("Invalid bundled skill names state: {error}"))?
    } else {
        BTreeSet::new()
    };
    SkillRegistry::load(root, &reserved, tools)
}
