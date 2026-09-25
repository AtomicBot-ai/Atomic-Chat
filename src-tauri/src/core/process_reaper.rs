//! Startup reaper for orphaned model-backend processes.
//!
//! The engine plugins spawn long-lived child processes (`llama-server`,
//! `mlx-server`). On a *graceful* quit we tear them down via `RunEvent::Exit`
//! (and `kill_on_drop` catches the normal `Child` drop). But none of that runs
//! when the app dies abnormally — a crash, an OOM kill, a Force Quit, or any
//! `SIGKILL`. In those cases the backends are re-parented to `launchd`/`init`
//! (ppid = 1) and keep holding RAM, GPU/Metal contexts and TCP ports forever.
//!
//! Users hit exactly this: after a few abnormal exits, several stale
//! `llama-server`/`mlx-server` processes pile up and starve the machine, so the
//! next launch "freezes everything". Because the app enforces single-instance,
//! any backend of *ours* still alive at startup can only be such an orphan — so
//! we reap them before spawning anything new, guaranteeing a clean slate.
//!
//! Matching is deliberately conservative: a victim must both (a) be named like
//! one of our backends and (b) execute from inside a directory this app owns
//! (its data folder, where llama.cpp backends are downloaded, or its bundled
//! resource dir, where `mlx-server` ships). That avoids ever touching an
//! unrelated process that merely shares a name.
//!
//! The single-instance assumption above stops holding once `atomic-chat-core`
//! ships: a CLI can own the same data folder and have models loaded right now,
//! and its backends live under exactly the directories we scan. So before
//! reaping we look for a live core owner (`<data>/atomic-core/instance.lock`)
//! and spare every process that owner registered in its journal
//! (`<data>/atomic-core/processes.json`). A dead owner protects nothing — its
//! leftovers are orphans like any other.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{Manager, Runtime};

use crate::core::app::commands::get_jan_data_folder_path;

/// Executable file-name prefixes for the backends we manage.
const BACKEND_NAME_PREFIXES: [&str; 3] = ["llama-server", "mlx-server", "sd-server"];

/// How long to wait after `SIGTERM` before escalating survivors to `SIGKILL`.
const GRACE_PERIOD: Duration = Duration::from_millis(1500);

fn is_backend_name(name: &str) -> bool {
    BACKEND_NAME_PREFIXES
        .iter()
        .any(|prefix| name == *prefix || name.starts_with(prefix))
}

fn exe_under_any_root(exe: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| exe.starts_with(root))
}

/// PIDs the journal attributes to `instance_id`, plus the owner itself.
///
/// Entries from a *previous* core instance are deliberately not protected: that
/// owner is gone, so its leftovers are exactly what the reaper exists for.
fn journalled_pids(
    journal_text: &str,
    instance_id: &str,
    owner_pid: u32,
) -> std::collections::HashSet<u32> {
    use std::collections::HashSet;
    let mut protected: HashSet<u32> = HashSet::new();
    protected.insert(owner_pid);
    let Ok(journal) = serde_json::from_str::<serde_json::Value>(journal_text) else {
        return protected;
    };
    let Some(entries) = journal.get("processes").and_then(|v| v.as_array()) else {
        return protected;
    };
    for entry in entries {
        if entry.get("instance_id").and_then(|v| v.as_str()) != Some(instance_id) {
            continue;
        }
        if let Some(pid) = entry.get("pid").and_then(|v| v.as_u64()) {
            protected.insert(pid as u32);
        }
    }
    protected
}

