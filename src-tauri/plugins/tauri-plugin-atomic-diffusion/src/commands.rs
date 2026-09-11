//! The command surface: one `#[tauri::command]` per method of
//! `DiffusionService` in `types.ts`, named as the snake_case of the method and
//! taking the interface's parameter names (camelCase over the bridge).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Runtime, State};

use crate::error::{DiffusionError, DiffusionErrorCode, DiffusionResult};
use crate::events::SharedEmitter;
use crate::gallery;
use crate::install::{self, FinalizeBackendInstallArgs};
use crate::jobs::{self, CancelResult};
use crate::session;
use crate::state::{
    BackendInstallRecord, DiffusionConfig, DiffusionState, DiffusionStatus, EngineKind,
    GalleryFlags, GalleryImageItem, GalleryListOptions, GalleryPage, ImageCapabilities,
    ImageGenerateRequest, ImageJob, LoadModelRequest, LoadedModel, ModelFile, ModelState,
    ServerSpec, DEFAULT_STARTUP_TIMEOUT_SECS,
};

fn emitter_for<R: Runtime>(app: &AppHandle<R>) -> SharedEmitter {
    Arc::new(app.clone())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateResponse {
    pub job_id: String,
}

// ---------------------------------------------------------------------------
// Configuration and status
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn configure(
    state: State<'_, DiffusionState>,
    config: DiffusionConfig,
) -> DiffusionResult<DiffusionStatus> {
    if config.data_folder.trim().is_empty() {
        return Err(DiffusionError::new(
            DiffusionErrorCode::NotConfigured,
            "The data folder is not set.",
        ));
    }
    let state = state.inner().clone();
    {
        let mut guard = state
            .config
            .lock()
            .map_err(|_| DiffusionError::internal("Diffusion config is poisoned."))?;
        *guard = Some(config);
    }
    for dir in [
        state.diffusion_root()?,
        state.backends_root()?,
        state.models_root()?,
        state.output_dir()?,
    ] {
        std::fs::create_dir_all(&dir)
            .map_err(|e| DiffusionError::io("Could not create the diffusion folders.", &e))?;
    }
    // Re-arm the idle timer with the (possibly new) interval.
    if state.session.lock().await.is_some() && state.active_job_id().is_none() {
        state.touch_idle();
    }
    Ok(session::status(&state).await)
}

#[tauri::command]
pub async fn get_status(state: State<'_, DiffusionState>) -> DiffusionResult<DiffusionStatus> {
    Ok(session::status(state.inner()).await)
}

#[tauri::command]
pub async fn set_output_dir<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DiffusionState>,
    path: String,
) -> DiffusionResult<DiffusionStatus> {
    let state = state.inner().clone();
    let trimmed = path.trim().to_string();
    if !trimmed.is_empty() {
        std::fs::create_dir_all(&trimmed)
            .map_err(|e| DiffusionError::io("Could not create the output folder.", &e))?;
    }
    {
        let mut guard = state
            .config
            .lock()
            .map_err(|_| DiffusionError::internal("Diffusion config is poisoned."))?;
        let config = guard.as_mut().ok_or_else(DiffusionError::not_configured)?;
        config.output_dir = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        };
    }
    std::fs::create_dir_all(state.output_dir()?)
        .map_err(|e| DiffusionError::io("Could not create the output folder.", &e))?;
    session::emit_state(&state, emitter_for(&app).as_ref(), "output-dir").await;
    Ok(session::status(&state).await)
}

// ---------------------------------------------------------------------------
// Engine binary
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn finalize_backend_install<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DiffusionState>,
    args: FinalizeBackendInstallArgs,
) -> DiffusionResult<BackendInstallRecord> {
    let state = state.inner().clone();
    let root = state.backends_root()?;
    let record = install::finalize_backend_install(&root, args).await?;
    session::emit_state(&state, emitter_for(&app).as_ref(), "install").await;
    Ok(record)
}

