//! Keeping the app attached to a core: find one, start one if there is none,
//! register as a client, and notice when it goes away.
//!
//! The supervisor is the only thing in the app that decides *which* core is the
//! current one. Everything else asks it for the attachment and uses whatever it
//! gets; that is what makes "the core died and a new one took its place"
//! expressible at all — the new attachment has a new generation, and anything
//! still holding the old one is told its data is stale rather than silently
//! reading a mirror of a dead process.
//!
//! Deliberately free of Tauri. The attach state machine is the part with the
//! interesting failure modes, so it is testable against a fake core without an
//! app handle, a webview or a resource bundle.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::client::{ControlClient, CoreError};
use super::launch;
use super::lock::{self, LockState};

/// How the app identifies itself in the core's client registry.
pub const CLIENT_NAME: &str = "atomic-chat-app";

/// §3.6: restart backoff, and a ceiling so a core that dies on every start
/// cannot become a spawn loop.
pub const RESTART_DELAYS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(5),
    Duration::from_secs(15),
];
pub const RESTART_WINDOW: Duration = Duration::from_secs(300);
/// A crashed app's client lease lasts 45 seconds; leave time for expiry and shutdown.
const PREVIOUS_APP_RECLAIM_TIMEOUT: Duration = Duration::from_secs(55);

/// The version of the core this app ships, stamped by `build.rs` from
/// `package.json`. `None` in a tree with no pin, which disables the version
/// check but not the protocol check.
pub fn expected_core_version() -> Option<&'static str> {
    option_env!("ATOMIC_CORE_VERSION")
}

/// A live attachment to one core process.
///
/// `generation` increments on every successful attach. Anything derived from a
/// core — a session mirror, an open event stream — carries the generation it
/// was built from, and is discarded when the supervisor has moved on.
pub struct Attached {
    pub client: ControlClient,
    pub instance_id: String,
    pub client_id: String,
    pub version: String,
    pub pid: u32,
    pub generation: u64,
    pub heartbeat_interval: Duration,
    /// The snapshot handed out at registration, consistent with its own cursor.
    pub snapshot: Value,
}

/// Written by hand rather than derived: the client inside holds the control
/// token, and a derived `Debug` would put it in every log line and panic
/// message that formats an attachment.
impl std::fmt::Debug for Attached {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Attached")
            .field("instance_id", &self.instance_id)
            .field("version", &self.version)
            .field("pid", &self.pid)
            .field("generation", &self.generation)
            .field("url", &self.client.base_url())
            .finish()
    }
}

/// Restart bookkeeping: how long to wait before starting a core again, and when
/// to stop trying.
///
/// Only *re*starts are counted. A cold start — the app opening onto a folder
/// nobody owns — is the normal path and must not be delayed; the backoff exists
/// because a core that keeps dying should not be respawned as fast as the app
/// can notice.
pub struct RestartPolicy {
    attempts: Vec<Instant>,
}

impl RestartPolicy {
    pub fn new() -> Self {
        Self {
            attempts: Vec::new(),
        }
    }

    /// How long to wait before the next restart, or `None` when this core has
    /// already been restarted as often as the window allows.
    pub fn next_delay(&mut self, now: Instant) -> Option<Duration> {
        self.attempts
            .retain(|at| now.duration_since(*at) < RESTART_WINDOW);
        let delay = RESTART_DELAYS.get(self.attempts.len()).copied()?;
        self.attempts.push(now);
        Some(delay)
    }
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self::new()
    }
}

pub struct Supervisor {
    data_folder: PathBuf,
    resource_dir: PathBuf,
    /// `None` disables the version check — used by tests and by builds with no
    /// pin. The protocol check is never disabled.
    expected_version: Option<String>,
    /// Serialises attach and launch: two callers must not each start a core.
    attachment: tokio::sync::Mutex<Option<Arc<Attached>>>,
    restarts: Mutex<RestartPolicy>,
    generation: AtomicU64,
    ever_attached: AtomicBool,
    start_timeout: Duration,
}

