//! The webview's and the app's entry points to the core.
//!
//! One command, `atomic_core_call`, carries every request. That is deliberate:
//! the control API is already a versioned HTTP surface, and wrapping each of its
//! forty routes in a Tauri command would be a second surface to keep in step
//! with it. What Rust adds is the credential — the control token never reaches
//! JS — and the supervisor's reattach behaviour.
//!
//! The flags that decide whether any of this runs live in the app's own
//! `settings.json`, so they can be read (and turned off) before the data folder
//! is opened.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use super::client::CoreError;
use super::relay::{self, EventSink};
use super::supervisor::{self, Supervisor};
use crate::core::app::commands::{
    get_app_configurations, get_jan_data_folder_path, update_app_configuration,
};
use crate::core::app::models::AtomicCoreFlags;
use crate::core::sessions::mirror::CoreSessions;

/// The app's attachment to the core, plus the background work that keeps it
/// alive. Managed state, so commands reach it without going through `AppState`
/// — this has its own lifecycle and is absent entirely when the flags are off.
pub struct AtomicCoreClient {
    supervisor: Arc<Supervisor>,
    /// What the core has loaded, as far as this app knows. Emptied whenever the
    /// attachment goes, so nothing can resolve a model to a port that died with it.
    sessions: Arc<CoreSessions>,
    enabled: AtomicBool,
    /// True only while persisted intent and the resolver's active owner are being reconciled.
    /// The extension reads this through `atomic_core_status` and refuses to start a legacy/core
    /// operation across the handover boundary.
    transitioning: AtomicBool,
    /// Serialises settings writes and lifecycle transitions.
    transition: tokio::sync::Mutex<()>,
    /// Calls hold a read permit; disabling first closes the atomic gate, then
    /// takes the write permit, so it drains in-flight calls before cancelling
    /// the lifecycle and forbids new ones from crossing the rollback boundary.
    operations: tokio::sync::RwLock<()>,
    background: Mutex<Option<BackgroundTask>>,
}

struct BackgroundTask {
    cancel: tokio::sync::oneshot::Sender<()>,
    handle: tokio::task::JoinHandle<()>,
}

struct TransitionMarker<'a>(&'a AtomicBool);

impl Drop for TransitionMarker<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl AtomicCoreClient {
    fn mark_transitioning(&self) -> TransitionMarker<'_> {
        self.transitioning.store(true, Ordering::SeqCst);
        TransitionMarker(&self.transitioning)
    }

    pub fn supervisor(&self) -> Arc<Supervisor> {
        Arc::clone(&self.supervisor)
    }

    /// The app's mirror of what the core has loaded. The single place anything in the app asks
    /// "where is this model served?" when the core owns the runtime.
    pub fn sessions(&self) -> Arc<CoreSessions> {
        Arc::clone(&self.sessions)
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

    /// Stop relaying and detach. The core keeps running with its models — this
    /// is the app stepping back, not a shutdown.
    async fn stop(&self) {
        self.enabled.store(false, Ordering::SeqCst);
        // A queued writer also prevents later readers from cutting in: calls
        // already holding a permit finish, while calls arriving after the
        // transition observe `enabled = false` once this permit is released.
        let _exclusive = self.operations.write().await;
        self.stop_unlocked().await;
    }

    async fn stop_unlocked(&self) {
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
        self.supervisor.detach().await;
    }

    fn disabled_error() -> CoreError {
        CoreError::new(
            "CORE_NOT_RUNNING",
            "The Atomic Chat core integration is disabled.",
            Some("enable an atomic_core flag before calling the control API".into()),
        )
    }

    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, CoreError> {
        let _operation = self.operations.read().await;
        if !self.enabled.load(Ordering::SeqCst) {
            return Err(Self::disabled_error());
        }
        if self.transitioning.load(Ordering::SeqCst) {
            return Err(CoreError::new(
                "CORE_TRANSITIONING",
                "The Atomic Chat runtime owner is changing.",
                Some("retry after the ownership transition completes".into()),
            ));
        }
        self.supervisor.call(method, path, body, true).await
    }

    async fn snapshot(&self) -> Result<Value, CoreError> {
        let _operation = self.operations.read().await;
        if !self.enabled.load(Ordering::SeqCst) {
            return Err(Self::disabled_error());
        }
        self.snapshot_unlocked().await
    }

    async fn snapshot_unlocked(&self) -> Result<Value, CoreError> {
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
        // Stage 3b keeps the extension/UI event surface stable while the process owner changes.
        // The core event remains available verbatim; this second emission is the compatibility
        // adapter for listeners that already handle an upstream llama-server crash.
        if let Some(legacy_payload) = legacy_session_died_payload(name, &payload) {
            const LEGACY_DIED: &str = "local_backend://llamacpp_upstream_session_died";
            if let Err(e) = self.app.emit(LEGACY_DIED, legacy_payload) {
                log::debug!("[atomic-core] could not emit {LEGACY_DIED}: {e}");
            }
        }
    }
}

