//! Crash recovery for the tunnel process.
//!
//! `RunEvent::Exit` ends cloudflared on a normal quit, but a crash, an OOM kill
//! or a Force Quit runs none of our cleanup. An orphaned tunnel is worse than an
//! orphaned model backend: it keeps a *public* URL pointed at a local port that
//! is now dead — or that the next process to bind it inherits.
//!
//! The name-and-directory matching of `process_reaper` does not fit here. The
//! sidecar sits next to the executable rather than under the resource dir, an
//! AppImage's mount path changes on every launch, and people who want this
//! feature often run a `cloudflared` of their own that must never be touched.
//! So, like the agent's PTY children, the tunnel is identified by a journal of
//! its pid plus its start time (the pid-reuse guard), and additionally by name.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessesToUpdate, System};

const JOURNAL_FILE_NAME: &str = "remote-access-tunnel.json";
/// Same tolerance as the agent PTY journal: the kernel's start time and our
/// clock reading a moment after `spawn` differ by a second or two at most.
const START_TIME_TOLERANCE_SECS: u64 = 5;
const PROCESS_NAME_PREFIX: &str = "cloudflared";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct JournalEntry {
    pid: u32,
    started_at_secs: u64,
}

fn epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
}

pub(crate) fn path_in(data_folder: &Path) -> PathBuf {
    data_folder.join(JOURNAL_FILE_NAME)
}

/// Records the live tunnel. Best effort: a journal that cannot be written only
/// costs crash recovery, never the tunnel.
pub(crate) fn record(path: &Path, pid: u32) {
    let entry = JournalEntry {
        pid,
        started_at_secs: epoch_secs(),
    };
    let result = serde_json::to_vec(&entry)
        .map_err(std::io::Error::other)
        .and_then(|body| {
            // Write-then-rename: a crash mid-write must not leave a truncated
            // journal that the next startup cannot parse.
            let temporary = path.with_extension("json.tmp");
            std::fs::write(&temporary, body)?;
            std::fs::rename(&temporary, path)
        });
    if let Err(error) = result {
        log::warn!(
            "[remote-access] could not journal tunnel pid {pid} at {}: {error}",
            path.display()
        );
    }
}

pub(crate) fn clear(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// Whether a live process is the tunnel the journal describes.
fn is_our_orphan(
    entry: &JournalEntry,
    self_pid: u32,
    process_name: &str,
    process_started_at_secs: u64,
) -> bool {
    entry.pid != self_pid
        && process_started_at_secs.abs_diff(entry.started_at_secs) <= START_TIME_TOLERANCE_SECS
        && is_tunnel_name(process_name)
}

/// Ends the tunnel a previous, abnormally ended run left behind. Called once at
/// startup, before anything could have started a new one.
pub fn reap_orphan(data_folder: &Path) {
    let path = path_in(data_folder);
    let Ok(body) = std::fs::read(&path) else {
        return;
    };
    // Whatever it says, it describes a previous run; never read it twice.
    clear(&path);
    let entry: JournalEntry = match serde_json::from_slice(&body) {
        Ok(entry) => entry,
        Err(error) => {
            log::warn!(
                "[remote-access] ignoring unreadable {}: {error}",
                path.display()
            );
            return;
        }
    };

    let pid = Pid::from_u32(entry.pid);
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    let Some(process) = system.process(pid) else {
        return;
    };
    let name = process.name().to_string_lossy();
    if !is_our_orphan(&entry, std::process::id(), &name, process.start_time()) {
        log::warn!(
            "[remote-access] pid {} is no longer our tunnel ({name}); leaving it alone",
            entry.pid
        );
        return;
    }
    if process.kill() {
        log::warn!(
            "[remote-access] ended a tunnel (pid {}) orphaned by a previous run",
            entry.pid
        );
    }
}

/// Ends the tunnel by pid without owning its handle: the supervisor task owns
/// the `Child`, and the exit hook cannot await it. `true` when no tunnel of
/// ours is left under that pid afterwards.
///
/// The name is checked even here. This runs for a pid we recorded earlier, and
/// between then and now the process may have died and the number been reused:
/// whatever holds it under another name is not ours to end.
pub(crate) fn kill_pid(pid: u32) -> bool {
    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    match system.process(pid) {
        Some(process) if is_tunnel_name(&process.name().to_string_lossy()) => process.kill(),
        Some(_) | None => true,
    }
}

fn is_tunnel_name(process_name: &str) -> bool {
    process_name
        .to_ascii_lowercase()
        .starts_with(PROCESS_NAME_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(pid: u32, started_at_secs: u64) -> JournalEntry {
        JournalEntry {
            pid,
            started_at_secs,
        }
    }

    #[test]
    fn recording_and_clearing_round_trips_through_the_file() {
        let folder = tempfile::tempdir().unwrap();
        let path = path_in(folder.path());
        record(&path, 4242);
        let stored: JournalEntry = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored.pid, 4242);
        assert!(stored.started_at_secs > 0);
        assert!(
            !path.with_extension("json.tmp").exists(),
            "the temporary file must be renamed away"
        );
        clear(&path);
        assert!(!path.exists());
        // Clearing twice is fine.
        clear(&path);
    }

    #[test]
    fn only_a_cloudflared_with_a_matching_start_time_is_ours() {
        let journal = entry(900, 1_000_000);
        assert!(is_our_orphan(&journal, 1, "cloudflared", 1_000_002));
        assert!(is_our_orphan(&journal, 1, "cloudflared.exe", 999_998));
        assert!(is_our_orphan(&journal, 1, "Cloudflared", 1_000_000));
        // A reused pid: same number, another program.
        assert!(!is_our_orphan(&journal, 1, "postgres", 1_000_000));
        // The user's own cloudflared that happens to hold a recycled pid.
        assert!(!is_our_orphan(&journal, 1, "cloudflared", 1_003_600));
        // Never ourselves.
        assert!(!is_our_orphan(&journal, 900, "cloudflared", 1_000_000));
    }

    #[test]
    fn reaping_tolerates_a_missing_or_corrupt_journal_and_consumes_it() {
        let folder = tempfile::tempdir().unwrap();
        reap_orphan(folder.path());

        let path = path_in(folder.path());
        std::fs::write(&path, b"{ not json").unwrap();
        reap_orphan(folder.path());
        assert!(
            !path.exists(),
            "an unparseable journal must be discarded, not retried forever"
        );
    }

    #[test]
    fn a_journalled_pid_that_is_not_a_tunnel_is_left_alone() {
        let folder = tempfile::tempdir().unwrap();
        let path = path_in(folder.path());
        // This test process is alive, and is certainly not cloudflared.
        let body = serde_json::to_vec(&entry(std::process::id(), epoch_secs())).unwrap();
        std::fs::write(&path, body).unwrap();
        reap_orphan(folder.path());
        assert!(!path.exists());
        // Still here to assert it: reaping did not kill us.
    }

    #[test]
    fn killing_a_pid_that_is_already_gone_counts_as_gone() {
        // Far above any real pid range.
        assert!(kill_pid(u32::MAX - 7));
    }

    #[test]
    fn a_recycled_pid_under_another_name_is_not_killed() {
        // This test process is alive and is not cloudflared: "no tunnel of ours
        // is left under that pid" is true, and we are still here to assert it.
        assert!(kill_pid(std::process::id()));
        assert!(is_tunnel_name("cloudflared"));
        assert!(is_tunnel_name("Cloudflared.exe"));
        assert!(!is_tunnel_name("app_lib-ea443147ebcd30c5"));
    }
}
