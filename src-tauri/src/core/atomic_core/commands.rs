//! The webview's and the app's entry points to the core.
//!
//! One command, `atomic_core_call`, carries every request. That is deliberate:
//! the control API is already a versioned HTTP surface, and wrapping each of its
//! forty routes in a Tauri command would be a second surface to keep in step
//! with it. What Rust adds is the credential — the control token never reaches
//! JS — and the supervisor's reattach behaviour.
//!
//! On desktop the core owns every local runtime and serves the public API
//! (PLAN.md §4, stage 6): the client starts with the app and stops only on full
//! exit or a factory reset. There is no switch back to an in-app engine.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use super::client::CoreError;
use super::relay::{self, EventSink};
use super::supervisor::{self, Supervisor};
use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::sessions::mirror::CoreSessions;

/// The app's attachment to the core, plus the background work that keeps it
/// alive. Managed state, so commands reach it without going through `AppState`.
pub struct AtomicCoreClient {
    supervisor: Arc<Supervisor>,
    /// What the core has loaded, as far as this app knows. Emptied whenever the
    /// attachment goes, so nothing can resolve a model to a port that died with it.
    sessions: Arc<CoreSessions>,
    enabled: AtomicBool,
    server_running_intent: AtomicBool,
    last_server_recovery: AtomicU64,
    /// Serialises public-server, provider and sign-in operations, so a reattach recovery never
    /// interleaves with a start or stop the webview asked for.
    transition: tokio::sync::Mutex<()>,
    /// Calls hold a read permit; stopping first closes the atomic gate, then
    /// takes the write permit, so it drains in-flight calls before cancelling
    /// the lifecycle and forbids new ones from relaunching the core.
    operations: tokio::sync::RwLock<()>,
    background: Mutex<Option<BackgroundTask>>,
}

struct BackgroundTask {
    cancel: tokio::sync::oneshot::Sender<()>,
    handle: tokio::task::JoinHandle<()>,
}

impl AtomicCoreClient {
    pub(super) fn new(supervisor: Arc<Supervisor>) -> Self {
        Self {
            supervisor,
            sessions: Arc::new(CoreSessions::new()),
            enabled: AtomicBool::new(false),
            server_running_intent: AtomicBool::new(false),
            last_server_recovery: AtomicU64::new(0),
            transition: tokio::sync::Mutex::new(()),
            operations: tokio::sync::RwLock::new(()),
            background: Mutex::new(None),
        }
    }

    #[cfg(test)]
    pub(super) async fn stop_for_live_test(&self) {
        self.stop().await;
    }

    pub(crate) async fn owner_gate(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.transition.lock().await
    }

    pub fn supervisor(&self) -> Arc<Supervisor> {
        Arc::clone(&self.supervisor)
    }

    /// The app's mirror of what the core has loaded: the single place anything in the app asks
    /// "where is this model served?".
    pub fn sessions(&self) -> Arc<CoreSessions> {
        Arc::clone(&self.sessions)
    }

    /// Whether the client is running (false only before setup and after exit).
    pub(crate) fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub(crate) fn set_server_running_intent(&self, running: bool) {
        self.server_running_intent.store(running, Ordering::SeqCst);
    }

    fn claim_server_recovery(&self, generation: u64) -> bool {
        let mut observed = self.last_server_recovery.load(Ordering::SeqCst);
        loop {
            if generation <= observed { return false; }
            match self.last_server_recovery.compare_exchange(observed, generation, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => return true,
                Err(current) => observed = current,
            }
        }
    }

