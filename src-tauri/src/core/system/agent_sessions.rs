//! The agents Atomic Chat opened in a terminal, while they still run.
//!
//! A model switch asks before it cuts off an agent the app opened, and on the
//! user's yes stops it and opens it again for the new model. Both need the
//! agent's process. On macOS and Linux the launcher writes its own pid to a
//! file made for it before it `exec`s the agent, so that pid is the agent's.
//! On Windows the app starts the console itself and keeps its pid; the agent
//! runs under it.
//!
//! A pid is believed only while the process holds the start time first seen
//! for it, and a pid read from a file only when that process started after the
//! terminal was opened: a reused pid is never reported, let alone stopped.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sysinfo::{Pid, ProcessStatus, ProcessesToUpdate, System};

/// How far a process's start time may differ from what was recorded (or
/// precede the terminal's opening) before the pid is no longer believed ours.
const START_TIME_TOLERANCE_SECS: u64 = 5;
/// How often a stop looks whether the agent has exited.
const STOP_POLL: Duration = Duration::from_millis(100);
/// How long a stopped agent may take to exit before it is killed.
pub(crate) const STOP_GRACE: Duration = Duration::from_secs(3);

/// Where an agent's process comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Root {
    /// The launcher writes the agent's pid into this file (macOS, Linux).
    #[cfg_attr(windows, allow(dead_code))]
    PidFile(PathBuf),
    /// The console the app started (Windows). The agent runs under it, and
    /// the console stays at a prompt once the agent exits.
    #[cfg_attr(not(windows), allow(dead_code))]
    Console,
}

#[derive(Clone, Debug)]
struct Session {
    model: Option<String>,
    root: Root,
    /// The root process and its start time, once seen.
    process: Option<(u32, u64)>,
    opened_at_secs: u64,
}

/// An agent Atomic Chat opened that still runs.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionInfo {
    /// The `integrations.ts` id.
    pub agent_id: String,
    /// The model it was opened for.
    pub model: Option<String>,
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn snapshot() -> System {
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    system
}

fn alive(system: &System, pid: u32) -> Option<u64> {
    let process = system.process(Pid::from_u32(pid))?;
    if matches!(
        process.status(),
        ProcessStatus::Zombie | ProcessStatus::Dead
    ) {
        return None;
    }
    Some(process.start_time())
}

/// Replace what is known about `agent_id` with a new terminal. A pid file of
/// the session it replaces is removed.
fn track(agent_id: &str, session: Session) {
    let previous = sessions()
        .lock()
        .ok()
        .and_then(|mut all| all.insert(agent_id.to_string(), session));
    if let Some(Session {
        root: Root::PidFile(path),
        ..
    }) = previous
    {
        let _ = std::fs::remove_file(path);
    }
}

/// A terminal whose launcher writes the agent's pid to `pid_file`.
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn track_pid_file(agent_id: &str, model: Option<String>, pid_file: PathBuf) {
    track(
        agent_id,
        Session {
            model,
            root: Root::PidFile(pid_file),
            process: None,
            opened_at_secs: now_secs(),
        },
    );
}

/// A console the app started with pid `pid`, the agent running under it.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn track_console(agent_id: &str, model: Option<String>, pid: u32) {
    let process = alive(&snapshot(), pid).map(|start| (pid, start));
    track(
        agent_id,
        Session {
            model,
            root: Root::Console,
            process,
            opened_at_secs: now_secs(),
        },
    );
}

/// The pid the launcher wrote, when it ran.
fn read_pid_file(path: &PathBuf) -> Option<u32> {
    std::fs::read_to_string(path)
        .ok()?
        .trim()
        .parse::<u32>()
        .ok()
        .filter(|pid| *pid > 1)
}