impl Supervisor {
    pub fn new(
        data_folder: PathBuf,
        resource_dir: PathBuf,
        expected_version: Option<String>,
    ) -> Self {
        Self {
            data_folder,
            resource_dir,
            expected_version,
            attachment: tokio::sync::Mutex::new(None),
            restarts: Mutex::new(RestartPolicy::new()),
            generation: AtomicU64::new(0),
            ever_attached: AtomicBool::new(false),
            start_timeout: launch::START_TIMEOUT,
        }
    }

    pub fn with_start_timeout(mut self, timeout: Duration) -> Self {
        self.start_timeout = timeout;
        self
    }

    pub fn data_folder(&self) -> &Path {
        &self.data_folder
    }

    /// The current attachment, if the app is attached right now. Does not
    /// attach — callers that need one use [`Supervisor::ensure_attached`].
    pub async fn current(&self) -> Option<Arc<Attached>> {
        self.attachment.lock().await.clone()
    }

    /// Attach to the core that owns this data folder, starting one if `launch`
    /// allows it and nobody owns it yet.
    pub async fn ensure_attached(&self, allow_launch: bool) -> Result<Arc<Attached>, CoreError> {
        let mut guard = self.attachment.lock().await;
        if let Some(attached) = guard.as_ref() {
            return Ok(Arc::clone(attached));
        }
        let attached = Arc::new(self.attach_or_launch(allow_launch).await?);
        self.ever_attached.store(true, Ordering::SeqCst);
        *guard = Some(Arc::clone(&attached));
        Ok(attached)
    }

    /// Forget the attachment if it is still the one `generation` refers to.
    ///
    /// Generation-scoped on purpose: a heartbeat failing for a core we already
    /// replaced must not tear down the healthy attachment that succeeded it.
    pub async fn invalidate(&self, generation: u64) -> bool {
        let mut guard = self.attachment.lock().await;
        match guard.as_ref() {
            Some(attached) if attached.generation == generation => {
                log::info!(
                    "[atomic-core] dropping attachment to instance {} (generation {generation})",
                    attached.instance_id
                );
                *guard = None;
                true
            }
            _ => false,
        }
    }

    /// Detach cleanly: tell the core we are gone, then forget it. The core and
    /// its models keep running — this is a client leaving, not a shutdown.
    pub async fn detach(&self) {
        let attached = self.attachment.lock().await.take();
        if let Some(attached) = attached {
            if let Err(e) = attached.client.unregister(&attached.client_id).await {
                log::debug!("[atomic-core] detach was not acknowledged: {e}");
            }
        }
    }