/// The backend PIDs a live core owner is responsible for right now.
///
/// Returns an empty set unless the shared lock parser proves the owner process
/// is still the same PID incarnation that wrote the record. Process names are
/// deliberately not evidence: a source checkout runs as `bun`, while PID plus
/// start identity is what excludes a recycled, unrelated process.
fn core_owned_pids(data_folder: &Path, system: &sysinfo::System) -> std::collections::HashSet<u32> {
    use crate::core::atomic_core::lock::{self, LockState};
    use std::collections::HashSet;

    let empty = HashSet::new();
    // One reader for the lock, shared with the supervisor: two parsers of the
    // same record would eventually disagree about who is alive, and here that
    // disagreement means killing a live core's backends.
    let record = match lock::inspect(data_folder, system) {
        LockState::Owned(record) => record,
        LockState::Stale(_) | LockState::Corrupt | LockState::Free => {
            log::info!("[reaper] no live core owner for {}", data_folder.display());
            return empty;
        }
    };

    let journal_text = std::fs::read_to_string(lock::core_dir(data_folder).join("processes.json"))
        .unwrap_or_default();
    let protected = journalled_pids(&journal_text, &record.instance_id, record.pid);

    log::info!(
        "[reaper] live core owner pid={} instance={}; sparing {} process(es)",
        record.pid,
        record.instance_id,
        protected.len()
    );
    protected
}

/// A core writes its model claim before spawning and journals the child only after readiness.
/// During that gap the app cannot map a just-created backend PID yet, so it must defer reaping.
fn core_has_live_loading_claim(data_folder: &Path, system: &sysinfo::System) -> bool {
    let claims = data_folder.join("atomic-core").join("model-claims");
    let Ok(entries) = std::fs::read_dir(claims) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let Ok(text) = std::fs::read_to_string(entry.path().join("claim.json")) else {
            return false;
        };
        let Ok(claim) = serde_json::from_str::<serde_json::Value>(&text) else {
            return false;
        };
        if claim.get("owner_kind").and_then(|v| v.as_str()) != Some("core")
            || claim.get("state").and_then(|v| v.as_str()) != Some("loading")
        {
            return false;
        }
        let Some(pid) = claim.get("owner_pid").and_then(|v| v.as_u64()) else {
            return false;
        };
        let Some(process) = system.process(sysinfo::Pid::from_u32(pid as u32)) else {
            return false;
        };
        match claim.get("owner_started_at").and_then(|v| v.as_str()) {
            Some(expected) => expected == format!("epoch:{}", process.start_time()),
            None => true,
        }
    })
}

