use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::manifest::{parse_skill_file, SkillManifest, SkillPlatform};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

pub const DISABLED_SKILLS_FILE: &str = ".disabled.json";
/// Fingerprints of skills the user has reviewed and allowed (Task 28, D36).
pub const REVIEWED_SKILLS_FILE: &str = ".reviewed.json";

#[derive(Debug, Clone)]
pub struct SkillRecord {
    pub manifest: SkillManifest,
    pub body: String,
    pub root: PathBuf,
    pub enabled: bool,
    pub compatible: bool,
    pub reserved: bool,
    pub unavailable_reasons: Vec<String>,
    /// SHA-256 over every file in the skill's folder, as loaded.
    pub fingerprint: String,
    /// Allowed by the user at exactly this fingerprint. Only a reviewed skill
    /// is offered to the AI, whether or not it is bundled.
    pub reviewed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillListEntry {
    pub name: String,
    pub description: String,
    pub version: String,
    pub requires_tools: Vec<String>,
    pub requires_scripts: Vec<String>,
    pub dangerous: bool,
    pub platforms: Option<Vec<SkillPlatform>>,
    pub enabled: bool,
    pub compatible: bool,
    pub reserved: bool,
    pub unavailable_reasons: Vec<String>,
    /// Added or changed since the user last allowed it; not offered to the AI.
    pub needs_review: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SkillDiagnostic {
    pub name: String,
    pub error: String,
    pub reserved: bool,
}

#[derive(Debug, Clone)]
pub struct SkillRegistry {
    root: PathBuf,
    records: BTreeMap<String, SkillRecord>,
    diagnostics: Vec<SkillDiagnostic>,
    disabled: BTreeSet<String>,
    reviewed: BTreeMap<String, String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct DisabledSkillsState {
    #[serde(default)]
    disabled: BTreeSet<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ReviewedSkillsState {
    #[serde(default)]
    reviewed: BTreeMap<String, String>,
}

impl SkillRegistry {
    pub fn load(
        root: impl Into<PathBuf>,
        reserved_names: &BTreeSet<String>,
        available_tools: &BTreeSet<String>,
    ) -> Result<Self, String> {
        let root = root.into();
        fs::create_dir_all(&root)
            .map_err(|error| format!("Failed to create agent skills directory: {error}"))?;
        let canonical_root = root
            .canonicalize()
            .map_err(|error| format!("Failed to resolve agent skills directory: {error}"))?;
        let disabled = read_disabled_state(&root)?;
        let reviewed = read_reviewed_state(&root);
        let mut entries = fs::read_dir(&root)
            .map_err(|error| format!("Failed to scan agent skills directory: {error}"))?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        let mut records = BTreeMap::new();
        let mut diagnostics = Vec::new();
        for entry in entries {
            let folder_name = entry.file_name().to_string_lossy().to_string();
            if folder_name.starts_with('.') {
                continue;
            }
            let reserved = reserved_names.contains(&folder_name);
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    diagnostics.push(SkillDiagnostic {
                        name: folder_name,
                        error: format!("Failed to inspect skill directory: {error}"),
                        reserved,
                    });
                    continue;
                }
            };
            if !file_type.is_dir() {
                continue;
            }
            let skill_root = entry.path();
            let canonical_skill_root = match skill_root.canonicalize() {
                Ok(path) if path.parent() == Some(canonical_root.as_path()) => path,
                Ok(_) => {
                    diagnostics.push(SkillDiagnostic {
                        name: folder_name,
                        error: "Skill directory resolves outside the global skills root"
                            .to_string(),
                        reserved,
                    });
                    continue;
                }
                Err(error) => {
                    diagnostics.push(SkillDiagnostic {
                        name: folder_name,
                        error: format!("Failed to resolve skill directory: {error}"),
                        reserved,
                    });
                    continue;
                }
            };
            let skill_path = canonical_skill_root.join("SKILL.md");
            let canonical_skill_path = match fs::symlink_metadata(&skill_path) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    diagnostics.push(SkillDiagnostic {
                        name: folder_name,
                        error: "SKILL.md must not be a symbolic link".to_string(),
                        reserved,
                    });
                    continue;
                }
                Ok(metadata) if !metadata.is_file() => {
                    diagnostics.push(SkillDiagnostic {
                        name: folder_name,
                        error: "SKILL.md must be a regular file".to_string(),
                        reserved,
                    });
                    continue;
                }
                Ok(_) => match skill_path.canonicalize() {
                    Ok(path) if path.parent() == Some(canonical_skill_root.as_path()) => path,
                    Ok(_) => {
                        diagnostics.push(SkillDiagnostic {
                            name: folder_name,
                            error: "SKILL.md resolves outside its skill directory".to_string(),
                            reserved,
                        });
                        continue;
                    }
                    Err(error) => {
                        diagnostics.push(SkillDiagnostic {
                            name: folder_name,
                            error: format!("Failed to resolve SKILL.md: {error}"),
                            reserved,
                        });
                        continue;
                    }
                },
                Err(error) => {
                    diagnostics.push(SkillDiagnostic {
                        name: folder_name,
                        error: format!("Failed to inspect SKILL.md: {error}"),
                        reserved,
                    });
                    continue;
                }
            };
            let content = match fs::read_to_string(&canonical_skill_path) {
                Ok(content) => content,
                Err(error) => {
                    diagnostics.push(SkillDiagnostic {
                        name: folder_name,
                        error: format!("Failed to read SKILL.md: {error}"),
                        reserved,
                    });
                    continue;
                }
            };
            let parsed = match parse_skill_file(&content) {
                Ok(parsed) => parsed,
                Err(error) => {
                    diagnostics.push(SkillDiagnostic {
                        name: folder_name,
                        error,
                        reserved,
                    });
                    continue;
                }
            };
            if parsed.manifest.name != folder_name {
                diagnostics.push(SkillDiagnostic {
                    name: folder_name,
                    error: format!(
                        "Manifest name `{}` does not match its directory",
                        parsed.manifest.name
                    ),
                    reserved,
                });
                continue;
            }
            if records.contains_key(&parsed.manifest.name) {
                diagnostics.push(SkillDiagnostic {
                    name: parsed.manifest.name,
                    error: "Duplicate skill name".to_string(),
                    reserved,
                });
                continue;
            }
            let compatible = is_platform_compatible(
                parsed.manifest.platforms.as_deref(),
                SkillPlatform::current().as_ref(),
            );
            let unavailable_reasons = parsed
                .manifest
                .requires_tools
                .iter()
                .filter(|tool| !available_tools.contains(*tool))
                .map(|tool| format!("Required tool `{tool}` is unavailable"))
                .collect();
            let name = parsed.manifest.name.clone();
            let fingerprint = match skill_fingerprint(&canonical_skill_root) {
                Ok(fingerprint) => fingerprint,
                Err(error) => {
                    diagnostics.push(SkillDiagnostic {
                        name,
                        error,
                        reserved,
                    });
                    continue;
                }
            };
            // Every skill - bundled, from Anthropic, written in Radium or
            // uploaded - must have been allowed by the user exactly as it is
            // now (the user's rule, 2026-09-14; Task 28, D36).
            let is_reviewed = reviewed.get(&name) == Some(&fingerprint);
            records.insert(
                name.clone(),
                SkillRecord {
                    manifest: parsed.manifest,
                    body: parsed.body,
                    root: canonical_skill_root,
                    enabled: !disabled.contains(&name),
                    compatible,
                    reserved,
                    unavailable_reasons,
                    fingerprint,
                    reviewed: is_reviewed,
                },
            );
        }
        Ok(Self {
            root,
            records,
            diagnostics,
            disabled,
            reviewed,
        })
    }