/// The session's root process while it is still the one first seen. Learns it
/// from the pid file the first time the launcher has written it.
fn resolve(session: &mut Session, system: &System) -> Option<u32> {
    if let Some((pid, start)) = session.process {
        return alive(system, pid)
            .filter(|actual| actual.abs_diff(start) <= START_TIME_TOLERANCE_SECS)
            .map(|_| pid);
    }
    let Root::PidFile(path) = &session.root else {
        return None;
    };
    let pid = read_pid_file(path)?;
    let start = alive(system, pid)?;
    // Started before the terminal opened: not the launcher's process.
    if start + START_TIME_TOLERANCE_SECS < session.opened_at_secs {
        return None;
    }
    session.process = Some((pid, start));
    Some(pid)
}

/// `root` and every process below it, children before their parents.
fn tree(system: &System, root: u32) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, process) in system.processes() {
        if let Some(parent) = process.parent() {
            children
                .entry(parent.as_u32())
                .or_default()
                .push(pid.as_u32());
        }
    }
    let mut order = vec![root];
    let mut seen: HashSet<u32> = HashSet::from([root]);
    let mut i = 0;
    while i < order.len() {
        if let Some(below) = children.get(&order[i]) {
            for pid in below {
                if seen.insert(*pid) {
                    order.push(*pid);
                }
            }
        }
        i += 1;
    }
    order.reverse();
    order
}

/// Whether the session's agent runs: its own process (a pid file), or a
/// process under the console (Windows) — a console back at its prompt holds
/// no agent.
fn agent_runs(session: &mut Session, system: &System) -> bool {
    let Some(root) = resolve(session, system) else {
        return false;
    };
    match session.root {
        Root::PidFile(_) => true,
        Root::Console => tree(system, root).len() > 1,
    }
}

/// The agents Atomic Chat opened that still run.
pub(crate) fn running() -> Vec<AgentSessionInfo> {
    let system = snapshot();
    let Ok(mut all) = sessions().lock() else {
        return Vec::new();
    };
    let mut found: Vec<AgentSessionInfo> = all
        .iter_mut()
        .filter_map(|(agent_id, session)| {
            agent_runs(session, &system).then(|| AgentSessionInfo {
                agent_id: agent_id.clone(),
                model: session.model.clone(),
            })
        })
        .collect();
    found.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
    found
}

/// Ask every process of `pids` to exit (SIGTERM; on Windows there is no such
/// request, so they are ended at once).
fn ask_to_exit(system: &System, pids: &[u32]) {
    for pid in pids {
        if let Some(process) = system.process(Pid::from_u32(*pid)) {
            #[cfg(unix)]
            {
                if process.kill_with(sysinfo::Signal::Term).is_none() {
                    process.kill();
                }
            }
            #[cfg(not(unix))]
            {
                process.kill();
            }
        }
    }
}

/// Stop the agent Atomic Chat opened as `agent_id` and everything it started,
/// waiting up to `grace` for it to exit before killing what is left. Answers
/// whether an agent was running. The session is forgotten either way; on
/// macOS the Terminal tab is kept, so the next open runs in it.
pub(crate) fn stop(agent_id: &str, grace: Duration) -> bool {
    let system = snapshot();
    let session = sessions()
        .lock()
        .ok()
        .and_then(|mut all| all.remove(agent_id));
    let Some(mut session) = session else {
        return false;
    };
    let root = resolve(&mut session, &system);
    if let Root::PidFile(path) = &session.root {
        let _ = std::fs::remove_file(path);
    }
    let Some(root) = root else {
        return false;
    };
    let pids = tree(&system, root);
    // A console back at its prompt has no agent; it is closed all the same,
    // so the agent opens again in one window rather than beside an old one.
    let had_agent = match session.root {
        Root::PidFile(_) => true,
        Root::Console => pids.len() > 1,
    };
    let start = alive(&system, root);
    ask_to_exit(&system, &pids);

    let deadline = Instant::now() + grace;
    loop {
        let system = snapshot();
        let left: Vec<u32> = pids
            .iter()
            .copied()
            .filter(|pid| alive(&system, *pid).is_some())
            .collect();
        if left.is_empty() {
            break;
        }
        if Instant::now() >= deadline {
            for pid in left {
                // The root is killed only while it is still the one stopped.
                if pid == root && alive(&system, pid) != start {
                    continue;
                }
                if let Some(process) = system.process(Pid::from_u32(pid)) {
                    process.kill();
                }
            }
            break;
        }
        std::thread::sleep(STOP_POLL);
    }
    log::info!("Stopped the {} agent Atomic Chat opened", agent_id);
    had_agent
}

