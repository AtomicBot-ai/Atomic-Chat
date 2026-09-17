//! Starting a core process when no one owns the data folder yet.
//!
//! The app-owned core is spawned detached to survive a window closing into the
//! tray; full app exit instead explicitly shuts it down.
//!
//! Readiness is read from the lock file, not from the child's stdout. Two
//! starters can race for one data folder; the one that loses the lock exits,
//! and its caller should attach to the winner rather than report a failure. The
//! lock is the only thing that tells them apart.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::client::CoreError;
use super::lock::{self, LockRecord, LockState};

/// How long to wait for a freshly spawned core to publish a ready endpoint.
pub const START_TIMEOUT: Duration = Duration::from_secs(20);

const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Overrides the binary the app would otherwise start. This is how a developer
/// runs the core from source against a dev build of the app:
/// `ATOMIC_CORE_CMD="bun run ../atomic-chat-core/src/cli/bin.ts" yarn dev`.
/// `bin.ts`, not `main.ts`: `main.ts` is the injectable command table and has no
/// side effects on import, so running it starts nothing.
pub const CORE_COMMAND_ENV: &str = "ATOMIC_CORE_CMD";

/// The bundled core, under the app's resource directory.
pub const BUNDLED_CORE_RELATIVE: &str = "resources/bin/atomic-chat-app-core";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreCommand {
    pub program: String,
    /// Arguments that come before the subcommand (`run …/main.ts`).
    pub prefix: Vec<String>,
}

impl CoreCommand {
    /// The full argv for `daemon`, which is the only way the app starts a core:
    /// `--control-port 0` lets the OS pick, and the port is read back from the
    /// lock rather than guessed.
    pub fn daemon_args(&self, data_folder: &Path) -> Vec<String> {
        let mut args = self.prefix.clone();
        args.push("daemon".into());
        args.push("--data-folder".into());
        args.push(data_folder.to_string_lossy().to_string());
        args.push("--control-port".into());
        args.push("0".into());
        args
    }

    pub fn display(&self, data_folder: &Path) -> String {
        format!(
            "{} {}",
            self.program,
            self.daemon_args(data_folder).join(" ")
        )
    }
}

/// Split a command line into program and arguments.
///
/// Only double quotes are honoured, which is what the override needs: Windows
/// paths contain spaces, and a full shell grammar here would be a way to run
/// arbitrary shell from an environment variable.
pub fn split_command_line(line: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut have_current = false;
    for c in line.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                have_current = true;
            }
            c if c.is_whitespace() && !quoted => {
                if have_current {
                    parts.push(std::mem::take(&mut current));
                    have_current = false;
                }
            }
            c => {
                current.push(c);
                have_current = true;
            }
        }
    }
    if have_current {
        parts.push(current);
    }
    parts
}

/// Which core to start: the override if one is set, otherwise the binary
/// bundled with the app.
pub fn resolve_core_command(
    resource_dir: &Path,
    override_line: Option<&str>,
) -> Result<CoreCommand, CoreError> {
    if let Some(line) = override_line.map(str::trim).filter(|l| !l.is_empty()) {
        let mut parts = split_command_line(line).into_iter();
        let program = parts.next().ok_or_else(|| {
            CoreError::new(
                "INVALID_ARGUMENT",
                format!("{CORE_COMMAND_ENV} is set but contains no command"),
                None,
            )
        })?;
        return Ok(CoreCommand {
            program,
            prefix: parts.collect(),
        });
    }

    let bundled = bundled_core_path(resource_dir);
    if !bundled.exists() {
        return Err(CoreError::new(
            "CORE_NOT_INSTALLED",
            "This build has no Atomic Chat core to start.",
            Some(format!(
                "expected {} — run `yarn download:core`, or set {CORE_COMMAND_ENV}",
                bundled.display()
            )),
        ));
    }
    Ok(CoreCommand {
        program: bundled.to_string_lossy().to_string(),
        prefix: Vec::new(),
    })
}

