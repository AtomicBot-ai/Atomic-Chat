//! Registry of long-lived, PTY-backed child processes.
//!
//! `os.shell.run` is a single shot: spawn, wait for exit, return output. That
//! makes a whole class of work impossible — starting a dev server, following a
//! long build, answering an interactive prompt. This module keeps such
//! processes alive *between* agent steps and *between* turns, and hands the
//! model an incremental view of their output.
//!
//! Two deliberate choices:
//!
//! - **A real PTY, not piped stdio.** Most tools detect a terminal and change
//!   behaviour: without one, progress bars vanish, colour disappears, and — the
//!   reason that matters — programs that prompt for input often refuse to.
//! - **Blocking reader threads, not tokio tasks.** A reader may sit in `read`
//!   for hours. `spawn_blocking` would park a runtime worker for that whole
//!   time; a dedicated thread is bounded by [`MAX_PROCS_GLOBAL`] instead.
//!
//! Every method here is synchronous and short: the only blocking call is inside
//! the per-process reader thread, so tool code can call the registry directly
//! from async context without `spawn_blocking`.
//!
//! Rendering lives in [`super::output_buffer`]; this module only moves bytes.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, CommandBuilder, PtyPair, PtySize};
use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessesToUpdate, System};

use super::output_buffer::{BufferSlice, OutputBuffer};
use crate::core::process_env::sanitize_pty_command;

/// Live processes one agent session may hold at once.
pub const MAX_PROCS_PER_SESSION: usize = 4;
/// Live processes across all sessions. Also bounds the reader-thread count.
pub const MAX_PROCS_GLOBAL: usize = 16;
/// A running process nobody has read from for this long is killed and dropped.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// An exited process is kept this long so the model can still collect its tail.
pub const EXITED_RETENTION: Duration = Duration::from_secs(5 * 60);
/// How long to wait for a child to be reaped after its PTY reports EOF before
/// escalating to a kill.
const EXIT_WAIT_TIMEOUT: Duration = Duration::from_secs(2);
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(50);

pub const DEFAULT_COLS: u16 = 120;
pub const DEFAULT_ROWS: u16 = 40;
const MIN_COLS: u16 = 20;
const MAX_COLS: u16 = 500;
const MIN_ROWS: u16 = 5;
const MAX_ROWS: u16 = 200;

/// Journal of live child pids, so a crash does not leak them forever.
const JOURNAL_FILE_NAME: &str = "agent-pty.json";
/// How far a candidate's real start time may differ from what we recorded
/// before we refuse to believe the pid is still ours.
const START_TIME_TOLERANCE_SECS: u64 = 5;

const READ_CHUNK_BYTES: usize = 8 * 1024;
const MAX_LABEL_CHARS: usize = 120;
/// Ceiling on one `os.proc.write` payload. Writing into a PTY is an approval-
/// gated action; a bounded payload keeps a single approval from authorising an
/// unbounded injection.
pub const MAX_WRITE_BYTES: usize = 8 * 1024;

/// Signals `os.proc.stop` and `os.proc.kill` accept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessSignal {
    Term,
    Kill,
    Int,
    Hup,
}

impl ProcessSignal {
    pub fn unix_name(self) -> &'static str {
        match self {
            Self::Term => "TERM",
            Self::Kill => "KILL",
            Self::Int => "INT",
            Self::Hup => "HUP",
        }
    }

    /// Accepts both `TERM` and `SIGTERM` spellings, case-insensitively.
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.to_ascii_uppercase().as_str() {
            "TERM" | "SIGTERM" => Ok(Self::Term),
            "KILL" | "SIGKILL" => Ok(Self::Kill),
            "INT" | "SIGINT" => Ok(Self::Int),
            "HUP" | "SIGHUP" => Ok(Self::Hup),
            other => Err(format!(
                "Unsupported process signal `{other}`; use SIGTERM, SIGKILL, SIGINT, or SIGHUP"
            )),
        }
    }
}

