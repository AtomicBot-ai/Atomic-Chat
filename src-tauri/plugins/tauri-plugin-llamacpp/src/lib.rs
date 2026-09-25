use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

mod backend;
mod gguf;
pub use backend::install_bundled_backend;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("llamacpp")
        .invoke_handler(tauri::generate_handler![
            gguf::commands::read_gguf_metadata,
            gguf::commands::is_model_supported,
            backend::map_old_backend_to_new,
            backend::get_local_installed_backends,
            backend::list_supported_backends,
            backend::determine_supported_backends,
            backend::get_supported_features,
            backend::find_latest_version_for_backend,
            backend::prioritize_backends,
            backend::check_backend_for_updates,
            backend::remove_old_backend_versions,
            backend::should_migrate_backend,
            backend::handle_setting_update,
            backend::install_bundled_backend
        ])
        .build()
}
