//! Session lifecycle: bringing `sd-server` up from a [`ServerSpec`], tearing
//! it down, and describing the result as the status / capabilities the UI
//! reads. Every state change here emits `atomic-diffusion://state`.

use std::time::Duration;

use crate::error::{DiffusionError, DiffusionErrorCode, DiffusionResult};
use crate::events::{emit, emit_error, DiffusionEmitter, StatePayload, EVENT_STATE};
use crate::install;
use crate::process;
use crate::state::{
    now_ms, DiffusionBackend, DiffusionSession, DiffusionState, DiffusionStatus, EngineInstall,
    ImageCapabilities, ImageWorkflow, LoadedModel, ModelState, ModelStatus, ServerSpec, MAX_BATCH,
};

/// CUDA / ROCm need a moment after the chat model's process dies before the
/// driver reports the VRAM as free; spawning immediately fails to allocate.
const GPU_SETTLE: Duration = Duration::from_millis(500);

pub fn workflows_for_family(family: &str) -> Vec<ImageWorkflow> {
    match family {
        "flux.2-klein" => vec![ImageWorkflow::Create, ImageWorkflow::Transform],
        _ => vec![ImageWorkflow::Create],
    }
}

/// The install the status reports: the resident session's tree when there
/// is one, otherwise the newest install record.
fn current_install(state: &DiffusionState) -> EngineInstall {
    let Ok(root) = state.backends_root() else {
        return EngineInstall::NotInstalled;
    };
    let records = install::list_installed_backends(&root);
    let chosen = match state.spec() {
        Some(spec) => records
            .iter()
            .find(|r| install::same_dir(std::path::Path::new(&r.dir), &spec.binary_dir))
            .or(records.first()),
        None => records.first(),
    };
    match chosen {
        Some(record) => EngineInstall::Installed {
            engine: record.engine,
            backend: record.backend,
            tag: record.tag.clone(),
            backend_id: record.backend_id.clone(),
            dir: record.dir.clone(),
        },
        None => EngineInstall::NotInstalled,
    }
}

/// Snapshot for `get_status` and the `state` event. Never blocks on the
/// session mutex: the loaded model is mirrored into `spec` + `model`.
pub fn build_status(state: &DiffusionState, loaded: Option<LoadedModel>) -> DiffusionStatus {
    let configured = state.data_folder().is_some();
    let (model_state, error) = state.model_state();
    DiffusionStatus {
        configured,
        install: if configured {
            current_install(state)
        } else {
            EngineInstall::NotInstalled
        },
        model: ModelStatus {
            state: model_state,
            loaded: if model_state == ModelState::Loaded {
                loaded
            } else {
                None
            },
            error,
        },
        active_job: state.active_job(),
        output_dir: state
            .output_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        idle_unload_secs: state.idle_unload_secs(),
    }
}

/// Status including the resident model; takes the session lock briefly.
pub async fn status(state: &DiffusionState) -> DiffusionStatus {
    let loaded = state
        .session
        .lock()
        .await
        .as_ref()
        .map(|session| session.info.clone());
    build_status(state, loaded)
}

pub async fn emit_state(state: &DiffusionState, emitter: &dyn DiffusionEmitter, reason: &str) {
    let status = status(state).await;
    emit(
        emitter,
        EVENT_STATE,
        StatePayload {
            status,
            reason: Some(reason.to_string()),
        },
    );
}

pub async fn capabilities(state: &DiffusionState) -> DiffusionResult<ImageCapabilities> {
    let spec = state.spec().ok_or_else(|| {
        DiffusionError::new(
            DiffusionErrorCode::ModelNotLoaded,
            "Load an image model first.",
        )
    })?;
    let cancel_generating = state
        .session
        .lock()
        .await
        .as_ref()
        .map(|s| s.capabilities.cancel_generating)
        .unwrap_or(false);
    Ok(ImageCapabilities {
        workflows: workflows_for_family(&spec.family),
        min_dim: spec.ranges.dims.0,
        max_dim: spec.ranges.dims.1,
        dim_multiple: spec.ranges.dim_multiple,
        supports_negative_prompt: spec.defaults.cfg_scale > 1.0,
        supports_guidance: spec.defaults.guidance.is_some(),
        cancel_generating,
        max_batch: MAX_BATCH,
        defaults: spec.defaults.clone(),
        ranges: spec.ranges.clone(),
    })
}

