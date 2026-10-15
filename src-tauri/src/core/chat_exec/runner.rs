//! Spawns one command, captures a bounded head and tail of each stream, and
//! stops it — with its whole process tree — on timeout or cancellation.

use std::{
    collections::VecDeque,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};
use tokio_util::sync::CancellationToken;

use crate::core::agent::tools::{
    configure_process_tree, terminate_process_tree, MAX_TOOL_OUTPUT_CHARS,
};
use crate::core::process_env::sanitize_tokio_command;

/// Bytes kept from the start and from the end of each stream. What falls in
/// between is counted, not stored, so a runaway `yes` costs no memory.
const HEAD_BYTES: usize = 64 * 1024;
const TAIL_BYTES: usize = 64 * 1024;
/// After the process exits, how long a grandchild that inherited the pipes
/// may keep them open before the readers are abandoned.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
pub(crate) struct Launch {
    pub program: String,
    pub args: Vec<String>,
    /// Windows only: the arguments as one verbatim string, for `cmd.exe`,
    /// which does not parse the quoting `args` would get.
    pub raw_args: Option<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    /// Start from an empty environment instead of the app's.
    pub clear_env: bool,
}

#[derive(Debug, Default)]
pub(crate) struct RunOutput {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub timed_out: bool,
    pub cancelled: bool,
    pub duration: Duration,
}

pub(crate) async fn run(
    launch: &Launch,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<RunOutput, String> {
    let mut command = Command::new(&launch.program);
    command.args(&launch.args);
    #[cfg(windows)]
    if let Some(raw) = &launch.raw_args {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().raw_arg(raw);
    }
    #[cfg(not(windows))]
    if launch.raw_args.is_some() {
        return Err("Verbatim arguments are Windows-only".into());
    }
    sanitize_tokio_command(&mut command);
    if launch.clear_env {
        command.env_clear();
    }
    command
        .envs(launch.env.iter().map(|(key, value)| (key, value)))
        .current_dir(&launch.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_process_tree(&mut command);

    let started = Instant::now();
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start `{}`: {error}", launch.program))?;
    let pid = child.id();
    let stdout = Arc::new(Mutex::new(Capture::default()));
    let stderr = Arc::new(Mutex::new(Capture::default()));
    let stdout_task = child
        .stdout
        .take()
        .map(|stream| tokio::spawn(read_into(stream, Arc::clone(&stdout))));
    let stderr_task = child
        .stderr
        .take()
        .map(|stream| tokio::spawn(read_into(stream, Arc::clone(&stderr))));

    let mut output = RunOutput::default();
    tokio::select! {
        _ = cancel.cancelled() => {
            terminate_process_tree(&mut child, pid).await;
            output.cancelled = true;
        }
        _ = tokio::time::sleep(timeout) => {
            terminate_process_tree(&mut child, pid).await;
            output.timed_out = true;
        }
        status = child.wait() => {
            let status = status.map_err(|error| format!("Could not wait for `{}`: {error}", launch.program))?;
            output.exit_code = status.code();
        }
    }
    for task in [stdout_task, stderr_task].into_iter().flatten() {
        let abort = task.abort_handle();
        if tokio::time::timeout(DRAIN_GRACE, task).await.is_err() {
            abort.abort();
        }
    }
    output.duration = started.elapsed();
    let (text, stdout_truncated) = take(&stdout).render(MAX_TOOL_OUTPUT_CHARS);
    output.stdout = text;
    let (text, stderr_truncated) = take(&stderr).render(MAX_TOOL_OUTPUT_CHARS);
    output.stderr = text;
    output.truncated = stdout_truncated || stderr_truncated;
    Ok(output)
}

fn take(capture: &Arc<Mutex<Capture>>) -> Capture {
    std::mem::take(&mut *capture.lock().unwrap_or_else(|poison| poison.into_inner()))
}

async fn read_into(mut stream: impl AsyncRead + Unpin, capture: Arc<Mutex<Capture>>) {
    let mut chunk = [0_u8; 8192];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(read) => capture
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .push(&chunk[..read]),
        }
    }
}

/// The first `HEAD_BYTES` and the last `TAIL_BYTES` of a stream.
#[derive(Debug, Default)]
struct Capture {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    /// Bytes that fell between head and tail.
    dropped: usize,
}

impl Capture {
    fn push(&mut self, mut bytes: &[u8]) {
        if self.head.len() < HEAD_BYTES {
            let take = bytes.len().min(HEAD_BYTES - self.head.len());
            self.head.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
        }
        self.tail.extend(bytes);
        let excess = self.tail.len().saturating_sub(TAIL_BYTES);
        if excess > 0 {
            self.tail.drain(..excess);
            self.dropped += excess;
        }
    }

