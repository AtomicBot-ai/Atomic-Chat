//! Remote access: a Cloudflare quick tunnel in front of the Local API Server.
//!
//! The bundled `cloudflared` sidecar gives the OpenAI-compatible API a
//! temporary public `https://<words>.trycloudflare.com` address, so another
//! Atomic Chat, an SDK or a coding agent can use this machine's models from
//! anywhere. No account, no domain, a new URL on every start.
//!
//! Shape of the code:
//!
//! * [`RemoteAccessManager`] is the state machine the commands talk to. Its
//!   state sits behind a `std::sync::Mutex` that is never held across an await.
//! * One *supervisor* task per run owns the child process. It waits for the
//!   tunnel to register, proves the URL reaches this server before anybody sees
//!   it, then watches for the process to exit. A `run` counter makes a
//!   supervisor that was overtaken (stop timed out, the app is quitting) unable
//!   to write state any more.
//! * Every transition is pushed to the frontend as `remote-access:status`; this
//!   is the first lifecycle event the Local API Server area has, because the
//!   URL arrives seconds after the command that asked for it has returned.
//!
//! The API key is deliberately not a precondition: exposing the server without
//! one is the user's call, made explicit by the frontend.

pub mod commands;
mod journal;
mod lan;
mod probe;
mod process;
#[cfg(test)]
mod tests;

pub use journal::reap_orphan;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

use self::probe::{Prober, PublicProber};
use self::process::{Ready, Spawner, TunnelProcess};
use crate::core::server::dynamic_hosts::DynamicTrustedHosts;
use crate::core::state::LocalServerEndpoint;

/// Pushed on every transition with a [`RemoteAccessStatus`] payload.
pub const REMOTE_ACCESS_STATUS_EVENT: &str = "remote-access:status";

/// The running server as `AppState` publishes it; `None` while it is stopped.
pub type ServerEndpoint = Arc<Mutex<Option<LocalServerEndpoint>>>;

/// cloudflared picks QUIC (UDP) by itself. Networks that drop UDP still let the
/// HTTP/2 (TCP) transport through, on the same port 7844, so that is the one
/// retry worth making.
const PROTOCOL_ATTEMPTS: [Option<&str>; 2] = [None, Some("http2")];

