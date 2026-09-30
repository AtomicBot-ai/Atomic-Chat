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

/// Qwen 2.1 and Krea 2 are guarded by the pinned 883 compatibility baseline.
/// Unknown tags fail closed; legacy families keep their existing engine policy.
pub fn check_engine_compatibility(family: &str, tag: &str) -> DiffusionResult<()> {
    let build = tag
        .strip_prefix("master-")
        .and_then(|rest| rest.split_once('-'))
        .filter(|(_, hash)| !hash.is_empty())
        .and_then(|(build, _)| build.parse::<u32>().ok());
    if matches!(family, "qwen-image-2.1" | "krea-2-turbo")
        && !build.is_some_and(|build| build >= 883)
    {
        return Err(DiffusionError::with_details(
            DiffusionErrorCode::EngineUpdateRequired,
            format!("{family} requires an image engine update. Update the engine, then retry loading the model."),
            format!("installed={tag}; required=master-883-137f740 or newer"),
        ));
    }
    Ok(())
}

/// Preserve the existing engine/backend selection, then find a compatible
/// release in that backend's installed trees (which are ordered by install time).
pub fn select_model_install<'a>(
    installed: &'a [crate::state::BackendInstallRecord],
    engine: crate::state::EngineKind,
    family: &str,
) -> DiffusionResult<&'a crate::state::BackendInstallRecord> {
    let selected = installed
        .iter()
        .find(|r| r.engine == engine)
        .ok_or_else(|| {
            DiffusionError::new(
                DiffusionErrorCode::EngineMissing,
                "Install the image engine first.",
            )
        })?;
    let record = installed
        .iter()
        .find(|candidate| {
            candidate.engine == engine
                && candidate.backend_id == selected.backend_id
                && check_engine_compatibility(family, &candidate.tag).is_ok()
        })
        .unwrap_or(selected);
    check_engine_compatibility(family, &record.tag)?;
    Ok(record)
}

/// Finalizing a different engine invalidates both a resident process and a
/// retained idle/crash spec, so generation cannot respawn the old binary.
/// Caller holds load_lock and has cancelled any active job.
pub async fn activate_install(
    state: &DiffusionState,
    emitter: &dyn DiffusionEmitter,
    record: &crate::state::BackendInstallRecord,
) {
    if state.spec().is_some_and(|spec| {
        spec.engine == record.engine
            && (spec.tag != record.tag
                || !install::same_dir(&spec.binary_dir, std::path::Path::new(&record.dir)))
    }) {
        unload(state, emitter, "engine-updated").await;
    }
}

/// Which workflows a family can run on sd.cpp. img2img and masking are generic
/// for the established base families, while distilled models such as Krea 2
/// Turbo remain restricted to their verified Create workflow. Reference-guided
/// generation and instruction edits need a model trained on reference images.
/// Qwen Image 2.1 also needs a separately loaded VLM projector;
/// [`workflows_for_spec`] removes those capabilities when absent.
pub fn workflows_for_family(family: &str) -> Vec<ImageWorkflow> {
    use ImageWorkflow::*;
    match family {
        "flux.2-klein" => vec![Create, Transform, Inpaint, Extend, Upscale, Reference, Edit],
        "qwen-image-2.1" => vec![Create, Reference, Edit],
        "krea-2-turbo" => vec![Create],
        "z-image" | "qwen-image" => {
            vec![Create, Transform, Inpaint, Extend, Upscale]
        }
        family if family.starts_with("flux.1") => {
            vec![Create, Transform, Inpaint, Extend, Upscale]
        }
        _ => vec![Create],
    }
}