    /// The text, cut to at most `max_chars` (plus the marker) by keeping its
    /// start and its end — a build log's error is at the bottom.
    fn render(self, max_chars: usize) -> (String, bool) {
        let tail: Vec<u8> = self.tail.into_iter().collect();
        if self.dropped == 0 {
            let mut bytes = self.head;
            bytes.extend_from_slice(&tail);
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let total = text.chars().count();
            if total <= max_chars {
                return (text, false);
            }
            let half = max_chars / 2;
            let start: String = text.chars().take(half).collect();
            let end: String = text.chars().skip(total - half).collect();
            let omitted = total - 2 * half;
            return (
                format!("{start}\n[… {omitted} characters omitted …]\n{end}"),
                true,
            );
        }
        let half = max_chars / 2;
        let head = String::from_utf8_lossy(&self.head);
        let tail_text = String::from_utf8_lossy(&tail);
        let start: String = head.chars().take(half).collect();
        let tail_chars = tail_text.chars().count();
        let end: String = tail_text
            .chars()
            .skip(tail_chars.saturating_sub(half))
            .collect();
        (
            format!(
                "{start}\n[… output omitted: more than {} bytes …]\n{end}",
                self.dropped
            ),
            true,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_short_output_whole() {
        let mut capture = Capture::default();
        capture.push(b"hello\n");
        assert_eq!(capture.render(100), ("hello\n".to_owned(), false));
    }

    #[test]
    fn keeps_the_start_and_the_end_of_long_output() {
        let mut capture = Capture::default();
        capture.push(b"start-");
        capture.push(&vec![b'x'; 1000]);
        capture.push(b"-end");

        let (text, truncated) = capture.render(20);
        assert!(truncated);
        assert!(text.starts_with("start-xxxx"), "{text}");
        assert!(text.ends_with("xxxx-end"), "{text}");
        assert!(text.contains("characters omitted"));
    }

    #[test]
    fn stores_no_more_than_head_and_tail_of_a_runaway_stream() {
        let mut capture = Capture::default();
        for _ in 0..64 {
            capture.push(&vec![b'y'; 64 * 1024]);
        }
        capture.push(b"LAST");

        assert_eq!(capture.head.len(), HEAD_BYTES);
        assert_eq!(capture.tail.len(), TAIL_BYTES);
        let (text, truncated) = capture.render(MAX_TOOL_OUTPUT_CHARS);
        assert!(truncated);
        assert!(text.ends_with("LAST"));
        assert!(text.contains("output omitted"));
    }

    #[cfg(unix)]
    fn sh(script: &str) -> Launch {
        Launch {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            raw_args: None,
            cwd: std::env::temp_dir(),
            env: vec![("ATOMIC_TEST_VALUE".into(), "from-env".into())],
            clear_env: false,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn captures_both_streams_and_the_exit_code() {
        let output = run(
            &sh("echo out; echo err >&2; echo $ATOMIC_TEST_VALUE; exit 3"),
            Duration::from_secs(10),
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(output.exit_code, Some(3));
        assert_eq!(output.stdout, "out\nfrom-env\n");
        assert_eq!(output.stderr, "err\n");
        assert!(!output.timed_out && !output.cancelled && !output.truncated);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stops_a_command_that_outlives_its_timeout() {
        let output = run(
            &sh("echo started; sleep 30"),
            Duration::from_millis(300),
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        assert!(output.timed_out);
        assert_eq!(output.exit_code, None);
        assert_eq!(output.stdout, "started\n");
        assert!(output.duration < Duration::from_secs(10));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_kills_the_whole_process_tree() {
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            trigger.cancel();
        });
        // The background sleep holds the pipes open; only a group kill lets
        // the run return promptly.
        let output = run(&sh("sleep 30 & sleep 30"), Duration::from_secs(60), &cancel)
            .await
            .unwrap();

        assert!(output.cancelled);
        assert!(output.duration < Duration::from_secs(10));
    }

    #[test]
    fn reports_a_program_that_cannot_start() {
        let launch = Launch {
            program: "/definitely/not/a/program".into(),
            args: vec![],
            raw_args: None,
            cwd: std::env::temp_dir(),
            env: vec![],
            clear_env: false,
        };
        let error = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(run(
                &launch,
                Duration::from_secs(1),
                &CancellationToken::new(),
            ))
            .unwrap_err();
        assert!(error.contains("Could not start"), "{error}");
    }
}