    /// One control call, with a single reattach if the core disappeared under
    /// us. Exactly one: a core that cannot be reached twice in a row is a
    /// failure the caller has to see, not something to keep retrying.
    pub async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        allow_launch: bool,
    ) -> Result<Value, CoreError> {
        let attached = self.ensure_attached(allow_launch).await?;
        match attached.client.call(method, path, body.clone()).await {
            Ok(value) => Ok(value),
            Err(e) if e.is_unreachable() => {
                self.invalidate(attached.generation).await;
                // A transport error does not say whether the core applied the
                // request before the response was lost. Repeating a mutation
                // can unload a replacement session, start two downloads or
                // even start a new core immediately after shutdown. Only
                // read-only methods are safe to repeat automatically.
                if method.eq_ignore_ascii_case("GET") || method.eq_ignore_ascii_case("HEAD") {
                    let retried = self.ensure_attached(allow_launch).await?;
                    retried.client.call(method, path, body).await
                } else {
                    Err(e)
                }
            }
            Err(e) => Err(e),
        }
    }

    /// Report that we are still here. Returns `false` when the attachment is
    /// gone — either the core forgot us or it is no longer answering — in which
    /// case it has already been invalidated.
    pub async fn heartbeat_once(&self) -> bool {
        let Some(attached) = self.current().await else {
            return false;
        };
        match attached.client.heartbeat(&attached.client_id).await {
            Ok(true) => true,
            Ok(false) => {
                log::info!("[atomic-core] our client registration expired; reattaching");
                self.invalidate(attached.generation).await;
                false
            }
            Err(e) => {
                log::info!("[atomic-core] heartbeat failed: {e}");
                self.invalidate(attached.generation).await;
                false
            }
        }
    }

    async fn attach_or_launch(&self, allow_launch: bool) -> Result<Attached, CoreError> {
        // A core of ours that has died must be released before we read the
        // lock: a zombie keeps its PID, so the record would still look like a
        // live owner and we would try to attach to a process that is gone.
        launch::reap_finished();
        let mut system = sysinfo::System::new();
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        match lock::inspect(&self.data_folder, &system) {
            LockState::Owned(record) if record.is_ready() => {
                if (record.owner_scope.as_deref() == Some("app") || self.expected_version.is_none())
                    && self.expected_version.as_deref().is_none_or(|v| v == record.version) {
                    if !self.ever_attached.load(Ordering::SeqCst) && self.expected_version.is_some() {
                        if !allow_launch {
                            return Err(CoreError::new("CORE_NOT_RUNNING", "The previous app core has not been retired.", None));
                        }
                        self.replace_previous_owner(&record, &system).await?;
                        self.launch().await
                    } else {
                        self.connect(&record.control_base_url()).await
                    }
                } else if allow_launch && record.owner_scope.as_deref() != Some("cli") {
                    self.replace_previous_owner(&record, &system).await?;
                    self.launch().await
                } else {
                    Err(CoreError::new("CORE_VERSION_MISMATCH",
                        "Another core scope or version owns the application data folder.",
                        Some(format!("pid {}, version {}, scope {:?}", record.pid, record.version, record.owner_scope))))
                }
            }
            LockState::Owned(record) => {
                // Someone is starting a core right now. Waiting for it is not
                // the same as starting our own: a live owner must never be
                // raced, however slow it is being.
                log::info!(
                    "[atomic-core] instance {} is starting; waiting for it",
                    record.instance_id
                );
                let record = self.wait_for_ready().await?;
                if record.owner_scope.as_deref() == Some("app")
                    && self.expected_version.as_deref().is_some_and(|v| v == record.version) {
                    if !self.ever_attached.load(Ordering::SeqCst) {
                        if !allow_launch {
                            return Err(CoreError::new("CORE_NOT_RUNNING", "The previous app core has not been retired.", None));
                        }
                        self.replace_previous_owner(&record, &system).await?;
                        self.launch().await
                    } else {
                        self.connect(&record.control_base_url()).await
                    }
                } else if self.expected_version.is_none() {
                    self.connect(&record.control_base_url()).await
                } else if allow_launch && record.owner_scope.as_deref() != Some("cli") {
                    self.replace_previous_owner(&record, &system).await?;
                    self.launch().await
                } else {
                    Err(CoreError::new("CORE_VERSION_MISMATCH", "Different core owns the application folder.", None))
                }
            }
            LockState::Free | LockState::Stale(_) | LockState::Corrupt if allow_launch => {
                self.launch().await
            }
            _ => Err(CoreError::new(
                "CORE_NOT_RUNNING",
                "No Atomic Chat core is running for this data folder.",
                Some(self.data_folder.to_string_lossy().to_string()),
            )),
        }
    }

    async fn replace_previous_owner(
        &self, record: &lock::LockRecord, system: &sysinfo::System,
    ) -> Result<(), CoreError> {
        if !lock::owner_identity_confirmed(record, system) {
            return Err(CoreError::new("CORE_ALREADY_RUNNING",
                "Cannot prove the previous owner's process identity; it will not be stopped.",
                Some(format!("pid {}", record.pid))));
        }
        let token = lock::read_control_token(&self.data_folder).ok_or_else(||
            CoreError::new("CORE_UNREACHABLE", "Previous core has no readable control token.", None))?;
        let client = ControlClient::new(record.control_base_url(), token)?;
        let health = client.health().await?;
        if health.instance_id != record.instance_id || health.pid != record.pid
            || health.owner_scope.as_deref() == Some("cli") {
            return Err(CoreError::new("CORE_PROTOCOL_MISMATCH",
                "Previous core does not match its app lock; refusing to stop it.", None));
        }
        let deadline = Instant::now() + PREVIOUS_APP_RECLAIM_TIMEOUT;
        let mut shutdown_requested = false;
        loop {
            launch::reap_finished();
            let mut fresh = sysinfo::System::new();
            fresh.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            match lock::inspect(&self.data_folder, &fresh) {
                LockState::Free | LockState::Stale(_) => return Ok(()),
                LockState::Owned(current) if current.instance_id == record.instance_id => {
                    if !lock::owner_identity_confirmed(&current, &fresh) {
                        return Err(CoreError::new("CORE_ALREADY_RUNNING", "Previous core identity can no longer be proven.", None));
                    }
                    if !shutdown_requested {
                        match client.call("POST", "/shutdown", Some(serde_json::json!({}))).await {
                            Ok(_) => shutdown_requested = true,
                            Err(error) if error.code == "CORE_ALREADY_RUNNING" => {},
                            Err(error) => return Err(error),
                        }
                    }
                }
                LockState::Owned(_) | LockState::Corrupt => return Err(CoreError::new(
                    "CORE_ALREADY_RUNNING", "The app core changed while retiring its previous owner.", None)),
            }
            if Instant::now() >= deadline {
                return Err(CoreError::new("CORE_ALREADY_RUNNING",
                    "Previous app core still has a live client or did not release its lock.", None));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    /// Full-off startup still retires an orphaned app core, but never launches one.
    pub async fn retire_previous_owner_if_any(&self) -> Result<(), CoreError> {
        let _attachment = self.attachment.lock().await;
        if self.ever_attached.load(Ordering::SeqCst) { return Ok(()); }
        let mut system = sysinfo::System::new();
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        match lock::inspect(&self.data_folder, &system) {
            LockState::Owned(record) if record.owner_scope.as_deref() == Some("app") =>
                self.replace_previous_owner(&record, &system).await,
            LockState::Owned(_) => Err(CoreError::new("CORE_ALREADY_RUNNING", "Another scope owns the app folder.", None)),
            _ => Ok(()),
        }
    }

    async fn launch(&self) -> Result<Attached, CoreError> {
        // A relaunch after we have already been attached is a restart, and
        // restarts are rate-limited; the first start of the session is not.
        if self.ever_attached.load(Ordering::SeqCst) {
            let delay = self
                .restarts
                .lock()
                .unwrap()
                .next_delay(Instant::now())
                .ok_or_else(|| {
                    CoreError::new(
                        "CORE_START_FAILED",
                        "The Atomic Chat core keeps stopping; it will not be started again automatically.",
                        Some(format!(
                            "{} restarts within {} minutes",
                            RESTART_DELAYS.len(),
                            RESTART_WINDOW.as_secs() / 60
                        )),
                    )
                })?;
            if !delay.is_zero() {
                log::info!(
                    "[atomic-core] waiting {}s before restarting",
                    delay.as_secs()
                );
                tokio::time::sleep(delay).await;
            }
        }

        let command = launch::resolve_core_command(
            &self.resource_dir,
            std::env::var(launch::CORE_COMMAND_ENV).ok().as_deref(),
        )?;
        let record =
            launch::launch_and_wait(&command, &self.data_folder, self.start_timeout).await?;
        self.connect(&record.control_base_url()).await
    }

    async fn wait_for_ready(&self) -> Result<lock::LockRecord, CoreError> {
        let deadline = Instant::now() + self.start_timeout;
        loop {
            let mut system = sysinfo::System::new();
            system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            if let LockState::Owned(record) = lock::inspect(&self.data_folder, &system) {
                if record.is_ready() {
                    return Ok(record);
                }
            }
            if Instant::now() >= deadline {
                return Err(CoreError::new(
                    "CORE_START_FAILED",
                    "A core is starting on this data folder but never became ready.",
                    Some(
                        lock::instance_lock_path(&self.data_folder)
                            .display()
                            .to_string(),
                    ),
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Handshake and register against an owner that is already up.
    async fn connect(&self, base_url: &str) -> Result<Attached, CoreError> {
        let token = lock::read_control_token(&self.data_folder).ok_or_else(|| {
            CoreError::new(
                "CORE_UNREACHABLE",
                "The core's control token is missing or unreadable.",
                Some(
                    lock::control_token_path(&self.data_folder)
                        .display()
                        .to_string(),
                ),
            )
        })?;
        let client = ControlClient::new(base_url, token)?;
        let health = client.handshake(self.expected_version.as_deref()).await?;
        let registration = client.register(CLIENT_NAME, std::process::id()).await?;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        log::info!(
            "[atomic-core] attached to instance {} ({}) at {base_url} as generation {generation}",
            health.instance_id,
            health.version
        );
        Ok(Attached {
            client,
            instance_id: health.instance_id,
            client_id: registration.client.id,
            version: health.version,
            pid: health.pid,
            generation,
            heartbeat_interval: Duration::from_millis(
                registration.heartbeat_interval_ms.max(1_000),
            ),
            snapshot: registration.snapshot,
        })
    }
}

/// The command the app would run to start a core, for diagnostics and for the
/// settings UI. Errors are returned rather than logged so the reason a build
/// has no core reaches the user.
pub fn describe_core_command(resource_dir: &Path, data_folder: &Path) -> Result<String, CoreError> {
    let command = launch::resolve_core_command(
        resource_dir,
        std::env::var(launch::CORE_COMMAND_ENV).ok().as_deref(),
    )?;
    Ok(command.display(data_folder))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::atomic_core::test_support::FakeCore;

    fn supervisor(core: &FakeCore, dir: &tempfile::TempDir, version: Option<&str>) -> Supervisor {
        core.publish_lock(dir.path());
        Supervisor::new(
            dir.path().to_path_buf(),
            dir.path().join("resources-that-do-not-exist"),
            version.map(str::to_string),
        )
        .with_start_timeout(Duration::from_millis(300))
    }

    #[test]
    fn the_first_restart_is_quick_and_the_fourth_never_happens() {
        let mut policy = RestartPolicy::new();
        let now = Instant::now();

        assert_eq!(policy.next_delay(now), Some(Duration::from_secs(1)));
        assert_eq!(policy.next_delay(now), Some(Duration::from_secs(5)));
        assert_eq!(policy.next_delay(now), Some(Duration::from_secs(15)));
        assert_eq!(
            policy.next_delay(now),
            None,
            "a core that dies four times in five minutes is broken, not unlucky"
        );
    }

    #[test]
    fn restarts_are_forgotten_once_the_window_has_passed() {
        let mut policy = RestartPolicy::new();
        let start = Instant::now();
        for _ in 0..3 {
            policy.next_delay(start);
        }

        let later = start + RESTART_WINDOW + Duration::from_secs(1);

        assert_eq!(policy.next_delay(later), Some(Duration::from_secs(1)));
    }

    #[tokio::test]
    async fn a_new_app_does_not_adopt_an_existing_owner_without_retirement() {
        let core = FakeCore::start().await;
        let dir = tempfile::tempdir().unwrap();
        let supervisor = supervisor(&core, &dir, Some("9.9.9"));

        assert_eq!(supervisor.ensure_attached(false).await.unwrap_err().code, "CORE_NOT_RUNNING");
        assert_eq!(core.registered_clients(), 0);
    }

    #[tokio::test]
    async fn a_second_caller_reuses_the_attachment_rather_than_registering_again() {
        let core = FakeCore::start().await;
        let dir = tempfile::tempdir().unwrap();
        let supervisor = supervisor(&core, &dir, None);

        let first = supervisor.ensure_attached(false).await.unwrap();
        let second = supervisor.ensure_attached(false).await.unwrap();

        assert_eq!(first.generation, second.generation);
        assert_eq!(core.registered_clients(), 1);
    }

    #[tokio::test]
    async fn refuses_to_attach_to_a_core_of_another_version() {
        let core = FakeCore::start().await;
        let dir = tempfile::tempdir().unwrap();
        let supervisor = supervisor(&core, &dir, Some("0.1.0"));

        let error = supervisor.ensure_attached(false).await.unwrap_err();

        assert_eq!(error.code, "CORE_VERSION_MISMATCH");
        assert_eq!(
            core.registered_clients(),
            0,
            "a core we refuse must not be left holding a registration for us"
        );
    }

    #[tokio::test]
    async fn without_a_control_token_there_is_no_attaching() {
        let core = FakeCore::start().await;
        let dir = tempfile::tempdir().unwrap();
        let supervisor = supervisor(&core, &dir, None);
        std::fs::remove_file(lock::control_token_path(dir.path())).unwrap();

        let error = supervisor.ensure_attached(false).await.unwrap_err();

        assert!(error.is_unreachable(), "got {error}");
    }

    #[tokio::test]
    async fn an_unowned_folder_is_not_a_core_when_launching_is_not_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let supervisor = Supervisor::new(dir.path().to_path_buf(), dir.path().to_path_buf(), None);

        let error = supervisor.ensure_attached(false).await.unwrap_err();

        assert_eq!(error.code, "CORE_NOT_RUNNING");
    }

    #[tokio::test]
    async fn a_build_without_a_bundled_core_says_so_instead_of_hanging() {
        let dir = tempfile::tempdir().unwrap();
        let supervisor = Supervisor::new(
            dir.path().to_path_buf(),
            dir.path().join("no-resources"),
            None,
        );

        let error = supervisor.ensure_attached(true).await.unwrap_err();

        assert_eq!(error.code, "CORE_NOT_INSTALLED");
    }

    #[tokio::test]
    async fn a_dead_core_invalidates_the_attachment_and_the_next_one_is_a_new_generation() {
        let mut core = FakeCore::start().await;
        let dir = tempfile::tempdir().unwrap();
        let supervisor = supervisor(&core, &dir, None);
        let first = supervisor.ensure_attached(false).await.unwrap();

        core.stop().await;

        assert!(
            !supervisor.heartbeat_once().await,
            "a core that stopped answering is not still attached"
        );
        assert!(supervisor.current().await.is_none());

        // A replacement core takes the folder; the app attaches to it and
        // everything derived from the old instance is a generation behind.
        let replacement = FakeCore::start().await;
        replacement.set_instance_id("instance-b");
        replacement.publish_lock(dir.path());

        let second = supervisor.ensure_attached(false).await.unwrap();

        assert_eq!(second.instance_id, "instance-b");
        assert!(second.generation > first.generation);
    }

    #[tokio::test]
    async fn a_registration_the_core_forgot_is_dropped_so_the_app_registers_again() {
        let core = FakeCore::start().await;
        let dir = tempfile::tempdir().unwrap();
        let supervisor = supervisor(&core, &dir, None);
        supervisor.ensure_attached(false).await.unwrap();

        core.forget_clients();

        assert!(!supervisor.heartbeat_once().await);
        supervisor.ensure_attached(false).await.unwrap();
        assert_eq!(core.registered_clients(), 1);
    }

    #[tokio::test]
    async fn invalidating_an_older_generation_leaves_the_current_attachment_alone() {
        let core = FakeCore::start().await;
        let dir = tempfile::tempdir().unwrap();
        let supervisor = supervisor(&core, &dir, None);
        let attached = supervisor.ensure_attached(false).await.unwrap();

        assert!(!supervisor.invalidate(attached.generation - 1).await);
        assert!(supervisor.current().await.is_some());

        assert!(supervisor.invalidate(attached.generation).await);
        assert!(supervisor.current().await.is_none());
    }

    #[tokio::test]
    async fn detaching_leaves_the_core_running_without_us() {
        let core = FakeCore::start().await;
        let dir = tempfile::tempdir().unwrap();
        let supervisor = supervisor(&core, &dir, None);
        supervisor.ensure_attached(false).await.unwrap();

        supervisor.detach().await;

        assert_eq!(core.registered_clients(), 0);
        assert!(supervisor.current().await.is_none());
        assert!(
            core.client().health().await.is_ok(),
            "detaching is a client leaving, not a shutdown"
        );
    }

    #[tokio::test]
    async fn a_call_reattaches_once_when_the_core_was_replaced_underneath_it() {
        let mut core = FakeCore::start().await;
        let dir = tempfile::tempdir().unwrap();
        let supervisor = supervisor(&core, &dir, None);
        supervisor.ensure_attached(false).await.unwrap();

        // The core dies and another takes the folder before the next call.
        core.stop().await;
        let replacement = FakeCore::start().await;
        replacement.set_instance_id("instance-b");
        replacement.set_sessions(serde_json::json!([{ "model_id": "m" }]));
        replacement.publish_lock(dir.path());

        let sessions = supervisor
            .call("GET", "/sessions", None, false)
            .await
            .unwrap();

        assert_eq!(sessions["sessions"][0]["model_id"], "m");
        assert_eq!(
            supervisor.current().await.unwrap().instance_id,
            "instance-b"
        );
    }

    #[tokio::test]
    async fn a_mutation_is_not_replayed_after_an_ambiguous_transport_failure() {
        let core = FakeCore::start().await;
        let dir = tempfile::tempdir().unwrap();
        let supervisor = supervisor(&core, &dir, None);
        supervisor.ensure_attached(false).await.unwrap();

        for (index, method) in ["POST", "PUT", "PATCH", "DELETE"].into_iter().enumerate() {
            let error = supervisor
                .call(method, "/test/apply-then-drop-response", None, false)
                .await
                .unwrap_err();

            assert!(error.is_unreachable(), "{method} returned {error}");
            assert_eq!(
                core.applied_mutations(),
                index as u64 + 1,
                "the core applied {method} before its response was lost; retrying would apply it twice"
            );
            assert!(
                supervisor.current().await.is_none(),
                "the ambiguous error still invalidates the attachment for the next independent call"
            );
        }
    }

    #[tokio::test]
    async fn a_call_that_finds_no_core_at_all_fails_rather_than_retrying_forever() {
        let mut core = FakeCore::start().await;
        let dir = tempfile::tempdir().unwrap();
        let supervisor = supervisor(&core, &dir, None);
        supervisor.ensure_attached(false).await.unwrap();

        core.stop().await;

        let error = supervisor
            .call("GET", "/sessions", None, false)
            .await
            .unwrap_err();

        assert!(error.is_unreachable(), "got {error}");
    }

    #[tokio::test]
    async fn an_error_from_the_core_is_passed_through_untouched() {
        let core = FakeCore::start().await;
        let dir = tempfile::tempdir().unwrap();
        let supervisor = supervisor(&core, &dir, None);

        let error = supervisor
            .call("GET", "/no-such-route", None, false)
            .await
            .unwrap_err();

        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert!(
            supervisor.current().await.is_some(),
            "the core answered, so the attachment is fine"
        );
    }
}
