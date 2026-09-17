const COMMANDS: &[&str] = &["get_mlx_server_version"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