/// One live child, as recorded on disk.
///
/// `started_at_secs` is the pid-reuse guard: a pid alone proves nothing after a
/// reboot or a busy machine has cycled the pid space, but a pid whose kernel
/// start time also matches what we wrote is ours with high confidence.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct JournalEntry {
    proc_id: String,
    pid: u32,
    started_at_secs: u64,
}

fn epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or_default()
}

pub struct SpawnRequest {
    pub session_id: String,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ExitInfo {
    pub code: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProcStatus {
    pub proc_id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit: Option<ExitInfo>,
    pub uptime_secs: u64,
}

/// One forward page of a process's output, paired with its current status.
#[derive(Debug, Clone)]
pub struct ReadPage {
    pub status: ProcStatus,
    pub slice: BufferSlice,
}

/// A `Mutex` guard that ignores poisoning.
///
/// A panicking reader thread must not brick the whole registry: the buffer it
/// was writing may be mid-line, which is a cosmetic problem, not a correctness
/// one. Failing every later read instead would be strictly worse.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct PtyProc {
    proc_id: String,
    label: String,
    pid: Option<u32>,
    spawned_at: Instant,
    /// Wall clock at spawn. `spawned_at` is monotonic and therefore useless for
    /// comparing against a kernel start time after a restart.
    started_at_secs: u64,
    buffer: Arc<Mutex<OutputBuffer>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    /// Kept alive for the lifetime of the process: dropping the master closes
    /// the PTY out from under the child.
    ///
    /// The `Mutex` is not for coordination — nothing reads this field — but for
    /// `Sync`. `MasterPty` is only `Send`, and the registry is stored in Tauri's
    /// managed `AppState`, which every command handler shares by reference.
    _master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    exit: Arc<Mutex<Option<ExitInfo>>>,
    /// Where the next cursor-less `os.proc.read` resumes.
    read_cursor: Mutex<u64>,
    /// Last time anything touched this process, for idle reaping.
    last_touch: Mutex<Instant>,
}

impl PtyProc {
    fn touch(&self) {
        *lock(&self.last_touch) = Instant::now();
    }

    fn exit_info(&self) -> Option<ExitInfo> {
        lock(&self.exit).clone()
    }

    fn is_running(&self) -> bool {
        self.exit_info().is_none()
    }

    fn status(&self) -> ProcStatus {
        let exit = self.exit_info();
        ProcStatus {
            proc_id: self.proc_id.clone(),
            label: self.label.clone(),
            pid: self.pid,
            running: exit.is_none(),
            exit,
            uptime_secs: self.spawned_at.elapsed().as_secs(),
        }
    }

    fn idle_for(&self) -> Duration {
        lock(&self.last_touch).elapsed()
    }

    /// Signal the process. `Kill` goes through `portable-pty` so it works on
    /// every platform; the softer signals have no portable equivalent, so on
    /// Unix they go through `kill(1)` and elsewhere degrade to a hard kill.
    fn signal(&self, signal: ProcessSignal) -> Result<(), String> {
        if signal == ProcessSignal::Kill {
            return lock(&self.child)
                .kill()
                .map_err(|error| format!("Could not kill process: {error}"));
        }
        #[cfg(unix)]
        {
            let Some(pid) = self.pid else {
                return Err("Process has no pid to signal".into());
            };
            let status = std::process::Command::new("kill")
                .args([format!("-{}", signal.unix_name()), pid.to_string()])
                .status()
                .map_err(|error| format!("Could not run kill: {error}"))?;
            if !status.success() {
                return Err(format!(
                    "kill -{} {pid} failed with status {status}",
                    signal.unix_name()
                ));
            }
            Ok(())
        }
        #[cfg(not(unix))]
        {
            lock(&self.child)
                .kill()
                .map_err(|error| format!("Could not kill process: {error}"))
        }
    }
}

/// Live PTY processes, keyed by agent session then process id.
///
/// Cloning shares the same registry; `AppState` holds one clone for the whole
/// app. Deliberately **not** part of `AgentSessionState`, which is serialised
/// to `agent-session.json` and cannot hold OS handles.
#[derive(Clone, Default)]
pub struct PtyRegistry {
    sessions: Arc<Mutex<HashMap<String, HashMap<String, Arc<PtyProc>>>>>,
    counter: Arc<AtomicU64>,
    /// Where to journal live pids. `None` until app setup supplies the data
    /// folder, which keeps the registry usable in tests without a filesystem.
    journal: Arc<Mutex<Option<PathBuf>>>,
}

impl PtyRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Point the crash-recovery journal at the app data folder. Called once
    /// during setup; before that, spawning simply journals nothing.
    pub fn set_journal_path(&self, data_folder: &Path) {
        *lock(&self.journal) = Some(data_folder.join(JOURNAL_FILE_NAME));
    }