fn legacy_session_died_payload(name: &str, payload: &Value) -> Option<Value> {
    if name != "atomic-core://session:died"
        || payload.get("provider").and_then(Value::as_str) != Some("llamacpp-upstream")
    {
        return None;
    }
    Some(json!({
        "model_id": payload.get("model_id"),
        "pid": payload.get("pid"),
        "error_code": payload.get("error_code")
            .and_then(Value::as_str)
            .unwrap_or("CORE_SESSION_DIED"),
        "message": payload.get("message"),
    }))
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

/// Build the client and, if the flags ask for it, start it.
///
/// Always registers the managed state, even with the flags off: the status and
/// flag commands have to answer either way, and "the core is off" is a real
/// answer the settings UI needs.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let flags = get_app_configurations(app.clone()).atomic_core;
    let data_folder = get_jan_data_folder_path(app.clone());
    let resource_dir = app.path().resource_dir().unwrap_or_default();
    let supervisor = Arc::new(Supervisor::new(
        data_folder,
        resource_dir,
        supervisor::expected_core_version().map(str::to_string),
    ));
    let client = AtomicCoreClient {
        supervisor,
        sessions: Arc::new(CoreSessions::new()),
        enabled: AtomicBool::new(false),
        transitioning: AtomicBool::new(false),
        transition: tokio::sync::Mutex::new(()),
        operations: tokio::sync::RwLock::new(()),
        background: Mutex::new(None),
    };
    app.manage(client);
    install_resolver(app);
    if flags.needs_core() {
        log::info!("[atomic-core] enabled: {flags:?}");
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(client) = handle.try_state::<AtomicCoreClient>() {
                let _transition = client.transition.lock().await;
                let _marker = client.mark_transitioning();
                // The startup task may run after a user has flipped the flag
                // back off. Persisted state wins, not task scheduling order.
                let current = get_app_configurations(handle.clone()).atomic_core;
                if current.needs_core() {
                    let plugin = handle.state::<tauri_plugin_llamacpp_upstream::LlamacppState>();
                    let _ownership = plugin.ownership_gate.write().await;
                    client.start(&handle).await;
                    if current.runtime.is_none() {
                        apply_ownership(&handle, current);
                    } else {
                        let _operations = client.operations.write().await;
                        match client.snapshot_unlocked().await {
                            Ok(_) => apply_ownership(&handle, current),
                            Err(error) => log::warn!(
                                "[atomic-core] persisted runtime ownership stays inactive until a snapshot is ready: {error}"
                            ),
                        }
                    }
                }
            }
        });
    }
}

/// Build the app's single session resolver and put it where everything can reach it.
///
/// It needs the two llama.cpp plugin states, the MLX state and the core's mirror, so it can only be
/// built once all of them exist — which is here, in `setup()`. Installing it is idempotent: the slot
/// is a `OnceLock`, and a second call leaves the first resolver in place rather than handing out a
/// second one with its own view of who owns what.
fn install_resolver<R: Runtime>(app: &AppHandle<R>) {
    use crate::core::sessions::resolver::SessionResolver;
    use crate::core::state::AppState;

    let (Some(app_state), Some(client)) = (
        app.try_state::<AppState>(),
        app.try_state::<AtomicCoreClient>(),
    ) else {
        log::warn!("[atomic-core] no app state yet; sessions will be read from the plugin maps");
        return;
    };
    let llamacpp = app
        .try_state::<tauri_plugin_llamacpp::LlamacppState>()
        .map(|state| state.llama_server_process.clone());
    let upstream = app
        .try_state::<tauri_plugin_llamacpp_upstream::LlamacppState>()
        .map(|state| state.llama_server_process.clone());
    let mlx = app
        .try_state::<tauri_plugin_mlx::state::MlxState>()
        .map(|state| state.mlx_server_process.clone());
    let (Some(llamacpp), Some(upstream), Some(mlx)) = (llamacpp, upstream, mlx) else {
        log::warn!("[atomic-core] a local runtime plugin is missing; resolver not installed");
        return;
    };

    let resolver = Arc::new(SessionResolver::new(
        llamacpp,
        upstream,
        mlx,
        client.sessions(),
    ));
    if app_state.session_resolver.set(resolver).is_err() {
        log::debug!("[atomic-core] session resolver was already installed");
    }
}