pub fn bundled_core_path(resource_dir: &Path) -> PathBuf {
    let mut path = resource_dir.join(BUNDLED_CORE_RELATIVE);
    if cfg!(windows) {
        path.set_extension("exe");
    }
    path
}

/// Cores this process started, kept only so they can be reaped.
///
/// A core we spawn is our child in the POSIX sense whatever else we do to
/// detach it, and a child that dies stays a zombie until its parent waits on
/// it. That is not a cosmetic leak: a zombie still has a PID, `ps` still lists
/// it with its original start time, and a replacement core reading the stale
/// lock therefore concludes the old owner is alive and refuses to take the data
/// folder over. A crashed core could never be restarted while the app ran.
///
/// So we keep the handles — never to signal them, only to call `try_wait` and
/// let the kernel release the dead ones.
static SPAWNED: std::sync::OnceLock<std::sync::Mutex<Vec<std::process::Child>>> =
    std::sync::OnceLock::new();

fn spawned() -> &'static std::sync::Mutex<Vec<std::process::Child>> {
    SPAWNED.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

/// Release any core of ours that has exited. Cheap, non-blocking, and safe to
/// call often: `try_wait` never signals a process that is still running.
pub fn reap_finished() -> usize {
    let mut children = spawned().lock().unwrap();
    let before = children.len();
    children.retain_mut(|child| !matches!(child.try_wait(), Ok(Some(_))));
    before - children.len()
}