    pub fn enabled(&self) -> impl Iterator<Item = &SkillRecord> {
        self.records.values().filter(|record| {
            record.enabled
                && record.reviewed
                && record.compatible
                && record.unavailable_reasons.is_empty()
        })
    }

    pub fn get_enabled(&self, name: &str) -> Option<&SkillRecord> {
        self.records.get(name).filter(|record| {
            record.enabled
                && record.reviewed
                && record.compatible
                && record.unavailable_reasons.is_empty()
        })
    }

    pub fn get(&self, name: &str) -> Option<&SkillRecord> {
        self.records.get(name)
    }

    pub fn list_all(&self) -> Vec<SkillListEntry> {
        let mut entries = self
            .records
            .values()
            .map(|record| SkillListEntry {
                name: record.manifest.name.clone(),
                description: record.manifest.description.clone(),
                version: record.manifest.version.clone(),
                requires_tools: record.manifest.requires_tools.clone(),
                requires_scripts: record.manifest.requires_scripts.clone(),
                dangerous: record.manifest.dangerous,
                platforms: record.manifest.platforms.clone(),
                // Every skill shows as off until the user has allowed it as it
                // is now (the user's rule, 2026-09-14).
                enabled: record.enabled && record.reviewed,
                compatible: record.compatible,
                reserved: record.reserved,
                unavailable_reasons: record.unavailable_reasons.clone(),
                needs_review: !record.reviewed,
                error: None,
            })
            .collect::<Vec<_>>();
        entries.extend(self.diagnostics.iter().map(|diagnostic| SkillListEntry {
            name: diagnostic.name.clone(),
            description: String::new(),
            version: String::new(),
            requires_tools: Vec::new(),
            requires_scripts: Vec::new(),
            dangerous: false,
            platforms: None,
            enabled: false,
            compatible: false,
            reserved: diagnostic.reserved,
            unavailable_reasons: Vec::new(),
            needs_review: false,
            error: Some(diagnostic.error.clone()),
        }));
        entries.sort_by(|left, right| left.name.cmp(&right.name));
        entries
    }

