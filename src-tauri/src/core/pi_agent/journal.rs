use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use sysinfo::{Pid, ProcessesToUpdate, System};

#[derive(Serialize, Deserialize)]
struct Entry {
    pid: u32,
    started: u64,
}

pub fn record(dir: &Path, pid: Option<u32>) -> Result<PathBuf, String> {
    let pid = Pid::from_u32(pid.ok_or("Missing pi process id")?);
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    let started = system
        .process(pid)
        .map(|p| p.start_time())
        .filter(|s| *s != 0)
        .ok_or("Could not identify the pi process")?;
    let path = dir.join("process.json");
    super::profile::write_file(
        &path,
        &serde_json::to_vec(&Entry {
            pid: pid.as_u32(),
            started,
        })
        .map_err(|e| e.to_string())?,
    )?;
    Ok(path)
}

pub fn reap(data: &Path, binary: &Path) {
    let Ok(expected) = binary.canonicalize() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(data.join("pi-agent")) else {
        return;
    };
    let mut system = System::new();
    for dir in entries.flatten() {
        if !dir.file_name().to_string_lossy().starts_with("thread-")
            || !dir.file_type().is_ok_and(|t| t.is_dir())
        {
            continue;
        }
        let file = dir.path().join("process.json");
        let Ok(bytes) = std::fs::read(&file) else {
            continue;
        };
        if let Ok(entry) = serde_json::from_slice::<Entry>(&bytes) {
            let pid = Pid::from_u32(entry.pid);
            system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
            if let Some(process) = system.process(pid) {
                if entry.started != 0
                    && process.start_time() == entry.started
                    && process
                        .exe()
                        .and_then(|exe| exe.canonicalize().ok())
                        .as_ref()
                        == Some(&expected)
                {
                    #[cfg(unix)]
                    if let Ok(id) = i32::try_from(entry.pid) {
                        let _ = nix::sys::signal::killpg(
                            nix::unistd::Pid::from_raw(id),
                            nix::sys::signal::Signal::SIGKILL,
                        );
                    }
                    #[cfg(windows)]
                    {
                        let _ = std::process::Command::new("taskkill")
                            .args(["/PID", &entry.pid.to_string(), "/T", "/F"])
                            .status();
                    }
                }
            }
        }
        let _ = std::fs::remove_file(file);
    }
}
