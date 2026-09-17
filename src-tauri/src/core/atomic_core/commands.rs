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

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::collections::HashMap;
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
    /// A failed compensating handover leaves the persisted owner untrustworthy.
    reconciliation_required: AtomicBool,
    server_running_intent: AtomicBool,
    last_server_recovery: AtomicU64,
    next_runtime_load: AtomicU64,
    runtime_loads: Mutex<HashMap<u64, String>>,
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
    #[cfg(test)]
    pub(super) fn for_live_test(supervisor: Arc<Supervisor>) -> Self {
        Self {
            supervisor,
            sessions: Arc::new(CoreSessions::new()),
            enabled: AtomicBool::new(false),
            transitioning: AtomicBool::new(false),
            reconciliation_required: AtomicBool::new(false),
            server_running_intent: AtomicBool::new(false),
            last_server_recovery: AtomicU64::new(0),
            next_runtime_load: AtomicU64::new(0),
            runtime_loads: Mutex::new(HashMap::new()),
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

    async fn begin_runtime_load(&self, provider: String) -> Result<u64, String> {
        let _transition = self.transition.lock().await;
        self.ensure_reconciled()?;
        if !crate::core::app::models::CoreRuntimeOwner::All.providers().contains(&provider.as_str()) {
            return Err(format!("Unknown runtime provider: {provider}"));
        }
        let id = self.next_runtime_load.fetch_add(1, Ordering::SeqCst) + 1;
        self.runtime_loads.lock().unwrap().insert(id, provider);
        Ok(id)
    }

    fn end_runtime_load(&self, id: u64) {
        self.runtime_loads.lock().unwrap().remove(&id);
    }

    fn loading_runtime_providers(&self, changing: &[(&str, bool)]) -> Vec<String> {
        let active = self.runtime_loads.lock().unwrap();
        active.values().filter(|provider| changing.iter().any(|(name, _)| *name == provider.as_str()))
            .cloned().collect()
    }

    /// A legacy extension holds the plugin gate while it may make a core call.
    /// Taking the operations writer first would deadlock that in-flight call.
    async fn lock_ownership<'a>(
        &'a self,
        plugin_gate: &'a tokio::sync::RwLock<()>,
    ) -> (
        tokio::sync::RwLockWriteGuard<'a, ()>,
        tokio::sync::RwLockWriteGuard<'a, ()>,
    ) {
        let ownership = plugin_gate.write().await;
        let operations = self.operations.write().await;
        (ownership, operations)
    }
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

    /// Whether the app is attached to a core at all (the transport flag is on).
    pub(crate) fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub(crate) fn ensure_reconciled(&self) -> Result<(), String> {
        if self.reconciliation_required.load(Ordering::SeqCst) {
            Err("The Local API Server owner is uncertain after a failed rollback; restart Atomic Chat to reconcile it.".into())
        } else {
            Ok(())
        }
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
        let relay = relay::run(Arc::clone(&self.supervisor), sink, cancel_rx);
        let external = super::external::run(app.clone());
        // One lifecycle: when the relay is cancelled or ends, publishing the app's own engines to
        // this attachment ends with it, and the core expires the registration.
        let handle = tokio::spawn(async move {
            tokio::select! {
                _ = relay => {}
                _ = external => {}
            }
        });
        *background = Some(BackgroundTask {
            cancel: cancel_tx,
            handle,
        });
    }

    /// Drain control calls and stop this app's core. Closing only the window to
    /// the tray never calls this; full exit and disabling every flag do.
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
            // No request after the write gate closes can re-launch this owner.
            let _ = attached
                .client
                .call(
                    "DELETE",
                    "/external-sessions/atomic-chat-app",
                    Some(json!({"generation": super::external::generation()})),
                )
                .await;
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

    fn disabled_error() -> CoreError {
        CoreError::new(
            "CORE_NOT_RUNNING",
            "The Atomic Chat core integration is disabled.",
            Some("enable an atomic_core flag before calling the control API".into()),
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
            return Err(Self::disabled_error());
        }
        if self.transitioning.load(Ordering::SeqCst) {
            return Err(CoreError::new(
                "CORE_TRANSITIONING",
                "The Atomic Chat runtime owner is changing.",
                Some("retry after the ownership transition completes".into()),
            ));
        }
        self.ensure_reconciled().map_err(|message| CoreError::new("CORE_TRANSITIONING", message, None))?;
        self.supervisor.call(method, path, body, true).await
    }

    async fn snapshot(&self) -> Result<Value, CoreError> {
        let _operation = self.operations.read().await;
        if !self.enabled.load(Ordering::SeqCst) {
            return Err(Self::disabled_error());
        }
        self.ensure_reconciled().map_err(|message| CoreError::new("CORE_TRANSITIONING", message, None))?;
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
        // Request telemetry goes to analytics and the API screen only: it can carry prompt text,
        // which must not reach the webview on any channel but the inspector's own.
        if super::api_requests::ingest(&self.app, name, &payload) {
            return;
        }
        if name == super::external::CTX_REQUESTED_EVENT {
            super::external::on_ctx_requested(&self.app, &payload);
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
        reconciliation_required: AtomicBool::new(false),
        server_running_intent: AtomicBool::new(false),
        last_server_recovery: AtomicU64::new(0),
        next_runtime_load: AtomicU64::new(0),
        runtime_loads: Mutex::new(HashMap::new()),
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
                    let (_ownership, _operations) =
                        client.lock_ownership(&plugin.ownership_gate).await;
                    client.start(&handle).await;
                    if current.runtime.is_none() {
                        apply_ownership(&handle, current);
                    } else {
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
    } else {
        // A previous app process may have crashed while its core was still
        // alive. Full-off must clean up that owner without ever starting one.
        let supervisor = app.state::<AtomicCoreClient>().supervisor();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = supervisor.retire_previous_owner_if_any().await {
                log::warn!("[atomic-core] could not retire previous app owner while disabled: {error}");
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
        if CoreRuntimeOwner::All
            .providers()
            .iter()
            .all(|provider| resolver.core_owns(provider))
        {
            Some(CoreRuntimeOwner::All)
        } else {
            resolver
                .core_owns(PROVIDER_LLAMACPP_UPSTREAM)
                .then_some(CoreRuntimeOwner::LlamacppUpstream)
        }
    })
}

/// Providers a runtime flag hands to the core.
fn owned_providers(
    runtime: Option<crate::core::app::models::CoreRuntimeOwner>,
) -> &'static [&'static str] {
    runtime.map(|owner| owner.providers()).unwrap_or(&[])
}

fn apply_ownership<R: Runtime>(app: &AppHandle<R>, flags: AtomicCoreFlags) {
    let Some(resolver) = session_resolver(app) else {
        return;
    };
    let owned: Vec<String> = owned_providers(flags.runtime)
        .iter()
        .map(|provider| provider.to_string())
        .collect();
    log::info!("[atomic-core] providers owned by the core: {owned:?}");
    resolver.set_core_owned(owned);
    // Only the upstream plugin has a load gate; every runtime flag includes upstream.
    app.state::<tauri_plugin_llamacpp_upstream::LlamacppState>()
        .core_owns_runtime
        .store(flags.runtime.is_some(), Ordering::SeqCst);
}

/// Model ids the Foundation Models plugin runs itself. The resolver has no table for this provider:
/// the app's proxy never routed to it, so only a handover needs to look.
#[cfg(feature = "foundation-models")]
async fn legacy_foundation_models_sessions<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    let Some(state) = app.try_state::<tauri_plugin_foundation_models::FoundationModelsState>() else {
        return Vec::new();
    };
    let sessions = state.sessions.lock().await;
    sessions.values().map(|session| session.info.model_id.clone()).collect()
}