#[tauri::command]
pub async fn list_installed_backends(
    state: State<'_, DiffusionState>,
) -> DiffusionResult<Vec<BackendInstallRecord>> {
    Ok(install::list_installed_backends(&state.backends_root()?))
}

#[tauri::command]
pub async fn remove_backend<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DiffusionState>,
    dir: String,
) -> DiffusionResult<()> {
    let state = state.inner().clone();
    let root = state.backends_root()?;
    let target = PathBuf::from(&dir);
    let in_use = state
        .session
        .lock()
        .await
        .as_ref()
        .map(|session| install::same_dir(&session.spec.binary_dir, &target))
        .unwrap_or(false)
        || state
            .spec()
            .map(|spec| install::same_dir(&spec.binary_dir, &target))
            .unwrap_or(false);
    if in_use {
        return Err(DiffusionError::new(
            DiffusionErrorCode::BackendInUse,
            "Unload the image model before removing its engine.",
        ));
    }
    install::remove_backend(&root, &target)?;
    session::emit_state(&state, emitter_for(&app).as_ref(), "uninstall").await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Model files
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_model_files(state: State<'_, DiffusionState>) -> DiffusionResult<Vec<ModelFile>> {
    Ok(install::list_model_files(&state.models_root()?))
}

#[tauri::command]
pub async fn delete_model_file(
    state: State<'_, DiffusionState>,
    path: String,
) -> DiffusionResult<()> {
    let root = state.models_root()?;
    let target = PathBuf::from(&path);
    if let Some(spec) = state.spec() {
        let used = spec
            .files
            .entries()
            .iter()
            .any(|(_, file)| install::same_dir(Path::new(file), &target));
        if used {
            return Err(DiffusionError::new(
                DiffusionErrorCode::BackendInUse,
                "That file belongs to the loaded image model. Unload it first.",
            ));
        }
    }
    install::delete_model_file(&root, &target)
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

fn check_files(files: &crate::state::ModelFiles) -> DiffusionResult<()> {
    for (label, path) in files.entries() {
        if !Path::new(path).is_file() {
            let code = if label == "diffusionModel" {
                DiffusionErrorCode::ModelMissing
            } else {
                DiffusionErrorCode::SideFileMissing
            };
            let name = Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.to_string());
            return Err(DiffusionError::with_details(
                code,
                format!("{name} is missing. Download the model again."),
                format!("{label}: {path}"),
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn load_model<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DiffusionState>,
    request: LoadModelRequest,
) -> DiffusionResult<LoadedModel> {
    let state = state.inner().clone();
    let emitter = emitter_for(&app);
    let root = state.backends_root()?;
    let _load = state.load_lock.lock().await;

    if let Some(active) = state.active_job_id() {
        let _ = jobs::cancel_job(&state, emitter.as_ref(), &active).await;
    }
    session::take_down_session(&state).await;
    state.set_spec(None);

    check_files(&request.files)?;
    let engine = request.engine.unwrap_or(EngineKind::SdCpp);
    if engine != EngineKind::SdCpp {
        return Err(DiffusionError::with_details(
            DiffusionErrorCode::UnsupportedBackend,
            "Only the stable-diffusion.cpp engine is available in this build.",
            format!("{engine:?}"),
        ));
    }
    let installed = install::list_installed_backends(&root);
    let record = installed
        .iter()
        .find(|r| r.engine == engine)
        .cloned()
        .ok_or_else(|| {
            DiffusionError::new(
                DiffusionErrorCode::EngineMissing,
                "Install the image engine first.",
            )
        })?;

    let spec = ServerSpec {
        binary_dir: PathBuf::from(&record.dir),
        engine,
        backend: record.backend,
        backend_id: record.backend_id.clone(),
        tag: record.tag.clone(),
        model_id: request.model_id,
        family: request.family,
        modality: request.modality,
        display_name: request.display_name,
        files: request.files,
        defaults: request.defaults,
        ranges: request.ranges,
        offload: request.offload,
        threads: request.threads,
        extra_args: Vec::new(),
        startup_timeout: Duration::from_secs(
            request
                .startup_timeout_secs
                .filter(|s| *s > 0)
                .unwrap_or(DEFAULT_STARTUP_TIMEOUT_SECS),
        ),
        cpu_fallback: false,
    };
    session::load_from_spec(&state, emitter.as_ref(), spec, "load").await
}

#[tauri::command]
pub async fn unload_model<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DiffusionState>,
) -> DiffusionResult<()> {
    let state = state.inner().clone();
    let emitter = emitter_for(&app);
    let _load = state.load_lock.lock().await;
    if let Some(active) = state.active_job_id() {
        let _ = jobs::cancel_job(&state, emitter.as_ref(), &active).await;
    }
    session::unload(&state, emitter.as_ref(), "unload").await;
    Ok(())
}

#[tauri::command]
pub async fn get_capabilities(
    state: State<'_, DiffusionState>,
) -> DiffusionResult<ImageCapabilities> {
    session::capabilities(state.inner()).await
}

#[tauri::command]
pub async fn touch_idle(state: State<'_, DiffusionState>) -> DiffusionResult<()> {
    if state.active_job_id().is_none() && state.model_state().0 == ModelState::Loaded {
        state.touch_idle();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn generate<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DiffusionState>,
    request: ImageGenerateRequest,
) -> DiffusionResult<GenerateResponse> {
    let (job_id, _handle) =
        jobs::start_image_job(state.inner().clone(), emitter_for(&app), request)?;
    Ok(GenerateResponse { job_id })
}

#[tauri::command]
pub async fn get_job(
    state: State<'_, DiffusionState>,
    job_id: String,
) -> DiffusionResult<Option<ImageJob>> {
    Ok(state.job(&job_id))
}

#[tauri::command]
pub async fn cancel_job<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DiffusionState>,
    job_id: String,
) -> DiffusionResult<CancelResult> {
    jobs::cancel_job(state.inner(), emitter_for(&app).as_ref(), &job_id).await
}

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_gallery(
    state: State<'_, DiffusionState>,
    options: GalleryListOptions,
) -> DiffusionResult<GalleryPage> {
    let dir = state.output_dir()?;
    let _guard = state.flags_lock.lock().await;
    let flags = gallery::read_flags(&dir);
    let dir_for_task = dir.clone();
    tauri::async_runtime::spawn_blocking(move || gallery::list(&dir_for_task, &options, &flags))
        .await
        .map_err(|e| {
            DiffusionError::with_details(
                DiffusionErrorCode::Internal,
                "Listing the gallery failed.",
                e.to_string(),
            )
        })
}

#[tauri::command]
pub async fn get_gallery_item(
    state: State<'_, DiffusionState>,
    id: String,
) -> DiffusionResult<Option<GalleryImageItem>> {
    let dir = state.output_dir()?;
    let _guard = state.flags_lock.lock().await;
    let flags = gallery::read_flags(&dir);
    gallery::get_item(&dir, &id, &flags)
}

#[tauri::command]
pub async fn delete_gallery_items(
    state: State<'_, DiffusionState>,
    ids: Vec<String>,
) -> DiffusionResult<()> {
    let dir = state.output_dir()?;
    let _guard = state.flags_lock.lock().await;
    let mut flags = gallery::read_flags(&dir);
    gallery::delete(&dir, &ids, &mut flags)
}

#[tauri::command]
pub async fn set_gallery_flags(
    state: State<'_, DiffusionState>,
    id: String,
    flags: GalleryFlags,
) -> DiffusionResult<GalleryImageItem> {
    let dir = state.output_dir()?;
    let _guard = state.flags_lock.lock().await;
    let mut map = gallery::read_flags(&dir);
    gallery::set_flags(&dir, &id, &flags, &mut map)
}

#[tauri::command]
pub async fn export_gallery_item(
    state: State<'_, DiffusionState>,
    id: String,
    target_path: String,
) -> DiffusionResult<()> {
    let dir = state.output_dir()?;
    gallery::export(&dir, &id, Path::new(&target_path))
}