    fn is_running(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
            && self
                .background
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|task| !task.handle.is_finished())
    }

    /// Start the one background lifecycle task. It owns both heartbeat and SSE
    /// so an expired registration or a dead stream cannot leave the other half
    /// believing the old generation is still current.
    async fn start<R: Runtime>(&self, app: &AppHandle<R>) {
        self.enabled.store(true, Ordering::SeqCst);
        let mut background = self.background.lock().unwrap();
        if background
            .as_ref()
            .is_some_and(|task| !task.handle.is_finished())
        {
            return;
        }
        // A completed task has no work left to cancel; dropping its handle is
        // the non-blocking equivalent of joining an already-finished task.
        background.take();
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
        let sink = Arc::new(TauriSink {
            app: app.clone(),
            sessions: Arc::clone(&self.sessions),
        });
        let handle = tokio::spawn(relay::run(Arc::clone(&self.supervisor), sink, cancel_rx));
        *background = Some(BackgroundTask {
            cancel: cancel_tx,
            handle,
        });
    }

    /// Drain control calls and stop this app's core. Closing only the window to
    /// the tray never calls this; full exit and a factory reset do.
    async fn stop(&self) {
        self.set_server_running_intent(false);
        self.enabled.store(false, Ordering::SeqCst);
        // A queued writer also prevents later readers from cutting in: calls
        // already holding a permit finish, while calls arriving after the
        // transition observe `enabled = false` once this permit is released.
        let _exclusive = self.operations.write().await;
        if let Err(error) = self.stop_unlocked().await {
            log::warn!("[atomic-core] could not shut down app-owned core: {error}");
        }
    }

    async fn stop_unlocked(&self) -> Result<(), CoreError> {
        self.enabled.store(false, Ordering::SeqCst);
        let task = self.background.lock().unwrap().take();
        if let Some(task) = task {
            let _ = task.cancel.send(());
            if let Err(error) = task.handle.await {
                if !error.is_cancelled() {
                    log::debug!("[atomic-core] lifecycle task stopped with an error: {error}");
                }
            }
        }
        let mut shutdown = Ok(());
        let attachment = match self.supervisor.current().await {
            Some(attached) => Some(attached),
            None => match self.supervisor.ensure_attached(false).await {
                Ok(attached) => Some(attached),
                Err(error) if error.code == "CORE_NOT_RUNNING" => {
                    self.supervisor.retire_previous_owner_if_any().await?;
                    None
                },
                // A foreign or unprovable owner must not be stopped. Waiting
                // for its lock to vanish would only stall app exit for 20 s.
                Err(error) => return Err(error),
            },
        };
        if let Some(attached) = attachment {
            shutdown = attached
                .client
                .call(
                    "POST",
                    "/shutdown",
                    Some(json!({"client_id": attached.client_id})),
                )
                .await
                .map(|_| ());
        }
        self.supervisor.detach().await;
        if shutdown.is_ok() {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            while std::time::Instant::now() < deadline {
                super::launch::reap_finished();
                let mut system = sysinfo::System::new();
                system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
                if !matches!(
                    super::lock::inspect(self.supervisor.data_folder(), &system),
                    super::lock::LockState::Owned(_)
                ) {
                    return Ok(());
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            return Err(CoreError::new(
                "CORE_ALREADY_RUNNING",
                "App-owned core did not release its lock after shutdown.",
                None,
            ));
        }
        shutdown
    }

    fn stopped_error() -> CoreError {
        CoreError::new(
            "CORE_NOT_RUNNING",
            "The Atomic Chat core is not running.",
            Some("the app is starting up or shutting down".into()),
        )
    }

    pub(crate) async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, CoreError> {
        let _operation = self.operations.read().await;
        if !self.enabled.load(Ordering::SeqCst) {
            return Err(Self::stopped_error());
        }
        self.supervisor.call(method, path, body, true).await
    }

    async fn snapshot(&self) -> Result<Value, CoreError> {
        let _operation = self.operations.read().await;
        if !self.enabled.load(Ordering::SeqCst) {
            return Err(Self::stopped_error());
        }
        let attached = self.supervisor.ensure_attached(true).await?;
        let snapshot = attached.client.snapshot().await?;
        relay::snapshot_cursor(&snapshot, &attached.instance_id)?;
        self.sessions
            .apply_snapshot(attached.generation, &attached.instance_id, &snapshot);
        Ok(json!({ "generation": attached.generation, "snapshot": snapshot }))
    }
}

/// Re-emits core events to every webview window.
struct TauriSink<R: Runtime> {
    app: AppHandle<R>,
    sessions: Arc<CoreSessions>,
}

impl<R: Runtime> EventSink for TauriSink<R> {
    fn emit(&self, name: &str, payload: Value) {
        // Request telemetry goes to analytics and the API screen only: it can carry prompt text,
        // which must not reach the webview on any channel but the inspector's own.
        if super::api_requests::ingest(&self.app, name, &payload) {
            return;
        }
        if name == relay::SNAPSHOT_EVENT {
            // A (re)attached core starts with previews off; restate what the API screen wants.
            super::api_requests::push_inspecting(&self.app);
            if let Some(generation) = payload.get("generation").and_then(Value::as_u64) {
                let app = self.app.clone();
                tauri::async_runtime::spawn(async move { recover_public_server(&app, generation).await; });
            }
        }
        // Update the app's own mirror before the webview hears about it: a listener that reacts by
        // asking "where is that model served?" must not be answered from a table that has not
        // caught up with the event it is reacting to.
        self.mirror(name, &payload);
        if let Err(e) = self.app.emit(name, payload.clone()) {
            log::debug!("[atomic-core] could not emit {name}: {e}");
        }
        if let Some((legacy_name, legacy_payload)) = relay::legacy_event_for(name, &payload) {
            if let Err(e) = self.app.emit(&legacy_name, legacy_payload) {
                log::debug!("[atomic-core] could not emit {legacy_name}: {e}");
            }
        }
    }
}

impl<R: Runtime> TauriSink<R> {
    /// Keep `CoreSessions` in step with the stream.
    ///
    /// The relay's own two events carry the generation they belong to; the core's session events do
    /// not, and do not need to — they only ever arrive between a snapshot and a detach, which is
    /// exactly one generation (see `CoreSessions::apply_current_event`).
    fn mirror(&self, name: &str, payload: &Value) {
        match name {
            relay::SNAPSHOT_EVENT => {
                let (Some(generation), Some(snapshot)) = (
                    payload.get("generation").and_then(Value::as_u64),
                    payload.get("snapshot"),
                ) else {
                    return;
                };
                let instance_id = snapshot
                    .get("instance_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                self.sessions
                    .apply_snapshot(generation, instance_id, snapshot);
            }
            relay::DETACHED_EVENT => {
                if let Some(generation) = payload.get("generation").and_then(Value::as_u64) {
                    self.sessions.invalidate(generation);
                }
            }
            other => {
                if let Some(event) = other.strip_prefix(relay::EVENT_PREFIX) {
                    self.sessions.apply_current_event(event, payload);
                }
            }
        }
    }
}

/// Build the client, install the session resolver over its mirror, and start it.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    use crate::core::sessions::resolver::SessionResolver;
    use crate::core::state::AppState;

    let data_folder = get_jan_data_folder_path(app.clone());
    let resource_dir = app.path().resource_dir().unwrap_or_default();
    let supervisor = Arc::new(Supervisor::new(
        data_folder,
        resource_dir,
        supervisor::expected_core_version().map(str::to_string),
    ));
    let client = AtomicCoreClient::new(supervisor);
    let sessions = client.sessions();
    app.manage(client);
    // One resolver for the proxy, the agent and the webview, over the only source of sessions.
    // The slot is a `OnceLock`: a second `setup` keeps the first resolver.
    if let Some(app_state) = app.try_state::<AppState>() {
        if app_state
            .session_resolver
            .set(Arc::new(SessionResolver::new(sessions)))
            .is_err()
        {
            log::debug!("[atomic-core] session resolver was already installed");
        }
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(client) = handle.try_state::<AtomicCoreClient>() {
            client.start(&handle).await;
        }
    });
}

