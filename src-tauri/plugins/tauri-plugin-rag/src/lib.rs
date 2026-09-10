use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

mod commands;
mod error;
mod parser;

pub use error::RagError;
pub use parser::parse_document;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("rag")
        .invoke_handler(tauri::generate_handler![commands::parse_document,])
        .setup(|_app, _api| Ok(()))
        .build()
}
