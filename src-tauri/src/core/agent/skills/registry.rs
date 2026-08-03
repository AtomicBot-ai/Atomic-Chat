use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::manifest::{parse_skill_file, SkillManifest, SkillPlatform};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

pub const DISABLED_SKILLS_FILE: &str = ".disabled.json";

#[derive(Debug, Clone)]
pub struct SkillRecord {
    pub manifest: SkillManifest,
    pub body: String,
    pub root: PathBuf,
    pub enabled: bool,
    pub compatible: bool,
    pub reserved: bool,
    pub unavailable_reasons: Vec<String>,
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
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct DisabledSkillsState {
    #[serde(default)]
    disabled: BTreeSet<String>,
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
                },
            );
        }
        Ok(Self {
            root,
            records,
            diagnostics,
            disabled,
        })
    }

    pub fn enabled(&self) -> impl Iterator<Item = &SkillRecord> {
        self.records.values().filter(|record| {
            record.enabled && record.compatible && record.unavailable_reasons.is_empty()
        })
    }

    pub fn get_enabled(&self, name: &str) -> Option<&SkillRecord> {
        self.records.get(name).filter(|record| {
            record.enabled && record.compatible && record.unavailable_reasons.is_empty()
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
                enabled: record.enabled,
                compatible: record.compatible,
                reserved: record.reserved,
                unavailable_reasons: record.unavailable_reasons.clone(),
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
            error: Some(diagnostic.error.clone()),
        }));
        entries.sort_by(|left, right| left.name.cmp(&right.name));
        entries
    }

    pub fn set_enabled(&mut self, name: &str, enabled: bool) -> Result<(), String> {
        if !self.records.contains_key(name) {
            return Err(format!("Skill `{name}` was not found"));
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
}

fn is_platform_compatible(
    supported: Option<&[SkillPlatform]>,
    current: Option<&SkillPlatform>,
) -> bool {
    supported.map_or(true, |platforms| {
        current.is_some_and(|platform| platforms.contains(platform))
    })
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
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
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
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
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
        assert!(registry.get_enabled("test-skill").is_some());
        registry.set_enabled("test-skill", false).unwrap();
        let registry = SkillRegistry::load(&root, &BTreeSet::new(), &tools).unwrap();
        assert!(registry.get_enabled("test-skill").is_none());
        assert!(!registry.get("test-skill").unwrap().enabled);
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
