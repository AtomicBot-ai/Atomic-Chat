use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub mod api;
mod commands;
mod db;
mod error;
mod state;
mod utils;

pub use error::VectorDBError;
pub use state::VectorDBState;

/// The plugin with collections in the legacy, fixed place.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    init_in(|_| VectorDBState::legacy_dir())
}

/// The plugin with collections where `base_dir` says — for the app, a folder inside its data
/// folder, resolved once the app handle exists.
pub fn init_in<R: Runtime>(
    base_dir: impl Fn(&tauri::AppHandle<R>) -> std::path::PathBuf + Send + Sync + 'static,
) -> TauriPlugin<R> {
    Builder::new("vector-db")
        .invoke_handler(tauri::generate_handler![
            commands::create_collection,
            commands::insert_chunks,
            commands::create_file,
            commands::search_collection,
            commands::delete_chunks,
            commands::delete_file,
            commands::delete_collection,
            commands::chunk_text,
            commands::get_status,
            commands::list_attachments,
            commands::get_chunks,
        ])
        .setup(move |app, _api| {
            app.manage(state::VectorDBState::at(base_dir(app)));
            Ok(())
        })
        .build()
}
