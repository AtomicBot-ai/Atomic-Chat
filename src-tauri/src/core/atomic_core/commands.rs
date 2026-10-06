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

    /// A call for the core that owns the folder now, which never starts one: for
    /// state the next snapshot restates anyway (error-reporting consent).
    pub(crate) async fn call_attached(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, CoreError> {
        let _operation = self.operations.read().await;
        if !self.enabled.load(Ordering::SeqCst) {
            return Err(Self::stopped_error());
        }
        self.supervisor.call(method, path, body, false).await
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
            // And it knows only the consent it was launched with, or none if another start won.
            super::telemetry::push(&self.app);
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

/// Bring the app's mirror of the core's sessions up to date from the core itself.
///
/// The mirror is kept by events, and events can be missed: right after a new core generation the
/// event stream is still being re-established, and a model loaded in that window has a session in
/// the core that the mirror has not heard of. Whoever looks a session up and does not find it asks
/// here before concluding that it does not exist.
pub async fn refresh_sessions<R: Runtime>(app: &AppHandle<R>) {
    if let Some(client) = app.try_state::<AtomicCoreClient>() {
        if let Err(error) = client.snapshot().await {
            log::debug!("[atomic-core] could not refresh sessions: {}", error.message);
        }
    }
}

/// Undo `shutdown` when the app is staying up after all — a data-folder move that failed after
/// the core had been stopped for it.
pub async fn resume<R: Runtime>(app: &AppHandle<R>) {
    if let Some(client) = app.try_state::<AtomicCoreClient>() {
        let _gate = client.transition.lock().await;
        client.start(app).await;
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

/// How long the app keeps waiting for the result of a `sudo` command the person runs by hand.
#[cfg(unix)]
const MANUAL_HOST_STEP_WAIT: std::time::Duration = std::time::Duration::from_secs(2 * 60 * 60);

/// Run the privileged step a managed-runtime operation is waiting on (design D3), and report back.
///
/// The webview names the operation and nothing else: the step — recipe, digests, parameters,
/// nonce — is read from the core here, the request file is written here, and the webview never
/// sees a path or an argument it could change. Answers `{outcome}`: `completed`,
/// `reboot-required`, `failed` (with `log_tail`) or `declined` once the receipt is sent; `manual`
/// with the exact command to run by hand otherwise — on Linux the `sudo` command when there is no
/// `pkexec` or no polkit agent (the receipt is sent once the result file appears), on Windows
/// `wsl --install` for an administrator terminal when UAC cannot be raised (no
/// receipt: the person checks again once it ran).
#[tauri::command]
pub async fn atomic_core_run_host_step<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AtomicCoreClient>,
    operation_id: String,
) -> Result<Value, CoreError> {
    run_host_step(&app, &state, &operation_id).await
}

async fn run_host_step<R: Runtime>(
    app: &AppHandle<R>,
    client: &AtomicCoreClient,
    operation_id: &str,
) -> Result<Value, CoreError> {
    #[cfg(windows)]
    {
        run_host_step_windows(app, client, operation_id).await
    }
    #[cfg(not(windows))]
    {
        #[cfg(unix)]
        if cfg!(target_os = "linux") {
            return run_host_step_unix(app, client, operation_id).await;
        }
        let _ = (app, client, operation_id);
        Err(CoreError::new(
            "MANAGED_ADAPTER_UNAVAILABLE",
            "Managed runtimes run on Linux and Windows only.",
            None,
        ))
    }
}

/// The step the operation waits on, read from the core, and the claim that keeps a second run of
/// it from starting while this one goes.
async fn pending_host_step(
    client: &AtomicCoreClient,
    operation_id: &str,
) -> Result<(super::host_step::HostStep, super::host_step::StepClaim), CoreError> {
    use super::host_step::{self, HostStep};

    if operation_id.is_empty()
        || !operation_id.chars().all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c))
    {
        return Err(CoreError::new("INVALID_ARGUMENT", "Not an operation id.", None));
    }
    let operation = client
        .call("GET", &format!("/environments/operations/{operation_id}"), None)
        .await?;
    let step = HostStep::from_operation(&operation).ok_or_else(|| {
        CoreError::new("MANAGED_HOST_STEP_INVALID", "This operation is not waiting for a privileged step.", None)
    })?;
    let claim = host_step::claim(&step.step_id).ok_or_else(|| {
        CoreError::new(
            "MANAGED_OPERATION_CONFLICT",
            "The system password prompt for this step is already open.",
            None,
        )
    })?;
    Ok((step, claim))
}

/// The CLI core beside the core this app runs: the bundled pair, or the local build that
/// ATOMIC_CORE_CMD points at in development.
fn host_step_executor<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, CoreError> {
    let resource_dir = app.path().resource_dir().unwrap_or_default();
    let command = super::launch::resolve_core_command(
        &resource_dir,
        std::env::var(super::launch::CORE_COMMAND_ENV).ok().as_deref(),
    )?;
    super::host_step::executor_binary(&command)
        .map_err(|why| CoreError::new("MANAGED_HOST_STEP_INVALID", "Could not prepare the privileged step.", Some(why)))
}

/// Compiled on every unix so the macOS build type-checks what ships on Linux; called on Linux only.
#[cfg(unix)]
async fn run_host_step_unix<R: Runtime>(
    app: &AppHandle<R>,
    client: &AtomicCoreClient,
    operation_id: &str,
) -> Result<Value, CoreError> {
    use super::host_step::{self, Elevation, ReceiptOutcome};

    let (step, claim) = pending_host_step(client, operation_id).await?;
    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .filter(|dir| dir.is_dir())
        .ok_or_else(|| {
            CoreError::new(
                "MANAGED_HOST_STEP_INVALID",
                "This session has no XDG_RUNTIME_DIR to prepare the privileged step in.",
                None,
            )
        })?;
    let core_binary = host_step_executor(app)?;
    let supervisor = client.supervisor();
    let prepared = host_step::prepare(&runtime_dir, &core_binary, &step, supervisor.data_folder())
        .map_err(|e| {
            CoreError::new(
                "MANAGED_HOST_STEP_INVALID",
                "Could not prepare the privileged step.",
                Some(format!("{}: {e}", core_binary.display())),
            )
        })?;

    let (outcome, log_tail) = match host_step::elevate(std::path::Path::new("pkexec"), &prepared).await {
        Elevation::Finished { outcome, log_tail } => {
            if outcome == ReceiptOutcome::Failed {
                // The result file goes with the copy; its reason stays in the app log (F-2).
                log::warn!("[host-step] {} failed: {log_tail}", step.step_id);
            }
            (outcome, log_tail)
        }
        Elevation::Declined => (ReceiptOutcome::Declined, String::new()),
        Elevation::Manual { command } => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let result = host_step::wait_for_result(
                    &prepared,
                    host_step::MANUAL_POLL_INTERVAL,
                    MANUAL_HOST_STEP_WAIT,
                )
                .await;
                if let Some((ReceiptOutcome::Failed, why)) = &result {
                    log::warn!("[host-step] {} failed: {why}", step.step_id);
                }
                if let (Some((outcome, _)), Some(client)) = (result, app.try_state::<AtomicCoreClient>()) {
                    send_host_step_receipt(&client, &step, outcome).await;
                }
                prepared.remove();
                drop(claim);
            });
            return Ok(json!({ "outcome": "manual", "command": command }));
        }
    };
    prepared.remove();
    send_host_step_receipt(client, &step, outcome).await;
    drop(claim);
    Ok(json!({ "outcome": outcome.as_str(), "log_tail": log_tail }))
}