    pub fn set_enabled(&mut self, name: &str, enabled: bool) -> Result<(), String> {
        if !self.records.contains_key(name) {
            return Err(format!("Skill `{name}` was not found"));
        }
        if enabled && !self.records[name].reviewed {
            return Err(format!(
                "Skill `{name}` needs review before it can be switched on"
            ));
        }
        if enabled {
            self.disabled.remove(name);
        } else {
            self.disabled.insert(name.to_string());
        }
        write_disabled_state(&self.root, &self.disabled)?;
        if let Some(record) = self.records.get_mut(name) {
            record.enabled = enabled;
        }
        Ok(())
    }

    /// Record that the user reviewed this skill as it is now (Task 28, D36).
    /// It stays offered to the AI only while its files still match.
    pub fn approve(&mut self, name: &str) -> Result<(), String> {
        let fingerprint = self
            .records
            .get(name)
            .map(|record| record.fingerprint.clone())
            .ok_or_else(|| format!("Skill `{name}` was not found"))?;
        self.reviewed.insert(name.to_string(), fingerprint);
        write_reviewed_state(&self.root, &self.reviewed)?;
        if let Some(record) = self.records.get_mut(name) {
            record.reviewed = true;
        }
        Ok(())
    }

    /// Treat every loaded skill as reviewed. Only for the evaluation harness and
    /// tests, which load their own fixture skills; the app never calls this.
    pub fn trust_all(&mut self) {
        for record in self.records.values_mut() {
            record.reviewed = true;
        }
    }
}