    /// Rewrite the journal from the current live set.
    ///
    /// A full rewrite rather than incremental edits: the file is at most
    /// [`MAX_PROCS_GLOBAL`] entries, and "always consistent" is worth far more
    /// here than saving a few bytes of I/O. Stale entries are harmless — the
    /// reaper verifies each pid before acting — so this only has to run where
    /// the live set grows or shrinks.
    fn write_journal(&self) {
        let Some(path) = lock(&self.journal).clone() else {
            return;
        };
        let entries = {
            let sessions = lock(&self.sessions);
            sessions
                .values()
                .flat_map(HashMap::values)
                .filter(|proc| proc.is_running())
                .filter_map(|proc| {
                    Some(JournalEntry {
                        proc_id: proc.proc_id.clone(),
                        pid: proc.pid?,
                        started_at_secs: proc.started_at_secs,
                    })
                })
                .collect::<Vec<_>>()
        };
        if let Err(error) = write_journal_file(&path, &entries) {
            log::warn!("[agent-pty] could not update {}: {error}", path.display());
        }
    }

    fn next_proc_id(&self) -> String {
        // Short and ordinal on purpose: a small local model echoes `proc-3`
        // back correctly far more reliably than a UUID.
        format!("proc-{}", self.counter.fetch_add(1, Ordering::Relaxed) + 1)
    }

    fn get(&self, session_id: &str, proc_id: &str) -> Result<Arc<PtyProc>, String> {
        lock(&self.sessions)
            .get(session_id)
            .and_then(|procs| procs.get(proc_id))
            .cloned()
            .ok_or_else(|| format!("No process `{proc_id}` in this session"))
    }

    pub fn spawn(&self, request: SpawnRequest) -> Result<ProcStatus, String> {
        self.reap();
        {
            let sessions = lock(&self.sessions);
            let global: usize = sessions.values().map(HashMap::len).sum();
            if global >= MAX_PROCS_GLOBAL {
                return Err(format!(
                    "Too many live processes ({global}/{MAX_PROCS_GLOBAL}); stop one with os.proc.stop first"
                ));
            }
            let owned = sessions.get(&request.session_id).map_or(0, HashMap::len);
            if owned >= MAX_PROCS_PER_SESSION {
                return Err(format!(
                    "This session already holds {owned}/{MAX_PROCS_PER_SESSION} processes; stop one with os.proc.stop first"
                ));
            }
        }

        let size = PtySize {
            rows: request
                .rows
                .unwrap_or(DEFAULT_ROWS)
                .clamp(MIN_ROWS, MAX_ROWS),
            cols: request
                .cols
                .unwrap_or(DEFAULT_COLS)
                .clamp(MIN_COLS, MAX_COLS),
            pixel_width: 0,
            pixel_height: 0,
        };
        let PtyPair { slave, master } = native_pty_system()
            .openpty(size)
            .map_err(|error| format!("Could not open a pty: {error}"))?;

        let mut command = CommandBuilder::new(&request.program);
        command.args(&request.args);
        command.cwd(&request.cwd);
        sanitize_pty_command(&mut command);
        let child = slave
            .spawn_command(command)
            .map_err(|error| format!("Could not start `{}`: {error}", request.program))?;
        // The master only ever sees EOF once every slave handle is closed, and
        // this process holds one until here. Without this drop a finished child
        // would leave its reader thread blocked forever.
        drop(slave);

        let reader = master
            .try_clone_reader()
            .map_err(|error| format!("Could not read from the pty: {error}"))?;
        let writer = master
            .take_writer()
            .map_err(|error| format!("Could not write to the pty: {error}"))?;

        let proc_id = self.next_proc_id();
        let proc = Arc::new(PtyProc {
            pid: child.process_id(),
            label: label_for(&request.program, &request.args),
            proc_id: proc_id.clone(),
            spawned_at: Instant::now(),
            started_at_secs: epoch_secs(),
            buffer: Arc::new(Mutex::new(OutputBuffer::default())),
            writer: Mutex::new(writer),
            child: Arc::new(Mutex::new(child)),
            _master: Mutex::new(master),
            exit: Arc::new(Mutex::new(None)),
            read_cursor: Mutex::new(0),
            last_touch: Mutex::new(Instant::now()),
        });

        spawn_reader_thread(
            &proc_id,
            reader,
            proc.buffer.clone(),
            proc.child.clone(),
            proc.exit.clone(),
        )?;

        let status = proc.status();
        lock(&self.sessions)
            .entry(request.session_id)
            .or_default()
            .insert(proc_id, proc);
        self.write_journal();
        Ok(status)
    }