/// Stop the core on the way out: full exit, or before a factory reset deletes the data folder the
/// core is using.
pub async fn shutdown<R: Runtime>(app: &AppHandle<R>) {
    if let Some(client) = app.try_state::<AtomicCoreClient>() {
        let _gate = client.transition.lock().await;
        client.stop().await;
    }
}

/// Any control route, with the token attached here.
///
/// `body` is passed through untouched: the control API's request shapes are its
/// own contract, and re-encoding them in Rust would be a third place to keep
/// them right.
#[tauri::command]
pub async fn atomic_core_call(
    state: State<'_, AtomicCoreClient>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, CoreError> {
    state.call(&method, &path, body).await
}

/// What the app knows about the core right now — for diagnosing a machine where the core will not
/// start, and for the extensions, which wait for an attachment before their first load.
#[tauri::command]
pub async fn atomic_core_status<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AtomicCoreClient>,
) -> Result<Value, CoreError> {
    let supervisor = state.supervisor();
    let resource_dir = app.path().resource_dir().unwrap_or_default();
    let command = supervisor::describe_core_command(&resource_dir, supervisor.data_folder());
    let attached = supervisor.current().await;
    Ok(json!({
        "running": state.is_running(),
        "expected_version": supervisor::expected_core_version(),
        "command": command.as_ref().ok(),
        "command_error": command.as_ref().err(),
        "attached": attached.as_ref().map(|a| json!({
            "instance_id": a.instance_id,
            "version": a.version,
            "pid": a.pid,
            "generation": a.generation,
            "client_id": a.client_id,
        })),
    }))
}

/// The snapshot the app is currently working from, taken fresh.
///
/// Carries the generation so a caller can tell whether what it holds belongs to
/// the core that is running now.
#[tauri::command]
pub async fn atomic_core_snapshot(state: State<'_, AtomicCoreClient>) -> Result<Value, CoreError> {
    state.snapshot().await
}

/// Control calls from a recovery that already holds the gate: straight to the supervisor.
struct SupervisorCaller(Arc<Supervisor>);

#[async_trait::async_trait]
impl crate::core::server::ownership::ControlCaller for SupervisorCaller {
    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, CoreError> {
        self.0.call(method, path, body, true).await
    }
}