/// Tell the resolver which providers the core owns right now.
///
/// This is the whole of the runtime handover: one call, and every resolution for that provider
/// starts coming from the core's mirror instead of the plugin's map. Turning the flag off reverses
/// it just as completely — the plugin never stopped holding what it loaded itself.
fn session_resolver<R: Runtime>(
    app: &AppHandle<R>,
) -> Option<Arc<crate::core::sessions::resolver::SessionResolver>> {
    use crate::core::state::AppState;

    app.try_state::<AppState>()
        .and_then(|state| state.session_resolver.get().cloned())
}

fn active_runtime<R: Runtime>(
    app: &AppHandle<R>,
) -> Option<crate::core::app::models::CoreRuntimeOwner> {
    use crate::core::app::models::CoreRuntimeOwner;
    use crate::core::sessions::resolver::PROVIDER_LLAMACPP_UPSTREAM;

    session_resolver(app).and_then(|resolver| {
        resolver
            .core_owns(PROVIDER_LLAMACPP_UPSTREAM)
            .then_some(CoreRuntimeOwner::LlamacppUpstream)
    })
}

fn apply_ownership<R: Runtime>(app: &AppHandle<R>, flags: AtomicCoreFlags) {
    use crate::core::sessions::resolver::PROVIDER_LLAMACPP_UPSTREAM;

    let Some(resolver) = session_resolver(app) else {
        return;
    };
    let owned: Vec<String> = match flags.runtime {
        Some(crate::core::app::models::CoreRuntimeOwner::LlamacppUpstream) => {
            vec![PROVIDER_LLAMACPP_UPSTREAM.to_string()]
        }
        None => Vec::new(),
    };
    log::info!("[atomic-core] providers owned by the core: {owned:?}");
    resolver.set_core_owned(owned);
    app.state::<tauri_plugin_llamacpp_upstream::LlamacppState>()
        .core_owns_runtime
        .store(flags.runtime.is_some(), Ordering::SeqCst);
}

async fn ensure_outgoing_runtime_is_empty<R: Runtime>(
    app: &AppHandle<R>,
    state: &AtomicCoreClient,
    target: Option<crate::core::app::models::CoreRuntimeOwner>,
) -> Result<(), String> {
    use crate::core::sessions::resolver::PROVIDER_LLAMACPP_UPSTREAM;

    let Some(resolver) = session_resolver(app) else {
        return Err("The session resolver is not installed.".to_string());
    };
    let current = active_runtime(app);
    if current == target {
        return Ok(());
    }

    let sessions = if current.is_some() {
        state
            .snapshot_unlocked()
            .await
            .map_err(|error| format!("Could not verify core sessions before handover: {error}"))?;
        state
            .sessions
            .list()
            .into_iter()
            .filter(|session| session.provider == PROVIDER_LLAMACPP_UPSTREAM)
            .collect::<Vec<_>>()
    } else {
        resolver.list_legacy_in(PROVIDER_LLAMACPP_UPSTREAM).await
    };
    if sessions.is_empty() {
        return Ok(());
    }

    let models = sessions
        .into_iter()
        .map(|session| session.model_id)
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "Cannot change the llamacpp-upstream runtime owner while models are loaded: {models}. Unload them first."
    ))
}

