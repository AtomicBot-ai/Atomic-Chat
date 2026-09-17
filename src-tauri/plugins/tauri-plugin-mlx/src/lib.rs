use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

mod commands;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mlx")
        .invoke_handler(tauri::generate_handler![commands::get_mlx_server_version])
        .build()
}
