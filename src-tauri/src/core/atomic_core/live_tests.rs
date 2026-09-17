//! The supervisor against a real `atomic-chat-app-core` binary.
//!
//! The fake core proves the app's half of the protocol; these prove the two
//! halves agree. Everything here needs a compiled core, so it runs only when
//! `ATOMIC_CORE_BIN` points at one (`make test-core-live`), and is skipped —
//! loudly, in the log — otherwise.
//!
//! What only a real core can show: that `daemon --control-port 0` publishes a
//! lock this app can read, that its token file is where we look for it, that
//! its protocol number is the one we compiled against, and that killing it
//! leaves a lock the app correctly treats as stale rather than attachable.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::supervisor::Supervisor;

struct NoopSink;

impl super::relay::EventSink for NoopSink {
    fn emit(&self, _name: &str, _payload: serde_json::Value) {}
}

#[derive(Default)]
struct RecordingSink(Mutex<Vec<(String, Value)>>);

impl super::relay::EventSink for RecordingSink {
    fn emit(&self, name: &str, payload: Value) {
        self.0.lock().unwrap().push((name.to_string(), payload));
    }
}

impl RecordingSink {
    fn events(&self) -> Vec<(String, Value)> {
        self.0.lock().unwrap().clone()
    }
}

/// The binary under test, or `None` when this run is not a live run.
fn core_binary() -> Option<PathBuf> {
    let raw = std::env::var("ATOMIC_CORE_BIN").ok()?;
    let path = PathBuf::from(raw);
    assert!(
        path.exists(),
        "ATOMIC_CORE_BIN points at {}, which does not exist",
        path.display()
    );
    Some(path)
}

/// A data folder with the core installed where the app looks for it, so the
/// test exercises the same resolution the packaged app uses rather than the
/// `ATOMIC_CORE_CMD` override.
struct LiveCore {
    data: tempfile::TempDir,
    resources: tempfile::TempDir,
}

impl LiveCore {
    fn new(binary: &std::path::Path) -> Self {
        let resources = tempfile::tempdir().expect("resource dir");
        let bundled = super::launch::bundled_core_path(resources.path());
        std::fs::create_dir_all(bundled.parent().unwrap()).expect("bin dir");
        // A symlink, not a copy: the binary is tens of megabytes and copying it
        // for every test would dominate the run.
        #[cfg(unix)]
        std::os::unix::fs::symlink(binary, &bundled).expect("link core");
        #[cfg(windows)]
        std::fs::copy(binary, &bundled)
            .map(|_| ())
            .expect("copy core");
        Self {
            data: tempfile::tempdir().expect("data folder"),
            resources,
        }
    }

    fn supervisor(&self) -> Arc<Supervisor> {
        Arc::new(
            Supervisor::new(
                self.data.path().to_path_buf(),
                self.resources.path().to_path_buf(),
                super::supervisor::expected_core_version().map(str::to_string),
            )
            .with_start_timeout(Duration::from_secs(30)),
        )
    }
}

impl Drop for LiveCore {
    fn drop(&mut self) {
        // Leave nothing running: a core that outlived its test would hold the
        // temp folder open and keep answering on a port.
        let mut system = sysinfo::System::new();
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        if let super::lock::LockState::Owned(record) =
            super::lock::inspect(self.data.path(), &system)
        {
            if record.owner_scope.as_deref() == Some("app")
                && super::lock::owner_identity_confirmed(&record, &system)
            {
                let process = system.process(sysinfo::Pid::from_u32(record.pid)).unwrap();
                process.kill();
            }
        }
    }
}

fn kill_owner(data_folder: &std::path::Path) -> u32 {
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let super::lock::LockState::Owned(record) = super::lock::inspect(data_folder, &system) else {
        panic!("expected a live owner to kill");
    };
    let process = system
        .process(sysinfo::Pid::from_u32(record.pid))
        .expect("owner process");
    process.kill();
    record.pid
}