/// Detach on the way out. Called from the app's shutdown path so the core stops
/// counting us as an attached client immediately, rather than waiting for the
/// registration to expire.
pub async fn shutdown<R: Runtime>(app: &AppHandle<R>) {
    if let Some(client) = app.try_state::<AtomicCoreClient>() {
        let _transition = client.transition.lock().await;
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

/// What the app knows about the core right now — for the settings UI and for
/// diagnosing a machine where the core will not start.
#[tauri::command]
pub async fn atomic_core_status<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AtomicCoreClient>,
) -> Result<Value, CoreError> {
    let supervisor = state.supervisor();
    let flags = get_app_configurations(app.clone()).atomic_core;
    let resource_dir = app.path().resource_dir().unwrap_or_default();
    let command = supervisor::describe_core_command(&resource_dir, supervisor.data_folder());
    let attached = supervisor.current().await;
    Ok(json!({
        "flags": flags,
        "active_runtime": active_runtime(&app),
        "transitioning": state.transitioning.load(Ordering::SeqCst),
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

#[tauri::command]
pub fn get_atomic_core_flags<R: Runtime>(app: AppHandle<R>) -> AtomicCoreFlags {
    get_app_configurations(app).atomic_core
}

/// Change what the core owns, and start or stop the client to match.
///
/// Read-modify-write of the whole configuration, so flipping a flag cannot lose
/// the data folder path that sits beside it in the same file.
#[tauri::command]
pub async fn set_atomic_core_flags<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AtomicCoreClient>,
    flags: AtomicCoreFlags,
) -> Result<AtomicCoreFlags, String> {
    let _transition = state.transition.lock().await;
    let _marker = state.mark_transitioning();
    let was_enabled = state.enabled.load(Ordering::SeqCst);
    // Drain calls that already chose the old owner. New core calls wait on this permit and then
    // observe either the committed owner or a disabled client; the webview also sees
    // `transitioning` and does not begin a legacy operation in the middle.
    let _operations = state.operations.write().await;
    let plugin = app.state::<tauri_plugin_llamacpp_upstream::LlamacppState>();
    let _ownership = plugin.ownership_gate.write().await;

    ensure_outgoing_runtime_is_empty(&app, &state, flags.runtime).await?;

    if flags.needs_core() {
        // `start` is idempotent, but it also replaces a lifecycle task that has already exited.
        // Persisted `enabled` alone is therefore not proof that heartbeat/SSE are still running.
        state.start(&app).await;
    }
    if flags.runtime.is_some() {
        if let Err(error) = state.snapshot_unlocked().await {
            if !was_enabled {
                state.stop_unlocked().await;
            }
            return Err(format!("Could not prepare core runtime ownership: {error}"));
        }
    }

    let mut configuration = get_app_configurations(app.clone());
    configuration.atomic_core = flags;
    if let Err(error) = update_app_configuration(app.clone(), configuration) {
        if !was_enabled && state.enabled.load(Ordering::SeqCst) {
            state.stop_unlocked().await;
        }
        return Err(error);
    }

    // Persisted intent is committed only after the outgoing side is empty and the incoming core
    // mirror is ready. From here the resolver switch cannot fail.
    apply_ownership(&app, flags);
    if let Err(error) = app.emit(
        "atomic-core://ownership-changed",
        json!({ "runtime": flags.runtime }),
    ) {
        log::debug!("[atomic-core] could not emit ownership change: {error}");
    }
    if !flags.needs_core() {
        state.stop_unlocked().await;
    }
    drop(_operations);
    drop(_marker);
    Ok(flags)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disabled_client(data_folder: &std::path::Path) -> AtomicCoreClient {
        AtomicCoreClient {
            supervisor: Arc::new(Supervisor::new(
                data_folder.to_path_buf(),
                data_folder.join("resources"),
                None,
            )),
            sessions: Arc::new(CoreSessions::new()),
            enabled: AtomicBool::new(false),
            transitioning: AtomicBool::new(false),
            transition: tokio::sync::Mutex::new(()),
            operations: tokio::sync::RwLock::new(()),
            background: Mutex::new(None),
        }
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

    #[test]
    fn only_upstream_core_crashes_are_mapped_to_the_legacy_event_shape() {
        let mapped = legacy_session_died_payload(
            "atomic-core://session:died",
            &json!({
                "provider": "llamacpp-upstream",
                "model_id": "demo",
                "pid": 42,
                "message": "crashed"
            }),
        )
        .unwrap();

        assert_eq!(mapped["model_id"], "demo");
        assert_eq!(mapped["pid"], 42);
        assert_eq!(mapped["error_code"], "CORE_SESSION_DIED");
        assert!(legacy_session_died_payload(
            "atomic-core://session:died",
            &json!({ "provider": "llamacpp", "model_id": "demo" })
        )
        .is_none());
    }

    #[tokio::test]
    async fn disabled_commands_do_not_start_or_attach_to_a_core() {
        let data = tempfile::tempdir().unwrap();
        let client = disabled_client(data.path());

        let call = client.call("GET", "/health", None).await.unwrap_err();
        let snapshot = client.snapshot().await.unwrap_err();

        assert_eq!(call.code, "CORE_NOT_RUNNING");
        assert_eq!(snapshot.code, "CORE_NOT_RUNNING");
        assert!(
            !crate::core::atomic_core::lock::instance_lock_path(data.path()).exists(),
            "an off command must not reach ensure_attached or launch a process"
        );
    }

    #[tokio::test]
    async fn a_call_cannot_cross_an_ownership_transition() {
        let data = tempfile::tempdir().unwrap();
        let client = disabled_client(data.path());
        client.enabled.store(true, Ordering::SeqCst);
        client.transitioning.store(true, Ordering::SeqCst);

        let error = client.call("GET", "/health", None).await.unwrap_err();

        assert_eq!(error.code, "CORE_TRANSITIONING");
        assert!(
            !crate::core::atomic_core::lock::instance_lock_path(data.path()).exists(),
            "a call rejected at the owner gate must not attach or launch"
        );
    }

    #[tokio::test]
    async fn disabling_drains_an_in_flight_call_and_rejects_calls_queued_after_it() {
        let data = tempfile::tempdir().unwrap();
        let client = Arc::new(disabled_client(data.path()));
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
            "the queued writer gives disable priority over later calls"
        );

        drop(in_flight);
        stopping.await.unwrap();
        let error = late_call.await.unwrap().unwrap_err();
        assert_eq!(error.code, "CORE_NOT_RUNNING");
    }
}