    /// Read forward. `since` overrides — and resets — the remembered cursor, so
    /// a cursor-less call is the ergonomic "what's new" and an explicit `since`
    /// is the way to re-read.
    pub fn read(
        &self,
        session_id: &str,
        proc_id: &str,
        since: Option<u64>,
        max_chars: usize,
    ) -> Result<ReadPage, String> {
        let proc = self.get(session_id, proc_id)?;
        proc.touch();
        let cursor = since.unwrap_or_else(|| *lock(&proc.read_cursor));
        let slice = lock(&proc.buffer).read_from(cursor, max_chars);
        *lock(&proc.read_cursor) = slice.next_cursor;
        Ok(ReadPage {
            status: proc.status(),
            slice,
        })
    }

    pub fn write(&self, session_id: &str, proc_id: &str, data: &str) -> Result<ProcStatus, String> {
        let proc = self.get(session_id, proc_id)?;
        if !proc.is_running() {
            return Err(format!("Process `{proc_id}` has already exited"));
        }
        if data.len() > MAX_WRITE_BYTES {
            return Err(format!(
                "Payload is {} bytes; the limit is {MAX_WRITE_BYTES}",
                data.len()
            ));
        }
        proc.touch();
        let mut writer = lock(&proc.writer);
        writer
            .write_all(data.as_bytes())
            .map_err(|error| format!("Could not write to `{proc_id}`: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("Could not flush `{proc_id}`: {error}"))?;
        drop(writer);
        Ok(proc.status())
    }

    /// Signal a process. The entry stays in the registry so the model can still
    /// collect the tail and the exit status; [`Self::reap`] removes it later.
    pub fn stop(
        &self,
        session_id: &str,
        proc_id: &str,
        signal: ProcessSignal,
    ) -> Result<ProcStatus, String> {
        let proc = self.get(session_id, proc_id)?;
        proc.touch();
        if !proc.is_running() {
            return Ok(proc.status());
        }
        proc.signal(signal)?;
        Ok(proc.status())
    }

    pub fn list(&self, session_id: &str) -> Vec<ProcStatus> {
        let sessions = lock(&self.sessions);
        let Some(procs) = sessions.get(session_id) else {
            return Vec::new();
        };
        let mut rows = procs.values().map(|proc| proc.status()).collect::<Vec<_>>();
        rows.sort_by(|left, right| left.proc_id.cmp(&right.proc_id));
        rows
    }

    /// Kill and forget every process a session owns. Called when the thread is
    /// closed — a dev server should outlive a *turn*, not the conversation.
    pub fn kill_session(&self, session_id: &str) -> usize {
        let procs = lock(&self.sessions).remove(session_id).unwrap_or_default();
        let count = procs.len();
        for proc in procs.values() {
            let _ = proc.signal(ProcessSignal::Kill);
        }
        self.write_journal();
        count
    }

    /// Kill everything. Wired to app shutdown.
    pub fn kill_all(&self) -> usize {
        let sessions = std::mem::take(&mut *lock(&self.sessions));
        let mut count = 0;
        for procs in sessions.values() {
            for proc in procs.values() {
                let _ = proc.signal(ProcessSignal::Kill);
                count += 1;
            }
        }
        // Empties the journal: on a graceful exit there is nothing to recover.
        self.write_journal();
        count
    }

    /// Drop stale entries: exited processes past their retention window, and
    /// running ones nobody has looked at for [`IDLE_TIMEOUT`].
    ///
    /// Called opportunistically on spawn rather than from a timer — the only
    /// resource worth reclaiming promptly is a slot, and slots only run out at
    /// spawn time.
    pub fn reap(&self) -> usize {
        let mut victims = Vec::new();
        {
            let mut sessions = lock(&self.sessions);
            for procs in sessions.values_mut() {
                procs.retain(|_, proc| {
                    let stale = if proc.is_running() {
                        proc.idle_for() >= IDLE_TIMEOUT
                    } else {
                        proc.idle_for() >= EXITED_RETENTION
                    };
                    if stale {
                        victims.push(proc.clone());
                    }
                    !stale
                });
            }
            sessions.retain(|_, procs| !procs.is_empty());
        }
        for proc in &victims {
            let _ = proc.signal(ProcessSignal::Kill);
        }
        if !victims.is_empty() {
            self.write_journal();
        }
        victims.len()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        lock(&self.sessions).values().map(HashMap::len).sum()
    }
}

fn write_journal_file(path: &Path, entries: &[JournalEntry]) -> std::io::Result<()> {
    let body = serde_json::to_vec(entries).map_err(std::io::Error::other)?;
    // Write-then-rename: a crash mid-write must not leave a truncated journal
    // that the next startup fails to parse and silently ignores.
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, body)?;
    std::fs::rename(&temporary, path)
}

/// Kill child processes left behind by a previous *abnormal* exit.
///
/// `RunEvent::Exit` handles the graceful path, but a crash, an OOM kill or a
/// Force Quit runs none of our cleanup, and unlike the model backends these
/// children are arbitrary user commands — a dev server, a watcher — so
/// [`crate::core::process_reaper`]'s name-and-path matching cannot identify
/// them. The journal plus a start-time check does instead.
pub fn reap_orphans(data_folder: &Path) {
    let path = data_folder.join(JOURNAL_FILE_NAME);
    let Ok(body) = std::fs::read(&path) else {
        return;
    };
    let entries: Vec<JournalEntry> = match serde_json::from_slice(&body) {
        Ok(entries) => entries,
        Err(error) => {
            log::warn!(
                "[agent-pty] ignoring unreadable {}: {error}",
                path.display()
            );
            let _ = std::fs::remove_file(&path);
            return;
        }
    };
    let _ = std::fs::remove_file(&path);
    if entries.is_empty() {
        return;
    }

    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let self_pid = std::process::id();

    let mut killed = 0usize;
    for entry in entries {
        if entry.pid == self_pid {
            continue;
        }
        let Some(process) = system.process(Pid::from_u32(entry.pid)) else {
            // Already gone; nothing to do.
            continue;
        };
        // The pid is live, but is it still *ours*? Compare kernel start time
        // with what we recorded. A reused pid belongs to something else, and
        // killing it would be a serious bug.
        let actual = process.start_time();
        if actual.abs_diff(entry.started_at_secs) > START_TIME_TOLERANCE_SECS {
            log::warn!(
                "[agent-pty] pid {} was reused since {} started; leaving it alone",
                entry.pid,
                entry.proc_id
            );
            continue;
        }
        process.kill();
        killed += 1;
    }
    if killed > 0 {
        log::warn!("[agent-pty] terminated {killed} process(es) orphaned by a previous run");
    }
}

fn label_for(program: &str, args: &[String]) -> String {
    let mut label = program.to_owned();
    for arg in args {
        label.push(' ');
        label.push_str(arg);
    }
    if label.chars().count() > MAX_LABEL_CHARS {
        label = label.chars().take(MAX_LABEL_CHARS - 1).collect::<String>();
        label.push('…');
    }
    label
}

fn spawn_reader_thread(
    proc_id: &str,
    mut reader: Box<dyn Read + Send>,
    buffer: Arc<Mutex<OutputBuffer>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    exit: Arc<Mutex<Option<ExitInfo>>>,
) -> Result<(), String> {
    std::thread::Builder::new()
        .name(format!("agent-pty-{proc_id}"))
        .spawn(move || {
            let mut chunk = [0u8; READ_CHUNK_BYTES];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => lock(&buffer).push_bytes(&chunk[..read]),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    // A Unix pty master reports EIO — not EOF — once the last
                    // slave handle is gone, so any read error ends the stream.
                    Err(_) => break,
                }
            }
            *lock(&exit) = Some(reap_child(&child));
        })
        .map(|_| ())
        .map_err(|error| format!("Could not start the pty reader thread: {error}"))
}

