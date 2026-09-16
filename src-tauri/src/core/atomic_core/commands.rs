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

/// The app's attachment to the core, plus the background work that keeps it
/// alive. Managed state, so commands reach it without going through `AppState`
/// — this has its own lifecycle and is absent entirely when the flags are off.
pub struct AtomicCoreClient {
    supervisor: Arc<Supervisor>,
    enabled: AtomicBool,
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

impl AtomicCoreClient {
    pub fn supervisor(&self) -> Arc<Supervisor> {
        Arc::clone(&self.supervisor)
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
        let sink = Arc::new(TauriSink { app: app.clone() });
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
        self.supervisor.call(method, path, body, true).await
    }

    async fn snapshot(&self) -> Result<Value, CoreError> {
        let _operation = self.operations.read().await;
        if !self.enabled.load(Ordering::SeqCst) {
            return Err(Self::disabled_error());
        }
        let attached = self.supervisor.ensure_attached(true).await?;
        let snapshot = attached.client.snapshot().await?;
        Ok(json!({ "generation": attached.generation, "snapshot": snapshot }))
    }
}

/// Re-emits core events to every webview window.
struct TauriSink<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> EventSink for TauriSink<R> {
    fn emit(&self, name: &str, payload: Value) {
        if let Err(e) = self.app.emit(name, payload) {
            log::debug!("[atomic-core] could not emit {name}: {e}");
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
        enabled: AtomicBool::new(false),
        transition: tokio::sync::Mutex::new(()),
        operations: tokio::sync::RwLock::new(()),
        background: Mutex::new(None),
    };
    app.manage(client);
    if flags.needs_core() {
        log::info!("[atomic-core] enabled: {flags:?}");
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(client) = handle.try_state::<AtomicCoreClient>() {
                let _transition = client.transition.lock().await;
                // The startup task may run after a user has flipped the flag
                // back off. Persisted state wins, not task scheduling order.
                if get_app_configurations(handle.clone())
                    .atomic_core
                    .needs_core()
                {
                    client.start(&handle).await;
                }
            }
        });
    }
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
    let disabling = !flags.needs_core();
    let was_enabled = state.enabled.load(Ordering::SeqCst);
    if disabling {
        // Close the gate at the start of the serialized transition, before the
        // settings write: no request that arrives after "off" began may get a
        // read permit and launch or reattach the core.
        state.enabled.store(false, Ordering::SeqCst);
    }
    let mut configuration = get_app_configurations(app.clone());
    configuration.atomic_core = flags;
    if let Err(error) = update_app_configuration(app.clone(), configuration) {
        // The requested transition did not persist, so retain the previously
        // active behavior rather than leaving memory and settings divergent.
        state.enabled.store(was_enabled, Ordering::SeqCst);
        return Err(error);
    }

    if !disabling {
        state.start(&app).await;
    } else {
        state.stop().await;
    }
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
            enabled: AtomicBool::new(false),
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