/// SHA-256 over every file in a skill's folder - its relative path and its
/// contents, in a fixed order - so any change to the instructions or to a
/// bundled script shows up. A symbolic link counts by where it points.
fn skill_fingerprint(skill_root: &Path) -> Result<String, String> {
    let mut files = Vec::new();
    collect_relative_files(skill_root, skill_root, &mut files)?;
    files.sort();
    let mut hasher = Sha256::new();
    for relative in files {
        let path = skill_root.join(&relative);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("Failed to inspect skill file for review: {error}"))?;
        hasher.update(relative.as_bytes());
        hasher.update([0u8]);
        if metadata.file_type().is_symlink() {
            let target = fs::read_link(&path)
                .map_err(|error| format!("Failed to read skill link for review: {error}"))?;
            hasher.update(b"symlink:");
            hasher.update(target.to_string_lossy().as_bytes());
        } else {
            let content = fs::read(&path)
                .map_err(|error| format!("Failed to read skill file for review: {error}"))?;
            hasher.update((content.len() as u64).to_le_bytes());
            hasher.update(&content);
        }
        hasher.update([0u8]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn collect_relative_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<String>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("Failed to scan skill directory for review: {error}"))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Failed to scan skill directory for review: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect skill file for review: {error}"))?;
        let path = entry.path();
        if file_type.is_dir() {
            collect_relative_files(root, &path, files)?;
        } else {
            let relative = path
                .strip_prefix(root)
                .map_err(|error| format!("Skill file is outside its folder: {error}"))?;
            files.push(
                relative
                    .components()
                    .map(|component| component.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/"),
            );
        }
    }
    Ok(())
}

/// A missing or unreadable file means nothing has been reviewed yet: every
/// added skill then asks again, which is the safe direction.
fn read_reviewed_state(root: &Path) -> BTreeMap<String, String> {
    let path = root.join(REVIEWED_SKILLS_FILE);
    let Ok(content) = fs::read_to_string(&path) else {
        return BTreeMap::new();
    };
    match serde_json::from_str::<ReviewedSkillsState>(&content) {
        Ok(state) => state.reviewed,
        Err(error) => {
            log::warn!("Ignoring invalid reviewed skills state: {error}");
            BTreeMap::new()
        }
    }
}

fn write_reviewed_state(root: &Path, reviewed: &BTreeMap<String, String>) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(&ReviewedSkillsState {
        reviewed: reviewed.clone(),
    })
    .map_err(|error| format!("Failed to serialize reviewed skills state: {error}"))?;
    let path = root.join(REVIEWED_SKILLS_FILE);
    let temporary = root.join(format!(
        "{REVIEWED_SKILLS_FILE}.{}.tmp",
        uuid::Uuid::new_v4()
    ));
    let result = fs::write(&temporary, &content)
        .map_err(|error| format!("Failed to write reviewed skills state: {error}"))
        .and_then(|()| {
            atomic_replace(&temporary, &path)
                .map_err(|error| format!("Failed to commit reviewed skills state: {error}"))
        });
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn is_platform_compatible(
    supported: Option<&[SkillPlatform]>,
    current: Option<&SkillPlatform>,
) -> bool {
    supported.is_none_or(|platforms| current.is_some_and(|platform| platforms.contains(platform)))
}

fn read_disabled_state(root: &Path) -> Result<BTreeSet<String>, String> {
    let path = root.join(DISABLED_SKILLS_FILE);
    if !path.exists() {
        return Ok(BTreeSet::new());
    }
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read disabled skills state: {error}"))?;
    serde_json::from_str::<DisabledSkillsState>(&content)
        .map(|state| state.disabled)
        .map_err(|error| format!("Invalid disabled skills state: {error}"))
}