/// Workflows the currently loaded server can actually execute.
pub fn workflows_for_spec(spec: &ServerSpec) -> Vec<ImageWorkflow> {
    let mut workflows = workflows_for_family(&spec.family);
    if spec.family == "qwen-image-2.1" && spec.files.llm_vision.is_none() {
        workflows.retain(|workflow| !workflow.uses_references());
    }
    workflows
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
        workflows: workflows_for_spec(&spec),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_spec() -> ServerSpec {
        ServerSpec {
            binary_dir: std::path::PathBuf::from("/opt/sd"),
            engine: crate::state::EngineKind::SdCpp,
            backend: DiffusionBackend::Metal,
            backend_id: "macos-arm64".into(),
            tag: "master-883-137f740".into(),
            model_id: "qwen-image-2.1:q4_k".into(),
            family: "qwen-image-2.1".into(),
            modality: crate::state::Modality::Image,
            display_name: "Qwen Image 2.1 Q4_K".into(),
            files: crate::state::ModelFiles {
                diffusion_model: "/models/qwen-image-2.1.gguf".into(),
                vae: Some("/models/qwen-image-2.1-vae.safetensors".into()),
                llm: Some("/models/qwen3-vl-8b.gguf".into()),
                ..Default::default()
            },
            defaults: crate::state::FamilyDefaults {
                steps: 40,
                cfg_scale: 6.0,
                guidance: None,
                sampling_method: Some("euler".into()),
                flow_shift: None,
                width: 1024,
                height: 1024,
            },
            ranges: crate::state::FamilyRanges {
                steps: (1, 100),
                dims: (256, 4096),
                dim_multiple: 32,
            },
            offload: crate::state::OffloadPolicy::Group,
            threads: None,
            extra_args: Vec::new(),
            startup_timeout: Duration::from_secs(600),
            cpu_fallback: false,
        }
    }

    fn record(tag: &str, backend_id: &str) -> crate::state::BackendInstallRecord {
        crate::state::BackendInstallRecord {
            tag: tag.into(),
            backend_id: backend_id.into(),
            backend: DiffusionBackend::Metal,
            engine: crate::state::EngineKind::SdCpp,
            dir: format!("/engines/{tag}/{backend_id}"),
            sha256: None,
            installed_at_ms: 1,
        }
    }

    #[test]
    fn modern_families_require_a_compatible_engine_without_switching_backends() {
        let old = record("master-849-d04e895", "macos-arm64");
        let new = record("master-883-137f740", "macos-arm64");
        let other = record("master-883-137f740", "win-cpu-x64");
        let engine = crate::state::EngineKind::SdCpp;
        assert_eq!(
            select_model_install(std::slice::from_ref(&old), engine, "qwen-image-2.1")
                .unwrap_err()
                .code,
            DiffusionErrorCode::EngineUpdateRequired
        );
        assert_eq!(
            select_model_install(&[old.clone(), other], engine, "qwen-image-2.1")
                .unwrap_err()
                .code,
            DiffusionErrorCode::EngineUpdateRequired
        );
        let records = [old, new];
        assert_eq!(
            select_model_install(&records, engine, "qwen-image-2.1")
                .unwrap()
                .tag,
            "master-883-137f740"
        );
        for family in ["qwen-image", "z-image", "flux.1", "flux.2-klein"] {
            assert_eq!(
                select_model_install(&records, engine, family).unwrap().tag,
                "master-849-d04e895"
            );
        }
        for family in ["qwen-image-2.1", "krea-2-turbo"] {
            assert_eq!(
                select_model_install(&records, engine, family).unwrap().tag,
                "master-883-137f740"
            );
            for tag in ["unknown", "master-882-abcdef0", "master-883", "master-883-"] {
                assert!(check_engine_compatibility(family, tag).is_err());
            }
            for tag in [
                "master-883-137f740",
                "master-883-137f740-a1234567",
                "master-1000-abcdef0",
            ] {
                assert!(check_engine_compatibility(family, tag).is_ok());
            }
        }
    }

    #[tokio::test]
    async fn incompatible_retained_spec_is_rejected_before_any_spawn_or_file_access() {
        let mut spec = test_spec();
        spec.tag = "master-849-d04e895".into();
        let dir = tempfile::tempdir().unwrap();
        let error = process::spawn_server(&spec, dir.path())
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, DiffusionErrorCode::EngineUpdateRequired);
    }

    #[tokio::test]
    async fn activating_an_update_forgets_idle_or_failed_specs() {
        for model_state in [ModelState::Unloaded, ModelState::Failed] {
            let state = DiffusionState::new();
            let mut spec = test_spec();
            spec.tag = "master-849-d04e895".into();
            state.set_spec(Some(spec));
            state.set_model_state(model_state, None);
            activate_install(
                &state,
                &crate::events::RecordingEmitter::default(),
                &record("master-883-137f740", "macos-arm64"),
            )
            .await;
            assert!(state.spec().is_none());
            assert_eq!(state.model_state().0, ModelState::Unloaded);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn activating_an_update_terminates_the_resident_old_server() {
        use std::sync::{Arc, Mutex};
        let state = DiffusionState::new();
        let mut spec = test_spec();
        spec.tag = "master-849-d04e895".into();
        let child = tokio::process::Command::new("sleep")
            .arg("60")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let info = LoadedModel {
            model_id: spec.model_id.clone(),
            family: spec.family.clone(),
            modality: spec.modality,
            display_name: spec.display_name.clone(),
            engine: spec.engine,
            backend: spec.backend,
            offload: spec.offload,
            cpu_fallback: false,
            port: 1234,
            pid,
            loaded_at_ms: 1,
        };
        *state.session.lock().await = Some(DiffusionSession::new(
            child,
            info,
            spec.clone(),
            crate::state::new_tail(),
            Arc::new(Mutex::new(None)),
            crate::state::ServerCapabilities::default(),
            Vec::new(),
            reqwest::Client::new(),
        ));
        state.set_spec(Some(spec));
        state.set_model_state(ModelState::Loaded, None);
        activate_install(
            &state,
            &crate::events::RecordingEmitter::default(),
            &record("master-883-137f740", "macos-arm64"),
        )
        .await;
        assert!(state.session.lock().await.is_none());
        assert!(state.spec().is_none());
        assert_eq!(state.model_state().0, ModelState::Unloaded);
        assert!(nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None).is_err());
    }

    #[test]
    fn families_expose_only_the_workflows_their_architecture_supports() {
        use ImageWorkflow::*;
        for family in ["z-image", "flux.1", "qwen-image"] {
            let ws = workflows_for_family(family);
            assert_eq!(
                ws,
                vec![Create, Transform, Inpaint, Extend, Upscale],
                "{family}"
            );
        }
        let klein = workflows_for_family("flux.2-klein");
        assert!(klein.contains(&Reference) && klein.contains(&Edit));
        assert_eq!(klein.len(), 7);
        assert_eq!(
            workflows_for_family("qwen-image-2.1"),
            vec![Create, Reference, Edit]
        );
        assert_eq!(workflows_for_family("krea-2-turbo"), vec![Create]);
        assert_eq!(workflows_for_family("wan2.2-ti2v-5b"), vec![Create]);
        assert_eq!(workflows_for_family("unknown"), vec![Create]);
    }

    #[test]
    fn qwen_image_2_1_reference_workflows_require_the_vision_projector() {
        let mut spec = test_spec();
        spec.files.llm_vision = None;
        assert_eq!(workflows_for_spec(&spec), vec![ImageWorkflow::Create]);

        spec.files.llm_vision = Some("/models/mmproj.gguf".into());
        assert_eq!(
            workflows_for_spec(&spec),
            vec![
                ImageWorkflow::Create,
                ImageWorkflow::Reference,
                ImageWorkflow::Edit
            ]
        );
    }
}