#[cfg(test)]
fn clear() {
    if let Ok(mut all) = sessions().lock() {
        all.clear();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    /// The registry is process-wide; the tests that use it run one at a time.
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    fn wait_for(mut done: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if done() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    /// What the launcher does: write `$$`, then exec the agent (here `sleep`,
    /// with a child of its own so the whole tree is covered).
    fn launch(pid_file: &std::path::Path) -> std::process::Child {
        Command::new("/bin/sh")
            .arg("-c")
            .arg(format!(
                "printf '%s' \"$$\" > '{}'; exec /bin/sh -c 'sleep 30 & wait'",
                pid_file.display()
            ))
            .stdout(Stdio::null())
            .spawn()
            .unwrap()
    }

    #[test]
    fn a_launched_agent_runs_until_stopped_with_its_children() {
        let _guard = serial();
        clear();
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("agent.pid");
        std::fs::write(&pid_file, "").unwrap();
        track_pid_file("codex", Some("qwen".into()), pid_file.clone());
        let mut child = launch(&pid_file);

        assert!(wait_for(|| !running().is_empty()));
        assert_eq!(
            running(),
            vec![AgentSessionInfo {
                agent_id: "codex".into(),
                model: Some("qwen".into())
            }]
        );
        // The `sleep` below the agent appears once the shell forks it.
        assert!(wait_for(|| tree(&snapshot(), child.id()).len() > 1));
        let sleeper = *tree(&snapshot(), child.id()).first().unwrap();

        assert!(stop("codex", STOP_GRACE));
        let _ = child.wait();
        assert!(wait_for(|| alive(&snapshot(), sleeper).is_none()));
        assert!(running().is_empty());
        assert!(!pid_file.exists());
        assert!(!stop("codex", STOP_GRACE));
    }

    #[test]
    fn a_launcher_that_never_ran_is_not_running() {
        let _guard = serial();
        clear();
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("agent.pid");
        std::fs::write(&pid_file, "").unwrap();
        track_pid_file("pi", None, pid_file);
        assert!(running().is_empty());
        assert!(!stop("pi", STOP_GRACE));
    }

    #[test]
    fn a_pid_older_than_the_terminal_is_not_believed() {
        let _guard = serial();
        clear();
        let mut bystander = Command::new("sleep").arg("30").spawn().unwrap();
        assert!(wait_for(|| alive(&snapshot(), bystander.id()).is_some()));
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("agent.pid");
        std::fs::write(&pid_file, bystander.id().to_string()).unwrap();
        track_pid_file("opencode", None, pid_file);
        // The terminal opened well after the pid in the file started.
        if let Ok(mut all) = sessions().lock() {
            all.get_mut("opencode").unwrap().opened_at_secs = now_secs() + 60;
        }
        assert!(running().is_empty());
        assert!(!stop("opencode", Duration::from_millis(100)));
        assert!(alive(&snapshot(), bystander.id()).is_some());
        let _ = bystander.kill();
        let _ = bystander.wait();
    }

    #[test]
    fn a_newer_terminal_replaces_the_session_and_its_pid_file() {
        let _guard = serial();
        clear();
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first.pid");
        let second = dir.path().join("second.pid");
        std::fs::write(&first, "").unwrap();
        std::fs::write(&second, "").unwrap();
        track_pid_file("goose", None, first.clone());
        track_pid_file("goose", Some("gemma".into()), second.clone());
        assert!(!first.exists());
        assert!(second.exists());
        clear();
    }
}
