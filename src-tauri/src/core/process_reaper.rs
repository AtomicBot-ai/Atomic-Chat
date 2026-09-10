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

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{Manager, Runtime};

use crate::core::app::commands::get_jan_data_folder_path;

/// Executable file-name prefixes for the backends we manage.
const BACKEND_NAME_PREFIXES: [&str; 2] = ["llama-server", "mlx-server"];

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

    // Collect victims first so we don't mutate while iterating the map.
    let victims: Vec<(sysinfo::Pid, String)> = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            if pid.as_u32() == self_pid {
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