/// Windows (change `add-tensorrt-llm-windows`, design D15): the bundled `atomic-chat-core.exe`
/// run in place through the UAC prompt, from a request folder under `%LOCALAPPDATA%` that only
/// the user, `SYSTEM` and `Administrators` can touch.
#[cfg(windows)]
async fn run_host_step_windows<R: Runtime>(
    app: &AppHandle<R>,
    client: &AtomicCoreClient,
    operation_id: &str,
) -> Result<Value, CoreError> {
    use super::host_step::{Elevation, ReceiptOutcome};
    use super::host_step_windows;

    let (step, claim) = pending_host_step(client, operation_id).await?;
    let root = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .filter(|dir| dir.is_dir())
        .ok_or_else(|| {
            CoreError::new(
                "MANAGED_HOST_STEP_INVALID",
                "This session has no %LOCALAPPDATA% to prepare the privileged step in.",
                None,
            )
        })?
        .join("AtomicChat")
        .join("host-steps");
    let core_binary = host_step_executor(app)?;
    let supervisor = client.supervisor();
    let prepared = host_step_windows::prepare(&root, &core_binary, &step, supervisor.data_folder())
        .map_err(|e| {
            CoreError::new(
                "MANAGED_HOST_STEP_INVALID",
                "Could not prepare the privileged step.",
                Some(format!("{}: {e}", root.display())),
            )
        })?;

    // The UAC prompt and the executor's run block their thread for as long as they take. Once the
    // person approved and the executor started, the UI hears it (`managed-host-step-running`):
    // `wsl --install` then runs for minutes with no window of its own.
    let emitter = app.clone();
    let started = json!({ "operation_id": operation_id, "step_id": step.step_id });
    let (prepared, elevation) = tauri::async_runtime::spawn_blocking(move || {
        let mut on_started = || {
            if let Err(e) = emitter.emit("managed-host-step-running", started.clone()) {
                log::warn!("[host-step] could not tell the UI the step started: {e}");
            }
        };
        let elevation = host_step_windows::elevate(&prepared, &mut on_started);
        (prepared, elevation)
    })
    .await
    .map_err(|e| CoreError::new("MANAGED_HOST_STEP_INVALID", "The privileged step did not finish.", Some(e.to_string())))?;
    prepared.remove();

    let (outcome, log_tail) = match elevation {
        Elevation::Finished { outcome, log_tail } => {
            if outcome == ReceiptOutcome::Failed {
                log::warn!("[host-step] {} failed: {log_tail}", step.step_id);
            }
            (outcome, log_tail)
        }
        Elevation::Declined => (ReceiptOutcome::Declined, String::new()),
        Elevation::Manual { command } => {
            // No result file will ever come: the person runs the command, then checks again.
            log::warn!("[host-step] UAC could not be raised for {}; handing over `{command}`", step.step_id);
            drop(claim);
            return Ok(json!({ "outcome": "manual", "command": command }));
        }
    };
    send_host_step_receipt(client, &step, outcome).await;
    drop(claim);
    Ok(json!({ "outcome": outcome.as_str(), "log_tail": log_tail }))
}