/// Kill any leftover backend processes belonging to this app before we spawn
/// new ones. Best-effort and non-fatal: failures are logged, never propagated.
///
/// Runs synchronously (it must finish before the engines start binding ports /
/// GPU) but only sleeps for [`GRACE_PERIOD`] when it actually found victims, so
/// a healthy startup pays effectively nothing.
pub fn reap_orphan_backends<R: Runtime>(app: &tauri::AppHandle<R>) {
    use sysinfo::{ProcessesToUpdate, Signal, System};

    // Directories we own. `llama-server` is downloaded under the data folder;
    // `mlx-server` is bundled under the resource dir. Both are checked so a
    // process only qualifies if it runs from inside one of them.
    let mut roots: Vec<PathBuf> = vec![get_jan_data_folder_path(app.clone())];
    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push(resource_dir);
    }
    // Drop roots that failed to resolve to something meaningful.
    roots.retain(|r| !r.as_os_str().is_empty());
    if roots.is_empty() {
        log::warn!("[reaper] no known app directories to scan; skipping");
        return;
    }

    let self_pid = std::process::id();

    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);

    if core_has_live_loading_claim(&roots[0], &system) {
        log::info!("[reaper] core is loading a model; deferring orphan cleanup");
        return;
    }

    // A core owner that is alive right now is using these backends; they are not orphans.
    let protected = core_owned_pids(&roots[0].clone(), &system);

    // Collect victims first so we don't mutate while iterating the map.
    let victims: Vec<(sysinfo::Pid, String)> = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            if pid.as_u32() == self_pid || protected.contains(&pid.as_u32()) {
                return None;
            }
            let name = process.name().to_string_lossy();
            if !is_backend_name(&name) {
                return None;
            }
            let exe = process.exe()?;
            if exe_under_any_root(exe, &roots) {
                Some((*pid, exe.to_string_lossy().into_owned()))
            } else {
                None
            }
        })
        .collect();

    if victims.is_empty() {
        // Also print directly: the reaper runs so early in `setup()` that the
        // file log target may not be attached yet, so `log::` alone can miss
        // app.log. `eprintln!` guarantees the line is visible in the terminal.
        eprintln!("[reaper] no orphaned backend processes at startup");
        log::info!("[reaper] no orphaned backend processes at startup");
        return;
    }

    eprintln!(
        "[reaper] found {} orphaned backend process(es) from a previous run; terminating",
        victims.len()
    );
    log::warn!(
        "[reaper] found {} orphaned backend process(es) from a previous run; terminating",
        victims.len()
    );

    for (pid, exe) in &victims {
        log::warn!("[reaper] SIGTERM orphaned backend pid={pid} exe={exe}");
        if let Some(process) = system.process(*pid) {
            process.kill_with(Signal::Term);
        }
    }

    std::thread::sleep(GRACE_PERIOD);
    system.refresh_processes(ProcessesToUpdate::All, true);

    let mut killed = 0usize;
    for (pid, exe) in &victims {
        if let Some(process) = system.process(*pid) {
            log::warn!("[reaper] SIGTERM ignored, sending SIGKILL pid={pid} exe={exe}");
            process.kill();
        }
        killed += 1;
    }

    eprintln!("[reaper] reaped {killed} orphaned backend process(es)");
    log::info!("[reaper] reaped {killed} orphaned backend process(es)");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_exact_backend_names() {
        assert!(is_backend_name("llama-server"));
        assert!(is_backend_name("mlx-server"));
    }

    #[test]
    fn matches_platform_suffixed_backend_names() {
        // macOS/Windows may report a suffixed executable name.
        assert!(is_backend_name("llama-server-bin"));
        assert!(is_backend_name("mlx-server.exe"));
    }

    #[test]
    fn rejects_unrelated_names() {
        assert!(!is_backend_name("server"));
        assert!(!is_backend_name("Atomic Chat"));
        assert!(!is_backend_name("node"));
        assert!(!is_backend_name("my-llama-server")); // prefix must be at the start
    }

    #[test]
    fn protects_the_live_owner_and_the_backends_it_registered() {
        let journal = r#"{
            "version": 1,
            "processes": [
                {"instance_id": "live", "pid": 4242, "model_id": "a"},
                {"instance_id": "live", "pid": 4243, "model_id": "b"},
                {"instance_id": "a-dead-owner", "pid": 999, "model_id": "old"}
            ]
        }"#;
        let protected = journalled_pids(journal, "live", 100);
        assert!(protected.contains(&100), "the owner process itself");
        assert!(protected.contains(&4242));
        assert!(protected.contains(&4243));
        assert!(
            !protected.contains(&999),
            "a previous instance's backend is an orphan, not something to spare"
        );
        assert_eq!(protected.len(), 3);
    }

    #[test]
    fn a_missing_or_broken_journal_still_protects_the_owner() {
        assert_eq!(journalled_pids("", "live", 7), [7].into_iter().collect());
        assert_eq!(
            journalled_pids("{ not json", "live", 7),
            [7].into_iter().collect()
        );
        assert_eq!(journalled_pids("{}", "live", 7), [7].into_iter().collect());
        assert_eq!(
            journalled_pids(r#"{"processes": "nope"}"#, "live", 7),
            [7].into_iter().collect()
        );
    }

    #[test]
    fn exe_must_live_under_an_owned_root() {
        let data = PathBuf::from("/Users/x/Library/Application Support/Atomic Chat/data");
        let resource = PathBuf::from("/Applications/Atomic Chat.app/Contents/Resources");
        let roots = vec![data.clone(), resource.clone()];

        // llama-server downloaded under the data folder → owned.
        assert!(exe_under_any_root(
            &data.join("llamacpp-upstream/backends/b1/macos-arm64/build/bin/llama-server"),
            &roots
        ));
        // mlx-server bundled under resources → owned.
        assert!(exe_under_any_root(&resource.join("bin/mlx-server"), &roots));
        // Same-named binary living elsewhere → NOT ours, must be spared.
        assert!(!exe_under_any_root(
            &PathBuf::from("/opt/homebrew/bin/llama-server"),
            &roots
        ));
        assert!(!exe_under_any_root(
            &PathBuf::from("/tmp/mlx-server"),
            &roots
        ));
    }
}
