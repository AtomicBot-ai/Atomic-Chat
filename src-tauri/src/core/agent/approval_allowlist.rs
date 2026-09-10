use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const APPROVAL_ALLOWLIST_FILE: &str = "agent-approval-allowlist.json";
const APPROVAL_ALLOWLIST_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ApprovalAllowlistFile {
    version: u32,
    fingerprints: BTreeSet<String>,
}

#[derive(Debug, Default)]
pub struct ApprovalAllowlist {
    data_folder: Option<PathBuf>,
    fingerprints: BTreeSet<String>,
}

impl ApprovalAllowlist {
    pub fn load_for_data_folder(&mut self, data_folder: &Path) -> Result<(), String> {
        if self.data_folder.as_deref() == Some(data_folder) {
            return Ok(());
        }

        self.fingerprints.clear();
        let path = data_folder.join(APPROVAL_ALLOWLIST_FILE);
        if !path.exists() {
            self.data_folder = Some(data_folder.to_path_buf());
            return Ok(());
        }

        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read Agent approval allowlist: {error}"))?;
        let state = serde_json::from_str::<ApprovalAllowlistFile>(&content)
            .map_err(|error| format!("Invalid Agent approval allowlist: {error}"))?;
        if state.version != APPROVAL_ALLOWLIST_VERSION {
            return Err(format!(
                "Unsupported Agent approval allowlist version: {}",
                state.version
            ));
        }
        if state
            .fingerprints
            .iter()
            .any(|fingerprint| !is_valid_fingerprint(fingerprint))
        {
            return Err("Invalid Agent approval allowlist fingerprint".into());
        }

        self.fingerprints = state.fingerprints;
        self.data_folder = Some(data_folder.to_path_buf());
        Ok(())
    }

    pub fn contains(&self, fingerprint: &str) -> bool {
        is_valid_fingerprint(fingerprint) && self.fingerprints.contains(fingerprint)
    }

    pub fn insert(&mut self, fingerprint: String) -> Result<(), String> {
        if !is_valid_fingerprint(&fingerprint) {
            return Err("Invalid Agent approval fingerprint".into());
        }
        let data_folder = self
            .data_folder
            .as_deref()
            .ok_or_else(|| "Agent approval allowlist is not loaded".to_string())?;
        if self.fingerprints.contains(&fingerprint) {
            return Ok(());
        }

        let mut updated = self.fingerprints.clone();
        updated.insert(fingerprint);
        write_allowlist(data_folder, &updated)?;
        self.fingerprints = updated;
        Ok(())
    }
}

pub fn fingerprint_prepared_action(tool: &str, args: &Value) -> String {
    let canonical = format!(
        "{{\"args\":{},\"tool\":{}}}",
        canonical_json(args),
        serde_json::to_string(tool).expect("tool name serializes")
    );
    format!("{:x}", Sha256::digest(canonical.as_bytes()))
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let sorted = values
                .iter()
                .map(|(key, value)| (key.clone(), value))
                .collect::<BTreeMap<_, _>>();
            format!(
                "{{{}}}",
                sorted
                    .iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON key serializes"),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        value => serde_json::to_string(value).expect("JSON value serializes"),
    }
}

fn is_valid_fingerprint(fingerprint: &str) -> bool {
    fingerprint.len() == 64
        && fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn write_allowlist(data_folder: &Path, fingerprints: &BTreeSet<String>) -> Result<(), String> {
    fs::create_dir_all(data_folder)
        .map_err(|error| format!("Failed to create Agent data folder: {error}"))?;
    let path = data_folder.join(APPROVAL_ALLOWLIST_FILE);
    let temporary = data_folder.join(format!(
        "{APPROVAL_ALLOWLIST_FILE}.{}.tmp",
        uuid::Uuid::new_v4()
    ));
    let content = serde_json::to_vec_pretty(&ApprovalAllowlistFile {
        version: APPROVAL_ALLOWLIST_VERSION,
        fingerprints: fingerprints.clone(),
    })
    .map_err(|error| format!("Failed to serialize Agent approval allowlist: {error}"))?;
    let result = (|| {
        let mut file = fs::File::create(&temporary)
            .map_err(|error| format!("Failed to create Agent approval allowlist: {error}"))?;
        file.write_all(&content)
            .map_err(|error| format!("Failed to write Agent approval allowlist: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Failed to sync Agent approval allowlist: {error}"))?;
        drop(file);
        atomic_replace(&temporary, &path)
            .map_err(|error| format!("Failed to commit Agent approval allowlist: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
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

    #[test]
    fn fingerprint_is_full_sha256_and_canonical() {
        let left = fingerprint_prepared_action(
            "os.fs.write",
            &serde_json::json!({"path": "/work/a", "content": "x"}),
        );
        let right = fingerprint_prepared_action(
            "os.fs.write",
            &serde_json::json!({"content": "x", "path": "/work/a"}),
        );
        assert_eq!(left, right);
        assert_eq!(left.len(), 64);
        assert_ne!(
            left,
            fingerprint_prepared_action(
                "os.fs.write",
                &serde_json::json!({"path": "/work/a", "content": "y"}),
            )
        );
    }

    #[test]
    fn persists_and_reloads_fingerprints() {
        let temp = TempDir::new().unwrap();
        let fingerprint = "a".repeat(64);
        let mut allowlist = ApprovalAllowlist::default();
        allowlist.load_for_data_folder(temp.path()).unwrap();
        allowlist.insert(fingerprint.clone()).unwrap();

        let mut reloaded = ApprovalAllowlist::default();
        reloaded.load_for_data_folder(temp.path()).unwrap();
        assert!(reloaded.contains(&fingerprint));
        let content = fs::read_to_string(temp.path().join(APPROVAL_ALLOWLIST_FILE)).unwrap();
        assert!(!content.contains("os.fs.write"));
    }

    #[test]
    fn corrupt_file_loads_no_permissions() {
        let temp = TempDir::new().unwrap();
        fs::write(temp.path().join(APPROVAL_ALLOWLIST_FILE), "{broken").unwrap();
        let mut allowlist = ApprovalAllowlist::default();

        assert!(allowlist.load_for_data_folder(temp.path()).is_err());
        assert!(!allowlist.contains(&"a".repeat(64)));
    }

    #[tokio::test]
    async fn concurrent_insertions_preserve_every_fingerprint() {
        let temp = TempDir::new().unwrap();
        let allowlist = std::sync::Arc::new(tokio::sync::Mutex::new(ApprovalAllowlist::default()));
        allowlist
            .lock()
            .await
            .load_for_data_folder(temp.path())
            .unwrap();
        let mut tasks = Vec::new();

        for digit in 0..16 {
            let allowlist = allowlist.clone();
            let fingerprint = format!("{digit:x}").repeat(64);
            tasks.push(tokio::spawn(async move {
                allowlist.lock().await.insert(fingerprint).unwrap();
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }

        let mut reloaded = ApprovalAllowlist::default();
        reloaded.load_for_data_folder(temp.path()).unwrap();
        for digit in 0..16 {
            assert!(reloaded.contains(&format!("{digit:x}").repeat(64)));
        }
        let temporary_files = fs::read_dir(temp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(temporary_files, 0);
    }
}