/// How long `stop` waits for the supervisor beyond its own grace periods.
const STOP_SUPERVISOR_MARGIN: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy)]
pub(crate) struct Timings {
    /// For the URL to be minted *and* an edge connection registered.
    pub ready: Duration,
    /// For the public URL to answer as this server, all probe phases together.
    pub probe_total: Duration,
    /// After SIGTERM, before the kill (unix).
    pub term_grace: Duration,
    /// After the kill, for the exit to be confirmed.
    pub kill_grace: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Self {
            ready: Duration::from_secs(15),
            probe_total: Duration::from_secs(45),
            term_grace: Duration::from_secs(5),
            kill_grace: Duration::from_secs(5),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteAccessState {
    Off,
    Starting,
    Online,
    Stopping,
    Error,
}

/// Machine-readable failure codes; the frontend owns the wording.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteAccessError {
    /// The bundled binary is missing or could not be started.
    CloudflaredUnavailable,
    /// cloudflared never printed a tunnel URL (no route to Cloudflare's API).
    NoUrl,
    /// A URL was minted but no edge connection registered, on either transport.
    NotRegistered,
    /// The tunnel registered, but its URL never answered as this server.
    NotReachable,
    /// A tunnel that was online ended by itself.
    Exited,
    /// The process could not be confirmed dead. Only Stop is offered until it is.
    StopFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteAccessBlockReason {
    /// A tunnel needs something to point at.
    ServerStopped,
}

/// What the frontend renders. camelCase on the wire, like the other payloads
/// the settings pages consume.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessStatus {
    pub state: RemoteAccessState,
    /// Origin only (`https://<words>.trycloudflare.com`), and only while online.
    pub url: Option<String>,
    pub error: Option<RemoteAccessError>,
    pub block_reason: Option<RemoteAccessBlockReason>,
    pub can_start: bool,
    pub can_stop: bool,
    /// Whether the *running* server was started with an API key. The frontend
    /// compares it with the key in its settings to offer "restart to apply".
    pub server_has_api_key: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Off,
    Starting,
    Online,
    Stopping,
    Failed(RemoteAccessError),
}

struct Inner {
    phase: Phase,
    url: Option<String>,
    /// Identifies the supervisor allowed to write this state.
    run: u64,
    /// Kept while the process may still be alive, for the exit hook and for
    /// retrying a stop whose exit could not be confirmed.
    child_pid: Option<u32>,
    stop_tx: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            phase: Phase::Off,
            url: None,
            run: 0,
            child_pid: None,
            stop_tx: None,
            task: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Snapshot {
    phase: Phase,
    url: Option<String>,
}

/// Type-erased event sink, the same trick as `RequestInspector`: `AppState` is
/// not generic over the Tauri runtime, and tests collect into a `Vec`.
pub(crate) type StatusSink = Arc<dyn Fn(&RemoteAccessStatus) + Send + Sync>;

/// Everything the supervisor needs from the outside world, injectable so the
/// state machine is tested without cloudflared and without a network.
pub(crate) struct Deps {
    pub spawner: Spawner,
    pub prober: Arc<dyn Prober>,
    pub timings: Timings,
}

impl Default for Deps {
    fn default() -> Self {
        Self {
            spawner: Arc::new(process::spawn_bundled),
            prober: Arc::new(PublicProber),
            timings: Timings::default(),
        }
    }
}

#[derive(Default)]
pub struct RemoteAccessManager {
    inner: StdMutex<Inner>,
    sink: OnceLock<StatusSink>,
    journal: StdMutex<Option<PathBuf>>,
    deps: Deps,
}

fn derive_status(snapshot: &Snapshot, server: Option<&LocalServerEndpoint>) -> RemoteAccessStatus {
    let (state, error) = match snapshot.phase {
        Phase::Off => (RemoteAccessState::Off, None),
        Phase::Starting => (RemoteAccessState::Starting, None),
        Phase::Online => (RemoteAccessState::Online, None),
        Phase::Stopping => (RemoteAccessState::Stopping, None),
        Phase::Failed(error) => (RemoteAccessState::Error, Some(error)),
    };
    let block_reason = server
        .is_none()
        .then_some(RemoteAccessBlockReason::ServerStopped);
    // A process that may still be alive must be dealt with before another one
    // is started next to it.
    let stop_failed = error == Some(RemoteAccessError::StopFailed);
    let idle = matches!(state, RemoteAccessState::Off | RemoteAccessState::Error);
    RemoteAccessStatus {
        state,
        url: (state == RemoteAccessState::Online)
            .then(|| snapshot.url.clone())
            .flatten(),
        error,
        block_reason,
        can_start: block_reason.is_none() && idle && !stop_failed,
        can_stop: matches!(
            state,
            RemoteAccessState::Starting | RemoteAccessState::Online
        ) || stop_failed,
        server_has_api_key: server.is_some_and(|server| !server.api_key.is_empty()),
    }
}

fn host_of(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()?
        .host_str()
        .map(|host| host.to_string())
}

impl RemoteAccessManager {
    #[cfg(test)]
    pub(crate) fn with_deps(deps: Deps) -> Self {
        Self {
            deps,
            ..Self::default()
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic while holding the lock leaves plain data behind; carrying on
        // beats wedging Stop forever.
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Binds the Tauri emitter. Idempotent; the first caller wins.
    pub fn attach<R: Runtime>(&self, app: AppHandle<R>) {
        let _ = self.sink.set(Arc::new(move |status| {
            if let Err(error) = app.emit(REMOTE_ACCESS_STATUS_EVENT, status) {
                log::debug!("remote-access emit failed: {error}");
            }
        }));
    }

    #[cfg(test)]
    pub(crate) fn attach_sink(&self, sink: StatusSink) {
        let _ = self.sink.set(sink);
    }

    /// Point the crash-recovery journal at the app data folder. Called once
    /// during setup; before that a tunnel simply is not journalled.
    pub fn set_journal_path(&self, data_folder: &Path) {
        if let Ok(mut journal) = self.journal.lock() {
            *journal = Some(journal::path_in(data_folder));
        }
    }

    fn journal_path(&self) -> Option<PathBuf> {
        self.journal.lock().ok().and_then(|path| path.clone())
    }

    fn snapshot(&self) -> Snapshot {
        let inner = self.lock();
        Snapshot {
            phase: inner.phase,
            url: inner.url.clone(),
        }
    }

    fn is_current(&self, run: u64) -> bool {
        self.lock().run == run
    }

    pub async fn status(&self, endpoint: &ServerEndpoint) -> RemoteAccessStatus {
        let server = endpoint.lock().await.clone();
        derive_status(&self.snapshot(), server.as_ref())
    }

    /// Computes the status and pushes it to the frontend. Also called by
    /// `start_server`/`stop_server`: `blockReason` and `canStart` follow the
    /// server, not only the tunnel.
    pub async fn announce(&self, endpoint: &ServerEndpoint) -> RemoteAccessStatus {
        let status = self.status(endpoint).await;
        if let Some(sink) = self.sink.get() {
            sink(&status);
        }
        status
    }

    /// Starts a tunnel and returns at once with `starting`; the rest is
    /// reported through events. Rejects with a machine-readable reason.
    pub async fn start(
        self: &Arc<Self>,
        endpoint: ServerEndpoint,
        hosts: DynamicTrustedHosts,
    ) -> Result<RemoteAccessStatus, String> {
        let Some(server) = endpoint.lock().await.clone() else {
            return Err("server_stopped".to_string());
        };
        // The endpoint carries the *bound* port (a fallback can change it) and
        // the dial host: `0.0.0.0` already mapped to loopback, while a server
        // bound to one specific address does not listen on loopback at all.
        let origin = format!("http://{}:{}", server.host, server.port);

        let refused = {
            let mut inner = self.lock();
            match inner.phase {
                // Already on its way or up: asking again changes nothing.
                Phase::Starting | Phase::Online => None,
                Phase::Stopping => Some("operation_in_progress"),
                Phase::Failed(RemoteAccessError::StopFailed) => Some("stop_failed"),
                Phase::Off | Phase::Failed(_) => {
                    inner.run += 1;
                    inner.phase = Phase::Starting;
                    inner.url = None;
                    inner.child_pid = None;
                    let (stop_tx, stop_rx) = oneshot::channel();
                    inner.stop_tx = Some(stop_tx);
                    // Spawned from a runtime worker on purpose: on Linux the
                    // child is tied to the life of the thread that forks it.
                    inner.task = Some(tokio::spawn(Arc::clone(self).supervise(
                        inner.run,
                        origin,
                        endpoint.clone(),
                        hosts,
                        stop_rx,
                    )));
                    None
                }
            }
        };
        if let Some(reason) = refused {
            return Err(reason.to_string());
        }
        Ok(self.announce(&endpoint).await)
    }

    /// Stops the tunnel and returns once it is down (normally well under a
    /// second; up to the two grace periods when the process does not react).
    pub async fn stop(
        &self,
        endpoint: &ServerEndpoint,
        hosts: &DynamicTrustedHosts,
    ) -> RemoteAccessStatus {
        enum Plan {
            Nothing,
            Reset,
            RetryKill(u32),
            Signal(Option<oneshot::Sender<()>>, Option<JoinHandle<()>>),
        }
        let plan = {
            let mut inner = self.lock();
            match inner.phase {
                Phase::Off | Phase::Stopping => Plan::Nothing,
                Phase::Failed(RemoteAccessError::StopFailed) => match inner.child_pid {
                    Some(pid) => Plan::RetryKill(pid),
                    None => Plan::Reset,
                },
                Phase::Failed(_) => Plan::Reset,
                Phase::Starting | Phase::Online => {
                    inner.phase = Phase::Stopping;
                    Plan::Signal(inner.stop_tx.take(), inner.task.take())
                }
            }
        };
        match plan {
            Plan::Nothing => {}
            Plan::Reset => self.reset_to_off(),
            Plan::RetryKill(pid) => {
                if journal::kill_pid(pid) {
                    hosts.clear_tunnel_host();
                    if let Some(path) = self.journal_path() {
                        journal::clear(&path);
                    }
                    self.reset_to_off();
                }
            }
            Plan::Signal(stop_tx, task) => {
                self.announce(endpoint).await;
                if let Some(stop_tx) = stop_tx {
                    let _ = stop_tx.send(());
                }
                if let Some(task) = task {
                    let timings = self.deps.timings;
                    let limit = timings.term_grace + timings.kill_grace + STOP_SUPERVISOR_MARGIN;
                    if tokio::time::timeout(limit, task).await.is_err() {
                        // The supervisor is stuck. Take the state away from it
                        // so it cannot write later, and say what is true.
                        let mut inner = self.lock();
                        if inner.phase == Phase::Stopping {
                            inner.run += 1;
                            inner.phase = Phase::Failed(RemoteAccessError::StopFailed);
                            inner.url = None;
                        }
                        drop(inner);
                        hosts.clear_tunnel_host();
                    }
                }
            }
        }
        self.announce(endpoint).await
    }

    fn reset_to_off(&self) {
        let mut inner = self.lock();
        inner.phase = Phase::Off;
        inner.url = None;
        inner.child_pid = None;
    }

    /// Synchronous teardown for the exit hook, which cannot await the
    /// supervisor and returns early on some paths. Signals only.
    pub fn kill_now(&self, hosts: &DynamicTrustedHosts) {
        let (pid, task) = {
            let mut inner = self.lock();
            // Whatever the supervisor still does, it no longer owns the state.
            inner.run += 1;
            inner.phase = Phase::Off;
            inner.url = None;
            inner.stop_tx = None;
            (inner.child_pid.take(), inner.task.take())
        };
        hosts.clear_tunnel_host();
        if let Some(pid) = pid {
            if journal::kill_pid(pid) {
                log::info!("[remote-access] ended the tunnel (pid {pid}) on exit");
            }
        }
        if let Some(task) = task {
            // Dropping the supervisor drops the child, which is `kill_on_drop`.
            task.abort();
        }
        if let Some(path) = self.journal_path() {
            journal::clear(&path);
        }
    }

    fn record_child(&self, run: u64, pid: Option<u32>) {
        let mut inner = self.lock();
        if inner.run != run {
            return;
        }
        inner.child_pid = pid;
        drop(inner);
        if let (Some(pid), Some(path)) = (pid, self.journal_path()) {
            journal::record(&path, pid);
        }
    }

    /// Flips `starting` to `online`. `false` means a stop got there first.
    fn go_online(&self, run: u64, url: &str) -> bool {
        let mut inner = self.lock();
        if inner.run != run || inner.phase != Phase::Starting {
            return false;
        }
        inner.phase = Phase::Online;
        inner.url = Some(url.to_string());
        true
    }

    /// Ends the process and records how the run ended. An exit that cannot be
    /// confirmed overrides `outcome`: the truth is then "may still be running".
    async fn end_run(
        &self,
        run: u64,
        tunnel: Option<Box<dyn TunnelProcess>>,
        outcome: Phase,
        endpoint: &ServerEndpoint,
        hosts: &DynamicTrustedHosts,
    ) {
        let confirmed = match tunnel {
            Some(mut tunnel) => tunnel.terminate(&self.deps.timings).await,
            None => true,
        };
        if !self.is_current(run) {
            // Overtaken (stop timed out, or the app is quitting): whoever took
            // over has already written the state and cleared the host.
            return;
        }
        hosts.clear_tunnel_host();
        {
            let mut inner = self.lock();
            inner.url = None;
            inner.stop_tx = None;
            if confirmed {
                // A stop that raced with a failure still ends in `off`: the
                // user asked for nothing to be running, and nothing is.
                inner.phase = if inner.phase == Phase::Stopping {
                    Phase::Off
                } else {
                    outcome
                };
                inner.child_pid = None;
            } else {
                inner.phase = Phase::Failed(RemoteAccessError::StopFailed);
            }
        }
        if confirmed {
            if let Some(path) = self.journal_path() {
                journal::clear(&path);
            }
        }
        if let Phase::Failed(error) = outcome {
            log::warn!("[remote-access] tunnel ended: {error:?}");
        }
        self.announce(endpoint).await;
    }

    async fn supervise(
        self: Arc<Self>,
        run: u64,
        origin: String,
        endpoint: ServerEndpoint,
        hosts: DynamicTrustedHosts,
        mut stop_rx: oneshot::Receiver<()>,
    ) {
        let timings = self.deps.timings;
        for (attempt, protocol) in PROTOCOL_ATTEMPTS.iter().enumerate() {
            let Some(mut tunnel) = (self.deps.spawner)(&origin, *protocol) else {
                let outcome = Phase::Failed(RemoteAccessError::CloudflaredUnavailable);
                self.end_run(run, None, outcome, &endpoint, &hosts).await;
                return;
            };
            self.record_child(run, tunnel.pid());

            let ready = tokio::select! {
                _ = &mut stop_rx => None,
                ready = tunnel.wait_ready(timings.ready) => Some(ready),
            };
            let url = match ready {
                None => {
                    self.end_run(run, Some(tunnel), Phase::Off, &endpoint, &hosts)
                        .await;
                    return;
                }
                Some(Ready::Url(url)) => url,
                Some(Ready::Exited { saw_url }) | Some(Ready::TimedOut { saw_url }) => {
                    let is_last_attempt = attempt + 1 == PROTOCOL_ATTEMPTS.len();
                    // A URL without a registered connection is what a network
                    // that drops QUIC looks like; no URL at all means Cloudflare
                    // was not reached, and another transport will not help.
                    if saw_url && !is_last_attempt {
                        if !tunnel.terminate(&timings).await {
                            let outcome = Phase::Failed(RemoteAccessError::StopFailed);
                            self.end_run(run, Some(tunnel), outcome, &endpoint, &hosts)
                                .await;
                            return;
                        }
                        log::info!(
                            "[remote-access] no edge connection registered; retrying over HTTP/2"
                        );
                        continue;
                    }
                    let error = if saw_url {
                        RemoteAccessError::NotRegistered
                    } else {
                        RemoteAccessError::NoUrl
                    };
                    self.end_run(run, Some(tunnel), Phase::Failed(error), &endpoint, &hosts)
                        .await;
                    return;
                }
            };

            let Some(host) = host_of(&url) else {
                let outcome = Phase::Failed(RemoteAccessError::NoUrl);
                self.end_run(run, Some(tunnel), outcome, &endpoint, &hosts)
                    .await;
                return;
            };
            // Before the probe, not after it: the probe path is exempt from
            // Host validation, the first real request is not.
            if self.is_current(run) {
                hosts.set_tunnel_host(&host);
            }

            enum Verified {
                Stopped,
                Exited,
                Reachable(bool),
            }
            let verified = tokio::select! {
                _ = &mut stop_rx => Verified::Stopped,
                _ = tunnel.wait_exit() => Verified::Exited,
                reachable = self.deps.prober.verify(&url, timings.probe_total) => {
                    Verified::Reachable(reachable)
                }
            };
            let failure = match verified {
                Verified::Stopped => Some(Phase::Off),
                Verified::Exited => Some(Phase::Failed(RemoteAccessError::Exited)),
                Verified::Reachable(false) => Some(Phase::Failed(RemoteAccessError::NotReachable)),
                Verified::Reachable(true) => None,
            };
            if let Some(outcome) = failure {
                self.end_run(run, Some(tunnel), outcome, &endpoint, &hosts)
                    .await;
                return;
            }

            if !self.go_online(run, &url) {
                // A stop arrived between the probe and here.
                self.end_run(run, Some(tunnel), Phase::Off, &endpoint, &hosts)
                    .await;
                return;
            }
            log::info!("[remote-access] tunnel online");
            self.announce(&endpoint).await;

            let outcome = tokio::select! {
                _ = &mut stop_rx => Phase::Off,
                _ = tunnel.wait_exit() => Phase::Failed(RemoteAccessError::Exited),
            };
            self.end_run(run, Some(tunnel), outcome, &endpoint, &hosts)
                .await;
            return;
        }
    }
}