/// A new core process has no public listener. Rebuild only a listener that this
/// app had explicitly kept running, and only once for this generation.
async fn recover_public_server<R: Runtime>(app: &AppHandle<R>, generation: u64) {
    use crate::core::server::commands::{core_owner, emit_server_state};
    use crate::core::server::ownership::{last_config, PublicApiOwner};
    use crate::core::state::{AppState, LocalServerEndpoint};

    let Some(state) = app.try_state::<AtomicCoreClient>() else { return; };
    let _gate = state.transition.lock().await;
    if !state.is_enabled() || !state.server_running_intent.load(Ordering::SeqCst) {
        return;
    }
    let Some(attached) = state.supervisor.current().await else { return; };
    if attached.generation != generation || !state.claim_server_recovery(generation) { return; }
    let owner = core_owner(app, SupervisorCaller(state.supervisor())).await;
    match owner.running_port().await {
        Ok(Some(port)) => {
            emit_server_state(app, "core", Some(port), Some(generation));
            return;
        }
        Ok(None) => {},
        Err(error) => {
            log::warn!("[atomic-core] could not determine public server state after reattach: {error}");
            return;
        }
    }
    let Some(config) = last_config() else {
        log::warn!("[atomic-core] cannot restore public API: its last successful configuration is unknown");
        emit_server_state(app, "core", None, Some(generation));
        return;
    };
    match owner.start(&config).await {
        Ok(port) => {
            if state.supervisor.current().await.as_ref().map(|attached| attached.generation) != Some(generation) {
                return;
            }
            *app.state::<AppState>().local_server_endpoint.lock().await =
                Some(LocalServerEndpoint::new(&config.host, port, &config.prefix, &config.api_key));
            emit_server_state(app, "core", Some(port), Some(generation));
        }
        Err(error) => {
            log::warn!("[atomic-core] could not restore public API in generation {generation}: {error}");
            match owner.running_port().await {
                Ok(port) => emit_server_state(app, "core", port, Some(generation)),
                Err(status) => log::warn!("[atomic-core] restored server status is unknown: {status}"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stopped_client(data_folder: &std::path::Path) -> AtomicCoreClient {
        AtomicCoreClient::new(Arc::new(Supervisor::new(
            data_folder.to_path_buf(),
            data_folder.join("resources"),
            None,
        )))
    }

    /// `build.rs` stamps the version from `package.json`; the supervisor refuses
    /// any other core. If the two ever disagree the app would refuse the very
    /// binary it ships, so the stamp is checked against the file it came from.
    #[test]
    fn the_stamped_core_version_is_the_one_package_json_pins() {
        let package_json = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../package.json"),
        )
        .expect("read package.json");
        let pinned: Value = serde_json::from_str(&package_json).expect("parse package.json");
        let pinned = pinned["atomicCore"]["version"]
            .as_str()
            .expect("package.json must pin atomicCore.version");

        assert_eq!(
            supervisor::expected_core_version(),
            Some(pinned),
            "build.rs did not stamp the pinned core version"
        );
    }

    #[tokio::test]
    async fn a_stopped_client_does_not_start_or_attach_to_a_core() {
        let data = tempfile::tempdir().unwrap();
        let client = stopped_client(data.path());

        let call = client.call("GET", "/health", None).await.unwrap_err();
        let snapshot = client.snapshot().await.unwrap_err();

        assert_eq!(call.code, "CORE_NOT_RUNNING");
        assert_eq!(snapshot.code, "CORE_NOT_RUNNING");
        assert!(
            !crate::core::atomic_core::lock::instance_lock_path(data.path()).exists(),
            "a call after exit must not reach ensure_attached or launch a process"
        );
    }

    #[tokio::test]
    async fn stopping_drains_an_in_flight_call_and_rejects_calls_queued_after_it() {
        let data = tempfile::tempdir().unwrap();
        let client = Arc::new(stopped_client(data.path()));
        client.enabled.store(true, Ordering::SeqCst);

        // Stand in for a control request that already crossed the enabled
        // gate. `stop` must wait for this permit before detaching.
        let in_flight = client.operations.read().await;
        let stopping = {
            let client = Arc::clone(&client);
            tokio::spawn(async move { client.stop().await })
        };
        while client.enabled.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }

        let mut late_call = {
            let client = Arc::clone(&client);
            tokio::spawn(async move { client.call("GET", "/health", None).await })
        };
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut late_call)
                .await
                .is_err(),
            "the queued writer gives the stop priority over later calls"
        );

        drop(in_flight);
        stopping.await.unwrap();
        let error = late_call.await.unwrap().unwrap_err();
        assert_eq!(error.code, "CORE_NOT_RUNNING");
    }

}