#[tokio::test]
async fn starts_a_real_core_and_attaches_to_it() {
    let Some(binary) = core_binary() else {
        eprintln!("skipping: ATOMIC_CORE_BIN is not set");
        return;
    };
    let live = LiveCore::new(&binary);
    let supervisor = live.supervisor();

    let attached = supervisor.ensure_attached(true).await.expect("attach");

    assert_eq!(attached.generation, 1);
    assert!(!attached.version.is_empty());
    let sessions = supervisor
        .call("GET", "/sessions", None, false)
        .await
        .expect("sessions");
    assert!(
        sessions["sessions"].as_array().unwrap().is_empty(),
        "a core that just started holds no models"
    );

    supervisor.detach().await;
}

#[tokio::test]
async fn full_app_exit_shuts_down_its_owner_and_releases_the_lock() {
    let Some(binary) = core_binary() else {
        eprintln!("skipping: ATOMIC_CORE_BIN is not set");
        return;
    };
    let live = LiveCore::new(&binary);
    let supervisor = live.supervisor();
    let app = super::commands::AtomicCoreClient::for_live_test(Arc::clone(&supervisor));
    let attached = supervisor.ensure_attached(true).await.expect("app owner");
    app.stop_for_live_test().await;
    assert!(supervisor.current().await.is_none());
    assert!(matches!(
        super::lock::inspect(live.data.path(), &{
            let mut system = sysinfo::System::new();
            system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            system
        }),
        super::lock::LockState::Free
    ));
    assert!(
        attached.client.health().await.is_err(),
        "the owner control listener must be closed"
    );
}

#[tokio::test]
async fn next_app_launch_replaces_an_idle_owner_with_an_outdated_lock_version() {
    let Some(binary) = core_binary() else {
        eprintln!("skipping: ATOMIC_CORE_BIN is not set");
        return;
    };
    let live = LiveCore::new(&binary);
    let first = live.supervisor();
    let old = first.ensure_attached(true).await.expect("first app owner");
    first.detach().await;
    let path = super::lock::instance_lock_path(live.data.path());
    let mut record: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    record["version"] = json!("0.1.0");
    std::fs::write(&path, record.to_string()).unwrap();

    let next = live.supervisor();
    let replacement = next
        .ensure_attached(true)
        .await
        .expect("replace the idle old app core");
    assert_ne!(replacement.instance_id, old.instance_id);
    assert_ne!(replacement.pid, old.pid);
    assert_eq!(replacement.version, "0.2.0");
    next.detach().await;
}

#[tokio::test]
async fn next_app_launch_never_stops_a_process_without_proven_start_identity() {
    let Some(binary) = core_binary() else {
        eprintln!("skipping: ATOMIC_CORE_BIN is not set");
        return;
    };
    let live = LiveCore::new(&binary);
    let first = live.supervisor();
    let old = first.ensure_attached(true).await.expect("first app owner");
    first.detach().await;
    let path = super::lock::instance_lock_path(live.data.path());
    let mut record: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    record["version"] = json!("0.1.0");
    record.as_object_mut().unwrap().remove("owner_started_at");
    record.as_object_mut().unwrap().remove("process_start_id");
    std::fs::write(&path, record.to_string()).unwrap();

    let next = live.supervisor();
    assert_eq!(
        next.ensure_attached(true).await.unwrap_err().code,
        "CORE_ALREADY_RUNNING"
    );
    assert_eq!(
        old.client.health().await.unwrap().instance_id,
        old.instance_id
    );
    // The test itself owns this process. Stop it via authenticated control,
    // because LiveCore's cleanup intentionally refuses unknown PID identity.
    old.client
        .call("POST", "/shutdown", Some(json!({})))
        .await
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while path.exists() && std::time::Instant::now() < deadline {
        super::launch::reap_finished();
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!path.exists());
}