#[cfg(not(feature = "foundation-models"))]
async fn legacy_foundation_models_sessions<R: Runtime>(_app: &AppHandle<R>) -> Vec<String> {
    Vec::new()
}

/// Providers whose owner changes between two runtime flags, in a stable order.
fn changing_providers(
    current: Option<crate::core::app::models::CoreRuntimeOwner>,
    target: Option<crate::core::app::models::CoreRuntimeOwner>,
) -> Vec<(&'static str, bool)> {
    let now = owned_providers(current);
    let next = owned_providers(target);
    crate::core::app::models::CoreRuntimeOwner::All
        .providers()
        .iter()
        .filter(|provider| now.contains(provider) != next.contains(provider))
        .map(|provider| (*provider, now.contains(provider)))
        .collect()
}

/// A runtime moves only when nothing is loaded on the side it leaves: a loaded model would keep its
/// process under an owner that no longer answers for it. Checked per provider whose owner changes.
async fn ensure_outgoing_runtime_is_empty<R: Runtime>(
    app: &AppHandle<R>,
    state: &AtomicCoreClient,
    target: Option<crate::core::app::models::CoreRuntimeOwner>,
) -> Result<(), String> {
    use crate::core::sessions::resolver::PROVIDER_FOUNDATION_MODELS;

    let Some(resolver) = session_resolver(app) else {
        return Err("The session resolver is not installed.".to_string());
    };
    let current = active_runtime(app);
    if current == target {
        return Ok(());
    }

    let changing = changing_providers(current, target);
    let loading = state.loading_runtime_providers(&changing);
    if !loading.is_empty() {
        return Err(format!("Cannot change runtime ownership while {} model loads are in progress.", loading.join(", ")));
    }
    if changing.iter().any(|(_, core_owned)| *core_owned) {
        state
            .snapshot_unlocked()
            .await
            .map_err(|error| format!("Could not verify core sessions before handover: {error}"))?;
    }
    let mut busy: Vec<&str> = Vec::new();
    let mut models: Vec<String> = Vec::new();
    for (provider, core_owned) in &changing {
        let loaded: Vec<String> = if *core_owned {
            state
                .sessions
                .list()
                .into_iter()
                .filter(|session| session.provider == *provider)
                .map(|session| session.model_id)
                .collect()
        } else if *provider == PROVIDER_FOUNDATION_MODELS {
            legacy_foundation_models_sessions(app).await
        } else {
            resolver
                .list_legacy_in(provider)
                .await
                .into_iter()
                .map(|session| session.model_id)
                .collect()
        };
        if !loaded.is_empty() {
            busy.push(provider);
            models.extend(loaded);
        }
    }
    if busy.is_empty() {
        return Ok(());
    }
    Err(format!(
        "Cannot change the {} runtime owner while models are loaded: {}. Unload them first.",
        busy.join(", "),
        models.join(", ")
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
        "transitioning": state.transitioning.load(Ordering::SeqCst) || state.reconciliation_required.load(Ordering::SeqCst),
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

/// A webview extension reserves its runtime owner before asynchronous model preparation starts.
/// The lease is short-lived and released by the extension in `finally`; handover rejects while it exists.
#[tauri::command]
pub async fn atomic_core_begin_runtime_load(
    state: State<'_, AtomicCoreClient>, provider: String,
) -> Result<u64, String> {
    state.begin_runtime_load(provider).await
}

#[tauri::command]
pub fn atomic_core_end_runtime_load(state: State<'_, AtomicCoreClient>, id: u64) {
    state.end_runtime_load(id);
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
    // Cancellation bypasses the gate: login may be holding it while waiting
    // for a browser callback. A pre-gate flags read is racy with another queued
    // transition, so cancel a pending login for every flags request, then read
    // the actual previous flags only after acquiring the gate.
    app.state::<crate::core::state::AppState>()
        .chatgpt_auth
        .cancel_login();
    if let Some(attached) = state.supervisor.current().await {
        let _ = attached.client.call("POST", "/auth/chatgpt/login/cancel", None).await;
    }
    let _transition = state.transition.lock().await;
    let _marker = state.mark_transitioning();
    state.ensure_reconciled()?;
    // Another flags command may have committed while this one waited on the gate.
    let previous = get_app_configurations(app.clone()).atomic_core;
    let was_enabled = state.enabled.load(Ordering::SeqCst);
    // Drain calls that already chose the old owner. New core calls wait on this permit and then
    // observe either the committed owner or a disabled client; the webview also sees
    // `transitioning` and does not begin a legacy operation in the middle.
    let plugin = app.state::<tauri_plugin_llamacpp_upstream::LlamacppState>();
    let (_ownership, _operations) = state.lock_ownership(&plugin.ownership_gate).await;

    ensure_outgoing_runtime_is_empty(&app, &state, flags.runtime).await?;

    if flags.needs_core() {
        // `start` is idempotent, but it also replaces a lifecycle task that has already exited.
        // Persisted `enabled` alone is therefore not proof that heartbeat/SSE are still running.
        state.start(&app).await;
    }
    if flags.runtime.is_some() {
        if let Err(error) = state.snapshot_unlocked().await {
            if !was_enabled {
                let _ = state.stop_unlocked().await;
            }
            return Err(format!("Could not prepare core runtime ownership: {error}"));
        }
    }

    let handover = if previous.core_serves() != flags.core_serves() {
        match hand_over_server(&app, &state, flags.core_serves()).await {
            Ok(outcome) => Some(outcome),
            Err(error) => {
                if !error.confirmed {
                    state.reconciliation_required.store(true, Ordering::SeqCst);
                } else {
                    if !error.restored {
                        state.set_server_running_intent(false);
                        crate::core::server::commands::emit_server_state(
                            &app,
                            if previous.core_serves() { "core" } else { "legacy" },
                            None,
                            None,
                        );
                    }
                    if !was_enabled && state.enabled.load(Ordering::SeqCst) {
                        let _ = state.stop_unlocked().await;
                    }
                }
                return Err(error.to_string());
            }
        }
    } else { None };

    let mut configuration = get_app_configurations(app.clone());
    configuration.atomic_core = flags;
    if let Err(error) = update_app_configuration(app.clone(), configuration) {
        if matches!(handover, Some(crate::core::server::ownership::Handover::Moved(_))) {
            match hand_over_server(&app, &state, previous.core_serves()).await {
                Ok(crate::core::server::ownership::Handover::Moved(port)) => {
                    state.set_server_running_intent(true);
                    crate::core::server::commands::emit_server_state(
                        &app,
                        if previous.core_serves() { "core" } else { "legacy" },
                        Some(port),
                        None,
                    );
                }
                Ok(crate::core::server::ownership::Handover::NotRunning) => {
                    state.reconciliation_required.store(true, Ordering::SeqCst);
                    return Err(format!("Could not save ownership settings: {error}; reverse handover found no running server."));
                }
                Err(rollback) => {
                    state.reconciliation_required.store(true, Ordering::SeqCst);
                    return Err(format!("Could not save ownership settings: {error}; reverse handover failed: {rollback}"));
                }
            }
        }
        if !was_enabled && state.enabled.load(Ordering::SeqCst) {
            let _ = state.stop_unlocked().await;
        }
        return Err(error);
    }

    // Persisted intent is committed only after the outgoing side is empty and the incoming core
    // mirror is ready. From here the resolver switch cannot fail.
    apply_ownership(&app, flags);
    if let Some(outcome) = &handover {
        use crate::core::server::ownership::Handover;
        let port = match outcome { Handover::Moved(port) => Some(*port), Handover::NotRunning => None };
        state.set_server_running_intent(port.is_some());
        crate::core::server::commands::emit_server_state(
            &app, if flags.core_serves() { "core" } else { "legacy" }, port, None,
        );
    }
    if let Err(error) = app.emit(
        "atomic-core://ownership-changed",
        json!({ "runtime": flags.runtime, "server": flags.server }),
    ) {
        log::debug!("[atomic-core] could not emit ownership change: {error}");
    }
    if !flags.needs_core() {
        state.stop_unlocked().await.map_err(|e| e.message)?;
    }
    drop(_operations);
    drop(_marker);
    Ok(flags)
}

/// Control calls made while a transition holds the operations permit: straight
/// to the supervisor, past the gates that would otherwise wait on this very
/// transition.
struct TransitionCaller(Arc<Supervisor>);

#[async_trait::async_trait]
impl crate::core::server::ownership::ControlCaller for TransitionCaller {
    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, CoreError> {
        self.0.call(method, path, body, true).await
    }
}

/// Move the public API between the app's proxy and the core (PLAN.md §4 stage
/// 4e). The ChatGPT session moves with it: the side that serves is the one that
/// refreshes, so the other must not hold a stale copy of the tokens.
async fn hand_over_server<R: Runtime>(
    app: &AppHandle<R>,
    state: &AtomicCoreClient,
    to_core: bool,
) -> Result<crate::core::server::ownership::Handover, crate::core::server::ownership::HandoverError> {
    use crate::core::server::commands::{core_owner, LegacyOwner};
    use crate::core::server::ownership::{hand_over, last_config, Handover};
    use crate::core::state::AppState;

    let legacy = LegacyOwner { app: app.clone() };
    let core = core_owner(app, TransitionCaller(state.supervisor())).await;
    let config = last_config();
    let outcome = if to_core {
        hand_over(&legacy, &core, config.as_ref()).await
    } else {
        hand_over(&core, &legacy, config.as_ref()).await
    };
    let app_state = app.state::<AppState>();
    match &outcome {
        Ok(Handover::Moved(port)) => {
            log::info!(
                "[atomic-core] Local API Server moved to the {} on port {port}",
                if to_core { "core" } else { "app" }
            );
            if to_core {
                if let Some(config) = &config {
                    *app_state.local_server_endpoint.lock().await =
                        Some(crate::core::state::LocalServerEndpoint::new(
                            &config.host,
                            *port,
                            &config.prefix,
                            &config.api_key,
                        ));
                }
            }
        }
        Ok(Handover::NotRunning) => {}
        Err(error) => {
            log::warn!("[atomic-core] Local API Server handover failed: {error}");
            if !error.restored {
                app_state.local_server_endpoint.lock().await.take();
            }
            return Err(error.clone());
        }
    }
    if to_core {
        app_state.chatgpt_auth.cancel_login();
    } else {
        app_state.chatgpt_auth.invalidate().await;
    }
    Ok(outcome.expect("successful handover has an outcome"))
}

/// A new core process has no public listener. Rebuild only a listener that this
/// app had explicitly kept running, and only once for this generation.
async fn recover_public_server<R: Runtime>(app: &AppHandle<R>, generation: u64) {
    use crate::core::server::commands::{core_owner, emit_server_state};
    use crate::core::server::ownership::{last_config, PublicApiOwner};
    use crate::core::state::{AppState, LocalServerEndpoint};

    let Some(state) = app.try_state::<AtomicCoreClient>() else { return; };
    let _transition = state.transition.lock().await;
    if !state.is_enabled() || state.reconciliation_required.load(Ordering::SeqCst)
        || !state.server_running_intent.load(Ordering::SeqCst)
        || !get_app_configurations(app.clone()).atomic_core.core_serves() {
        return;
    }
    let Some(attached) = state.supervisor.current().await else { return; };
    if attached.generation != generation || !state.claim_server_recovery(generation) { return; }
    let plugin = app.state::<tauri_plugin_llamacpp_upstream::LlamacppState>();
    let (_ownership, _operations) = state.lock_ownership(&plugin.ownership_gate).await;
    let owner = core_owner(app, TransitionCaller(state.supervisor())).await;
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

    #[test]
    fn a_handover_checks_exactly_the_providers_whose_owner_changes() {
        use crate::core::app::models::CoreRuntimeOwner::{All, LlamacppUpstream};

        // Off → all: every provider leaves the app, so every legacy table must be empty.
        assert_eq!(
            changing_providers(None, Some(All)),
            vec![
                ("llamacpp-upstream", false),
                ("llamacpp", false),
                ("mlx", false),
                ("foundation-models", false)
            ]
        );
        // Upstream → all: upstream stays in the core; the other three move in.
        assert_eq!(
            changing_providers(Some(LlamacppUpstream), Some(All)),
            vec![("llamacpp", false), ("mlx", false), ("foundation-models", false)]
        );
        // The rollback: all → upstream hands three back, whose core sessions must be gone.
        assert_eq!(
            changing_providers(Some(All), Some(LlamacppUpstream)),
            vec![("llamacpp", true), ("mlx", true), ("foundation-models", true)]
        );
        assert!(changing_providers(Some(All), Some(All)).is_empty());
        assert_eq!(owned_providers(None), &[] as &[&str]);
    }

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
            reconciliation_required: AtomicBool::new(false),
            server_running_intent: AtomicBool::new(false),
            last_server_recovery: AtomicU64::new(0),
            next_runtime_load: AtomicU64::new(0),
            runtime_loads: Mutex::new(HashMap::new()),
            transition: tokio::sync::Mutex::new(()),
            operations: tokio::sync::RwLock::new(()),
            background: Mutex::new(None),
        }
    }

    #[tokio::test]
    async fn runtime_load_lease_blocks_only_a_handover_of_its_provider() {
        let data = tempfile::tempdir().unwrap();
        let client = Arc::new(disabled_client(data.path()));
        let lease = client.begin_runtime_load("mlx".into()).await.unwrap();
        assert_eq!(client.loading_runtime_providers(&[("mlx", false)]), vec!["mlx"]);
        assert!(client.loading_runtime_providers(&[("foundation-models", false)]).is_empty());

        let guard = client.transition.lock().await;
        let waiting = {
            let client = Arc::clone(&client);
            tokio::spawn(async move { client.begin_runtime_load("foundation-models".into()).await })
        };
        tokio::task::yield_now().await;
        assert_eq!(client.runtime_loads.lock().unwrap().len(), 1, "a new load waits for flag handover");
        drop(guard);
        let second = waiting.await.unwrap().unwrap();
        client.end_runtime_load(lease);
        client.end_runtime_load(second);
        assert!(client.loading_runtime_providers(&[("mlx", false), ("foundation-models", false)]).is_empty());
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

    #[tokio::test]
    async fn transition_waits_for_the_plugin_before_blocking_its_in_flight_core_call() {
        let data = tempfile::tempdir().unwrap();
        let client = Arc::new(disabled_client(data.path()));
        let plugin_gate = Arc::new(tokio::sync::RwLock::new(()));
        let extension_operation = plugin_gate.read().await;

        let transition = {
            let client = Arc::clone(&client);
            let plugin_gate = Arc::clone(&plugin_gate);
            tokio::spawn(async move {
                let (_plugin, _calls) = client.lock_ownership(&plugin_gate).await;
            })
        };
        tokio::task::yield_now().await;
        let call = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            client.call("GET", "/health", None),
        )
        .await
        .expect("an extension holding the plugin gate must be able to finish its core call");
        assert_eq!(call.unwrap_err().code, "CORE_NOT_RUNNING");
        drop(extension_operation);
        tokio::time::timeout(std::time::Duration::from_secs(1), transition)
            .await
            .expect("handover proceeds after the extension finishes")
            .unwrap();
    }
}