/// Spawn the server for `spec` and make it the resident session. The caller
/// holds `load_lock`; any previous session must already be gone.
pub async fn load_from_spec(
    state: &DiffusionState,
    emitter: &dyn DiffusionEmitter,
    spec: ServerSpec,
    reason: &str,
) -> DiffusionResult<LoadedModel> {
    state.set_model_state(ModelState::Loading, None);
    emit_state(state, emitter, reason).await;

    if matches!(
        spec.backend,
        DiffusionBackend::Cuda | DiffusionBackend::Rocm
    ) {
        tokio::time::sleep(GPU_SETTLE).await;
    }

    let scratch = state.scratch_dir()?;
    let spawned = match process::spawn_server(&spec, &scratch).await {
        Ok(spawned) => spawned,
        Err(err) => {
            state.set_model_state(ModelState::Failed, Some(err.clone()));
            emit_state(state, emitter, "load-failed").await;
            emit_error(emitter, None, &err);
            return Err(err);
        }
    };

    let info = LoadedModel {
        model_id: spec.model_id.clone(),
        family: spec.family.clone(),
        modality: spec.modality,
        display_name: spec.display_name.clone(),
        engine: spec.engine,
        backend: spec.backend,
        offload: spec.offload,
        cpu_fallback: spec.cpu_fallback,
        port: spawned.port,
        pid: spawned.pid,
        loaded_at_ms: now_ms(),
    };
    let session = DiffusionSession::new(
        spawned.child,
        info.clone(),
        spec.clone(),
        spawned.tail,
        spawned.step_listener,
        spawned.capabilities,
        spawned.drain_tasks,
        spawned.client,
    );
    *state.session.lock().await = Some(session);
    state.set_spec(Some(spec));
    state.set_model_state(ModelState::Loaded, None);
    state.touch_idle();
    emit_state(state, emitter, "loaded").await;
    Ok(info)
}

/// Take the session out of the state and terminate it. Returns whether one
/// was running. Does not touch `spec` or the model state: callers decide
/// what the teardown means.
pub async fn take_down_session(state: &DiffusionState) -> bool {
    let session = state.session.lock().await.take();
    let Some(mut session) = session else {
        return false;
    };
    session.set_step_listener(None);
    process::terminate(&mut session.child).await;
    for task in session.drain_tasks.drain(..) {
        task.abort();
    }
    true
}

/// Explicit unload: stop the server, forget the spec, report `unloaded`.
pub async fn unload(state: &DiffusionState, emitter: &dyn DiffusionEmitter, reason: &str) {
    let (model_state, _) = state.model_state();
    if model_state == ModelState::Loaded {
        state.set_model_state(ModelState::Unloading, None);
        emit_state(state, emitter, reason).await;
    }
    take_down_session(state).await;
    state.set_spec(None);
    state.clear_idle();
    state.set_model_state(ModelState::Unloaded, None);
    emit_state(state, emitter, reason).await;
}

/// The server was stopped but the spec stays: the next `generate` respawns.
pub async fn stop_keeping_spec(
    state: &DiffusionState,
    emitter: &dyn DiffusionEmitter,
    reason: &str,
    error: Option<DiffusionError>,
) {
    take_down_session(state).await;
    state.clear_idle();
    match error {
        Some(err) => state.set_model_state(ModelState::Failed, Some(err)),
        None => state.set_model_state(ModelState::Unloaded, None),
    }
    emit_state(state, emitter, reason).await;
}

/// App exit: no events, no waiting beyond a short grace.
pub fn shutdown_blocking(state: &DiffusionState) {
    let session = state.session.clone();
    tauri::async_runtime::block_on(async move {
        if let Some(mut session) = session.lock().await.take() {
            process::terminate_with_grace(&mut session.child, Duration::from_secs(2)).await;
        }
    });
}
