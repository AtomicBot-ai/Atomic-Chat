//! Running agent installers and short probes without hanging on them.
//!
//! An installer's stdout and stderr are drained on their own threads: reading
//! one to the end before the other deadlocks as soon as the other fills its
//! pipe buffer (uv writes its progress to stderr). Every line is decoded with
//! [`decode_console_bytes`], so one line in the console code page does not end
//! the log, and a deadline stops an installer that waits for input it will
//! never get.

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::commands::decode_console_bytes;

/// How long an agent installer (including a Node.js bootstrap through winget)
/// may run. Generous: a native agent download is a few hundred MB.
pub(crate) const INSTALLER_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// Output kept to classify a failure (network or not); the log streams it all.
const CAPTURE_LIMIT: usize = 16_384;

/// Once the process exits, how long a grandchild it left running may keep its
/// pipes open before we stop reading them.
const PIPE_GRACE: Duration = Duration::from_secs(5);

/// How a streamed process ended.
#[derive(Debug)]
pub(crate) enum StreamEnd {
    Exited(ExitStatus),
    /// Still running at the deadline; it and its children were killed.
    TimedOut,
}

/// Spawn `cmd`, hand every line of its stdout and stderr to `on_line` as it
/// arrives, and wait for it at most `timeout`. Also returns the first
/// [`CAPTURE_LIMIT`] bytes of output.
pub(crate) fn run_streaming(
    mut cmd: Command,
    timeout: Duration,
    mut on_line: impl FnMut(String),
) -> Result<(StreamEnd, String), String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    own_process_group(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    let (tx, rx) = mpsc::channel::<String>();
    if let Some(stdout) = child.stdout.take() {
        read_lines(stdout, tx.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        read_lines(stderr, tx.clone());
    }
    drop(tx);

    let deadline = Instant::now() + timeout;
    let mut captured = String::new();
    let mut pipes_open = true;
    let mut exited: Option<(ExitStatus, Instant)> = None;
    loop {
        if pipes_open {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(line) => {
                    if captured.len() < CAPTURE_LIMIT {
                        captured.push_str(&line);
                        captured.push('\n');
                    }
                    on_line(line);
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => pipes_open = false,
            }
        } else {
            std::thread::sleep(Duration::from_millis(50));
        }
        if exited.is_none() {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                exited = Some((status, Instant::now()));
            }
        }
        if let Some((status, at)) = exited {
            if !pipes_open || at.elapsed() >= PIPE_GRACE {
                return Ok((StreamEnd::Exited(status), captured));
            }
        } else if Instant::now() >= deadline {
            kill_tree(&mut child);
            return Ok((StreamEnd::TimedOut, captured));
        }
    }
}

/// Run a short probe and return its exit status and stdout, or `None` when it
/// could not start or was still running after `timeout` (then it is killed).
/// stderr is discarded. Output still in flight when the process exits is
/// waited for briefly, not until every grandchild closes the pipe.
pub(crate) fn output_within(mut cmd: Command, timeout: Duration) -> Option<(ExitStatus, Vec<u8>)> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let collected = Arc::new(Mutex::new(Vec::new()));
    let (done_tx, done_rx) = mpsc::channel::<()>();
    if let Some(mut stdout) = child.stdout.take() {
        let sink = Arc::clone(&collected);
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            while let Ok(n) = stdout.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                if let Ok(mut out) = sink.lock() {
                    out.extend_from_slice(&chunk[..n]);
                }
            }
            let _ = done_tx.send(());
        });
    }

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let _ = done_rx.recv_timeout(Duration::from_millis(500));
    let out = collected.lock().map(|out| out.clone()).unwrap_or_default();
    Some((status, out))
}

/// Forward each line of `pipe`, without its line ending, until it closes.
fn read_lines(pipe: impl Read + Send + 'static, tx: Sender<String>) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(pipe);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    while matches!(line.last(), Some(b'\n' | b'\r')) {
                        line.pop();
                    }
                    if tx.send(decode_console_bytes(&line)).is_err() {
                        break;
                    }
                }
            }
        }
    });
}

/// Put the installer in a process group of its own so a timeout can stop the
/// `npm`/`curl` it started, not only the shell around them.
fn own_process_group(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(not(unix))]
    let _ = cmd;
}

fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(child.id() as i32),
            nix::sys::signal::Signal::SIGKILL,
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn sh(script: &str) -> Command {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", script]);
        cmd
    }

    fn run(script: &str, timeout: Duration) -> (StreamEnd, String, Vec<String>) {
        let mut lines = Vec::new();
        let (end, captured) =
            run_streaming(sh(script), timeout, |line| lines.push(line)).expect("spawn sh");
        (end, captured, lines)
    }

    #[test]
    fn streams_both_pipes_and_reports_the_exit_code() {
        let (end, captured, lines) = run(
            "printf 'out one\\r\\n'; printf 'err one\\n' >&2; printf 'out two'; exit 3",
            Duration::from_secs(10),
        );
        assert!(matches!(end, StreamEnd::Exited(s) if s.code() == Some(3)));
        let mut sorted = lines.clone();
        sorted.sort();
        assert_eq!(sorted, ["err one", "out one", "out two"]);
        assert!(captured.contains("err one\n"));
    }

    #[test]
    fn a_full_stderr_pipe_does_not_deadlock_stdout() {
        // 256 KiB on stderr before the only stdout line: far past any pipe buffer.
        let (end, _, lines) = run(
            "i=0; while [ $i -lt 4096 ]; do printf '%064d\\n' $i >&2; i=$((i+1)); done; echo done",
            Duration::from_secs(30),
        );
        assert!(matches!(end, StreamEnd::Exited(s) if s.success()));
        assert_eq!(lines.len(), 4097);
        assert!(lines.contains(&"done".to_string()));
    }

    #[test]
    fn a_line_that_is_not_utf8_does_not_end_the_log() {
        let (_, _, lines) = run(
            "printf 'before\\n\\377\\376 bytes\\nafter\\n'",
            Duration::from_secs(10),
        );
        assert_eq!(lines.first().map(String::as_str), Some("before"));
        assert_eq!(lines.len(), 3);
        assert!(lines[1].ends_with(" bytes"));
        assert_eq!(lines.last().map(String::as_str), Some("after"));
    }

    #[test]
    fn stops_an_installer_and_its_children_at_the_deadline() {
        let started = Instant::now();
        let (end, _, lines) = run(
            "echo waiting; sleep 30 & sleep 30; echo never",
            Duration::from_millis(500),
        );
        assert!(matches!(end, StreamEnd::TimedOut));
        assert_eq!(lines, ["waiting"]);
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn does_not_wait_for_a_grandchild_holding_the_pipe() {
        let started = Instant::now();
        let (end, _, lines) = run("echo hi; (sleep 30 &) ; exit 0", Duration::from_secs(60));
        assert!(matches!(end, StreamEnd::Exited(s) if s.success()));
        assert_eq!(lines, ["hi"]);
        assert!(started.elapsed() < PIPE_GRACE + Duration::from_secs(5));
    }

    #[test]
    fn a_probe_returns_its_output_or_nothing_after_the_deadline() {
        let (status, out) = output_within(sh("printf 'x%sy' 1"), Duration::from_secs(10)).unwrap();
        assert!(status.success());
        assert_eq!(out, b"x1y");

        let started = Instant::now();
        assert!(output_within(sh("sleep 30"), Duration::from_millis(300)).is_none());
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
