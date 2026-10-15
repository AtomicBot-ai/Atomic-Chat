//! Terminal commands and scripts the chat pipeline's model runs
//! (`run_command` / `run_script`).
//!
//! The frontend asks for approval (the thread's approval mode) before it calls
//! `chat_exec_run`; this side runs the call in the chat's own folder. On
//! Windows the run goes through Microsoft MXC (`mxc`) whenever this machine
//! supports it, whatever the approval mode; elsewhere it runs on the host.
//! ADRs: 2026-10-15-run-commands-and-scripts-from-chat,
//! 2026-10-15-sandbox-chat-commands-with-mxc-on-windows.

pub mod commands;
mod mxc;
mod runner;
mod runtimes;
mod types;
mod workdir;

#[cfg(test)]
mod ipc_tests;
#[cfg(all(test, windows))]
mod mxc_windows_tests;

use std::{
    collections::HashMap,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use tokio_util::sync::CancellationToken;

pub use types::*;

use runtimes::{BundledBins, ManagedPython, Runtime};

/// What `chat_exec_status` found, kept for the session.
pub(crate) struct Prepared {
    pub status: ChatExecStatus,
    pub runtimes: HashMap<ScriptLanguage, Runtime>,
    pub bins: BundledBins,
    /// `wxc-exec.exe`, when the sandbox is in use.
    pub wxc_exec: Option<PathBuf>,
    /// The PATH commands inherit and interpreters are found on.
    pub search_path: Option<OsString>,
}

#[derive(Default)]
pub struct ChatExecState {
    prepared: tokio::sync::Mutex<Option<Arc<Prepared>>>,
    python: tokio::sync::Mutex<Option<ManagedPython>>,
    /// Running calls by call id.
    runs: std::sync::Mutex<HashMap<String, RunEntry>>,
}

struct RunEntry {
    thread_id: String,
    token: CancellationToken,
}

/// How long deleting a thread waits for its stopped calls to exit before it
/// removes their folder anyway.
const THREAD_STOP_WAIT: Duration = Duration::from_secs(5);

impl ChatExecState {
    fn runs(&self) -> std::sync::MutexGuard<'_, HashMap<String, RunEntry>> {
        self.runs
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn register(&self, call_id: &str, thread_id: &str) -> Result<RunGuard<'_>, String> {
        let mut runs = self.runs();
        if runs.contains_key(call_id) {
            return Err(format!("Call {call_id} is already running"));
        }
        let token = CancellationToken::new();
        runs.insert(
            call_id.to_owned(),
            RunEntry {
                thread_id: thread_id.to_owned(),
                token: token.clone(),
            },
        );
        Ok(RunGuard {
            state: self,
            call_id: call_id.to_owned(),
            token,
        })
    }

    fn cancel(&self, call_id: &str) -> bool {
        self.runs()
            .get(call_id)
            .map(|entry| entry.token.cancel())
            .is_some()
    }

    /// Stop every call running in `thread_id`; how many there were.
    fn cancel_thread(&self, thread_id: &str) -> usize {
        self.runs()
            .values()
            .filter(|entry| entry.thread_id == thread_id)
            .map(|entry| entry.token.cancel())
            .count()
    }

    fn has_runs_in(&self, thread_id: &str) -> bool {
        self.runs()
            .values()
            .any(|entry| entry.thread_id == thread_id)
    }
}

/// A deleted thread takes its command folder with it. Calls still running in
/// it are stopped first (and given a moment to exit, so Windows lets go of
/// their files); a folder that still cannot be removed is logged, never a
/// reason to fail the thread's deletion.
pub async fn forget_thread(state: Option<&ChatExecState>, data_folder: &Path, thread_id: &str) {
    if let Some(state) = state {
        if state.cancel_thread(thread_id) > 0 {
            let deadline = Instant::now() + THREAD_STOP_WAIT;
            while state.has_runs_in(thread_id) && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
    let Ok(folder) = workdir::chat_workdir(data_folder, thread_id) else {
        return;
    };
    match std::fs::remove_dir_all(&folder) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!(
            "chat_exec: could not remove the chat folder '{}': {error}",
            folder.display()
        ),
    }
}

/// Keeps a run's cancellation token registered for as long as it runs.
struct RunGuard<'a> {
    state: &'a ChatExecState,
    call_id: String,
    token: CancellationToken,
}

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        self.state.runs().remove(&self.call_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::test_support::TestWorkspace;

    #[tokio::test]
    async fn deleting_a_thread_stops_its_calls_and_removes_its_folder() {
        let data = TestWorkspace::new();
        let state = Arc::new(ChatExecState::default());
        let doomed = workdir::ensure_chat_workdir(data.path(), "doomed").unwrap();
        let kept = workdir::ensure_chat_workdir(data.path(), "kept").unwrap();
        std::fs::write(doomed.root.join("out.txt"), "x").unwrap();

        // A call in each thread, each holding its run open until cancelled.
        let mut tokens = Vec::new();
        let mut waiters = Vec::new();
        for (call, thread) in [("c1", "doomed"), ("c2", "kept")] {
            let state = Arc::clone(&state);
            let (registered_tx, registered_rx) = tokio::sync::oneshot::channel();
            waiters.push(tokio::spawn(async move {
                let run = state.register(call, thread).unwrap();
                registered_tx.send(run.token.clone()).unwrap();
                run.token.cancelled().await;
            }));
            tokens.push(registered_rx.await.unwrap());
        }

        forget_thread(Some(&state), data.path(), "doomed").await;

        assert!(tokens[0].is_cancelled());
        assert!(!tokens[1].is_cancelled());
        assert!(!doomed.root.exists());
        assert!(kept.root.is_dir());
        assert!(!state.has_runs_in("doomed"));
        tokens[1].cancel();
        for waiter in waiters {
            waiter.await.unwrap();
        }
    }

    #[tokio::test]
    async fn deleting_a_thread_that_never_ran_anything_is_quiet() {
        let data = TestWorkspace::new();
        forget_thread(None, data.path(), "never-ran").await;
        forget_thread(None, data.path(), "../not-a-thread").await;
        assert!(!data.path().join("agent-workspace").exists());
    }
}
