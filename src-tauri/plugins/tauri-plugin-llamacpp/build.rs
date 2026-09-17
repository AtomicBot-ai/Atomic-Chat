const COMMANDS: &[&str] = &[
    // GGUF commands
    "read_gguf_metadata",
    "is_model_supported",
    // backend management
    "map_old_backend_to_new",
    "get_local_installed_backends",
    "list_supported_backends",
    "determine_supported_backends",
    "get_supported_features",
    "find_latest_version_for_backend",
    "prioritize_backends",
    "check_backend_for_updates",
    "remove_old_backend_versions",
    "should_migrate_backend",
    "handle_setting_update",
    "install_bundled_backend",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