/// Collect the child's exit status after its PTY has closed.
///
/// Polls rather than calling `wait` directly: `wait` holds the child lock until
/// the process is gone, and a grandchild that outlives its parent would turn
/// that into a stuck thread holding a lock `stop` needs.
fn reap_child(child: &Mutex<Box<dyn portable_pty::Child + Send + Sync>>) -> ExitInfo {
    let deadline = Instant::now() + EXIT_WAIT_TIMEOUT;
    loop {
        if let Ok(Some(status)) = lock(child).try_wait() {
            return ExitInfo {
                code: status.exit_code(),
                signal: status.signal().map(str::to_owned),
            };
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(EXIT_POLL_INTERVAL);
    }
    // The PTY is closed but the child is still around; it can no longer produce
    // output, so end it rather than leaking the process.
    let mut guard = lock(child);
    let _ = guard.kill();
    match guard.wait() {
        Ok(status) => ExitInfo {
            code: status.exit_code(),
            signal: status.signal().map(str::to_owned),
        },
        Err(_) => ExitInfo {
            code: 1,
            signal: Some("UNKNOWN".into()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(session: &str, script: &str) -> SpawnRequest {
        SpawnRequest {
            session_id: session.into(),
            program: "sh".into(),
            args: vec!["-c".into(), script.into()],
            cwd: std::env::temp_dir(),
            cols: None,
            rows: None,
        }
    }

    /// Poll until `predicate` holds or the deadline passes. PTY output is
    /// inherently asynchronous, so every assertion about it needs a bound.
    fn wait_until(mut predicate: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if predicate() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        false
    }

    #[test]
    fn parses_signal_spellings() {
        assert_eq!(ProcessSignal::parse("term").unwrap(), ProcessSignal::Term);
        assert_eq!(
            ProcessSignal::parse("SIGKILL").unwrap(),
            ProcessSignal::Kill
        );
        assert!(ProcessSignal::parse("STOP").is_err());
    }

    #[test]
    fn truncates_long_labels() {
        let args = vec!["x".repeat(500)];
        let label = label_for("sh", &args);
        assert_eq!(label.chars().count(), MAX_LABEL_CHARS);
        assert!(label.ends_with('…'));
    }

    #[cfg(unix)]
    #[test]
    fn streams_output_incrementally_and_records_exit() {
        let registry = PtyRegistry::new();
        let status = registry
            .spawn(request(
                "s1",
                "for i in 1 2 3; do echo line-$i; sleep 0.1; done",
            ))
            .expect("spawn");
        assert!(status.running);
        assert!(status.pid.is_some());

        assert!(
            wait_until(|| {
                let page = registry
                    .read("s1", &status.proc_id, Some(0), usize::MAX)
                    .unwrap();
                page.slice.text.contains("line-3")
            }),
            "never saw the final line"
        );
        assert!(
            wait_until(|| !registry
                .read("s1", &status.proc_id, Some(0), 10)
                .unwrap()
                .status
                .running),
            "exit status never recorded"
        );

        let page = registry
            .read("s1", &status.proc_id, Some(0), usize::MAX)
            .unwrap();
        assert_eq!(
            page.status.exit,
            Some(ExitInfo {
                code: 0,
                signal: None
            })
        );
        for expected in ["line-1", "line-2", "line-3"] {
            assert!(page.slice.text.contains(expected), "missing {expected}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_remembered_cursor_only_yields_new_output() {
        let registry = PtyRegistry::new();
        let status = registry
            .spawn(request("s1", "echo first; sleep 0.4; echo second"))
            .expect("spawn");

        assert!(wait_until(|| {
            registry
                .read("s1", &status.proc_id, Some(0), usize::MAX)
                .unwrap()
                .slice
                .text
                .contains("first")
        }));
        // Consume everything so far through the remembered cursor.
        while registry
            .read("s1", &status.proc_id, None, usize::MAX)
            .unwrap()
            .slice
            .next_cursor
            == 0
        {
            std::thread::sleep(Duration::from_millis(25));
        }

        assert!(wait_until(|| {
            let page = registry
                .read("s1", &status.proc_id, None, usize::MAX)
                .unwrap();
            page.slice.text.contains("second")
        }));
        // "first" was already delivered, so it must not come back.
        let page = registry
            .read("s1", &status.proc_id, None, usize::MAX)
            .unwrap();
        assert!(!page.slice.text.contains("first"), "{:?}", page.slice.text);
    }

    #[cfg(unix)]
    #[test]
    fn writing_feeds_the_child_stdin() {
        let registry = PtyRegistry::new();
        let status = registry
            .spawn(request("s1", "read answer; echo got:$answer"))
            .expect("spawn");
        registry
            .write("s1", &status.proc_id, "hello\n")
            .expect("write");
        assert!(
            wait_until(|| {
                registry
                    .read("s1", &status.proc_id, Some(0), usize::MAX)
                    .unwrap()
                    .slice
                    .text
                    .contains("got:hello")
            }),
            "child never echoed the written line"
        );
    }

    #[cfg(unix)]
    #[test]
    fn stop_terminates_a_process_that_would_never_exit() {
        let registry = PtyRegistry::new();
        let status = registry
            .spawn(request("s1", "while true; do sleep 1; done"))
            .unwrap();
        registry
            .stop("s1", &status.proc_id, ProcessSignal::Kill)
            .expect("stop");
        assert!(wait_until(|| {
            !registry
                .read("s1", &status.proc_id, Some(0), 10)
                .unwrap()
                .status
                .running
        }));
    }

    #[cfg(unix)]
    #[test]
    fn writing_to_an_exited_process_is_an_error() {
        let registry = PtyRegistry::new();
        let status = registry.spawn(request("s1", "true")).unwrap();
        assert!(wait_until(|| {
            !registry
                .read("s1", &status.proc_id, Some(0), 10)
                .unwrap()
                .status
                .running
        }));
        assert!(registry.write("s1", &status.proc_id, "x\n").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn enforces_the_per_session_cap() {
        let registry = PtyRegistry::new();
        for _ in 0..MAX_PROCS_PER_SESSION {
            registry
                .spawn(request("s1", "while true; do sleep 1; done"))
                .expect("spawn under the cap");
        }
        let error = registry
            .spawn(request("s1", "true"))
            .expect_err("cap must be enforced");
        assert!(error.contains("os.proc.stop"), "{error}");
        // A different session still has room, so the cap is per-session.
        registry
            .spawn(request("s2", "true"))
            .expect("other session");
        registry.kill_all();
    }

    #[cfg(unix)]
    #[test]
    fn unknown_ids_are_rejected_and_sessions_are_isolated() {
        let registry = PtyRegistry::new();
        let status = registry.spawn(request("s1", "true")).unwrap();
        assert!(registry.read("s1", "proc-999", None, 10).is_err());
        // The id is real but belongs to another session.
        assert!(registry.read("s2", &status.proc_id, None, 10).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn kill_session_clears_only_that_session() {
        let registry = PtyRegistry::new();
        registry
            .spawn(request("s1", "while true; do sleep 1; done"))
            .unwrap();
        registry
            .spawn(request("s1", "while true; do sleep 1; done"))
            .unwrap();
        let survivor = registry
            .spawn(request("s2", "while true; do sleep 1; done"))
            .unwrap();
        assert_eq!(registry.kill_session("s1"), 2);
        assert_eq!(registry.list("s1").len(), 0);
        assert_eq!(registry.list("s2").len(), 1);
        assert_eq!(registry.list("s2")[0].proc_id, survivor.proc_id);
        registry.kill_all();
    }

    #[cfg(unix)]
    #[test]
    fn spawning_journals_the_live_pid_and_exiting_clears_it() {
        let folder = tempfile::tempdir().unwrap();
        let registry = PtyRegistry::new();
        registry.set_journal_path(folder.path());

        let status = registry
            .spawn(request("s1", "while true; do sleep 1; done"))
            .unwrap();
        let journal = folder.path().join(JOURNAL_FILE_NAME);
        let entries: Vec<JournalEntry> =
            serde_json::from_slice(&std::fs::read(&journal).unwrap()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].pid, status.pid.unwrap());
        assert_eq!(entries[0].proc_id, status.proc_id);

        registry.kill_all();
        let entries: Vec<JournalEntry> =
            serde_json::from_slice(&std::fs::read(&journal).unwrap()).unwrap();
        assert!(
            entries.is_empty(),
            "a clean exit must leave nothing to recover"
        );
    }

    #[test]
    fn reaping_tolerates_a_missing_or_corrupt_journal() {
        let folder = tempfile::tempdir().unwrap();
        // Missing: nothing to do, and nothing to create.
        reap_orphans(folder.path());
        assert!(!folder.path().join(JOURNAL_FILE_NAME).exists());

        std::fs::write(folder.path().join(JOURNAL_FILE_NAME), b"{ not json").unwrap();
        reap_orphans(folder.path());
        assert!(
            !folder.path().join(JOURNAL_FILE_NAME).exists(),
            "an unparseable journal must be discarded, not retried forever"
        );
    }

    #[cfg(unix)]
    #[test]
    fn reaping_kills_a_recorded_orphan_but_spares_a_reused_pid() {
        use std::process::{Command, Stdio};

        // Two identical survivors of a "previous run".
        let mut victim = Command::new("sleep")
            .arg("30")
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let mut bystander = Command::new("sleep")
            .arg("30")
            .stdout(Stdio::null())
            .spawn()
            .unwrap();

        let mut system = System::new();
        system.refresh_processes(ProcessesToUpdate::All, true);
        let victim_start = system
            .process(Pid::from_u32(victim.id()))
            .expect("victim must be running")
            .start_time();

        let folder = tempfile::tempdir().unwrap();
        write_journal_file(
            &folder.path().join(JOURNAL_FILE_NAME),
            &[
                JournalEntry {
                    proc_id: "proc-1".into(),
                    pid: victim.id(),
                    started_at_secs: victim_start,
                },
                // Same shape, but the recorded start time does not match the
                // live process: this is what pid reuse looks like, and the
                // reaper must refuse to touch it.
                JournalEntry {
                    proc_id: "proc-2".into(),
                    pid: bystander.id(),
                    started_at_secs: victim_start - 3_600,
                },
            ],
        )
        .unwrap();

        reap_orphans(folder.path());

        let killed = wait_until(|| matches!(victim.try_wait(), Ok(Some(_))));
        assert!(killed, "the recorded orphan should have been terminated");
        assert!(
            matches!(bystander.try_wait(), Ok(None)),
            "a reused pid must be left alone"
        );

        let _ = bystander.kill();
        let _ = bystander.wait();
    }

    #[cfg(unix)]
    #[test]
    fn ansi_noise_never_reaches_the_model() {
        let registry = PtyRegistry::new();
        let status = registry
            .spawn(request("s1", "printf '\\033[31mred\\033[0m\\n'"))
            .unwrap();
        assert!(wait_until(|| {
            let text = registry
                .read("s1", &status.proc_id, Some(0), usize::MAX)
                .unwrap()
                .slice
                .text;
            text.contains("red") && !text.contains('\u{1b}')
        }));
    }
}