fn write_disabled_state(root: &Path, disabled: &BTreeSet<String>) -> Result<(), String> {
    let path = root.join(DISABLED_SKILLS_FILE);
    let temporary = root.join(format!(
        "{DISABLED_SKILLS_FILE}.{}.tmp",
        uuid::Uuid::new_v4()
    ));
    let content = serde_json::to_vec_pretty(&DisabledSkillsState {
        disabled: disabled.clone(),
    })
    .map_err(|error| format!("Failed to serialize disabled skills state: {error}"))?;
    let result = (|| {
        let mut file = fs::File::create(&temporary)
            .map_err(|error| format!("Failed to create disabled skills state: {error}"))?;
        use std::io::Write;
        file.write_all(&content)
            .map_err(|error| format!("Failed to write disabled skills state: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Failed to sync disabled skills state: {error}"))?;
        drop(file);
        atomic_replace(&temporary, &path)
            .map_err(|error| format!("Failed to commit disabled skills state: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(windows)]
pub(crate) fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let source_wide: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

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
    fn loads_enabled_skills_and_persists_disabled_names() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let skill = root.join("test-skill");
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: test-skill\ndescription: Test\nrequires_tools: [os.fs.read]\n---\nBody",
        )
        .unwrap();
        let tools = BTreeSet::from(["os.fs.read".to_string()]);
        let mut registry = SkillRegistry::load(&root, &BTreeSet::new(), &tools).unwrap();
        // Task 28: a skill the user added is only offered once it is reviewed.
        registry.approve("test-skill").unwrap();
        assert!(registry.get_enabled("test-skill").is_some());
        registry.set_enabled("test-skill", false).unwrap();
        let registry = SkillRegistry::load(&root, &BTreeSet::new(), &tools).unwrap();
        assert!(registry.get_enabled("test-skill").is_none());
        assert!(!registry.get("test-skill").unwrap().enabled);
    }

    fn write_reviewable_skill(root: &Path, name: &str, body: &str) -> PathBuf {
        let skill = root.join(name);
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            format!(
                "---\nname: {name}\ndescription: Test\nrequires_tools: [os.fs.read]\n---\n{body}"
            ),
        )
        .unwrap();
        skill
    }

    fn read_tool() -> BTreeSet<String> {
        BTreeSet::from(["os.fs.read".to_string()])
    }

    fn needs_review(registry: &SkillRegistry, name: &str) -> bool {
        registry
            .list_all()
            .into_iter()
            .find(|entry| entry.name == name)
            .expect("skill is listed")
            .needs_review
    }

    #[test]
    fn a_skill_nobody_has_reviewed_is_listed_but_never_offered() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        write_reviewable_skill(&root, "added-skill", "Body");

        let registry = SkillRegistry::load(&root, &BTreeSet::new(), &read_tool()).unwrap();

        assert!(registry.get_enabled("added-skill").is_none());
        assert_eq!(registry.enabled().count(), 0);
        assert!(needs_review(&registry, "added-skill"));
    }

    #[test]
    fn approving_a_skill_offers_it_and_the_approval_survives_a_reload() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        write_reviewable_skill(&root, "added-skill", "Body");

        let mut registry = SkillRegistry::load(&root, &BTreeSet::new(), &read_tool()).unwrap();
        registry.approve("added-skill").unwrap();
        assert!(registry.get_enabled("added-skill").is_some());

        let registry = SkillRegistry::load(&root, &BTreeSet::new(), &read_tool()).unwrap();
        assert!(registry.get_enabled("added-skill").is_some());
        assert!(!needs_review(&registry, "added-skill"));
    }

    #[test]
    fn changing_an_approved_skill_hides_it_until_it_is_reviewed_again() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let skill = write_reviewable_skill(&root, "added-skill", "Body");
        let mut registry = SkillRegistry::load(&root, &BTreeSet::new(), &read_tool()).unwrap();
        registry.approve("added-skill").unwrap();

        // Different instructions.
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: added-skill\ndescription: Test\nrequires_tools: [os.fs.read]\n---\nNow do something else",
        )
        .unwrap();
        let mut registry = SkillRegistry::load(&root, &BTreeSet::new(), &read_tool()).unwrap();
        assert!(registry.get_enabled("added-skill").is_none());
        assert!(needs_review(&registry, "added-skill"));

        // A script added next to approved instructions counts as a change too.
        registry.approve("added-skill").unwrap();
        fs::create_dir_all(skill.join("scripts")).unwrap();
        fs::write(skill.join("scripts").join("run.sh"), "echo hello").unwrap();
        let registry = SkillRegistry::load(&root, &BTreeSet::new(), &read_tool()).unwrap();
        assert!(registry.get_enabled("added-skill").is_none());
        assert!(needs_review(&registry, "added-skill"));
    }

    #[test]
    fn bundled_skills_need_review_too() {
        // The user's rule (2026-09-14): every skill goes through Allow / Preview /
        // Cancel, whether it ships with Radium, comes from Anthropic or is
        // written by the user.
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        write_reviewable_skill(&root, "starter", "Body");
        let reserved = BTreeSet::from(["starter".to_string()]);

        let mut registry = SkillRegistry::load(&root, &reserved, &read_tool()).unwrap();
        assert!(registry.get_enabled("starter").is_none());
        assert!(needs_review(&registry, "starter"));

        registry.approve("starter").unwrap();
        assert!(registry.get_enabled("starter").is_some());
    }

    #[test]
    fn every_skill_starts_switched_off_until_the_user_allows_it() {
        // The user's rule (2026-09-14): every skill, bundled or added, is off by
        // default and only shows as on once the user has allowed it.
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        write_reviewable_skill(&root, "starter", "Body");
        write_reviewable_skill(&root, "added-skill", "Body");
        let reserved = BTreeSet::from(["starter".to_string()]);
        let shown_on = |registry: &SkillRegistry| -> Vec<String> {
            registry
                .list_all()
                .into_iter()
                .filter(|entry| entry.enabled)
                .map(|entry| entry.name)
                .collect()
        };

        let mut registry = SkillRegistry::load(&root, &reserved, &read_tool()).unwrap();
        assert!(shown_on(&registry).is_empty());
        assert_eq!(registry.enabled().count(), 0);

        registry.approve("added-skill").unwrap();
        registry.set_enabled("added-skill", true).unwrap();
        assert_eq!(shown_on(&registry), ["added-skill"]);

        let reloaded = SkillRegistry::load(&root, &reserved, &read_tool()).unwrap();
        assert_eq!(shown_on(&reloaded), ["added-skill"]);

        // A skill that changes after it was allowed shows as off again.
        fs::write(root.join("added-skill").join("SKILL.md"), {
            let original = fs::read_to_string(root.join("added-skill").join("SKILL.md")).unwrap();
            format!("{original}\nChanged.")
        })
        .unwrap();
        let changed = SkillRegistry::load(&root, &reserved, &read_tool()).unwrap();
        assert!(shown_on(&changed).is_empty());
    }

    #[test]
    fn switching_on_an_unreviewed_skill_is_refused_but_switching_off_is_not() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        write_reviewable_skill(&root, "added-skill", "Body");
        let mut registry = SkillRegistry::load(&root, &BTreeSet::new(), &read_tool()).unwrap();

        let error = registry.set_enabled("added-skill", true).unwrap_err();
        assert!(error.contains("review"), "{error}");
        registry.set_enabled("added-skill", false).unwrap();
    }

    #[test]
    fn keeps_malformed_skills_as_diagnostics() {
        let temp = TempDir::new().unwrap();
        let skill = temp.path().join("bad");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), "# invalid").unwrap();
        let registry =
            SkillRegistry::load(temp.path(), &BTreeSet::new(), &BTreeSet::new()).unwrap();
        let row = registry.list_all().pop().unwrap();
        assert_eq!(row.name, "bad");
        assert!(row.error.is_some());
    }

    #[test]
    fn filters_incompatible_and_tool_unavailable_skills_from_enabled_view() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let incompatible = root.join("incompatible-skill");
        let missing_tool = root.join("missing-tool");
        fs::create_dir_all(&incompatible).unwrap();
        fs::create_dir_all(&missing_tool).unwrap();
        let other_platform = match SkillPlatform::current().expect("desktop test platform") {
            SkillPlatform::Darwin => "linux",
            SkillPlatform::Linux | SkillPlatform::Win32 => "darwin",
        };
        fs::write(
            incompatible.join("SKILL.md"),
            format!(
                "---\nname: incompatible-skill\ndescription: Test\nplatforms: [{other_platform}]\n---\nBody"
            ),
        )
        .unwrap();
        fs::write(
            missing_tool.join("SKILL.md"),
            "---\nname: missing-tool\ndescription: Test\nrequires_tools: [missing.tool]\n---\nBody",
        )
        .unwrap();

        let registry = SkillRegistry::load(&root, &BTreeSet::new(), &BTreeSet::new()).unwrap();
        assert_eq!(registry.enabled().count(), 0);
        assert!(!registry.get("incompatible-skill").unwrap().compatible);
        assert_eq!(
            registry.get("missing-tool").unwrap().unavailable_reasons,
            ["Required tool `missing.tool` is unavailable"]
        );
    }

    #[test]
    fn platform_constraints_reject_unsupported_targets() {
        assert!(is_platform_compatible(None, None));
        assert!(!is_platform_compatible(Some(&[SkillPlatform::Linux]), None));
        assert!(is_platform_compatible(
            Some(&[SkillPlatform::Linux]),
            Some(&SkillPlatform::Linux)
        ));
        assert!(!is_platform_compatible(
            Some(&[SkillPlatform::Linux]),
            Some(&SkillPlatform::Darwin)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_skill_manifest() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let skill = root.join("linked-skill");
        fs::create_dir_all(&skill).unwrap();
        let outside = temp.path().join("outside.md");
        fs::write(
            &outside,
            "---\nname: linked-skill\ndescription: Escaped\n---\nBody",
        )
        .unwrap();
        symlink(&outside, skill.join("SKILL.md")).unwrap();

        let registry = SkillRegistry::load(&root, &BTreeSet::new(), &BTreeSet::new()).unwrap();
        let entry = registry.list_all().pop().unwrap();

        assert_eq!(entry.name, "linked-skill");
        assert_eq!(
            entry.error.as_deref(),
            Some("SKILL.md must not be a symbolic link")
        );
        assert!(registry.get("linked-skill").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_windows_reparse_points_in_skill_registry() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        let outside_skill = temp.path().join("outside-skill");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside_skill).unwrap();
        fs::write(
            outside_skill.join("SKILL.md"),
            "---\nname: junction-skill\ndescription: Escaped\n---\nBody",
        )
        .unwrap();
        let junction = root.join("junction-skill");
        create_junction(&junction, &outside_skill);

        let registry = SkillRegistry::load(&root, &BTreeSet::new(), &BTreeSet::new()).unwrap();
        assert!(registry.get("junction-skill").is_none());
        fs::remove_dir(&junction).unwrap();

        let linked_skill = root.join("linked-skill");
        fs::create_dir_all(&linked_skill).unwrap();
        let outside_manifest = temp.path().join("outside.md");
        fs::write(
            &outside_manifest,
            "---\nname: linked-skill\ndescription: Escaped\n---\nBody",
        )
        .unwrap();
        let manifest_link = linked_skill.join("SKILL.md");
        if create_file_symlink_if_allowed(&manifest_link, &outside_manifest) {
            let registry = SkillRegistry::load(&root, &BTreeSet::new(), &BTreeSet::new()).unwrap();
            let entry = registry
                .list_all()
                .into_iter()
                .find(|entry| entry.name == "linked-skill")
                .unwrap();
            assert_eq!(
                entry.error.as_deref(),
                Some("SKILL.md must not be a symbolic link")
            );
            assert!(registry.get("linked-skill").is_none());
            fs::remove_file(&manifest_link).unwrap();
        }
    }
}