/// Start a core and wait until it publishes a ready endpoint.
///
/// Returns the record of whichever core ends up owning the folder — which may
/// not be the one we spawned, if another starter won the lock first.
pub async fn launch_and_wait(
    command: &CoreCommand,
    data_folder: &Path,
    timeout: Duration,
) -> Result<LockRecord, CoreError> {
    // Before deciding anything from the lock: a dead core of ours still holding
    // a PID would make both us and the core we are about to start misread it.
    let reaped = reap_finished();
    if reaped > 0 {
        log::info!("[atomic-core] released {reaped} exited core process(es)");
    }
    log::info!("[atomic-core] starting: {}", command.display(data_folder));
    let mut child = spawn_detached(command, data_folder)?;

    let deadline = Instant::now() + timeout;
    loop {
        let mut system = sysinfo::System::new();
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        if let LockState::Owned(record) = lock::inspect(data_folder, &system) {
            if record.is_ready() {
                // Hand the core over to the reaper list and stop thinking about
                // it: it outlives us, and we will never signal it.
                spawned().lock().unwrap().push(child);
                return Ok(record);
            }
        }

        // A core that exited is only a failure if nobody else took the folder;
        // losing the lock race is a normal outcome, not an error to report.
        if let Ok(Some(status)) = child.try_wait() {
            let ready = wait_for_ready_owner(data_folder, deadline).await;
            return ready.ok_or_else(|| {
                CoreError::new(
                    "CORE_START_FAILED",
                    "The Atomic Chat core exited before it was ready.",
                    Some(format!(
                        "{} exited with {status}{}",
                        command.program,
                        start_log_tail(data_folder)
                    )),
                )
            });
        }

        if Instant::now() >= deadline {
            let _ = child.kill();
            spawned().lock().unwrap().push(child);
            return Err(CoreError::new(
                "CORE_START_FAILED",
                "The Atomic Chat core did not become ready in time.",
                Some(format!(
                    "waited {}s for {}{}",
                    timeout.as_secs(),
                    lock::instance_lock_path(data_folder).display(),
                    start_log_tail(data_folder)
                )),
            ));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Name of the file a starting core's stderr is redirected to.
///
/// Without it a failed start is an exit code and nothing else — the core's own
/// log file is only opened once it is far enough along to have one, so whatever
/// killed it early is exactly what goes missing.
pub const START_LOG_FILE: &str = "core-start.log";

/// The last few lines of that file, formatted for an error's details.
fn start_log_tail(data_folder: &Path) -> String {
    let Ok(text) = std::fs::read_to_string(lock::core_dir(data_folder).join(START_LOG_FILE)) else {
        return String::new();
    };
    let tail: Vec<&str> = text.lines().rev().take(10).collect();
    if tail.is_empty() {
        return String::new();
    }
    format!(
        "\n{}",
        tail.into_iter().rev().collect::<Vec<_>>().join("\n")
    )
}

/// Open the start log, truncating it so a failure shows this start rather than
/// the history of every previous one. A failure to open it is not a reason not
/// to start the core.
fn start_log(data_folder: &Path) -> Stdio {
    let dir = lock::core_dir(data_folder);
    if std::fs::create_dir_all(&dir).is_err() {
        return Stdio::null();
    }
    std::fs::File::create(dir.join(START_LOG_FILE)).map_or(Stdio::null(), Stdio::from)
}

/// Poll the lock for a ready owner until the deadline. Used after our own
/// child exited, to find the core that beat it to the folder.
async fn wait_for_ready_owner(data_folder: &Path, deadline: Instant) -> Option<LockRecord> {
    loop {
        let mut system = sysinfo::System::new();
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        if let LockState::Owned(record) = lock::inspect(data_folder, &system) {
            if record.is_ready() {
                return Some(record);
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

fn spawn_detached(
    command: &CoreCommand,
    data_folder: &Path,
) -> Result<std::process::Child, CoreError> {
    // The environment is inherited as-is: `process_env`'s AppImage stripping is
    // for host executables like `curl` or a terminal, and the core is the
    // opposite of that — it loads the llama.cpp libraries the AppImage brings,
    // so removing `LD_LIBRARY_PATH` would break every backend it starts.
    let mut cmd = Command::new(&command.program);
    cmd.args(command.daemon_args(data_folder))
        .stdin(Stdio::null())
        // Readiness is read from the lock, so stdout is not needed — and a pipe
        // we stopped reading would eventually block the core on a full buffer.
        // stderr goes to a file instead of a pipe for the same reason: it has
        // to survive us letting go of the process.
        .stdout(Stdio::null())
        .stderr(start_log(data_folder));

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own session: a signal sent to the app's process group — Ctrl+C in
        // a dev terminal, a group kill on quit — must not reach the core.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }

    cmd.spawn().map_err(|e| {
        CoreError::new(
            "CORE_START_FAILED",
            "Could not start the Atomic Chat core.",
            Some(format!("{}: {e}", command.program)),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_whitespace_and_keeps_quoted_paths_whole() {
        assert_eq!(
            split_command_line("bun run ../atomic-chat-core/src/cli/main.ts"),
            vec!["bun", "run", "../atomic-chat-core/src/cli/main.ts"]
        );
        assert_eq!(
            split_command_line(r#""C:\Program Files\core.exe" --flag"#),
            vec![r"C:\Program Files\core.exe", "--flag"]
        );
        assert_eq!(split_command_line("   "), Vec::<String>::new());
        assert_eq!(
            split_command_line(r#"a "" b"#),
            vec!["a", "", "b"],
            "an explicit empty argument is not the same as no argument"
        );
    }

    #[test]
    fn the_override_wins_over_the_bundled_binary() {
        let dir = tempfile::tempdir().unwrap();

        let command = resolve_core_command(dir.path(), Some("bun run main.ts")).unwrap();

        assert_eq!(command.program, "bun");
        assert_eq!(command.prefix, vec!["run", "main.ts"]);
    }

    #[test]
    fn an_empty_override_falls_through_to_the_bundle() {
        let dir = tempfile::tempdir().unwrap();

        // No bundled binary either, so the error names what is missing rather
        // than silently doing nothing.
        let error = resolve_core_command(dir.path(), Some("   ")).unwrap_err();

        assert_eq!(error.code, "CORE_NOT_INSTALLED");
    }

    #[test]
    fn finds_the_bundled_core_under_the_resource_directory() {
        let dir = tempfile::tempdir().unwrap();
        let bundled = bundled_core_path(dir.path());
        std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        std::fs::write(&bundled, b"#!/bin/sh\n").unwrap();

        let command = resolve_core_command(dir.path(), None).unwrap();

        assert_eq!(command.program, bundled.to_string_lossy());
        assert!(command.prefix.is_empty());
    }

    #[test]
    fn a_build_with_no_core_says_how_to_get_one() {
        let dir = tempfile::tempdir().unwrap();

        let error = resolve_core_command(dir.path(), None).unwrap_err();

        assert_eq!(error.code, "CORE_NOT_INSTALLED");
        assert!(error.details.unwrap().contains("download:core"));
    }

    #[test]
    fn the_daemon_argv_pins_the_folder_and_lets_the_os_pick_the_port() {
        let command = CoreCommand {
            program: "core".into(),
            prefix: vec!["run".into()],
        };

        assert_eq!(
            command.daemon_args(Path::new("/data")),
            vec![
                "run",
                "daemon",
                "--data-folder",
                "/data",
                "--control-port",
                "0"
            ]
        );
    }

    #[tokio::test]
    async fn a_command_that_does_not_exist_fails_to_start() {
        let dir = tempfile::tempdir().unwrap();
        let command = CoreCommand {
            program: "atomic-core-that-does-not-exist".into(),
            prefix: Vec::new(),
        };

        let error = launch_and_wait(&command, dir.path(), Duration::from_millis(200))
            .await
            .unwrap_err();

        assert_eq!(error.code, "CORE_START_FAILED");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn a_core_that_exits_without_taking_the_lock_is_a_start_failure() {
        let dir = tempfile::tempdir().unwrap();
        let command = CoreCommand {
            program: "/bin/sh".into(),
            prefix: vec!["-c".into(), "exit 3".into(), "sh".into()],
        };

        let error = launch_and_wait(&command, dir.path(), Duration::from_millis(500))
            .await
            .unwrap_err();

        assert_eq!(error.code, "CORE_START_FAILED");
        assert!(
            error.message.contains("exited"),
            "the user needs to know it died, not that we timed out: {}",
            error.message
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn a_core_that_died_is_released_rather_than_left_holding_its_pid() {
        // The bug this guards: a killed core stays a zombie under the app, `ps`
        // still reports it with its original start time, and the replacement
        // core reads the stale lock, decides the owner is alive and refuses the
        // folder. Reaping is what makes both sides agree that it is gone.
        let dir = tempfile::tempdir().unwrap();
        let command = CoreCommand {
            program: "/bin/sh".into(),
            prefix: vec!["-c".into(), "exit 0".into(), "sh".into()],
        };
        let _ = launch_and_wait(&command, dir.path(), Duration::from_millis(300)).await;
        let child = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let pid = child.id();
        spawned().lock().unwrap().push(child);
        tokio::time::sleep(Duration::from_millis(100)).await;

        assert!(reap_finished() >= 1, "pid {pid} should have been released");
        assert_eq!(reap_finished(), 0, "nothing left to release");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn a_failed_start_reports_what_the_core_printed() {
        let dir = tempfile::tempdir().unwrap();
        let command = CoreCommand {
            program: "/bin/sh".into(),
            prefix: vec![
                "-c".into(),
                "echo 'CORE_ALREADY_RUNNING: another core owns this folder' >&2; exit 1".into(),
                "sh".into(),
            ],
        };

        let error = launch_and_wait(&command, dir.path(), Duration::from_millis(500))
            .await
            .unwrap_err();

        assert!(
            error.details.unwrap().contains("CORE_ALREADY_RUNNING"),
            "an exit code alone leaves nobody able to say why it failed"
        );
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn a_core_that_never_becomes_ready_times_out_naming_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        let command = CoreCommand {
            program: "/bin/sh".into(),
            prefix: vec!["-c".into(), "sleep 30".into(), "sh".into()],
        };

        let error = launch_and_wait(&command, dir.path(), Duration::from_millis(300))
            .await
            .unwrap_err();

        assert_eq!(error.code, "CORE_START_FAILED");
        assert!(error.details.unwrap().contains("instance.lock"));
    }
}
