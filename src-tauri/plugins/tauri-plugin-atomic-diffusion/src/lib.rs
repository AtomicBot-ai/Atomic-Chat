//! Atomic Chat local image generation.
//!
//! Supervises one resident `sd-server` (stable-diffusion.cpp) process, runs
//! generation jobs against its `/sdcpp/v1/*` API, parses its verbose stdout
//! for step progress, and owns the gallery on disk. The web app hands it
//! explicit file paths; it never resolves a catalog or downloads anything.
//!
//! The same job runner serves `POST /v1/images/generations` on the local API
//! server (see `core::server::images_route` in the main crate).

pub mod args;
pub mod commands;
pub mod error;
pub mod events;
pub mod gallery;
pub mod install;
pub mod jobs;
pub mod process;
pub mod progress;
pub mod session;
pub mod state;

pub use error::{DiffusionError, DiffusionErrorCode};
pub use events::{DiffusionEmitter, SharedEmitter};
pub use jobs::{run_image_job, start_image_job, JobOutcome};
pub use state::{DiffusionState, ImageGenerateRequest, LoadedModel};

use std::sync::Arc;
use std::time::Duration;

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, RunEvent, Runtime,
};

/// How often the idle task checks the deadline.
const IDLE_TICK: Duration = Duration::from_secs(30);

/// Initialise the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("atomic-diffusion")
        .invoke_handler(tauri::generate_handler![
            commands::configure,
            commands::get_status,
            commands::finalize_backend_install,
            commands::list_installed_backends,
            commands::remove_backend,
            commands::list_model_files,
            commands::delete_model_file,
            commands::load_model,
            commands::unload_model,
            commands::get_capabilities,
            commands::touch_idle,
            commands::generate,
            commands::get_job,
            commands::cancel_job,
            commands::list_gallery,
            commands::get_gallery_item,
            commands::delete_gallery_items,
            commands::set_gallery_flags,
            commands::export_gallery_item,
            commands::set_output_dir,
        ])
        .setup(|app, _api| {
            let state = DiffusionState::new();
            app.manage(state.clone());
            let emitter: SharedEmitter = Arc::new(app.clone());
            tauri::async_runtime::spawn(idle_task(state, emitter));
            Ok(())
        })
        .on_event(|app, event| {
            // A multi-gigabyte sd-server must not outlive the window.
            if matches!(event, RunEvent::Exit) {
                if let Some(state) = app.try_state::<DiffusionState>() {
                    session::shutdown_blocking(state.inner());
                }
            }
        })
        .build()
}

/// Unload the model after `idleUnloadSecs` without a job. The deadline is
/// re-armed by every job completion and by `touch_idle`.
async fn idle_task(state: DiffusionState, emitter: SharedEmitter) {
    loop {
        tokio::time::sleep(IDLE_TICK).await;
        if !state.idle_expired() || state.active_job_id().is_some() {
            continue;
        }
        let Ok(_load) = state.load_lock.try_lock() else {
            continue;
        };
        if state.session.lock().await.is_none() {
            state.clear_idle();
            continue;
        }
        log::info!("[atomic-diffusion] unloading the image model after idling");
        session::unload(&state, emitter.as_ref(), "idle").await;
    }
}
