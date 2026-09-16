//! Atomic model ownership shared with `atomic-chat-core`.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use sysinfo::{Pid, ProcessesToUpdate, System};

#[derive(Debug, Serialize, Deserialize)]
struct ClaimRecord {
    claim_id: String,
    provider: String,
    model_id: String,
    owner_kind: String,
    owner_pid: u32,
    owner_started_at: Option<String>,
    owner_instance_id: String,
    state: String,
    updated_at: String,
}

#[derive(Debug)]
pub struct ModelClaim {
    dir: PathBuf,
    record: ClaimRecord,
}

fn process_start(pid: u32) -> Option<String> {
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
    system
        .process(Pid::from_u32(pid))
        .map(|process| format!("epoch:{}", process.start_time()))
}

fn claim_key(provider: &str, model_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(provider.as_bytes());
    hash.update([0]);
    hash.update(model_id.as_bytes());
    format!("{:x}", hash.finalize())
}

fn unique_id() -> String {
    format!("{}-{}", std::process::id(), std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos())
}

fn write_record(dir: &Path, record: &ClaimRecord) -> Result<(), String> {
    let temp = dir.join(format!("claim.{}.tmp", record.claim_id));
    let target = dir.join("claim.json");
    let bytes = serde_json::to_vec_pretty(record).map_err(|e| e.to_string())?;
    std::fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &target).map_err(|e| e.to_string())
}

fn read_record(dir: &Path) -> Option<ClaimRecord> {
    serde_json::from_slice(&std::fs::read(dir.join("claim.json")).ok()?).ok()
}

fn stale(record: &ClaimRecord) -> bool {
    let Some(actual) = process_start(record.owner_pid) else { return true };
    record.owner_started_at.as_ref().is_some_and(|expected| expected != &actual)
}

impl ModelClaim {
    pub fn acquire(core_dir: &Path, provider: &str, model_id: &str) -> Result<Self, String> {
        let claims = core_dir.join("model-claims");
        std::fs::create_dir_all(&claims).map_err(|e| e.to_string())?;
        let dir = claims.join(claim_key(provider, model_id));
        for _ in 0..2 {
            match std::fs::create_dir(&dir) {
                Ok(()) => {
                    let pid = std::process::id();
                    let started = process_start(pid);
                    let record = ClaimRecord {
                        claim_id: unique_id(), provider: provider.into(), model_id: model_id.into(),
                        owner_kind: "app".into(), owner_pid: pid,
                        owner_instance_id: format!("app-{pid}-{}", started.as_deref().unwrap_or("unknown")),
                        owner_started_at: started, state: "loading".into(),
                        updated_at: format!("{}", std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()),
                    };
                    if let Err(error) = write_record(&dir, &record) {
                        let _ = std::fs::remove_dir_all(&dir);
                        return Err(error);
                    }
                    return Ok(Self { dir, record });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let existing = read_record(&dir);
                    if existing.as_ref().map_or(true, |record| !stale(record)) {
                        let owner = existing.map(|r| format!("{} pid {} ({})", r.owner_kind, r.owner_pid, r.state))
                            .unwrap_or_else(|| dir.display().to_string());
                        return Err(format!("Another runtime already owns '{model_id}': {owner}"));
                    }
                    let stale_dir = claims.join(format!(".stale-{}", unique_id()));
                    if std::fs::rename(&dir, &stale_dir).is_ok() {
                        let _ = std::fs::remove_dir_all(stale_dir);
                    }
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        Err(format!("Could not claim model '{model_id}'"))
    }

    pub fn ready(&mut self) -> Result<(), String> {
        self.record.state = "ready".into();
        write_record(&self.dir, &self.record)
    }

    pub fn release(self) {
        if read_record(&self.dir).is_some_and(|r| r.claim_id == self.record.claim_id) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_is_exclusive_and_release_makes_it_available() {
        let temp = tempfile::tempdir().unwrap();
        let first = ModelClaim::acquire(temp.path(), "llamacpp-upstream", "owner/model").unwrap();
        let conflict = ModelClaim::acquire(temp.path(), "llamacpp-upstream", "owner/model")
            .unwrap_err();
        assert!(conflict.contains("Another runtime already owns"));
        first.release();
        ModelClaim::acquire(temp.path(), "llamacpp-upstream", "owner/model")
            .unwrap()
            .release();
    }

    #[test]
    fn provider_is_part_of_the_claim_key() {
        assert_ne!(
            claim_key("llamacpp", "owner/model"),
            claim_key("llamacpp-upstream", "owner/model")
        );
    }
}
