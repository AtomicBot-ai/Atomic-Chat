const COMMANDS: &[&str] = &[
    "configure",
    "get_status",
    "finalize_backend_install",
    "list_installed_backends",
    "remove_backend",
    "list_model_files",
    "delete_model_file",
    "load_model",
    "unload_model",
    "get_capabilities",
    "touch_idle",
    "generate",
    "get_job",
    "cancel_job",
    "list_gallery",
    "get_gallery_item",
    "delete_gallery_items",
    "set_gallery_flags",
    "export_gallery_item",
    "set_output_dir",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