async fn send_host_step_receipt(
    client: &AtomicCoreClient,
    step: &super::host_step::HostStep,
    outcome: super::host_step::ReceiptOutcome,
) {
    let receipt = step.receipt(outcome, &uuid::Uuid::new_v4().to_string());
    let path = format!("/environments/operations/{}/host-step-result", step.operation_id);
    if let Err(error) = client.call("POST", &path, Some(receipt)).await {
        // The operation stays in `preparing-host`; the provider page offers to try again.
        log::warn!("[host-step] the core did not take the receipt: {error:?}");
    }
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

/// The one thing a managed setup can ask of the person's session, done for them from the progress
/// bar: `restart` — Windows, after WSL was turned on (`reboot-required`): `shutdown.exe /r /t 0`;
/// `sign-out` — Linux, after the `docker` group was added (`relogin-required`): `loginctl
/// terminate-session $XDG_SESSION_ID`. Both run as the person, without elevation; anything else, or
/// either on the other OS, is refused. An error is returned as text for the bar to show.
#[tauri::command]
pub async fn atomic_core_finish_session_step(action: String) -> Result<(), String> {
    session_step_command(&action, std::env::var("XDG_SESSION_ID").ok())
        .ok_or_else(|| format!("{action} is not available on this system"))
        .and_then(|(program, args)| {
            let mut command = std::process::Command::new(program);
            command.args(&args);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            }
            let status = command.status().map_err(|e| format!("{program}: {e}"))?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("{program} exited with {status}"))
            }
        })
}

/// The argv for a session step on this OS, or None when it does not apply here.
fn session_step_command(
    action: &str,
    session_id: Option<String>,
) -> Option<(&'static str, Vec<String>)> {
    match action {
        "restart" if cfg!(windows) => Some((
            "shutdown.exe",
            vec!["/r".into(), "/t".into(), "0".into()],
        )),
        "sign-out" if cfg!(target_os = "linux") => {
            let id = session_id.filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric()))?;
            Some(("loginctl", vec!["terminate-session".into(), id]))
        }
        _ => None,
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


    #[test]
    fn a_session_step_is_one_fixed_command_for_this_os_only() {
        assert_eq!(session_step_command("format-disk", Some("2".into())), None);
        if cfg!(windows) {
            assert_eq!(
                session_step_command("restart", None),
                Some(("shutdown.exe", vec!["/r".to_string(), "/t".into(), "0".into()]))
            );
            assert_eq!(session_step_command("sign-out", Some("2".into())), None);
        }
        if cfg!(target_os = "linux") {
            assert_eq!(
                session_step_command("sign-out", Some("c2".into())),
                Some(("loginctl", vec!["terminate-session".to_string(), "c2".into()]))
            );
            assert_eq!(session_step_command("sign-out", Some("2; rm -rf /".into())), None);
            assert_eq!(session_step_command("sign-out", None), None);
            assert_eq!(session_step_command("restart", None), None);
        }
    }
}