#[tokio::test]
async fn vanished_app_registration_expires_and_the_core_exits_without_a_shutdown_request() {
    let Some(binary) = core_binary() else {
        eprintln!("skipping: ATOMIC_CORE_BIN is not set");
        return;
    };
    let live = LiveCore::new(&binary);
    let supervisor = live.supervisor();
    let attached = supervisor.ensure_attached(true).await.expect("app owner");
    let pid = attached.pid;
    // Simulate an app crash: neither heartbeat nor unregister nor shutdown is sent.
    drop(attached);
    drop(supervisor);
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        super::launch::reap_finished();
        let mut system = sysinfo::System::new();
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        if matches!(
            super::lock::inspect(live.data.path(), &system),
            super::lock::LockState::Free
        ) {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "app-core outlived the client registration lease"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    // Releasing the lock is an early shutdown step. The child can still be
    // exiting when the lock disappears, so observe its exit separately.
    loop {
        super::launch::reap_finished();
        let mut system = sysinfo::System::new();
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        if system.process(sysinfo::Pid::from_u32(pid)).is_none() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "app-core released its lock but did not exit after the registration expired"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test]
async fn a_second_app_does_not_attach_to_the_first_apps_live_core() {
    let Some(binary) = core_binary() else {
        eprintln!("skipping: ATOMIC_CORE_BIN is not set");
        return;
    };
    let live = LiveCore::new(&binary);
    let first = live.supervisor();
    let attached = first.ensure_attached(true).await.expect("attach");

    // A new app process must not inherit the first process's models or secrets.
    let second = live.supervisor();
    assert_eq!(second.ensure_attached(false).await.unwrap_err().code, "CORE_NOT_RUNNING");
    assert_eq!(attached.client.health().await.unwrap().instance_id, attached.instance_id);

    first.detach().await;
    second.detach().await;
}

#[tokio::test]
async fn a_new_app_replaces_a_same_version_orphan_after_the_old_client_detaches() {
    let Some(binary) = core_binary() else {
        eprintln!("skipping: ATOMIC_CORE_BIN is not set");
        return;
    };
    let live = LiveCore::new(&binary);
    let first = live.supervisor();
    let old = first.ensure_attached(true).await.expect("old app owner");
    first.detach().await;
    let second = live.supervisor();
    let new = second.ensure_attached(true).await.expect("replace old app owner");
    assert_ne!(new.instance_id, old.instance_id);
    assert_ne!(new.pid, old.pid);
    second.detach().await;
}

#[tokio::test]
async fn a_killed_core_is_noticed_and_replaced_exactly_once() {
    let Some(binary) = core_binary() else {
        eprintln!("skipping: ATOMIC_CORE_BIN is not set");
        return;
    };
    let live = LiveCore::new(&binary);
    let supervisor = live.supervisor();
    let first = supervisor.ensure_attached(true).await.expect("attach");

    let killed = kill_owner(live.data.path());
    assert_eq!(killed, first.pid);
    // The lock is still on disk, naming a process that no longer exists.
    tokio::time::sleep(Duration::from_millis(300)).await;

    assert!(
        !supervisor.heartbeat_once().await,
        "a core that was killed is not still attached"
    );

    let second = supervisor.ensure_attached(true).await.expect("reattach");

    assert_ne!(second.instance_id, first.instance_id);
    assert_ne!(second.pid, first.pid);
    assert_eq!(second.generation, first.generation + 1);

    supervisor.detach().await;
}

#[tokio::test]
async fn a_fourth_real_crash_within_the_restart_window_does_not_spawn_another_owner() {
    let Some(binary) = core_binary() else {
        eprintln!("skipping: ATOMIC_CORE_BIN is not set");
        return;
    };
    let live = LiveCore::new(&binary);
    let supervisor = live.supervisor();
    let mut attached = supervisor.ensure_attached(true).await.expect("cold start");

    for expected_generation in 2..=4 {
        kill_owner(live.data.path());
        assert!(!supervisor.heartbeat_once().await);
        let replacement = supervisor
            .ensure_attached(true)
            .await
            .expect("budgeted restart");
        assert_eq!(replacement.generation, expected_generation);
        assert_ne!(replacement.instance_id, attached.instance_id);
        attached = replacement;
    }

    kill_owner(live.data.path());
    assert!(!supervisor.heartbeat_once().await);
    let refused = supervisor.ensure_attached(true).await.unwrap_err();
    assert_eq!(refused.code, "CORE_START_FAILED");
    assert!(supervisor.current().await.is_none());
    assert!(matches!(
        super::lock::inspect(live.data.path(), &{
            let mut system = sysinfo::System::new();
            system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            system
        }),
        super::lock::LockState::Stale(_) | super::lock::LockState::Free
    ));
}

#[tokio::test]
async fn production_lifecycle_starts_and_replaces_a_core_without_a_manual_call() {
    let Some(binary) = core_binary() else {
        eprintln!("skipping: ATOMIC_CORE_BIN is not set");
        return;
    };
    let live = LiveCore::new(&binary);
    let supervisor = live.supervisor();
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(super::relay::run(
        Arc::clone(&supervisor),
        Arc::new(NoopSink),
        cancel_rx,
    ));

    let first = wait_for_attachment(&supervisor, 0).await;
    kill_owner(live.data.path());

    let replacement = wait_for_attachment(&supervisor, first.generation).await;
    assert_ne!(replacement.instance_id, first.instance_id);
    assert_ne!(replacement.pid, first.pid);

    let _ = cancel_tx.send(());
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("lifecycle stops after cancellation")
        .expect("lifecycle task did not panic");
    supervisor.detach().await;
}

#[tokio::test]
async fn production_relay_delivers_one_snapshot_then_deltas_and_resnapshots_after_a_real_crash() {
    let Some(binary) = core_binary() else {
        eprintln!("skipping: ATOMIC_CORE_BIN is not set");
        return;
    };
    let live = LiveCore::new(&binary);
    let supervisor = live.supervisor();
    let sink = Arc::new(RecordingSink::default());
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(super::relay::run(
        Arc::clone(&supervisor),
        Arc::clone(&sink),
        cancel_rx,
    ));

    let first = wait_for_attachment(&supervisor, 0).await;
    wait_for_event(&sink, |(name, payload)| {
        name == super::relay::SNAPSHOT_EVENT
            && payload["generation"] == first.generation
            && payload["snapshot"]["instance_id"] == first.instance_id
    })
    .await;
    supervisor
        .call(
            "PUT",
            "/backends/llamacpp-upstream/optimal",
            Some(json!({"expected_revision": 0, "optimal": null})),
            false,
        )
        .await
        .expect("write optimal result through real control listener");
    wait_for_event(&sink, |(name, payload)| {
        name == "atomic-core://backend:optimal-changed" && payload["revision"] == 1
    })
    .await;
    let before_crash = sink.events();
    let first_snapshot = before_crash
        .iter()
        .position(|(name, _)| name == super::relay::SNAPSHOT_EVENT)
        .unwrap();
    let first_delta = before_crash
        .iter()
        .position(|(name, _)| name == "atomic-core://backend:optimal-changed")
        .unwrap();
    assert!(
        first_snapshot < first_delta,
        "the app must see a baseline before its delta"
    );

    kill_owner(live.data.path());
    let replacement = wait_for_attachment(&supervisor, first.generation).await;
    wait_for_event(&sink, |(name, payload)| {
        name == super::relay::SNAPSHOT_EVENT
            && payload["generation"] == replacement.generation
            && payload["snapshot"]["instance_id"] == replacement.instance_id
    })
    .await;
    let events = sink.events();
    let detached = events
        .iter()
        .position(|(name, payload)| {
            name == super::relay::DETACHED_EVENT && payload["generation"] == first.generation
        })
        .expect("old generation was invalidated");
    let new_snapshot = events
        .iter()
        .position(|(name, payload)| {
            name == super::relay::SNAPSHOT_EVENT && payload["generation"] == replacement.generation
        })
        .unwrap();
    assert!(first_delta < detached && detached < new_snapshot);
    assert_eq!(
        events
            .iter()
            .filter(|(name, _)| name == "atomic-core://backend:optimal-changed")
            .count(),
        1
    );

    let _ = cancel_tx.send(());
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("lifecycle stops")
        .expect("lifecycle did not panic");
    supervisor.detach().await;
}

async fn wait_for_event(sink: &RecordingSink, predicate: impl Fn(&(String, Value)) -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if sink.events().iter().any(&predicate) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "relay did not deliver the event"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn wait_for_attachment(
    supervisor: &Arc<Supervisor>,
    after_generation: u64,
) -> Arc<super::supervisor::Attached> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(attached) = supervisor.current().await {
            if attached.generation > after_generation {
                return attached;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "lifecycle did not attach to a core"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn the_command_override_starts_a_core_a_build_does_not_bundle() {
    // The development path: `ATOMIC_CORE_CMD="bun run …/src/app-daemon.ts" yarn dev`
    // runs the core from source against an app build that has no core in its
    // resources. Here the override points at the binary instead of at bun, so
    // the test needs no toolchain; what it proves is that the override is
    // consulted and wins, which is the part the app owns.
    let Some(binary) = core_binary() else {
        eprintln!("skipping: ATOMIC_CORE_BIN is not set");
        return;
    };
    let data = tempfile::tempdir().expect("data folder");
    let empty_resources = tempfile::tempdir().expect("resource dir");

    // Safe in this edition, and the live tests run single-threaded (see the
    // `test-core-live` target) so no other test observes the change.
    std::env::set_var(
        super::launch::CORE_COMMAND_ENV,
        format!("\"{}\"", binary.display()),
    );
    let supervisor = Arc::new(
        Supervisor::new(
            data.path().to_path_buf(),
            empty_resources.path().to_path_buf(),
            None,
        )
        .with_start_timeout(Duration::from_secs(30)),
    );

    let attached = supervisor.ensure_attached(true).await;
    std::env::remove_var(super::launch::CORE_COMMAND_ENV);
    let attached = attached.expect("attach to the overridden core");

    assert!(!attached.version.is_empty());
    supervisor.detach().await;

    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    if let super::lock::LockState::Owned(record) = super::lock::inspect(data.path(), &system) {
        if record.pid == attached.pid && super::lock::owner_identity_confirmed(&record, &system) {
            if let Some(process) = system.process(sysinfo::Pid::from_u32(record.pid)) {
                process.kill();
            }
        }
    }
}

#[tokio::test]
async fn detach_allows_a_short_reconnect_before_the_app_registration_expires() {
    let Some(binary) = core_binary() else {
        eprintln!("skipping: ATOMIC_CORE_BIN is not set");
        return;
    };
    let live = LiveCore::new(&binary);
    let supervisor = live.supervisor();
    let attached = supervisor.ensure_attached(true).await.expect("attach");
    let pid = attached.pid;

    supervisor.detach().await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    assert!(
        system.process(sysinfo::Pid::from_u32(pid)).is_some(),
        "a transient detach should leave a short reconnection window"
    );

    // And the app can come back to it, which is what happens on the next launch.
    let again = supervisor.ensure_attached(false).await.expect("reattach");
    assert_eq!(again.pid, pid);
    supervisor.detach().await;
}

/// Control calls straight through the supervisor, as a handover makes them.
struct SupervisorCaller(Arc<Supervisor>);

#[async_trait::async_trait]
impl crate::core::server::ownership::ControlCaller for SupervisorCaller {
    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, super::client::CoreError> {
        self.0.call(method, path, body, true).await
    }
}

/// Stands in for the app's proxy: holds the port the way a running server does.
struct PortHolder {
    port: u16,
    listener: tokio::sync::Mutex<Option<std::net::TcpListener>>,
    fail_restart: bool,
}

#[async_trait::async_trait]
impl crate::core::server::ownership::PublicApiOwner for PortHolder {
    fn label(&self) -> &'static str {
        "app"
    }
    async fn running_port(&self) -> Result<Option<u16>, String> {
        Ok(self.listener.lock().await.as_ref().map(|_| self.port))
    }
    async fn start(
        &self,
        config: &crate::core::server::ownership::StartServerConfig,
    ) -> Result<u16, String> {
        if self.fail_restart {
            return Err("restart refused".into());
        }
        let listener =
            std::net::TcpListener::bind(("127.0.0.1", config.port)).map_err(|e| e.to_string())?;
        *self.listener.lock().await = Some(listener);
        Ok(config.port)
    }
    async fn stop(&self) -> Result<(), String> {
        self.listener.lock().await.take();
        Ok(())
    }
}

fn server_config(port: u16, host: &str) -> crate::core::server::ownership::StartServerConfig {
    crate::core::server::ownership::StartServerConfig {
        host: host.into(),
        port,
        prefix: "/v1".into(),
        api_key: String::new(),
        trusted_hosts: vec![],
        proxy_timeout: 600,
    }
}

#[tokio::test]
async fn the_public_api_moves_to_a_real_core_on_the_same_port_and_back() {
    use crate::core::server::ownership::{hand_over, CoreOwner, Handover, PublicApiOwner};

    let Some(binary) = core_binary() else {
        eprintln!("skipping: ATOMIC_CORE_BIN is not set");
        return;
    };
    let live = LiveCore::new(&binary);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("app server port");
    let port = listener.local_addr().unwrap().port();
    let app = PortHolder {
        port,
        listener: tokio::sync::Mutex::new(Some(listener)),
        fail_restart: false,
    };
    let core = CoreOwner {
        caller: SupervisorCaller(live.supervisor()),
        providers: vec![(
            "cloudprov".to_string(),
            json!({"api_key": "sk-live", "base_url": "http://127.0.0.1:9/v1", "custom_headers": [], "models": ["cloud-model"]}),
        )],
        external_sessions: Vec::new(),
        external_generation: 1,
    };
    let config = server_config(port, "127.0.0.1");

    let moved = hand_over(&app, &core, Some(&config))
        .await
        .expect("handover to the core");
    assert_eq!(
        moved,
        Handover::Moved(port),
        "the core took over the very port the app released"
    );
    let models: Value = reqwest::get(format!("http://127.0.0.1:{port}/v1/models"))
        .await
        .expect("core answers on the moved port")
        .json()
        .await
        .unwrap();
    assert_eq!(
        models["data"][0]["id"],
        json!("cloud-model"),
        "providers were handed over first"
    );
    let state_file: Value = serde_json::from_str(
        &std::fs::read_to_string(live.data.path().join("local-api-server.json"))
            .expect("state file"),
    )
    .unwrap();
    assert_eq!(state_file["running"], json!(true));
    assert_eq!(state_file["port"], json!(port));

    let back = hand_over(&core, &app, Some(&config))
        .await
        .expect("rollback to the app");
    assert_eq!(back, Handover::Moved(port));
    assert_eq!(core.running_port().await, Ok(None));
    let stopped: Value = serde_json::from_str(
        &std::fs::read_to_string(live.data.path().join("local-api-server.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        stopped["running"],
        json!(false),
        "the core marked the file stopped as it left"
    );
    live.supervisor().detach().await;
}

#[tokio::test]
async fn a_core_that_cannot_serve_hands_the_api_back_or_reports_it_stopped() {
    use crate::core::server::ownership::{hand_over, CoreOwner};

    let Some(binary) = core_binary() else {
        eprintln!("skipping: ATOMIC_CORE_BIN is not set");
        return;
    };
    let live = LiveCore::new(&binary);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("app server port");
    let port = listener.local_addr().unwrap().port();
    let core = CoreOwner {
        caller: SupervisorCaller(live.supervisor()),
        providers: vec![],
        external_sessions: Vec::new(),
        external_generation: 1,
    };
    // An address this machine does not have: even the free-port fallback cannot bind it.
    let unbindable = server_config(port, "203.0.113.7");

    let app = PortHolder {
        port,
        listener: tokio::sync::Mutex::new(Some(listener)),
        fail_restart: false,
    };
    let restored = hand_over(&app, &core, Some(&unbindable)).await.unwrap_err();
    assert!(restored.restored, "{restored}");
    // Refused by the running core itself, not for want of a core.
    assert!(restored.message.contains("did not start"), "{restored}");
    assert!(
        !restored.message.contains("no Atomic Chat core"),
        "{restored}"
    );
    eprintln!("refusal seen: {restored}");
    assert!(app.listener.lock().await.is_some(), "the app serves again");

    let doomed = PortHolder {
        port,
        listener: tokio::sync::Mutex::new(app.listener.lock().await.take()),
        fail_restart: true,
    };
    let stopped = hand_over(&doomed, &core, Some(&unbindable))
        .await
        .unwrap_err();
    assert!(!stopped.restored, "{stopped}");
    live.supervisor().detach().await;
}
