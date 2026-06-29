use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_llamacpp::cleanup_llama_processes;

use crate::core::app::commands::{
    default_data_folder_path, get_jan_data_folder_path, update_app_configuration,
};
use crate::core::app::constants::{JAN_DATA_FILES, JAN_DATA_SUBDIRS};
use crate::core::app::models::AppConfiguration;
use crate::core::mcp::helpers::{stop_mcp_servers_with_context, ShutdownContext};
use crate::core::state::AppState;

fn is_safe_to_delete(path: &std::path::Path) -> bool {
    let count = path.components().count();
    count >= 3
}

fn remove_dir_all_with_retry(path: &std::path::Path) {
    const MAX_ATTEMPTS: u32 = 5;
    const RETRY_DELAY_MS: u64 = 500;

    for attempt in 1..=MAX_ATTEMPTS {
        match fs::remove_dir_all(path) {
            Ok(()) => {
                if attempt > 1 {
                    log::info!("Removed {} on attempt {}", path.display(), attempt);
                }
                return;
            }
            Err(e) if attempt < MAX_ATTEMPTS => {
                log::warn!(
                    "Failed to remove {} (attempt {}/{}): {e}",
                    path.display(),
                    attempt,
                    MAX_ATTEMPTS
                );
                std::thread::sleep(std::time::Duration::from_millis(RETRY_DELAY_MS));
            }
            Err(e) => {
                log::error!(
                    "Failed to remove {} after {} attempts: {e}",
                    path.display(),
                    MAX_ATTEMPTS
                );
            }
        }
    }
}

fn remove_jan_data_contents(data_folder: &std::path::Path) {
    for subdir in JAN_DATA_SUBDIRS {
        let path = data_folder.join(subdir);
        if path.is_dir() {
            remove_dir_all_with_retry(&path);
        }
    }
    for file in JAN_DATA_FILES {
        let path = data_folder.join(file);
        if path.is_file() {
            if let Err(e) = fs::remove_file(&path) {
                log::warn!("Failed to remove {}: {e}", path.display());
            }
        }
    }
}

/// Detect the user's default shell and return the appropriate env file path.
/// Returns (shell_name, env_file_path).
fn detect_shell_env_file(home_dir: &str, is_macos: bool) -> (&'static str, String) {
    let shell = std::env::var("SHELL").unwrap_or_default();
    if shell.ends_with("/bash") {
        // macOS uses login shells in Terminal, so ~/.bash_profile is sourced.
        // Linux interactive shells source ~/.bashrc.
        let file = if is_macos {
            format!("{}/.bash_profile", home_dir)
        } else {
            format!("{}/.bashrc", home_dir)
        };
        ("bash", file)
    } else {
        // Default to zsh (macOS default since Catalina)
        ("zsh", format!("{}/.zshenv", home_dir))
    }
}

// Helper function to write env vars to a shell config file
fn write_env_to_shell(env_file_path: &str, env_vars: &[(String, String)]) -> Result<(), String> {
    let marker = "# Jan Local API Server - Claude Code Config";
    let new_entries: String = env_vars
        .iter()
        .map(|(k, v)| format!("export {}='{}'\n", k, v))
        .collect();

    let existing_content = std::fs::read_to_string(env_file_path).unwrap_or_default();
    let cleaned: Vec<&str> = existing_content
        .split('\n')
        .filter(|line| {
            // Remove Jan config markers and existing ANTHROPIC env vars to replace them
            !line.starts_with(marker)
                && !line.starts_with("# Jan Local API Server")
                && !line.starts_with("export ANTHROPIC_")
        })
        .collect();

    let new_content = format!("{}\n{}\n{}\n", marker, new_entries, marker);

    let final_content = cleaned.join("\n") + &new_content;
    std::fs::write(env_file_path, &final_content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn factory_reset<R: Runtime>(app_handle: tauri::AppHandle<R>, state: State<'_, AppState>) {
    // close window (not available on mobile platforms)
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let windows = app_handle.webview_windows();
        for (label, window) in windows.iter() {
            window.close().unwrap_or_else(|_| {
                log::warn!("Failed to close window: {label:?}");
            });
        }
    }
    let data_folder = get_jan_data_folder_path(app_handle.clone());
    log::info!("Factory reset, removing data folder: {data_folder:?}");

    tauri::async_runtime::block_on(async {
        let _ =
            stop_mcp_servers_with_context(&app_handle, &state, ShutdownContext::FactoryReset).await;

        {
            let mut active_servers = state.mcp_active_servers.lock().await;
            active_servers.clear();
        }

        use crate::core::mcp::lockfile::cleanup_own_locks;
        if let Err(e) = cleanup_own_locks(&app_handle) {
            log::warn!("Failed to cleanup lock files: {}", e);
        }
        // Clean up both llama.cpp providers' process maps.
        let _ = cleanup_llama_processes(app_handle.clone()).await;
        let _ = tauri_plugin_llamacpp_upstream::cleanup_llama_processes(app_handle.clone()).await;

        // Windows needs time to release file handles after TerminateProcess
        #[cfg(windows)]
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        if data_folder.exists() {
            if !is_safe_to_delete(&data_folder) {
                log::error!(
                    "Refusing factory reset: path is too close to filesystem root: {}",
                    data_folder.display()
                );
                return;
            }

            // Preserve downloaded llamacpp backends across factory reset so the user
            // doesn't have to re-download CUDA/Vulkan binaries (can be hundreds of MB).
            let backends_dir = data_folder.join("llamacpp").join("backends");
            let temp_backends = std::env::temp_dir().join("atomic-chat-backends-preserve");
            let backends_preserved = if backends_dir.is_dir() {
                if temp_backends.exists() {
                    let _ = fs::remove_dir_all(&temp_backends);
                }
                match fs::rename(&backends_dir, &temp_backends) {
                    Ok(()) => {
                        log::info!("Preserved llamacpp backends to temp dir");
                        true
                    }
                    Err(e) => {
                        log::warn!("Failed to preserve llamacpp backends: {e}");
                        false
                    }
                }
            } else {
                false
            };

            remove_jan_data_contents(&data_folder);

            if backends_preserved {
                let llamacpp_dir = data_folder.join("llamacpp");
                let _ = fs::create_dir_all(&llamacpp_dir);
                match fs::rename(&temp_backends, &backends_dir) {
                    Ok(()) => log::info!("Restored llamacpp backends after factory reset"),
                    Err(e) => log::warn!("Failed to restore llamacpp backends: {e}"),
                }
            }
        }

        // Reset the configuration
        let mut default_config = AppConfiguration::default();
        default_config.data_folder = default_data_folder_path(app_handle.clone());
        let _ = update_app_configuration(app_handle.clone(), default_config);

        app_handle.restart();
    });
}

#[tauri::command]
pub fn relaunch<R: Runtime>(app: AppHandle<R>) {
    app.restart()
}

#[tauri::command]
pub fn open_app_directory<R: Runtime>(app: AppHandle<R>) {
    let app_path = app.path().app_data_dir().unwrap();
    if cfg!(target_os = "windows") {
        std::process::Command::new("explorer")
            .arg(app_path)
            .status()
            .expect("Failed to open app directory");
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .arg(app_path)
            .status()
            .expect("Failed to open app directory");
    } else {
        std::process::Command::new("xdg-open")
            .arg(app_path)
            .status()
            .expect("Failed to open app directory");
    }
}

#[tauri::command]
pub fn open_file_explorer(path: String) {
    let path = PathBuf::from(path);
    if cfg!(target_os = "windows") {
        std::process::Command::new("explorer")
            .arg(path)
            .status()
            .expect("Failed to open file explorer");
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .arg(path)
            .status()
            .expect("Failed to open file explorer");
    } else {
        std::process::Command::new("xdg-open")
            .arg(path)
            .status()
            .expect("Failed to open file explorer");
    }
}

#[tauri::command]
pub async fn read_logs<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let log_path = get_jan_data_folder_path(app).join("logs").join("app.log");
    if log_path.exists() {
        let content = fs::read_to_string(log_path).map_err(|e| e.to_string())?;
        Ok(content)
    } else {
        Err("Log file not found".to_string())
    }
}

/// Best-effort detection of how this build was installed (ATO-111 telemetry).
/// Returns one of: "appimage" | "msi" | "setup_exe" | "dmg" | "unknown".
/// No PII: only the install-channel enum is returned.
#[tauri::command]
pub fn get_installer_type() -> String {
    #[cfg(target_os = "linux")]
    {
        // The AppImage runtime exports APPIMAGE; nothing else does.
        if std::env::var_os("APPIMAGE").is_some() {
            return "appimage".to_string();
        }
        "unknown".to_string()
    }

    #[cfg(target_os = "windows")]
    {
        detect_windows_installer_type()
    }

    #[cfg(target_os = "macos")]
    {
        // Distinguishing a DMG-mounted copy from a manually-copied .app is not
        // reliable; DMG is the shipped channel, so report it best-effort.
        "dmg".to_string()
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        "unknown".to_string()
    }
}

#[cfg(target_os = "windows")]
fn detect_windows_installer_type() -> String {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    const PRODUCT: &str = "Atomic Chat";
    const UNINSTALL: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

    // NSIS (setup.exe) writes its uninstall key named after the product.
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let root = RegKey::predef(hive);
        if root.open_subkey(format!("{UNINSTALL}\\{PRODUCT}")).is_ok() {
            return "setup_exe".to_string();
        }
    }

    // WiX (MSI) registers a product-GUID uninstall key carrying
    // WindowsInstaller=1; scan for a matching DisplayName.
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let root = RegKey::predef(hive);
        if let Ok(uninstall) = root.open_subkey(UNINSTALL) {
            for key_name in uninstall.enum_keys().flatten() {
                if let Ok(entry) = uninstall.open_subkey(&key_name) {
                    let name: Result<String, _> = entry.get_value("DisplayName");
                    if let Ok(name) = name {
                        if name.starts_with(PRODUCT) {
                            let is_msi: u32 = entry.get_value("WindowsInstaller").unwrap_or(0);
                            return if is_msi == 1 {
                                "msi".to_string()
                            } else {
                                "setup_exe".to_string()
                            };
                        }
                    }
                }
            }
        }
    }

    "unknown".to_string()
}

// check if a system library is available
#[tauri::command]
pub fn is_library_available(library: &str) -> bool {
    match unsafe { libloading::Library::new(library) } {
        Ok(_) => true,
        Err(e) => {
            log::info!("Library {library} is not available: {e}");
            false
        }
    }
}

#[tauri::command]
pub fn launch_claude_code_with_config(
    api_url: String,
    api_key: Option<String>,
    big_model: Option<String>,
    medium_model: Option<String>,
    small_model: Option<String>,
    custom_env_vars: Vec<serde_json::Value>,
) -> Result<(), String> {
    // Clone values for logging before moving
    let api_url_log = api_url.clone();
    let big_model_log = big_model.clone();
    let medium_model_log = medium_model.clone();
    let small_model_log = small_model.clone();

    let mut env_vars: Vec<(String, String)> = Vec::with_capacity(8);
    env_vars.push(("ANTHROPIC_BASE_URL".to_string(), api_url));

    env_vars.push((
        "ANTHROPIC_AUTH_TOKEN".to_string(),
        api_key.unwrap_or_else(|| "jan".to_string()),
    ));

    if let Some(model) = big_model {
        env_vars.push(("ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(), model));
    }

    if let Some(model) = medium_model {
        env_vars.push(("ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(), model));
    }

    if let Some(model) = small_model {
        env_vars.push(("ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(), model));
    }

    // Add custom env vars from the custom CLI section
    for env in &custom_env_vars {
        if let (Some(key), Some(value)) = (
            env.get("key").and_then(|v| v.as_str()),
            env.get("value").and_then(|v| v.as_str()),
        ) {
            env_vars.push((key.to_string(), value.to_string()));
        }
    }

    log::info!(
        "Launching Claude Code with API URL: {}, models: opus={:?}, sonnet={:?}, haiku={:?}, custom_envs={}",
        api_url_log,
        big_model_log,
        medium_model_log,
        small_model_log,
        custom_env_vars.len()
    );

    // Build the command environment
    // Export environment variables to the user's shell config file

    if cfg!(target_os = "macos") {
        let home_dir = std::env::var("HOME").map_err(|e| e.to_string())?;
        let (shell_name, env_file_path) = detect_shell_env_file(&home_dir, true);
        log::info!(
            "Detected shell: {}, writing env to: {}",
            shell_name,
            env_file_path
        );

        // Try direct write first
        match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .open(&env_file_path)
        {
            Ok(_) => {
                write_env_to_shell(&env_file_path, &env_vars)?;
                return Ok(());
            }
            Err(_) => {
                // Use admin privileges to write
                let marker = "# Jan Local API Server - Claude Code Config";
                let existing_content = std::fs::read_to_string(&env_file_path).unwrap_or_default();
                let cleaned: Vec<&str> = existing_content
                    .split('\n')
                    .filter(|line| {
                        !line.starts_with(marker)
                            && !line.starts_with("# Jan Local API Server")
                            && !line.starts_with("export ANTHROPIC_")
                    })
                    .collect();

                let env_content: String = env_vars
                    .iter()
                    .map(|(k, v)| format!("export {}='{}'\n", k, v))
                    .collect();

                let new_block = format!("{}\n{}", marker, env_content);

                let final_content = cleaned.join("\n") + "\n" + &new_block + marker;

                // Write to a temp file first, then use osascript to move it
                let temp_script_path = format!("{}/.jan_env_update.sh", home_dir);
                std::fs::write(&temp_script_path, &final_content).map_err(|e| e.to_string())?;

                // Use admin privileges to move the temp file
                let script = format!(
                    r#"do shell script "cp '{}' '{}' && rm '{}' && echo 'Env vars written to {}'" with administrator privileges"#,
                    temp_script_path, env_file_path, temp_script_path, env_file_path
                );

                std::process::Command::new("osascript")
                    .arg("-e")
                    .arg(&script)
                    .output()
                    .map_err(|e| e.to_string())?;

                log::info!(
                    "Env vars written to {} with admin privileges",
                    env_file_path
                );
                return Ok(());
            }
        }
    } else if cfg!(target_os = "linux") {
        let home_dir = std::env::var("HOME").map_err(|e| e.to_string())?;
        let (shell_name, env_file_path) = detect_shell_env_file(&home_dir, false);
        log::info!(
            "Detected shell: {}, writing env to: {}",
            shell_name,
            env_file_path
        );

        match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .open(&env_file_path)
        {
            Ok(_) => {
                write_env_to_shell(&env_file_path, &env_vars)?;
                return Ok(());
            }
            Err(_) => {
                let jan_config_dir = format!("{}/.config/jan", home_dir);
                let ext = if shell_name == "bash" { "bash" } else { "zsh" };
                let env_file = format!("{}/claude-code-env.{}", jan_config_dir, ext);
                return Err(format!("NEED_PERMISSION:{}", env_file));
            }
        }
    } else {
        // On Windows, set persistent user environment variables using setx
        for (key, value) in &env_vars {
            let output = std::process::Command::new("setx")
                .arg(key)
                .arg(value)
                .output()
                .map_err(|e| e.to_string())?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Failed to set env var {}: {}", key, stderr));
            }
        }

        log::info!("Environment variables set permanently in Windows registry.");
        return Ok(());
    }
}

#[derive(serde::Serialize)]
pub struct CliInstallStatus {
    pub installed: bool,
    pub path: Option<String>,
}

/// Check if the `jan` CLI binary is accessible on PATH.
#[tauri::command]
pub async fn check_jan_cli_installed() -> CliInstallStatus {
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    let mut cmd = std::process::Command::new(which_cmd);
    cmd.arg("jan");

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    match tokio::task::spawn_blocking(move || cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => {
            let raw = String::from_utf8_lossy(&out.stdout);
            #[cfg(windows)]
            let path = {
                // `where` returns one path per line; pick the first that isn't a
                // dev-build artifact (i.e. skip paths containing \target\)
                raw.lines()
                    .map(str::trim)
                    .filter(|p| !p.is_empty() && !p.to_ascii_lowercase().contains("\\target\\"))
                    .next()
                    .map(str::to_string)
                    // fall back to the raw first line if every path looks like a build dir
                    .or_else(|| {
                        raw.lines()
                            .map(str::trim)
                            .find(|p| !p.is_empty())
                            .map(str::to_string)
                    })
            };
            #[cfg(not(windows))]
            let path = Some(raw.trim().to_string());
            CliInstallStatus {
                installed: path.is_some(),
                path,
            }
        }
        _ => CliInstallStatus {
            installed: false,
            path: None,
        },
    }
}

/// Core install logic — synchronous, no Tauri command overhead.
pub fn install_jan_cli_sync<R: Runtime>(
    app_handle: &AppHandle<R>,
) -> Result<CliInstallStatus, String> {
    let bin_name = if cfg!(windows) {
        "jan-cli.exe"
    } else {
        "jan-cli"
    };
    let dest_bin_name = if cfg!(windows) { "jan.exe" } else { "jan" };
    let resource_bin_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("resources/bin");
    let bundled = resource_bin_dir.join(bin_name);
    let dest = resource_bin_dir.join(dest_bin_name);

    if !bundled.exists() && !dest.exists() {
        return Err("Jan CLI binary not bundled with this version of Jan.".to_string());
    }

    #[cfg(windows)]
    {
        if bundled.exists() {
            if let Err(e) = std::fs::rename(&bundled, &dest) {
                log::warn!("Could not rename jan-cli.exe to jan.exe: {}", e);
            }
        }
        if dest.exists() {
            let alias = resource_bin_dir.join("atomic-chat-cli.exe");
            if let Err(e) = std::fs::copy(&dest, &alias) {
                log::warn!("Could not copy jan.exe to atomic-chat-cli.exe: {}", e);
            }
        }
        add_to_path_windows(&resource_bin_dir)?;
        return Ok(CliInstallStatus {
            installed: true,
            path: Some(dest.to_string_lossy().into_owned()),
        });
    }

    #[cfg(unix)]
    {
        let install_dir = jan_cli_install_dir()?;
        std::fs::create_dir_all(&install_dir).map_err(|e| e.to_string())?;
        let dest = install_dir.join(dest_bin_name);

        std::fs::copy(&bundled, &dest)
            .map_err(|e| format!("Failed to copy jan to {}: {}", dest.display(), e))?;

        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;

        Ok(CliInstallStatus {
            installed: true,
            path: Some(dest.to_string_lossy().into_owned()),
        })
    }
}

/// Copy the bundled `jan` binary to the system PATH (Tauri command wrapper).
#[tauri::command]
pub async fn install_jan_cli<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<CliInstallStatus, String> {
    install_jan_cli_sync(&app_handle)
}

/// Remove the installed `jan` CLI binary.
#[tauri::command]
pub fn uninstall_jan_cli() -> Result<(), String> {
    #[cfg(windows)]
    {
        let bin_dir = jan_cli_bin_dir_windows()?;
        for name in ["jan.exe", "atomic-chat-cli.exe"] {
            let path = bin_dir.join(name);
            if path.exists() {
                if let Err(e) = std::fs::remove_file(&path) {
                    log::warn!("Could not remove {}: {}", path.display(), e);
                }
            }
        }
        remove_from_path_windows(&bin_dir)?;
        return Ok(());
    }

    #[cfg(unix)]
    {
        let dest = jan_cli_install_dir()?.join("jan");
        if dest.exists() {
            std::fs::remove_file(&dest)
                .map_err(|e| format!("Failed to remove Jan CLI from {}: {}", dest.display(), e))?;
        }
        Ok(())
    }
}

/// Build the cleaned shell-file content with all Jan CC env vars stripped out.
fn build_cleaned_env_content(env_file_path: &str) -> String {
    let existing_content = std::fs::read_to_string(env_file_path).unwrap_or_default();
    let cleaned: Vec<&str> = existing_content
        .split('\n')
        .filter(|line| {
            !line.starts_with("# Jan Local API Server - Claude Code Config")
                && !line.starts_with("# Jan Local API Server")
                && !line.starts_with("export ANTHROPIC_")
        })
        .collect();
    // Trim trailing blank lines left behind by the removed block
    cleaned.join("\n").trim_end().to_string() + "\n"
}

/// Clear all Jan-written Claude Code environment variables from the shell config.
/// Uses the same write-probe + osascript-fallback logic as `launch_claude_code_with_config`.
#[tauri::command]
pub fn clear_claude_code_env() -> Result<(), String> {
    if cfg!(target_os = "macos") {
        let home_dir = std::env::var("HOME").map_err(|e| e.to_string())?;
        let (shell_name, env_file_path) = detect_shell_env_file(&home_dir, true);
        log::info!(
            "Clearing CC env from shell: {}, file: {}",
            shell_name,
            env_file_path
        );

        let cleaned = build_cleaned_env_content(&env_file_path);

        match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .open(&env_file_path)
        {
            Ok(_) => {
                std::fs::write(&env_file_path, &cleaned).map_err(|e| e.to_string())?;
                return Ok(());
            }
            Err(_) => {
                // Write cleaned content to a temp file, then use osascript to move it
                let temp_path = format!("{}/.jan_env_clear.sh", home_dir);
                std::fs::write(&temp_path, &cleaned).map_err(|e| e.to_string())?;

                let script = format!(
                    r#"do shell script "cp '{}' '{}' && rm '{}'" with administrator privileges"#,
                    temp_path, env_file_path, temp_path
                );

                std::process::Command::new("osascript")
                    .arg("-e")
                    .arg(&script)
                    .output()
                    .map_err(|e| e.to_string())?;

                log::info!(
                    "CC env cleared from {} with admin privileges",
                    env_file_path
                );
                return Ok(());
            }
        }
    } else if cfg!(target_os = "linux") {
        let home_dir = std::env::var("HOME").map_err(|e| e.to_string())?;
        let (shell_name, env_file_path) = detect_shell_env_file(&home_dir, false);
        log::info!(
            "Clearing CC env from shell: {}, file: {}",
            shell_name,
            env_file_path
        );

        let cleaned = build_cleaned_env_content(&env_file_path);

        match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .open(&env_file_path)
        {
            Ok(_) => {
                std::fs::write(&env_file_path, &cleaned).map_err(|e| e.to_string())?;
                Ok(())
            }
            Err(_) => Err(format!("NEED_PERMISSION:{}", env_file_path)),
        }
    } else {
        // Windows: delete the persistent user env vars from the registry
        let keys = [
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        ];
        for key in &keys {
            let _ = std::process::Command::new("reg")
                .args(["delete", "HKCU\\Environment", "/v", key, "/f"])
                .output();
        }
        log::info!("CC env vars removed from Windows registry.");
        Ok(())
    }
}

/// Determine the best writable directory for the Jan CLI install (Unix only).
#[cfg(unix)]
fn jan_cli_install_dir() -> Result<PathBuf, String> {
    let usr_local_bin = PathBuf::from("/usr/local/bin");
    if usr_local_bin.exists() {
        let probe = usr_local_bin.join(".jan_write_probe");
        if std::fs::write(&probe, b"").is_ok() {
            let _ = std::fs::remove_file(&probe);
            return Ok(usr_local_bin);
        }
    }
    let home =
        std::env::var("HOME").map_err(|_| "Cannot determine home directory".to_string())?;
    Ok(PathBuf::from(home).join(".local").join("bin"))
}

/// Return the directory containing the bundled CLI binary on Windows.
#[cfg(windows)]
fn jan_cli_bin_dir_windows() -> Result<PathBuf, String> {
    let local_app_data = std::env::var("LOCALAPPDATA")
        .map_err(|_| "Cannot determine LOCALAPPDATA".to_string())?;
    Ok(PathBuf::from(local_app_data)
        .join("Programs")
        .join("Atomic Chat")
        .join("resources")
        .join("bin"))
}

/// Strip the Windows extended-length / verbatim prefix (`\\?\` or `\\?\UNC\`)
/// from a path string.
///
/// Tauri's `resource_dir()` returns verbatim-prefixed paths on Windows
/// (e.g. `\\?\C:\Users\...\resources\bin`). That prefix is valid Win32 but does
/// not belong in the user PATH: some tools fail to resolve executables from a
/// `\\?\`-prefixed PATH entry because the prefix disables normal path parsing.
/// We always write the plain, normalized form instead.
#[cfg(windows)]
fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        // \\?\UNC\server\share -> \\server\share
        format!(r"\\{}", rest)
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        // \\?\C:\... -> C:\...
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// Add a directory to the Windows user PATH.
#[cfg(windows)]
fn add_to_path_windows(install_dir: &PathBuf) -> Result<(), String> {
    use std::process::Command;

    // Always write the normalized (non-verbatim) form to PATH.
    let install_dir_str = strip_verbatim_prefix(&install_dir.to_string_lossy());

    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-Command",
        "[Environment]::GetEnvironmentVariable('Path', 'User')",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let read_output = cmd
        .output()
        .map_err(|e| format!("Failed to read user PATH: {}", e))?;

    let existing_user_path = String::from_utf8_lossy(&read_output.stdout)
        .trim()
        .to_string();

    // Remove stale old-style PATH entry (..\\Programs\\Jan without \\resources\\bin)
    // left by previous versions that placed jan.exe next to the GUI binary.
    let old_jan_dir = install_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_string_lossy().to_string());

    let old_jan_dir_norm = old_jan_dir.as_deref().map(strip_verbatim_prefix);

    let parts: Vec<&str> = existing_user_path
        .split(';')
        .filter(|p| !p.is_empty())
        .filter(|p| {
            let norm = strip_verbatim_prefix(p);
            // Drop the stale old-style GUI-dir entry...
            if let Some(ref old) = old_jan_dir_norm {
                if norm.eq_ignore_ascii_case(old) {
                    return false;
                }
            }
            // ...and drop any existing copy of our bin dir (including the
            // legacy `\\?\`-prefixed form) so we can re-add the clean entry.
            // This lets older installs self-heal on the next launch.
            !norm.eq_ignore_ascii_case(&install_dir_str)
        })
        .collect();

    let mut new_parts = vec![install_dir_str.as_str()];
    new_parts.extend(parts);
    let new_path = new_parts.join(";");

    // Nothing to change: our clean entry is already present and no stale
    // entries needed removing. Skip the write to avoid touching the registry
    // on every launch.
    if new_path == existing_user_path {
        return Ok(());
    }

    let mut cmd_write = Command::new("powershell");
    cmd_write.args([
        "-NoProfile",
        "-Command",
        &format!(
            "[Environment]::SetEnvironmentVariable('Path', '{}', 'User')",
            new_path.replace('\'', "''")
        ),
    ]);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd_write.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let write_output = cmd_write
        .output()
        .map_err(|e| format!("Failed to update user PATH: {}", e))?;

    if !write_output.status.success() {
        return Err(format!(
            "Failed to update PATH: {}",
            String::from_utf8_lossy(&write_output.stderr)
        ));
    }

    log::info!("Added {} to Windows user PATH", install_dir_str);
    Ok(())
}

/// Remove a directory from the Windows user PATH.
#[cfg(windows)]
fn remove_from_path_windows(dir: &PathBuf) -> Result<(), String> {
    use std::process::Command;

    let dir_str = dir.to_string_lossy().to_string();

    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-Command",
        "[Environment]::GetEnvironmentVariable('Path', 'User')",
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let read_output = cmd
        .output()
        .map_err(|e| format!("Failed to read user PATH: {}", e))?;

    let existing_user_path = String::from_utf8_lossy(&read_output.stdout)
        .trim()
        .to_string();

    let dir_str = strip_verbatim_prefix(&dir_str);
    let new_path: String = existing_user_path
        .split(';')
        // Match both the plain entry and any legacy `\\?\`-prefixed copy.
        .filter(|p| !p.is_empty() && !strip_verbatim_prefix(p).eq_ignore_ascii_case(&dir_str))
        .collect::<Vec<_>>()
        .join(";");

    if new_path.len() != existing_user_path.len() {
        let mut cmd_write = Command::new("powershell");
        cmd_write.args([
            "-NoProfile",
            "-Command",
            &format!(
                "[Environment]::SetEnvironmentVariable('Path', '{}', 'User')",
                new_path.replace('\'', "''")
            ),
        ]);

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd_write.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let write_output = cmd_write
            .output()
            .map_err(|e| format!("Failed to update user PATH: {}", e))?;

        if !write_output.status.success() {
            return Err(format!(
                "Failed to update PATH: {}",
                String::from_utf8_lossy(&write_output.stderr)
            ));
        }

        log::info!("Removed {} from Windows user PATH", dir_str);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Hermes Agent integration
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn configure_hermes_agent(
    api_url: String,
    model: String,
    api_key: Option<String>,
    context_length: Option<u32>,
) -> Result<(), String> {
    let home_dir = if cfg!(windows) {
        std::env::var("USERPROFILE").map_err(|e| e.to_string())?
    } else {
        std::env::var("HOME").map_err(|e| e.to_string())?
    };

    let hermes_dir = std::path::PathBuf::from(&home_dir).join(".hermes");
    let config_path = hermes_dir.join("config.yaml");
    let env_path = hermes_dir.join(".env");

    // The installer runs with `-SkipSetup`, so on a fresh install (notably
    // Windows) no config.yaml exists yet. Seed a default skeleton so the patch
    // logic below has the anchors it expects, instead of failing outright.
    if !config_path.exists() {
        std::fs::create_dir_all(&hermes_dir)
            .map_err(|e| format!("Failed to create ~/.hermes directory: {}", e))?;
        std::fs::write(&config_path, HERMES_DEFAULT_CONFIG)
            .map_err(|e| format!("Failed to create config.yaml: {}", e))?;
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config.yaml: {}", e))?;

    // --- Patch model section (first occurrence of each key) ---
    let mut did_default = false;
    let mut did_provider = false;
    let mut did_base_url = false;

    let patched: Vec<String> = content
        .lines()
        .map(|line| {
            let trimmed = line.trim();
            if !did_default && trimmed.starts_with("default:") {
                did_default = true;
                return replace_yaml_scalar_value(line, &model);
            }
            if !did_provider && trimmed.starts_with("provider:") {
                did_provider = true;
                return replace_yaml_scalar_value(line, "custom");
            }
            if !did_base_url && trimmed.starts_with("base_url:") {
                did_base_url = true;
                return replace_yaml_scalar_value(line, &api_url);
            }
            line.to_string()
        })
        .collect();

    let after_model_patch = patched.join("\n");

    // --- Upsert only our entry in custom_providers (preserves user's other providers) ---
    // Hermes Agent rejects any model whose context window is below 64K, so the
    // fallback must satisfy that floor too (the UI passes 65536 explicitly).
    let ctx = context_length.unwrap_or(65536);
    let after_cp = upsert_atomic_provider(
        &after_model_patch,
        &api_url,
        &model,
        ctx,
    );

    // Seed a per-request timeout for the `custom` provider (the id our model
    // section uses). Hermes reads `providers.<id>.request_timeout_seconds`
    // (run_agent.py::get_provider_request_timeout); without it the legacy
    // 1800s default applies. Any value the user already set is preserved.
    let after_timeout = upsert_provider_request_timeout(
        &after_cp,
        "custom",
        HERMES_REQUEST_TIMEOUT_SECONDS,
    );

    let final_content = if content.ends_with('\n') && !after_timeout.ends_with('\n') {
        format!("{}\n", after_timeout)
    } else {
        after_timeout
    };

    std::fs::write(&config_path, &final_content)
        .map_err(|e| format!("Failed to write config.yaml: {}", e))?;

    // --- Ensure NO_PROXY is set in .env to bypass system proxy for localhost ---
    let no_proxy_line = "NO_PROXY=localhost,127.0.0.1,0.0.0.0";
    let no_proxy_lower = "export no_proxy=localhost,127.0.0.1,0.0.0.0";

    if env_path.exists() {
        let env_content = std::fs::read_to_string(&env_path)
            .map_err(|e| format!("Failed to read .env: {}", e))?;
        if !env_content.contains("NO_PROXY=") && !env_content.contains("no_proxy=") {
            let separator = if env_content.ends_with('\n') { "" } else { "\n" };
            let patched = format!(
                "{}{}\n{}\n{}",
                env_content, separator, no_proxy_line, no_proxy_lower
            );
            std::fs::write(&env_path, patched)
                .map_err(|e| format!("Failed to write .env: {}", e))?;
        }
    }

    let _ = api_key; // reserved for future use

    log::info!(
        "Hermes Agent configured: model={}, base_url={}, context_length={}",
        model,
        api_url,
        ctx
    );
    Ok(())
}

#[tauri::command]
pub fn clear_hermes_agent_config() -> Result<(), String> {
    let home_dir = if cfg!(windows) {
        std::env::var("USERPROFILE").map_err(|e| e.to_string())?
    } else {
        std::env::var("HOME").map_err(|e| e.to_string())?
    };

    let hermes_dir = std::path::PathBuf::from(&home_dir).join(".hermes");
    let config_path = hermes_dir.join("config.yaml");

    if !config_path.exists() {
        return Ok(());
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config.yaml: {}", e))?;

    let mut did_default = false;
    let mut did_provider = false;
    let mut did_base_url = false;

    let patched: Vec<String> = content
        .lines()
        .map(|line| {
            let trimmed = line.trim();
            if !did_default && trimmed.starts_with("default:") {
                did_default = true;
                return replace_yaml_scalar_value(line, "anthropic/claude-opus-4.6");
            }
            if !did_provider && trimmed.starts_with("provider:") {
                did_provider = true;
                return replace_yaml_scalar_value(line, "auto");
            }
            if !did_base_url && trimmed.starts_with("base_url:") {
                did_base_url = true;
                return replace_yaml_scalar_value(line, "https://openrouter.ai/api/v1");
            }
            line.to_string()
        })
        .collect();

    let after_model_patch = patched.join("\n");

    // Remove only our entry from custom_providers (preserves user's other providers)
    let after_cp = remove_atomic_provider(&after_model_patch);

    let final_content = if content.ends_with('\n') && !after_cp.ends_with('\n') {
        format!("{}\n", after_cp)
    } else {
        after_cp
    };

    std::fs::write(&config_path, &final_content)
        .map_err(|e| format!("Failed to write config.yaml: {}", e))?;

    // Remove NO_PROXY lines from .env
    let env_path = hermes_dir.join(".env");
    if env_path.exists() {
        let env_content = std::fs::read_to_string(&env_path)
            .map_err(|e| format!("Failed to read .env: {}", e))?;
        let cleaned: String = env_content
            .lines()
            .filter(|line| {
                let trimmed = line.trim();
                !trimmed.starts_with("NO_PROXY=") && !trimmed.starts_with("no_proxy=")
            })
            .collect::<Vec<_>>()
            .join("\n");
        let cleaned = if cleaned.ends_with('\n') {
            cleaned
        } else {
            format!("{}\n", cleaned)
        };
        std::fs::write(&env_path, cleaned)
            .map_err(|e| format!("Failed to write .env: {}", e))?;
    }

    log::info!("Hermes Agent config reset to defaults");
    Ok(())
}

/// Replace the scalar value of a `key: value` YAML line, preserving the leading
/// indentation and the key. Handles both quoted (`key: "old"`) and bare
/// (`key: old`) values; the new value is written unquoted to match Hermes'
/// default config style (model ids, providers, and URLs are all valid plain
/// scalars). Lines without a `:` separator are returned unchanged.
fn replace_yaml_scalar_value(line: &str, new_value: &str) -> String {
    match line.find(':') {
        Some(colon) => format!("{} {}", &line[..=colon], new_value),
        None => line.to_string(),
    }
}

const ATOMIC_PROVIDER_NAME: &str = "atomic-chat";

/// Default per-request timeout (seconds) seeded for Hermes' `custom` provider.
/// Hermes otherwise defaults to 1800s (`HERMES_API_TIMEOUT`); a tighter cap
/// lets a wedged local turn fail fast without waiting half an hour.
const HERMES_REQUEST_TIMEOUT_SECONDS: u32 = 180;

/// Minimal Hermes `config.yaml` skeleton seeded when none exists yet.
///
/// The installer is spawned with `-SkipSetup`/`--skip-setup`, which skips the
/// interactive wizard that would otherwise create `~/.hermes/config.yaml`. On
/// Windows the install script writes no config at all, so `configure_*` had
/// nothing to patch. This skeleton carries exactly the anchors the patch logic
/// expects (`default`/`provider`/`base_url` model keys + `custom_providers`);
/// `configure_hermes_agent` then rewrites them to point at the local server.
/// Values mirror the Hermes defaults restored by `clear_hermes_agent_config`.
const HERMES_DEFAULT_CONFIG: &str = "model:
  default: anthropic/claude-opus-4.6
  provider: auto
  base_url: https://openrouter.ai/api/v1
custom_providers: []
";

/// Split the config into (before, entries, after) around `custom_providers:`.
/// `entries` is a Vec of Vec<String>, one per YAML list item.
fn split_custom_providers(content: &str) -> (Vec<String>, Vec<Vec<String>>, Vec<String>) {
    let mut before: Vec<String> = Vec::new();
    let mut block_lines: Vec<String> = Vec::new();
    let mut after: Vec<String> = Vec::new();

    #[derive(PartialEq)]
    enum Phase { Before, InBlock, After }
    let mut phase = Phase::Before;

    for line in content.lines() {
        match phase {
            Phase::Before => {
                let t = line.trim();
                if t == "custom_providers:"
                    || t == "custom_providers: []"
                    || t == "custom_providers:[]"
                {
                    phase = if t.contains("[]") { Phase::After } else { Phase::InBlock };
                } else {
                    before.push(line.to_string());
                }
            }
            Phase::InBlock => {
                let first = line.chars().next();
                match first {
                    None | Some(' ') | Some('\t') | Some('-') => {
                        block_lines.push(line.to_string());
                    }
                    _ => {
                        phase = Phase::After;
                        after.push(line.to_string());
                    }
                }
            }
            Phase::After => {
                after.push(line.to_string());
            }
        }
    }

    let mut entries: Vec<Vec<String>> = Vec::new();
    let mut current: Vec<String> = Vec::new();

    for line in &block_lines {
        if line.starts_with("- ") {
            if !current.is_empty() {
                entries.push(std::mem::take(&mut current));
            }
        }
        if !line.trim().is_empty() {
            current.push(line.clone());
        }
    }
    if !current.is_empty() {
        entries.push(current);
    }

    (before, entries, after)
}

fn entry_is_ours(entry: &[String]) -> bool {
    entry.iter().any(|l| {
        let t = l.trim();
        let name_val = if t.starts_with("- name:") {
            t.trim_start_matches("- name:").trim()
        } else if t.starts_with("name:") {
            t.trim_start_matches("name:").trim()
        } else {
            return false;
        };
        name_val == ATOMIC_PROVIDER_NAME
            || name_val == format!("\"{}\"", ATOMIC_PROVIDER_NAME)
    })
}

fn rebuild_custom_providers(
    before: &[String],
    entries: &[Vec<String>],
    after: &[String],
) -> String {
    let mut result: Vec<String> = before.to_vec();

    while result.last().map_or(false, |l| l.trim().is_empty()) {
        result.pop();
    }

    if entries.is_empty() {
        result.push("custom_providers: []".to_string());
    } else {
        result.push("custom_providers:".to_string());
        for entry in entries {
            for line in entry {
                result.push(line.clone());
            }
        }
    }

    for line in after {
        result.push(line.clone());
    }

    let out = result.join("\n");
    if out.ends_with('\n') { out } else { format!("{}\n", out) }
}

/// Add or update only the `atomic-chat` entry in `custom_providers`,
/// leaving all other user entries (Telegram, WhatsApp, etc.) intact.
fn upsert_atomic_provider(
    content: &str,
    api_url: &str,
    model: &str,
    context_length: u32,
) -> String {
    let (before, mut entries, after) = split_custom_providers(content);

    entries.retain(|e| !entry_is_ours(e));

    entries.push(vec![
        format!("- name: {}", ATOMIC_PROVIDER_NAME),
        format!("  base_url: {}", api_url),
        format!("  model: {}", model),
        "  models:".to_string(),
        format!("    {}:", model),
        format!("      context_length: {}", context_length),
    ]);

    rebuild_custom_providers(&before, &entries, &after)
}

/// Remove only the `atomic-chat` entry from `custom_providers`,
/// leaving all other user entries intact.
fn remove_atomic_provider(content: &str) -> String {
    let (before, mut entries, after) = split_custom_providers(content);
    entries.retain(|e| !entry_is_ours(e));
    rebuild_custom_providers(&before, &entries, &after)
}

/// Return true for a YAML line that begins a top-level (column-0) mapping key,
/// i.e. not indented, not a list item, not a comment, not blank.
fn is_top_level_yaml_key(line: &str) -> bool {
    match line.chars().next() {
        Some(c) => c != ' ' && c != '\t' && c != '-' && c != '#',
        None => false,
    }
}

/// Ensure `providers.<provider_id>.request_timeout_seconds: <seconds>` exists in
/// the Hermes config, creating the `providers:` map and the provider sub-block
/// as needed. A value the user has already set under that provider is left
/// untouched (we only fill the gap, never clobber).
fn upsert_provider_request_timeout(content: &str, provider_id: &str, seconds: u32) -> String {
    let mut lines: Vec<String> = content.lines().map(|s| s.to_string()).collect();

    let prov_key_line = format!("  {}:", provider_id);
    let field_line = format!("    request_timeout_seconds: {}", seconds);

    // Locate a top-level `providers:` mapping (also tolerate an empty `{}` form).
    let providers_idx = lines.iter().position(|l| {
        let t = l.trim_end();
        is_top_level_yaml_key(l)
            && (t == "providers:" || t == "providers: {}" || t == "providers:{}")
    });

    match providers_idx {
        None => {
            while lines.last().map_or(false, |l| l.trim().is_empty()) {
                lines.pop();
            }
            lines.push("providers:".to_string());
            lines.push(prov_key_line);
            lines.push(field_line);
        }
        Some(pidx) => {
            if lines[pidx].trim_end() != "providers:" {
                lines[pidx] = "providers:".to_string();
            }

            // Extent of the providers block: until the next top-level key.
            let mut block_end = lines.len();
            for i in (pidx + 1)..lines.len() {
                if is_top_level_yaml_key(&lines[i]) {
                    block_end = i;
                    break;
                }
            }

            // Find the provider sub-key at 2-space indent.
            let prov_idx =
                (pidx + 1..block_end).find(|&i| lines[i].trim_end() == prov_key_line);

            match prov_idx {
                None => {
                    lines.insert(pidx + 1, field_line);
                    lines.insert(pidx + 1, prov_key_line);
                }
                Some(pk) => {
                    // Extent of this provider's sub-block: until the next key at
                    // indent <= 2 (a sibling provider) or the block end.
                    let mut sub_end = block_end;
                    for i in (pk + 1)..block_end {
                        let l = &lines[i];
                        if l.trim().is_empty() {
                            continue;
                        }
                        let indent = l.len() - l.trim_start().len();
                        if indent <= 2 {
                            sub_end = i;
                            break;
                        }
                    }
                    let has_field = (pk + 1..sub_end).any(|i| {
                        lines[i].trim_start().starts_with("request_timeout_seconds:")
                    });
                    if !has_field {
                        lines.insert(pk + 1, field_line);
                    }
                }
            }
        }
    }

    let out = lines.join("\n");
    if out.ends_with('\n') {
        out
    } else {
        format!("{}\n", out)
    }
}

// ---------------------------------------------------------------------------
// External coding-agent / assistant integrations (Launch page)
// ---------------------------------------------------------------------------

const ATOMIC_MANAGED_BEGIN: &str = "# >>> Atomic Chat (managed) >>>";
const ATOMIC_MANAGED_END: &str = "# <<< Atomic Chat (managed) <<<";

/// Resolve the user's home directory in a platform-aware way.
fn agent_home_dir() -> Result<String, String> {
    if cfg!(windows) {
        std::env::var("USERPROFILE").map_err(|e| e.to_string())
    } else {
        std::env::var("HOME").map_err(|e| e.to_string())
    }
}

/// Remove every previously written `# >>> Atomic Chat (managed) >>> ... <<<`
/// block. Some agents (e.g. Codex) need two managed regions — a root-level
/// activation key at the very top of the file and a tables block at the
/// bottom — so this strips them all, not just the first.
fn strip_atomic_managed_block(content: &str) -> String {
    let mut result = content.to_string();
    while let (Some(start), Some(end)) = (
        result.find(ATOMIC_MANAGED_BEGIN),
        result.find(ATOMIC_MANAGED_END),
    ) {
        if end < start {
            break;
        }
        let end_idx = end + ATOMIC_MANAGED_END.len();
        let mut next = String::with_capacity(result.len());
        next.push_str(&result[..start]);
        next.push_str(&result[end_idx..]);
        result = next;
    }
    result
}

/// Installer spec for an agent: (program, args, prerequisite_binary, docs_url).
/// Verified against each vendor's official install path:
///   - Claude Code / Codex / OpenCode / OpenClaw ship as global npm packages.
///   - Hermes is a Python project installed via its official shell / PowerShell
///     bootstrap script (NOT npm).
fn agent_install_spec(
    agent_id: &str,
) -> Result<(String, Vec<String>, &'static str, &'static str), String> {
    let npm = |pkg: &str| {
        if cfg!(windows) {
            // On Windows `npm` is `npm.cmd` (a batch shim). Rust's
            // `std::process::Command` spawns via `CreateProcessW`, which only
            // resolves `.exe` on PATH and refuses to execute `.cmd`/`.bat`
            // directly (rust-lang/rust#37519). Route through `cmd.exe` so the
            // shim is found and run.
            (
                "cmd".to_string(),
                vec![
                    "/C".to_string(),
                    "npm".to_string(),
                    "install".to_string(),
                    "-g".to_string(),
                    pkg.to_string(),
                ],
            )
        } else {
            (
                "npm".to_string(),
                vec!["install".to_string(), "-g".to_string(), pkg.to_string()],
            )
        }
    };

    match agent_id {
        "claude-code" => {
            let (p, a) = npm("@anthropic-ai/claude-code");
            Ok((p, a, "npm", "https://docs.anthropic.com/en/docs/claude-code"))
        }
        "codex" => {
            let (p, a) = npm("@openai/codex");
            Ok((p, a, "npm", "https://github.com/openai/codex"))
        }
        "opencode" => {
            let (p, a) = npm("opencode-ai");
            Ok((p, a, "npm", "https://opencode.ai"))
        }
        "cline" => {
            let (p, a) = npm("cline");
            Ok((p, a, "npm", "https://docs.cline.bot/cline-cli/getting-started"))
        }
        "mimo" => {
            let (p, a) = npm("@mimo-ai/cli");
            Ok((p, a, "npm", "https://mimo.xiaomi.com/mimocode/"))
        }
        "droid" => {
            let (p, a) = npm("droid");
            Ok((
                p,
                a,
                "npm",
                "https://docs.factory.ai/cli/getting-started/quickstart",
            ))
        }
        "copilot" => {
            let (p, a) = npm("@github/copilot");
            Ok((
                p,
                a,
                "npm",
                "https://docs.github.com/en/copilot/how-tos/copilot-cli",
            ))
        }
        "openclaw" => {
            let (p, a) = npm("openclaw");
            Ok((p, a, "npm", "https://docs.openclaw.ai"))
        }
        "pi" => {
            let (p, a) = npm("@earendil-works/pi-coding-agent");
            Ok((p, a, "npm", "https://github.com/earendil-works/pi"))
        }
        "kilo" => {
            let (p, a) = npm("@kilocode/cli");
            Ok((p, a, "npm", "https://kilo.ai/docs"))
        }
        "openhands" => {
            // The CLI ships in the `openhands` pip package (NOT `openhands-ai`,
            // which is the SDK with no executable). `uv tool install` puts the
            // `openhands` binary on PATH; `--python 3.12` pins a supported
            // interpreter.
            Ok((
                "uv".to_string(),
                vec![
                    "tool".to_string(),
                    "install".to_string(),
                    "openhands".to_string(),
                    "--python".to_string(),
                    "3.12".to_string(),
                ],
                "uv",
                "https://docs.openhands.dev/openhands/usage/cli/installation",
            ))
        }
        "goose" => {
            // Block ships Goose via an official shell / PowerShell bootstrap
            // script (NOT npm). `CONFIGURE=false` skips the post-install
            // interactive setup wizard — we write the agent's config ourselves
            // via `configure_goose`, so the wizard is redundant and would hang
            // reading from the console (/dev/tty on Unix) when spawned from the
            // app. Both bootstrap scripts honor the `CONFIGURE` env var, so the
            // Windows path seeds `$env:CONFIGURE='false'` before `iex`.
            let (program, args): (String, Vec<String>) = if cfg!(windows) {
                (
                    "powershell".to_string(),
                    vec![
                        "-NoProfile".to_string(),
                        "-Command".to_string(),
                        "$env:CONFIGURE='false'; irm https://github.com/block/goose/releases/download/stable/download_cli.ps1 | iex".to_string(),
                    ],
                )
            } else {
                (
                    "sh".to_string(),
                    vec![
                        "-c".to_string(),
                        "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash".to_string(),
                    ],
                )
            };
            let prereq = if cfg!(windows) { "powershell" } else { "curl" };
            Ok((program, args, prereq, "https://block.github.io/goose/"))
        }
        "hermes" => {
            // `--skip-setup`/`-SkipSetup` skips the post-install interactive
            // setup wizard, and `--non-interactive`/`-NonInteractive` makes any
            // remaining prompt fall back to its default. Without these the
            // installer's wizard reads from /dev/tty and hangs forever when we
            // spawn it from the app — we write the agent's config ourselves via
            // `configure_hermes_agent`, so the wizard is redundant here.
            let (program, args): (String, Vec<String>) = if cfg!(windows) {
                (
                    "powershell".to_string(),
                    vec![
                        "-NoProfile".to_string(),
                        "-Command".to_string(),
                        "iex \"& { $(irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1) } -SkipSetup -NonInteractive\"".to_string(),
                    ],
                )
            } else {
                (
                    "sh".to_string(),
                    vec![
                        "-c".to_string(),
                        "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup --non-interactive".to_string(),
                    ],
                )
            };
            let prereq = if cfg!(windows) { "powershell" } else { "curl" };
            Ok((program, args, prereq, "https://github.com/NousResearch/hermes-agent"))
        }
        "zed" => {
            // Zed ships its own installer (NOT npm). On macOS/Linux the official
            // shell script downloads the editor and drops a `zed` CLI shim on
            // PATH (`~/.local/bin`). On Windows it's distributed via winget.
            if cfg!(windows) {
                Ok((
                    "winget".to_string(),
                    vec![
                        "install".to_string(),
                        "--id".to_string(),
                        "Zed.Zed".to_string(),
                        "-e".to_string(),
                        "--accept-package-agreements".to_string(),
                        "--accept-source-agreements".to_string(),
                    ],
                    "winget",
                    "https://zed.dev/docs/windows",
                ))
            } else {
                Ok((
                    "sh".to_string(),
                    vec![
                        "-c".to_string(),
                        "curl -fsSL https://zed.dev/install.sh | sh".to_string(),
                    ],
                    "curl",
                    "https://zed.dev/docs/getting-started",
                ))
            }
        }
        other => Err(format!("Unknown or non-installable agent id: {}", other)),
    }
}

/// Resolve the user's interactive login-shell PATH.
///
/// A GUI app launched from Finder/Dock inherits the minimal launchd PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), which excludes Homebrew
/// (`/opt/homebrew/bin`), nvm, Volta, etc. — so `npm`/`node` and the agent
/// binaries can't be found even when they are installed. Querying the login
/// shell recovers the real PATH the user sees in their terminal. The result is
/// cached for the process lifetime (one shell spawn, not one per probe).
///
/// A sentinel wraps the value so rc files that echo to stdout don't corrupt it.
/// Returns `None` on probe failure; callers then fall back to the inherited PATH.
#[cfg(not(windows))]
fn login_shell_path() -> Option<String> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            // `-l` sources login files (.zprofile/.bash_profile, where Homebrew
            // shellenv usually lives); `-i` sources interactive rc files
            // (.zshrc/.bashrc, where nvm usually lives).
            let out = std::process::Command::new(&shell)
                .args(["-lic", "printf '__OCPATH__%s__OCEND__' \"$PATH\""])
                .output()
                .ok()?;
            if !out.status.success() {
                return None;
            }
            let s = String::from_utf8_lossy(&out.stdout);
            let start = s.find("__OCPATH__")? + "__OCPATH__".len();
            let end = s[start..].find("__OCEND__")? + start;
            let path = s[start..end].trim().to_string();
            if path.is_empty() {
                None
            } else {
                Some(path)
            }
        })
        .clone()
}

/// Augment a spawned command's PATH with the user's login-shell PATH so GUI
/// builds can find user-installed tools (`npm`/`node`, agent binaries). No-op
/// on Windows, where processes inherit the registry (user/system) PATH.
#[cfg(not(windows))]
fn apply_login_path(cmd: &mut std::process::Command) {
    if let Some(path) = login_shell_path() {
        cmd.env("PATH", path);
    }
}

#[cfg(windows)]
fn apply_login_path(_cmd: &mut std::process::Command) {}

/// Re-read the persisted Windows PATH (User + Machine) from the registry and
/// merge it with the live process PATH. The GUI snapshots PATH once at startup
/// via `fix_path_env::fix()`, so a Node/npm installed after launch is invisible
/// to spawned subprocesses until restart; reading the registry here recovers it.
/// Returns the merged, de-duplicated PATH, or None if the registry read failed.
#[cfg(windows)]
fn refresh_windows_path() -> Option<String> {
    use std::process::Command;

    fn read_scope(scope: &str) -> Option<String> {
        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-Command",
            &format!("[Environment]::GetEnvironmentVariable('Path', '{}')", scope),
        ]);
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let out = cmd.output().ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }

    let user = read_scope("User");
    let machine = read_scope("Machine");

    // The npm global prefix on Windows defaults to %APPDATA%\npm, where global
    // shims (claude.cmd, codex.cmd, opencode.cmd, ...) installed via `npm i -g`
    // live. A fresh Node/npm install adds this to the *user* PATH, but a running
    // GUI may have snapshotted PATH before that entry was broadcast (and `install_agent`
    // installs into exactly this dir). Include it explicitly so npm-based agents
    // resolve from any spawned process even when the registry PATH lacks it.
    let npm_global = std::env::var("APPDATA")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|appdata| format!("{}\\npm", appdata.trim_end_matches('\\')));

    if user.is_none() && machine.is_none() && npm_global.is_none() {
        return None;
    }

    let live = std::env::var("PATH").unwrap_or_default();
    let mut merged: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for chunk in [
        machine.as_deref(),
        user.as_deref(),
        npm_global.as_deref(),
        Some(live.as_str()),
    ]
    .into_iter()
    .flatten()
    {
        for part in chunk.split(';').map(str::trim).filter(|p| !p.is_empty()) {
            let key = part.to_lowercase();
            if seen.insert(key) {
                merged.push(part.to_string());
            }
        }
    }
    if merged.is_empty() {
        None
    } else {
        Some(merged.join(";"))
    }
}

/// Apply the freshly-read registry PATH to a spawned command (Windows only).
/// No-op off Windows or when the registry read fails (the inherited PATH stands).
#[cfg(windows)]
fn apply_runtime_path(cmd: &mut std::process::Command) {
    if let Some(path) = refresh_windows_path() {
        cmd.env("PATH", path);
    }
}

#[cfg(not(windows))]
fn apply_runtime_path(_cmd: &mut std::process::Command) {}

/// Decode bytes captured from a spawned process into a String. On Windows,
/// `cmd.exe` emits its own diagnostics (e.g. "... is not recognized as an
/// internal or external command") in the console OEM codepage (cp866 on a
/// Russian install), NOT UTF-8 — decoding those as UTF-8 yields mojibake.
/// Node-based CLIs like Cline already emit UTF-8, so try UTF-8 first and only
/// fall back to the OEM codepage when the bytes are not valid UTF-8.
#[cfg(windows)]
fn decode_console_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            decode_oem(bytes).unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned())
        }
    }
}

/// Decode a byte buffer using the current Windows OEM codepage.
#[cfg(windows)]
fn decode_oem(bytes: &[u8]) -> Option<String> {
    use windows_sys::Win32::Globalization::{GetOEMCP, MultiByteToWideChar};
    if bytes.is_empty() {
        return Some(String::new());
    }
    let cp = unsafe { GetOEMCP() };
    let len = bytes.len() as i32;
    // First pass: required wide-char count.
    let needed =
        unsafe { MultiByteToWideChar(cp, 0, bytes.as_ptr(), len, std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return None;
    }
    let mut buf: Vec<u16> = vec![0; needed as usize];
    let written =
        unsafe { MultiByteToWideChar(cp, 0, bytes.as_ptr(), len, buf.as_mut_ptr(), needed) };
    if written <= 0 {
        return None;
    }
    buf.truncate(written as usize);
    Some(String::from_utf16_lossy(&buf))
}

#[cfg(not(windows))]
fn decode_console_bytes(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Proxy details forwarded from the app's in-app proxy config so that spawned
/// agent installers/terminals can reach the network when the user is behind a
/// region block. Mirrors the frontend `useProxyConfig` store fields we need.
#[derive(serde::Deserialize, Clone)]
pub struct ProxyEnv {
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub no_proxy: Option<String>,
}

/// Inject basic-auth credentials into a proxy URL when both are present and the
/// URL does not already carry credentials. Returns the URL unchanged otherwise.
fn proxy_url_with_auth(url: &str, username: Option<&str>, password: Option<&str>) -> String {
    let user = match username.map(str::trim).filter(|u| !u.is_empty()) {
        Some(u) => u,
        None => return url.to_string(),
    };
    // Only splice credentials into a scheme://host URL that has no `@` already.
    if let Some(scheme_end) = url.find("://") {
        let (scheme, rest) = url.split_at(scheme_end + 3);
        if rest.contains('@') {
            return url.to_string();
        }
        let pass = password.unwrap_or("");
        return format!("{}{}:{}@{}", scheme, user, pass, rest);
    }
    url.to_string()
}

/// Apply the app proxy to a spawned command's environment so child installers
/// (`uv`/`curl`/npm/PowerShell) can reach the network. Sets the common
/// HTTP/HTTPS/ALL_PROXY variables (upper- and lower-case) plus NO_PROXY, always
/// keeping loopback in NO_PROXY so the local server stays reachable.
///
/// Best-effort: `uv`/`curl` honor `ALL_PROXY`/SOCKS; npm and PowerShell
/// `Invoke-RestMethod` largely ignore SOCKS env (handled by clearer messaging).
fn apply_proxy_env(cmd: &mut std::process::Command, proxy: &ProxyEnv) {
    let url = proxy.url.trim();
    if url.is_empty() {
        return;
    }
    let full = proxy_url_with_auth(
        url,
        proxy.username.as_deref(),
        proxy.password.as_deref(),
    );

    for key in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] {
        cmd.env(key, &full);
    }

    let mut no_proxy = proxy
        .no_proxy
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("")
        .to_string();
    for loopback in ["localhost", "127.0.0.1", "::1"] {
        if !no_proxy
            .split(',')
            .any(|p| p.trim().eq_ignore_ascii_case(loopback))
        {
            if !no_proxy.is_empty() {
                no_proxy.push(',');
            }
            no_proxy.push_str(loopback);
        }
    }
    cmd.env("NO_PROXY", &no_proxy);
    cmd.env("no_proxy", &no_proxy);
}

/// Detect a DNS/tunnel failure signature in installer output so we can append an
/// actionable proxy hint to the surfaced error.
fn output_indicates_network_failure(output: &str) -> bool {
    let lower = output.to_lowercase();
    [
        "os error 11001",
        "dns error",
        "tunnel error",
        "wsahost_not_found",
        "failed to lookup address",
        "could not resolve host",
        "getaddrinfo",
        "temporary failure in name resolution",
        "network is unreachable",
        "etimedout",
        "econnrefused",
    ]
    .iter()
    .any(|sig| lower.contains(sig))
}

/// Result of probing whether an external CLI agent is reachable.
#[derive(serde::Serialize)]
pub struct AgentDetection {
    /// Whether the binary was found (native PATH, WSL, or a user-supplied path).
    pub installed: bool,
    /// True only when the binary was found inside a WSL distribution (Windows),
    /// where it is reachable via `wsl.exe` but not from the native Win32 PATH.
    pub via_wsl: bool,
}

/// Probe whether a CLI binary is reachable on the native PATH (`which`/`where`).
async fn detect_on_native_path(bin: &str) -> bool {
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    let mut cmd = std::process::Command::new(which_cmd);
    cmd.arg(bin);
    apply_login_path(&mut cmd);
    // On Windows, re-read the registry PATH so a tool installed after the app
    // launched is found without a restart. No-op elsewhere.
    apply_runtime_path(&mut cmd);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    matches!(
        tokio::task::spawn_blocking(move || cmd.output()).await,
        Ok(Ok(out))
            if out.status.success()
                && !String::from_utf8_lossy(&out.stdout).trim().is_empty()
    )
}

/// Probe whether a CLI binary is reachable inside a WSL distribution.
///
/// Many CLI agents are installed inside WSL (they want a bash environment), so
/// the native `where.exe` PATH lookup misses them. We run the lookup through a
/// login shell (`sh -lc`) so the user's WSL `PATH` (e.g. `~/.local/bin`,
/// npm-global) is in scope. Returns false when WSL is absent or the lookup
/// fails. The agent binary names come from a fixed catalog, so there is no
/// shell-injection surface here.
#[cfg(windows)]
async fn detect_via_wsl(bin: &str) -> bool {
    use std::os::windows::process::CommandExt;
    let probe = format!("command -v {}", bin);
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.arg("-e").arg("sh").arg("-lc").arg(&probe);
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    matches!(
        tokio::task::spawn_blocking(move || cmd.output()).await,
        Ok(Ok(out))
            if out.status.success()
                && !String::from_utf8_lossy(&out.stdout).trim().is_empty()
    )
}

/// Probe whether an external CLI agent is reachable.
///
/// Resolution order:
/// 1. `custom_path` (authoritative when provided) — a user-supplied path,
///    reported installed iff the file exists. This is the manual override that
///    lets users fix a wrong "Not installed" status for non-standard installs.
/// 2. native PATH lookup (`which` / `where`).
/// 3. (Windows only) a WSL fallback so agents installed inside a WSL
///    distribution are detected instead of showing as missing.
#[tauri::command]
pub async fn detect_agent_installed(
    bin: String,
    custom_path: Option<String>,
) -> AgentDetection {
    if let Some(path) = custom_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        return AgentDetection {
            installed: std::path::Path::new(path).is_file(),
            via_wsl: false,
        };
    }

    if detect_on_native_path(&bin).await {
        return AgentDetection {
            installed: true,
            via_wsl: false,
        };
    }

    #[cfg(windows)]
    {
        if detect_via_wsl(&bin).await {
            return AgentDetection {
                installed: true,
                via_wsl: true,
            };
        }
    }

    AgentDetection {
        installed: false,
        via_wsl: false,
    }
}

/// Attempt to install Node.js (which bundles npm) for the user via the Windows
/// Package Manager (`winget`), so npm-based Launch-page agents install on a
/// fresh machine without the user leaving the app. Streams winget output to the
/// same `agent_install_log:<id>` event the agent installer uses.
///
/// Returns `true` only when, after the attempt, `npm` resolves on the
/// freshly-refreshed PATH. Gracefully returns `false` (the caller then surfaces
/// the actionable "install Node.js from nodejs.org" error) when winget is
/// absent (e.g. Windows LTSC / older builds), the install fails, or npm still
/// isn't found. Windows-only; a no-op returning `false` on other platforms.
#[cfg(windows)]
async fn try_bootstrap_npm_via_winget<R: Runtime>(
    app_handle: &AppHandle<R>,
    event: &str,
    proxy: Option<ProxyEnv>,
) -> bool {
    // winget itself (App Installer) must be present; it ships on Win10 1809+
    // mainline but not on LTSC / Server / stripped images.
    if !detect_agent_installed("winget".to_string(), None)
        .await
        .installed
    {
        let _ = app_handle.emit(
            event,
            "npm not found and winget is unavailable - cannot auto-install Node.js.".to_string(),
        );
        return false;
    }

    let _ = app_handle.emit(
        event,
        "npm not found. Installing Node.js LTS via winget...".to_string(),
    );

    let app = app_handle.clone();
    let ev = event.to_string();
    let ran = tokio::task::spawn_blocking(move || -> bool {
        use std::io::{BufRead, BufReader};
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};

        let mut cmd = Command::new("winget");
        cmd.args([
            "install",
            "--id",
            "OpenJS.NodeJS.LTS",
            "-e",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        apply_runtime_path(&mut cmd);
        if let Some(ref proxy) = proxy {
            apply_proxy_env(&mut cmd, proxy);
        }
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = app.emit(&ev, format!("Failed to spawn winget: {}", e));
                return false;
            }
        };
        if let Some(stdout) = child.stdout.take() {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = app.emit(&ev, line);
            }
        }
        if let Some(stderr) = child.stderr.take() {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = app.emit(&ev, line);
            }
        }
        matches!(child.wait(), Ok(s) if s.success())
    })
    .await
    .unwrap_or(false);

    if !ran {
        let _ = app_handle.emit(
            event,
            "Node.js installation via winget did not complete successfully.".to_string(),
        );
        return false;
    }

    // winget adds the Node install dir to PATH; `detect_agent_installed`
    // re-reads the registry PATH at runtime, so npm is found without a restart.
    detect_agent_installed("npm".to_string(), None)
        .await
        .installed
}

#[cfg(not(windows))]
async fn try_bootstrap_npm_via_winget<R: Runtime>(
    _app_handle: &AppHandle<R>,
    _event: &str,
    _proxy: Option<ProxyEnv>,
) -> bool {
    false
}

/// Install an external agent by spawning its official installer, streaming
/// stdout/stderr to the UI via the `agent_install_log:<agent_id>` event.
#[tauri::command]
pub async fn install_agent<R: Runtime>(
    app_handle: AppHandle<R>,
    agent_id: String,
    proxy: Option<ProxyEnv>,
) -> Result<(), String> {
    let (program, args, prereq, docs) = agent_install_spec(&agent_id)?;

    let event = format!("agent_install_log:{}", agent_id);

    // `detect_on_native_path` re-reads the registry PATH at runtime on Windows
    // so a Node/npm installed after the app launched (or present in the registry
    // but not the GUI's snapshotted PATH) is found without an app restart.
    if !detect_agent_installed(prereq.to_string(), None)
        .await
        .installed
    {
        // For npm-based agents on Windows, try to auto-install Node.js (which
        // bundles npm) via winget before giving up, so the Launch flow works on
        // a fresh machine. Falls back to the actionable error when winget is
        // unavailable or the install fails.
        let bootstrapped = prereq == "npm"
            && try_bootstrap_npm_via_winget(&app_handle, &event, proxy.clone()).await;
        if !bootstrapped {
            return Err(format!(
                "'{}' is required to install this agent but was not found on PATH. \
                 Install it (Node.js from https://nodejs.org for npm-based agents), \
                 then restart Atomic Chat and try again: {}",
                prereq, docs
            ));
        }
    }

    let agent_id_log = agent_id.clone();

    let (success, captured) =
        tokio::task::spawn_blocking(move || -> Result<(bool, String), String> {
            use std::io::{BufRead, BufReader};
            use std::process::{Command, Stdio};

            let mut cmd = Command::new(&program);
            cmd.args(&args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            // Find `npm`/`curl`/`powershell` even when launched from Finder/Dock
            // with a minimal PATH (macOS/Linux); no-op on Windows.
            apply_login_path(&mut cmd);
            // On Windows, augment with the freshly-read registry PATH.
            apply_runtime_path(&mut cmd);
            // Forward the app proxy so the installer can reach the network when
            // the user is behind a region block.
            if let Some(ref proxy) = proxy {
                apply_proxy_env(&mut cmd, proxy);
            }

            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }

            let mut child = cmd
                .spawn()
                .map_err(|e| format!("Failed to spawn '{}': {}", program, e))?;

            // Accumulate output (bounded) so we can classify network failures.
            let mut captured = String::new();
            if let Some(stdout) = child.stdout.take() {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if captured.len() < 16_384 {
                        captured.push_str(&line);
                        captured.push('\n');
                    }
                    let _ = app_handle.emit(&event, line);
                }
            }
            if let Some(stderr) = child.stderr.take() {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    if captured.len() < 16_384 {
                        captured.push_str(&line);
                        captured.push('\n');
                    }
                    let _ = app_handle.emit(&event, line);
                }
            }

            let status = child.wait().map_err(|e| e.to_string())?;
            Ok((status.success(), captured))
        })
        .await
        .map_err(|e| e.to_string())??;

    if success {
        log::info!("Agent '{}' installed successfully", agent_id_log);
        Ok(())
    } else if output_indicates_network_failure(&captured) {
        Err(format!(
            "The installer for '{}' could not reach the network (DNS/connection \
             failure). If you are behind a region block, configure a proxy in \
             Settings -> HTTPS Proxy and try again. Note: SOCKS proxies may not \
             work for npm/PowerShell-based installers - prefer an HTTP/HTTPS \
             proxy for these. See the install log for details.",
            agent_id_log
        ))
    } else {
        Err(format!(
            "The installer for '{}' exited with a non-zero status. See the install log for details.",
            agent_id_log
        ))
    }
}

/// Escape a value for use inside a TOML basic string (delimited by `"`).
///
/// TOML basic strings treat `\` as the escape character, so any literal
/// backslash must be written as `\\`, and any embedded `"` as `\"`. This
/// avoids invalid TOML when model ids or URLs contain Windows path separators.
fn toml_basic_string_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Configure Codex CLI by upserting a managed block in `~/.codex/config.toml`.
#[tauri::command]
pub fn configure_codex(
    api_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<(), String> {
    let home = agent_home_dir()?;
    let dir = PathBuf::from(&home).join(".codex");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create ~/.codex: {}", e))?;
    let path = dir.join("config.toml");

    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let cleaned = strip_atomic_managed_block(&existing);

    // Codex 0.135+ removed the legacy root-level `profile` selector (named
    // profiles now live in separate `~/.codex/<name>.config.toml` files chosen
    // via `--profile`) and dropped `wire_api = "chat"` entirely. So we make
    // Atomic the *default* provider via the root keys `model` / `model_provider`
    // — bare TOML keys that must precede any `[table]`, hence a top region —
    // plus the `[model_providers.atomic]` table below. `wire_api` is left at
    // its default (`responses`), the only wire API Codex still supports.
    // `strip_atomic_managed_block` removes both regions on rerun.
    let mut head = String::new();
    head.push_str(ATOMIC_MANAGED_BEGIN);
    head.push('\n');
    head.push_str(&format!(
        "model = \"{}\"\n",
        toml_basic_string_escape(&model)
    ));
    head.push_str("model_provider = \"atomic\"\n");
    head.push_str(ATOMIC_MANAGED_END);
    head.push('\n');

    let mut block = String::new();
    block.push_str(ATOMIC_MANAGED_BEGIN);
    block.push('\n');
    block.push_str("[model_providers.atomic]\n");
    block.push_str("name = \"Atomic Chat\"\n");
    block.push_str(&format!(
        "base_url = \"{}\"\n",
        toml_basic_string_escape(&api_url)
    ));
    if api_key.as_deref().filter(|k| !k.is_empty()).is_some() {
        // Codex reads the secret from the env var named here, not inline.
        block.push_str("env_key = \"ATOMIC_CHAT_API_KEY\"\n");
    }
    block.push_str(ATOMIC_MANAGED_END);
    block.push('\n');

    let final_content = if cleaned.trim().is_empty() {
        format!("{}\n{}", head, block)
    } else {
        format!("{}\n{}\n{}", head, cleaned.trim_end(), block)
    };

    std::fs::write(&path, final_content)
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    log::info!("Codex configured: base_url={}, model={}", api_url, model);
    Ok(())
}

/// Configure OpenCode by upserting `provider.atomic` in
/// `~/.config/opencode/opencode.json` (strict JSON, other providers preserved).
#[tauri::command]
pub fn configure_opencode(
    api_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<(), String> {
    let home = agent_home_dir()?;
    let dir = PathBuf::from(&home).join(".config").join("opencode");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create ~/.config/opencode: {}", e))?;
    let path = dir.join("opencode.json");

    let mut root: serde_json::Value = if path.exists() {
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if text.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&text).map_err(|e| {
                format!(
                    "Could not parse {}: {}. Fix or remove the file and try again.",
                    path.display(),
                    e
                )
            })?
        }
    } else {
        serde_json::json!({})
    };

    let obj = root
        .as_object_mut()
        .ok_or_else(|| "opencode.json is not a JSON object".to_string())?;
    obj.entry("$schema")
        .or_insert_with(|| serde_json::json!("https://opencode.ai/config.json"));

    let provider = obj
        .entry("provider")
        .or_insert_with(|| serde_json::json!({}));
    if !provider.is_object() {
        *provider = serde_json::json!({});
    }

    let key_val = api_key.as_deref().filter(|k| !k.is_empty()).unwrap_or("atomic");
    let mut models = serde_json::Map::new();
    models.insert(model.clone(), serde_json::json!({ "name": model }));

    provider.as_object_mut().unwrap().insert(
        "atomic".to_string(),
        serde_json::json!({
            "npm": "@ai-sdk/openai-compatible",
            "name": "Atomic Chat",
            "options": { "baseURL": api_url, "apiKey": key_val },
            "models": serde_json::Value::Object(models),
        }),
    );

    // Select Atomic as the active default model so OpenCode opens on it without
    // a manual `/models` pick. Format is `<providerId>/<modelId>`. Pressing Run
    // is an explicit "use this", so we overwrite any prior selection.
    obj.insert(
        "model".to_string(),
        serde_json::json!(format!("atomic/{}", model)),
    );

    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty + "\n")
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    log::info!("OpenCode configured: baseURL={}, model={}", api_url, model);
    Ok(())
}

/// Configure MiMo Code by upserting `provider.atomic` in
/// `~/.config/mimocode/mimocode.json` (strict JSON, other providers preserved).
/// MiMo Code is a fork of OpenCode, so its config system is OpenCode's
/// field-for-field; only the paths and `$schema` differ.
#[tauri::command]
pub fn configure_mimo(
    api_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<(), String> {
    let home = agent_home_dir()?;
    let dir = PathBuf::from(&home).join(".config").join("mimocode");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create ~/.config/mimocode: {}", e))?;
    let path = dir.join("mimocode.json");

    let mut root: serde_json::Value = if path.exists() {
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if text.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&text).map_err(|e| {
                format!(
                    "Could not parse {}: {}. Fix or remove the file and try again.",
                    path.display(),
                    e
                )
            })?
        }
    } else {
        serde_json::json!({})
    };

    let obj = root
        .as_object_mut()
        .ok_or_else(|| "mimocode.json is not a JSON object".to_string())?;
    obj.entry("$schema")
        .or_insert_with(|| serde_json::json!("https://mimo.xiaomi.com/config.json"));

    let provider = obj
        .entry("provider")
        .or_insert_with(|| serde_json::json!({}));
    if !provider.is_object() {
        *provider = serde_json::json!({});
    }

    let key_val = api_key.as_deref().filter(|k| !k.is_empty()).unwrap_or("atomic");
    let mut models = serde_json::Map::new();
    models.insert(model.clone(), serde_json::json!({ "name": model }));

    provider.as_object_mut().unwrap().insert(
        "atomic".to_string(),
        serde_json::json!({
            "npm": "@ai-sdk/openai-compatible",
            "name": "Atomic Chat",
            "options": { "baseURL": api_url, "apiKey": key_val },
            "models": serde_json::Value::Object(models),
        }),
    );

    // Select Atomic as the active default model so MiMo Code opens on it without
    // a manual `/models` pick. Format is `<providerId>/<modelId>`. Pressing Run
    // is an explicit "use this", so we overwrite any prior selection.
    obj.insert(
        "model".to_string(),
        serde_json::json!(format!("atomic/{}", model)),
    );

    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty + "\n")
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    log::info!("MiMo Code configured: baseURL={}, model={}", api_url, model);
    Ok(())
}

/// Configure Factory.ai Droid by upserting our entry in the `customModels`
/// array of `~/.factory/settings.json` (strict JSON, other models preserved).
/// Droid speaks OpenAI Chat Completions via `generic-chat-completion-api`, so
/// `api_url` carries the `/v1` suffix.
#[tauri::command]
pub fn configure_droid(
    api_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<(), String> {
    const DISPLAY_NAME: &str = "Atomic Chat";

    let home = agent_home_dir()?;
    let dir = PathBuf::from(&home).join(".factory");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create ~/.factory: {}", e))?;
    let path = dir.join("settings.json");

    let mut root: serde_json::Value = if path.exists() {
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if text.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&text).map_err(|e| {
                format!(
                    "Could not parse {}: {}. Fix or remove the file and try again.",
                    path.display(),
                    e
                )
            })?
        }
    } else {
        serde_json::json!({})
    };

    let obj = root
        .as_object_mut()
        .ok_or_else(|| "settings.json is not a JSON object".to_string())?;

    let custom_models = obj
        .entry("customModels")
        .or_insert_with(|| serde_json::json!([]));
    if !custom_models.is_array() {
        *custom_models = serde_json::json!([]);
    }
    let arr = custom_models.as_array_mut().unwrap();

    // Droid rejects an empty apiKey, so use a non-empty placeholder when the
    // local server runs without a key.
    let key_val = api_key
        .as_deref()
        .filter(|k| !k.is_empty())
        .unwrap_or("atomic");

    let entry = serde_json::json!({
        "model": model,
        "displayName": DISPLAY_NAME,
        "baseUrl": api_url,
        "apiKey": key_val,
        "provider": "generic-chat-completion-api",
        "maxOutputTokens": 16384
    });

    // Upsert by displayName (our managed marker); preserve any other models.
    let idx = arr
        .iter()
        .position(|m| m.get("displayName").and_then(|v| v.as_str()) == Some(DISPLAY_NAME));
    let idx = match idx {
        Some(i) => {
            arr[i] = entry;
            i
        }
        None => {
            arr.push(entry);
            arr.len() - 1
        }
    };

    // Select our model as the default so the session opens on it without a
    // manual `/model` pick. Droid's custom selector is
    // `custom:<displayName with spaces->dashes>-<index>`.
    let selector = format!("custom:{}-{}", DISPLAY_NAME.replace(' ', "-"), idx);
    obj.insert("model".to_string(), serde_json::json!(selector));

    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty + "\n")
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    log::info!(
        "Droid configured: baseUrl={}, model={}, selector={}",
        api_url,
        model,
        selector
    );
    Ok(())
}

/// Display name (and provider id) of the custom provider we register in Zed.
const ZED_PROVIDER_ID: &str = "Atomic Chat";

/// Configure Zed by upserting a custom OpenAI-compatible provider named
/// "Atomic Chat" under `language_models.openai_compatible` in
/// `~/.config/zed/settings.json`, and (when a model is running) selecting it as
/// the agent's default model.
///
/// We deliberately use Zed's built-in `openai_compatible` mechanism rather than
/// the native `atomic_chat` provider: `openai_compatible` ships in every stock
/// Zed release, so the integration works without building a custom Zed. The
/// tradeoff is that stock Zed can't auto-discover models (we list the running
/// one) and marks the provider "authenticated" only once a key is present — so
/// we also seed the `ATOMIC_CHAT_API_KEY` env var on launch (see `launch_zed`).
///
/// Zed reads `settings.json` as JSONC (comments, trailing commas), so we parse
/// leniently with json5 and re-serialize as strict JSON — any comments are
/// dropped on write, every other setting is preserved.
#[tauri::command]
pub fn configure_zed(
    api_url: String,
    model: Option<String>,
    // Accepted for call-site symmetry with the other agents. Zed reads the
    // provider key from its keychain / the ATOMIC_CHAT_API_KEY env var, not
    // from settings.json, so we don't persist it here.
    api_key: Option<String>,
) -> Result<(), String> {
    let _ = api_key;
    let home = agent_home_dir()?;
    let dir = PathBuf::from(&home).join(".config").join("zed");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create ~/.config/zed: {}", e))?;
    let path = dir.join("settings.json");

    let mut root: serde_json::Value = if path.exists() {
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if text.trim().is_empty() {
            serde_json::json!({})
        } else {
            json5::from_str(&text).map_err(|e| {
                format!(
                    "Could not parse {}: {}. Fix the reported location and try again.",
                    path.display(),
                    e
                )
            })?
        }
    } else {
        serde_json::json!({})
    };

    let obj = root
        .as_object_mut()
        .ok_or_else(|| "settings.json is not a JSON object".to_string())?;

    // Navigate/create language_models.openai_compatible, preserving any other
    // providers the user has configured.
    let language_models = obj
        .entry("language_models")
        .or_insert_with(|| serde_json::json!({}));
    if !language_models.is_object() {
        *language_models = serde_json::json!({});
    }
    let compatible = language_models
        .as_object_mut()
        .unwrap()
        .entry("openai_compatible")
        .or_insert_with(|| serde_json::json!({}));
    if !compatible.is_object() {
        *compatible = serde_json::json!({});
    }

    // Stock Zed has no model auto-discovery for openai_compatible providers, so
    // we advertise the currently-running model. If none is running we still
    // register the provider (empty model list) so it appears in Zed's UI.
    let mut available_models = Vec::new();
    if let Some(model) = model.as_deref().filter(|m| !m.is_empty()) {
        available_models.push(serde_json::json!({
            "name": model,
            "display_name": model,
            "max_tokens": 32768,
            "max_output_tokens": 8192,
            "capabilities": {
                "tools": true,
                "images": true,
                "parallel_tool_calls": false,
                "prompt_cache_key": false
            }
        }));
    }

    compatible.as_object_mut().unwrap().insert(
        ZED_PROVIDER_ID.to_string(),
        serde_json::json!({
            "api_url": api_url,
            "available_models": available_models,
        }),
    );

    // Select our model as the agent's default so Zed opens on it without a
    // manual pick. For openai_compatible providers the provider id is the map
    // key we just used (ZED_PROVIDER_ID).
    if let Some(model) = model.as_deref().filter(|m| !m.is_empty()) {
        let agent = obj.entry("agent").or_insert_with(|| serde_json::json!({}));
        if !agent.is_object() {
            *agent = serde_json::json!({});
        }
        agent.as_object_mut().unwrap().insert(
            "default_model".to_string(),
            serde_json::json!({ "provider": ZED_PROVIDER_ID, "model": model }),
        );
    }

    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty + "\n")
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    log::info!("Zed configured: api_url={}, model={:?}", api_url, model);
    Ok(())
}

/// Launch the Zed editor GUI.
///
/// Unlike the CLI agents we spawn in a terminal, Zed is a desktop editor whose
/// agent lives in its own window, so we start the app directly. Prefer the
/// `zed` CLI (resolved against the user's login-shell PATH so GUI builds find
/// the `~/.local/bin` shim the installer drops); on macOS fall back to
/// `open -a Zed` when the CLI shim isn't present.
///
/// We seed `ATOMIC_CHAT_API_KEY` so the custom openai_compatible provider is
/// authenticated without the user pasting a key: stock Zed reads the provider
/// key from the `<PROVIDER_ID>_API_KEY` env var and treats any non-empty value
/// as authenticated, which is all a keyless local server needs. This only takes
/// effect on a cold start (the CLI inherits our env); if Zed is already
/// running, the key entered once in its UI persists in the keychain anyway.
#[tauri::command]
pub fn launch_zed() -> Result<(), String> {
    // Non-empty placeholder: the local server is keyless, but Zed needs *some*
    // key present to consider the provider authenticated.
    const KEY_ENV: &str = "ATOMIC_CHAT_API_KEY";
    const KEY_PLACEHOLDER: &str = "atomic";

    let mut cmd = std::process::Command::new("zed");
    apply_login_path(&mut cmd);
    cmd.env(KEY_ENV, KEY_PLACEHOLDER);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    if cmd.spawn().is_ok() {
        log::info!("Launched Zed via `zed` CLI");
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-a", "Zed"])
            .env(KEY_ENV, KEY_PLACEHOLDER)
            .spawn()
            .map_err(|e| format!("Failed to launch Zed: {}", e))?;
        log::info!("Launched Zed via `open -a Zed`");
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("Could not launch Zed. Is it installed and on your PATH?".to_string())
}

/// Configure OpenClaw by upserting `models.providers.atomic` plus the
/// `agents.defaults.models` allowlist entry in `~/.openclaw/openclaw.json`.
#[tauri::command]
pub fn configure_openclaw(
    api_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<(), String> {
    let home = agent_home_dir()?;
    let config_path = std::env::var("OPENCLAW_CONFIG_PATH")
        .ok()
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(&home).join(".openclaw").join("openclaw.json")
        });

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }

    // OpenClaw reads this file as JSON5 (comments, unquoted keys, trailing
    // commas), so we must parse with the same leniency or we reject configs
    // OpenClaw happily accepts (ATO-87). json5 deserializes into the same
    // serde_json::Value, and we always re-serialize as strict JSON on write,
    // which normalizes (and silently drops comments from) the file.
    let mut root: serde_json::Value = if config_path.exists() {
        let text = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
        if text.trim().is_empty() {
            serde_json::json!({})
        } else {
            json5::from_str(&text).map_err(|e| {
                format!(
                    "Could not parse {}: {}. Fix the reported location and try again.",
                    config_path.display(),
                    e
                )
            })?
        }
    } else {
        serde_json::json!({})
    };

    let obj = root
        .as_object_mut()
        .ok_or_else(|| "openclaw.json is not a JSON object".to_string())?;

    let model_ref = format!("atomic/{}", model);
    let key_val = api_key.as_deref().filter(|k| !k.is_empty()).unwrap_or("atomic");

    let models = obj.entry("models").or_insert_with(|| serde_json::json!({}));
    let models_obj = models
        .as_object_mut()
        .ok_or_else(|| "models is not a JSON object".to_string())?;
    models_obj
        .entry("mode")
        .or_insert_with(|| serde_json::json!("merge"));
    let providers = models_obj
        .entry("providers")
        .or_insert_with(|| serde_json::json!({}));
    let providers_obj = providers
        .as_object_mut()
        .ok_or_else(|| "models.providers is not a JSON object".to_string())?;
    // The catalog entry's `id` is the bare model id our /v1 server reports;
    // OpenClaw builds the model ref as `<providerId>/<id>` (= `model_ref`), so
    // prefixing here would double it to `atomic/atomic/...` and break lookup.
    providers_obj.insert(
        "atomic".to_string(),
        serde_json::json!({
            "baseUrl": api_url,
            "apiKey": key_val,
            "api": "openai-completions",
            "models": [ { "id": model, "name": model } ],
        }),
    );

    // OpenClaw's local gateway (ws://127.0.0.1:18789) refuses to open its
    // websocket without connection auth. For our loopback-only setup, seed
    // "none" (private-ingress open auth) so the agent is reachable with no
    // token/password. Preserve any auth mode the user set deliberately.
    let gateway = obj
        .entry("gateway")
        .or_insert_with(|| serde_json::json!({}));
    let gateway_obj = gateway
        .as_object_mut()
        .ok_or_else(|| "gateway is not a JSON object".to_string())?;
    // `openclaw gateway` only starts when gateway.mode is "local"; the TUI also
    // needs this to treat the loopback gateway as locally managed. Seed it
    // (preserving an explicit "remote" the user may have configured).
    gateway_obj
        .entry("mode")
        .or_insert_with(|| serde_json::json!("local"));
    let auth = gateway_obj
        .entry("auth")
        .or_insert_with(|| serde_json::json!({}));
    let auth_obj = auth
        .as_object_mut()
        .ok_or_else(|| "gateway.auth is not a JSON object".to_string())?;
    auth_obj
        .entry("mode")
        .or_insert_with(|| serde_json::json!("none"));

    let agents = obj.entry("agents").or_insert_with(|| serde_json::json!({}));
    let agents_obj = agents
        .as_object_mut()
        .ok_or_else(|| "agents is not a JSON object".to_string())?;
    let defaults = agents_obj
        .entry("defaults")
        .or_insert_with(|| serde_json::json!({}));
    let defaults_obj = defaults
        .as_object_mut()
        .ok_or_else(|| "agents.defaults is not a JSON object".to_string())?;
    // Small local models can exceed OpenClaw's short default request timeout
    // once wrapped in the agent system prompt + tools. Seed a generous default
    // (preserving any value the user already set).
    defaults_obj
        .entry("timeoutSeconds")
        .or_insert_with(|| serde_json::json!(240));
    // Point the agent at our model via `model.primary` (object form; current
    // OpenClaw rejects a plain string). Preserve sibling `model.*` keys and heal
    // a stale string written by older builds. Run is explicit "use this", so we
    // overwrite primary to keep it synced with the active model.
    let model_entry = defaults_obj
        .entry("model")
        .or_insert_with(|| serde_json::json!({}));
    if !model_entry.is_object() {
        *model_entry = serde_json::json!({});
    }
    model_entry["primary"] = serde_json::json!(model_ref.clone());
    let allow = defaults_obj
        .entry("models")
        .or_insert_with(|| serde_json::json!({}));
    let allow_obj = allow
        .as_object_mut()
        .ok_or_else(|| "agents.defaults.models is not a JSON object".to_string())?;
    allow_obj
        .entry(model_ref)
        .or_insert_with(|| serde_json::json!({}));

    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, pretty + "\n")
        .map_err(|e| format!("Failed to write {}: {}", config_path.display(), e))?;
    log::info!("OpenClaw configured: baseUrl={}, model={}", api_url, model);
    Ok(())
}

/// Configure Claude Code by upserting `~/.claude/settings.json` so it points at
/// the local Atomic Chat server and uses the active model. Values go into the
/// `env` block — Claude reads it at startup regardless of how `claude` was
/// launched, and `ANTHROPIC_MODEL` there overrides any stale top-level `model`.
/// All other user settings are preserved.
#[tauri::command]
pub fn configure_claude_code(
    api_url: String,
    model: Option<String>,
    api_key: Option<String>,
) -> Result<(), String> {
    let home = agent_home_dir()?;
    let dir = PathBuf::from(&home).join(".claude");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create ~/.claude: {}", e))?;
    let path = dir.join("settings.json");

    let mut root: serde_json::Value = if path.exists() {
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if text.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&text).map_err(|e| {
                format!(
                    "Could not parse {}: {}. Fix or remove the file and try again.",
                    path.display(),
                    e
                )
            })?
        }
    } else {
        serde_json::json!({})
    };

    let obj = root
        .as_object_mut()
        .ok_or_else(|| "settings.json is not a JSON object".to_string())?;

    let key_val = api_key
        .as_deref()
        .filter(|k| !k.is_empty())
        .unwrap_or("atomic");

    let env = obj.entry("env").or_insert_with(|| serde_json::json!({}));
    if !env.is_object() {
        *env = serde_json::json!({});
    }
    let env_obj = env.as_object_mut().unwrap();
    // Claude Code appends its own `/v1`, so `api_url` here is the bare host:port.
    env_obj.insert(
        "ANTHROPIC_BASE_URL".to_string(),
        serde_json::json!(api_url),
    );
    env_obj.insert(
        "ANTHROPIC_AUTH_TOKEN".to_string(),
        serde_json::json!(key_val),
    );

    if let Some(model) = model.as_deref().filter(|m| !m.is_empty()) {
        // ANTHROPIC_MODEL overrides the `model` setting; the tier aliases make
        // every Opus/Sonnet/Haiku request route to the single local model too.
        env_obj.insert("ANTHROPIC_MODEL".to_string(), serde_json::json!(model));
        env_obj.insert(
            "ANTHROPIC_DEFAULT_OPUS_MODEL".to_string(),
            serde_json::json!(model),
        );
        env_obj.insert(
            "ANTHROPIC_DEFAULT_SONNET_MODEL".to_string(),
            serde_json::json!(model),
        );
        env_obj.insert(
            "ANTHROPIC_DEFAULT_HAIKU_MODEL".to_string(),
            serde_json::json!(model),
        );
        obj.insert("model".to_string(), serde_json::json!(model));
    }

    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty + "\n")
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    log::info!(
        "Claude Code configured: base_url={}, model={:?}",
        api_url,
        model
    );
    Ok(())
}

/// Upsert a marked `export KEY='VALUE'` block into a shell rc file. Removes any
/// previous block carrying the same `marker` plus stray `export <prefix>...`
/// lines, then appends a fresh block. Generalizes `write_env_to_shell` (which is
/// hardcoded to the legacy Jan / Claude Code marker) for Atomic-branded agents.
fn write_marked_env_to_shell(
    env_file_path: &str,
    marker: &str,
    export_prefix: &str,
    env_vars: &[(String, String)],
) -> Result<(), String> {
    let new_entries: String = env_vars
        .iter()
        .map(|(k, v)| format!("export {}='{}'\n", k, v))
        .collect();

    let existing_content = std::fs::read_to_string(env_file_path).unwrap_or_default();

    // Block-based removal first: drop everything between (and including) the
    // paired marker lines. This is what makes rerun idempotent even when the
    // managed block contains env vars whose names do NOT share `export_prefix`
    // (e.g. Goose writes `OPENAI_*` lines alongside `GOOSE_*`). A user's own
    // unrelated exports outside the block are preserved untouched.
    let mut in_block = false;
    let export_line = format!("export {}", export_prefix);
    let cleaned: Vec<&str> = existing_content
        .split('\n')
        .filter(|line| {
            if line.starts_with(marker) {
                // Toggle on the opening marker, off after the closing marker.
                in_block = !in_block;
                return false;
            }
            if in_block {
                return false;
            }
            // Safety net for any stray, prefix-matching managed lines that
            // leaked outside a block (e.g. from an older write format).
            !line.starts_with(export_line.as_str())
        })
        .collect();

    let new_block = format!("{}\n{}\n{}\n", marker, new_entries, marker);
    let final_content = cleaned.join("\n") + &new_block;
    std::fs::write(env_file_path, &final_content).map_err(|e| e.to_string())?;
    Ok(())
}

/// Configure GitHub Copilot CLI to use the local Atomic Chat server via its BYOK
/// environment variables. Copilot has no provider config file — it reads these
/// from the environment at launch — so we persist them to the user's shell rc
/// (Windows: `setx`). The auto-opened terminal then sources them. `COPILOT_OFFLINE`
/// is on so no GitHub sign-in is required and traffic stays on the local provider.
#[tauri::command]
pub fn configure_copilot(
    api_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<(), String> {
    let mut env_vars: Vec<(String, String)> = Vec::with_capacity(5);
    env_vars.push(("COPILOT_PROVIDER_BASE_URL".to_string(), api_url.clone()));
    env_vars.push(("COPILOT_PROVIDER_TYPE".to_string(), "openai".to_string()));
    env_vars.push(("COPILOT_MODEL".to_string(), model.clone()));
    env_vars.push(("COPILOT_OFFLINE".to_string(), "true".to_string()));
    if let Some(key) = api_key.as_deref().filter(|k| !k.is_empty()) {
        env_vars.push((
            "COPILOT_PROVIDER_API_KEY".to_string(),
            key.to_string(),
        ));
    }

    const MARKER: &str = "# Atomic Chat - Copilot CLI Config";

    if cfg!(target_os = "windows") {
        for (key, value) in &env_vars {
            let output = std::process::Command::new("setx")
                .arg(key)
                .arg(value)
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Failed to set env var {}: {}", key, stderr));
            }
        }
        log::info!(
            "Copilot configured (Windows env): base_url={}, model={}",
            api_url,
            model
        );
        return Ok(());
    }

    let home = agent_home_dir()?;
    let is_macos = cfg!(target_os = "macos");
    let (_shell, env_file_path) = detect_shell_env_file(&home, is_macos);
    write_marked_env_to_shell(&env_file_path, MARKER, "COPILOT_", &env_vars)?;
    log::info!(
        "Copilot configured: base_url={}, model={}, rc={}",
        api_url,
        model,
        env_file_path
    );
    Ok(())
}

/// Configure Pi by upserting the `atomic` provider in `~/.pi/agent/models.json`
/// and pointing `~/.pi/agent/settings.json` at it (both strict JSON, all other
/// providers / keys preserved). Pi speaks OpenAI Chat Completions, so `api_url`
/// carries the `/v1` suffix.
#[tauri::command]
pub fn configure_pi(
    api_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<(), String> {
    let home = agent_home_dir()?;
    let dir = PathBuf::from(&home).join(".pi").join("agent");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create ~/.pi/agent: {}", e))?;

    let key_val = api_key
        .as_deref()
        .filter(|k| !k.is_empty())
        .unwrap_or("atomic");

    // --- models.json: upsert providers.atomic (preserve other providers) ---
    let models_path = dir.join("models.json");
    let mut models_root: serde_json::Value = if models_path.exists() {
        let text = std::fs::read_to_string(&models_path).map_err(|e| e.to_string())?;
        if text.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&text).map_err(|e| {
                format!(
                    "Could not parse {}: {}. Fix or remove the file and try again.",
                    models_path.display(),
                    e
                )
            })?
        }
    } else {
        serde_json::json!({})
    };

    let models_obj = models_root
        .as_object_mut()
        .ok_or_else(|| "models.json is not a JSON object".to_string())?;
    let providers = models_obj
        .entry("providers")
        .or_insert_with(|| serde_json::json!({}));
    if !providers.is_object() {
        *providers = serde_json::json!({});
    }
    providers.as_object_mut().unwrap().insert(
        "atomic".to_string(),
        serde_json::json!({
            "api": "openai-completions",
            "apiKey": key_val,
            "baseUrl": api_url,
            "models": [ { "id": model } ],
        }),
    );

    let pretty = serde_json::to_string_pretty(&models_root).map_err(|e| e.to_string())?;
    std::fs::write(&models_path, pretty + "\n")
        .map_err(|e| format!("Failed to write {}: {}", models_path.display(), e))?;

    // --- settings.json: point defaultProvider/defaultModel at us (preserve keys) ---
    let settings_path = dir.join("settings.json");
    let mut settings_root: serde_json::Value = if settings_path.exists() {
        let text = std::fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        if text.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&text).map_err(|e| {
                format!(
                    "Could not parse {}: {}. Fix or remove the file and try again.",
                    settings_path.display(),
                    e
                )
            })?
        }
    } else {
        serde_json::json!({})
    };

    let settings_obj = settings_root
        .as_object_mut()
        .ok_or_else(|| "settings.json is not a JSON object".to_string())?;
    settings_obj.insert("defaultProvider".to_string(), serde_json::json!("atomic"));
    settings_obj.insert("defaultModel".to_string(), serde_json::json!(model));

    let pretty = serde_json::to_string_pretty(&settings_root).map_err(|e| e.to_string())?;
    std::fs::write(&settings_path, pretty + "\n")
        .map_err(|e| format!("Failed to write {}: {}", settings_path.display(), e))?;

    log::info!("Pi configured: baseUrl={}, model={}", api_url, model);
    Ok(())
}

/// Configure Goose via its BYOK environment variables. Goose has no provider
/// config file we patch here — it reads `GOOSE_PROVIDER` / `GOOSE_MODEL` plus
/// the OpenAI host vars from the environment — so we persist them to the user's
/// shell rc (Windows: `setx`). Goose appends its own path, so `OPENAI_HOST` is
/// the bare host:port (`endpointWithPrefix` is false) and `OPENAI_BASE_PATH`
/// carries the chat-completions path.
#[tauri::command]
pub fn configure_goose(
    api_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<(), String> {
    let key_val = api_key
        .as_deref()
        .filter(|k| !k.is_empty())
        .unwrap_or("atomic");

    let mut env_vars: Vec<(String, String)> = Vec::with_capacity(5);
    env_vars.push(("GOOSE_PROVIDER".to_string(), "openai".to_string()));
    env_vars.push(("GOOSE_MODEL".to_string(), model.clone()));
    env_vars.push(("OPENAI_HOST".to_string(), api_url.clone()));
    env_vars.push((
        "OPENAI_BASE_PATH".to_string(),
        "v1/chat/completions".to_string(),
    ));
    env_vars.push(("OPENAI_API_KEY".to_string(), key_val.to_string()));

    const MARKER: &str = "# Atomic Chat - Goose Config";

    if cfg!(target_os = "windows") {
        for (key, value) in &env_vars {
            let output = std::process::Command::new("setx")
                .arg(key)
                .arg(value)
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Failed to set env var {}: {}", key, stderr));
            }
        }
        log::info!(
            "Goose configured (Windows env): host={}, model={}",
            api_url,
            model
        );
        return Ok(());
    }

    let home = agent_home_dir()?;
    let is_macos = cfg!(target_os = "macos");
    let (_shell, env_file_path) = detect_shell_env_file(&home, is_macos);
    // `write_marked_env_to_shell` removes the entire region between the paired
    // marker lines on rerun, so the managed `OPENAI_*` vars written inside the
    // block (which do not share the `GOOSE_` prefix) are cleaned together with
    // the `GOOSE_*` vars. A user's own unrelated `OPENAI_*` exports living
    // outside the block are preserved. The `GOOSE_` prefix is kept as a safety
    // net for any stray managed lines that leaked outside a block.
    write_marked_env_to_shell(&env_file_path, MARKER, "GOOSE_", &env_vars)?;
    log::info!(
        "Goose configured: host={}, model={}, rc={}",
        api_url,
        model,
        env_file_path
    );
    Ok(())
}

/// Configure OpenHands via its BYOK environment variables. The CLI reads env
/// overrides only when launched with `--override-with-envs`, using `LLM_API_KEY`
/// / `LLM_BASE_URL` / `LLM_MODEL`. We persist them to the user's shell rc
/// (Windows: `setx`). The litellm `openai/` prefix on the model id is required
/// for a custom OpenAI-compatible base_url; `LLM_BASE_URL` carries the `/v1`
/// suffix (`endpointWithPrefix` is true).
#[tauri::command]
pub fn configure_openhands(
    api_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<(), String> {
    let key_val = api_key
        .as_deref()
        .filter(|k| !k.is_empty())
        .unwrap_or("atomic");

    let mut env_vars: Vec<(String, String)> = Vec::with_capacity(3);
    env_vars.push(("LLM_MODEL".to_string(), format!("openai/{}", model)));
    env_vars.push(("LLM_BASE_URL".to_string(), api_url.clone()));
    env_vars.push(("LLM_API_KEY".to_string(), key_val.to_string()));

    const MARKER: &str = "# Atomic Chat - OpenHands Config";

    if cfg!(target_os = "windows") {
        for (key, value) in &env_vars {
            let output = std::process::Command::new("setx")
                .arg(key)
                .arg(value)
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("Failed to set env var {}: {}", key, stderr));
            }
        }
        log::info!(
            "OpenHands configured (Windows env): base_url={}, model={}",
            api_url,
            model
        );
        return Ok(());
    }

    let home = agent_home_dir()?;
    let is_macos = cfg!(target_os = "macos");
    let (_shell, env_file_path) = detect_shell_env_file(&home, is_macos);
    write_marked_env_to_shell(&env_file_path, MARKER, "LLM_", &env_vars)?;
    log::info!(
        "OpenHands configured: base_url={}, model={}, rc={}",
        api_url,
        model,
        env_file_path
    );
    Ok(())
}

/// Configure KiloCode by upserting the `atomic` provider in
/// `~/.config/kilo/kilo.jsonc` and selecting our model (other providers
/// preserved). The file is JSONC (comments / trailing commas), so we parse it
/// with json5 — the same leniency KiloCode applies — and re-serialize as strict
/// JSON on write. KiloCode speaks OpenAI Chat Completions, so `api_url` carries
/// the `/v1` suffix.
#[tauri::command]
pub fn configure_kilo(
    api_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<(), String> {
    let home = agent_home_dir()?;
    let dir = PathBuf::from(&home).join(".config").join("kilo");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create ~/.config/kilo: {}", e))?;
    let path = dir.join("kilo.jsonc");

    // kilo.jsonc is JSON5 (comments, unquoted keys, trailing commas), so we must
    // parse with the same leniency or we reject configs KiloCode happily accepts.
    // json5 deserializes into the same serde_json::Value, and we always
    // re-serialize as strict JSON on write (which drops any comments).
    let mut root: serde_json::Value = if path.exists() {
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if text.trim().is_empty() {
            serde_json::json!({})
        } else {
            json5::from_str(&text).map_err(|e| {
                format!(
                    "Could not parse {}: {}. Fix the reported location and try again.",
                    path.display(),
                    e
                )
            })?
        }
    } else {
        serde_json::json!({})
    };

    let obj = root
        .as_object_mut()
        .ok_or_else(|| "kilo.jsonc is not a JSON object".to_string())?;
    obj.entry("$schema")
        .or_insert_with(|| serde_json::json!("https://app.kilo.ai/config.json"));

    let key_val = api_key
        .as_deref()
        .filter(|k| !k.is_empty())
        .unwrap_or("atomic");

    let provider = obj
        .entry("provider")
        .or_insert_with(|| serde_json::json!({}));
    if !provider.is_object() {
        *provider = serde_json::json!({});
    }
    let mut models = serde_json::Map::new();
    models.insert(model.clone(), serde_json::json!({ "name": model }));
    provider.as_object_mut().unwrap().insert(
        "atomic".to_string(),
        serde_json::json!({
            "name": "Atomic Chat",
            "npm": "@ai-sdk/openai-compatible",
            "options": { "baseURL": api_url, "apiKey": key_val },
            "models": serde_json::Value::Object(models),
        }),
    );

    // Select Atomic as the active model so KiloCode opens on it without a manual
    // pick. Format is `<providerId>/<modelId>`. Run is explicit "use this", so
    // we overwrite any prior selection.
    obj.insert(
        "model".to_string(),
        serde_json::json!(format!("atomic/{}", model)),
    );

    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty + "\n")
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    log::info!("KiloCode configured: baseURL={}, model={}", api_url, model);
    Ok(())
}

/// Configure Cline CLI by RUNNING its official non-interactive setup command
/// (`cline auth ...`) rather than writing a config file. Cline has no clean
/// user-facing config file and no base-URL env var; its on-disk state
/// (`~/.cline/globalState.json`) is a brittle legacy format that must not be
/// hand-written. The `cline auth` path is exactly what `ollama launch cline`
/// invokes under the hood. `cline` is guaranteed on PATH by the time this runs
/// (handleRun installs the agent before configuring).
#[tauri::command]
pub fn configure_cline(
    api_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<(), String> {
    // Cline rejects an empty apikey (and an empty modelid; model is always set
    // because requiresModel is true), so fall back to a non-empty placeholder
    // when the local server runs without a key.
    let key_val = api_key
        .as_deref()
        .filter(|k| !k.is_empty())
        .unwrap_or("local");

    let auth_args = [
        "auth",
        "--provider",
        "openai-compatible",
        "--apikey",
        key_val,
        "--modelid",
        &model,
        "--baseurl",
        &api_url,
    ];

    // On Windows the npm-installed `cline` is a batch shim (`cline.cmd`). Rust's
    // `std::process::Command` spawns via `CreateProcessW`, which only resolves
    // `.exe` on PATH and refuses to execute `.cmd`/`.bat` directly
    // (rust-lang/rust#37519). Route through `cmd.exe` so the shim is found and
    // run — the same workaround the `npm()` helper uses. On macOS/Linux spawn
    // `cline` directly.
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/C").arg("cline").args(auth_args);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut cmd = std::process::Command::new("cline");
        cmd.args(auth_args);
        cmd
    };
    // Find the npm-installed `cline` even when launched from Finder/Dock with a
    // minimal PATH (macOS/Linux); no-op on Windows.
    apply_login_path(&mut cmd);
    // On Windows, augment with the freshly-read registry PATH so a `cline`
    // installed by npm earlier in this same session (after the GUI snapshotted
    // PATH at startup) is found without an app restart -- mirrors `install_agent`.
    apply_runtime_path(&mut cmd);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to spawn 'cline': {}", e))?;

    if !output.status.success() {
        // `cmd.exe`'s own errors arrive in the OEM codepage, not UTF-8, so decode
        // accordingly. Prefer stderr; fall back to stdout since the stream split
        // for `cline auth` is undocumented.
        let stderr = decode_console_bytes(&output.stderr);
        let detail = if stderr.trim().is_empty() {
            decode_console_bytes(&output.stdout).trim().to_string()
        } else {
            stderr.trim().to_string()
        };
        return Err(format!("`cline auth` failed: {}", detail));
    }

    log::info!("Cline configured: baseUrl={}, model={}", api_url, model);
    Ok(())
}

/// Open the OS terminal and run `command` interactively, so the user can start
/// using a just-configured agent in one click. The terminal stays open after
/// the command (it launches an interactive TUI agent like codex/claude).
#[tauri::command]
pub fn open_agent_terminal(
    command: String,
    proxy: Option<ProxyEnv>,
) -> Result<(), String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("Empty terminal command".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        // Escape for an AppleScript double-quoted string literal.
        let escaped = command.replace('\\', "\\\\").replace('"', "\\\"");
        let _ = &proxy;
        // When Terminal.app is *not* already running, `activate` opens a default
        // empty window and `do script` opens a second one — two windows. So we
        // branch: if it was already running, open a fresh window (don't hijack
        // an existing session); if it was cold, reuse the auto-opened window 1.
        let script = format!(
            "set wasRunning to application \"Terminal\" is running\n\
             tell application \"Terminal\"\n\
             activate\n\
             if wasRunning then\n\
             do script \"{cmd}\"\n\
             else\n\
             delay 0.2\n\
             do script \"{cmd}\" in window 1\n\
             end if\n\
             end tell",
            cmd = escaped
        );
        std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .spawn()
            .map_err(|e| format!("Failed to open Terminal: {}", e))?;
        log::info!("Opened Terminal with command: {}", command);
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        // `start "" cmd /K <cmd>` opens a fresh console that stays open so the
        // interactive agent keeps running. The empty "" is the window title arg.
        // The new console inherits this command's environment, so the proxy env
        // applied below reaches the interactive agent.
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "start", "", "cmd", "/K", &command]);
        // The launched console inherits this `cmd`'s environment, so refresh the
        // PATH from the registry (+ npm global prefix) here — otherwise a console
        // started from a GUI launched before Node/npm was installed inherits a
        // stale snapshot and can't find npm-installed agent shims (claude.cmd, ...).
        apply_runtime_path(&mut cmd);
        if let Some(ref proxy) = proxy {
            apply_proxy_env(&mut cmd, proxy);
        }
        cmd.spawn()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
        log::info!("Opened cmd with command: {}", command);
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // `exec $SHELL` keeps the window open after the agent exits.
        let inner = format!("{}; exec $SHELL", command);
        let candidates: &[(&str, &[&str])] = &[
            ("x-terminal-emulator", &["-e"]),
            ("gnome-terminal", &["--"]),
            ("konsole", &["-e"]),
            ("xfce4-terminal", &["-e"]),
            ("xterm", &["-e"]),
        ];
        for (term, pre) in candidates {
            let mut cmd = std::process::Command::new(term);
            cmd.args(*pre);
            cmd.args(["bash", "-lc", &inner]);
            // The emulator inherits this env; resolve the login-shell PATH so the
            // agent binary is found, then `bash -lc` sees PATH + proxy.
            apply_login_path(&mut cmd);
            apply_runtime_path(&mut cmd);
            if let Some(ref proxy) = proxy {
                apply_proxy_env(&mut cmd, proxy);
            }
            if cmd.spawn().is_ok() {
                log::info!("Opened {} with command: {}", term, command);
                return Ok(());
            }
        }
        return Err("No supported terminal emulator found".to_string());
    }

    #[allow(unreachable_code)]
    Ok(())
}

/// Launch a GUI editor for the "IDEs & Editors" integrations (VS Code,
/// JetBrains, Xcode).
///
/// Unlike the CLI coding agents, these editors have no writable provider config
/// — VS Code stores Copilot BYOK in secret storage, and JetBrains/Xcode keep
/// the provider in IDE settings — so this command only *opens* the editor. The
/// connection details still have to be pasted into the editor's own UI (the
/// card shows those manual steps and a "Copy settings" button).
///
/// Resolution order: try the editor's command-line launcher(s) on the user's
/// login-shell PATH first (so custom installs are respected), then fall back to
/// the macOS app launcher (`open -a`). Returns an error if nothing was found.
#[tauri::command]
pub fn launch_editor(editor_id: String) -> Result<(), String> {
    use std::process::{Command, Stdio};

    // Spawn a detached GUI process, returning whether it started. A missing
    // binary makes `spawn` fail, which is how we fall through to the next
    // candidate / the platform launcher.
    fn try_spawn(program: &str, args: &[&str]) -> bool {
        let mut cmd = Command::new(program);
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // Find user-installed launchers (`code`, `idea`, …) even when Atomic
        // Chat was started from Finder/Dock with a minimal PATH. No-op on Windows.
        apply_login_path(&mut cmd);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        cmd.spawn().is_ok()
    }

    // (CLI launchers to try in order, macOS .app name to fall back to).
    let (clis, mac_app): (&[&str], Option<&str>) = match editor_id.as_str() {
        "vscode" => (&["code"], Some("Visual Studio Code")),
        // JetBrains Toolbox installs a different launcher per IDE; try the
        // common ones so any installed JetBrains IDE opens.
        "jetbrains" => (
            &[
                "idea", "pycharm", "webstorm", "phpstorm", "rubymine", "clion",
                "goland", "rider", "datagrip", "rustrover",
            ],
            Some("IntelliJ IDEA"),
        ),
        // Xcode is macOS-only and ships no general-purpose launcher binary
        // (`xed` needs a file argument), so we open the app directly.
        "xcode" => (&[], Some("Xcode")),
        other => return Err(format!("Unknown editor: {}", other)),
    };

    for cli in clis {
        if try_spawn(cli, &[]) {
            log::info!("Launched editor '{}' via '{}'", editor_id, cli);
            return Ok(());
        }
    }

    #[cfg(target_os = "macos")]
    if let Some(app) = mac_app {
        if try_spawn("open", &["-a", app]) {
            log::info!("Launched editor '{}' via 'open -a {}'", editor_id, app);
            return Ok(());
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = mac_app;

    Err(format!(
        "Couldn't find {} on this system. Install it (or enable its command-line launcher) and try again.",
        editor_id
    ))
}

/// One-time macOS migration for the autostart launcher switch from
/// `MacosLauncher::LaunchAgent` to `MacosLauncher::AppleScript` (real Login
/// Item). The legacy launcher wrote `~/Library/LaunchAgents/{app_name}.plist`
/// (where `{app_name}` is `package_info().name`, the exact value the plugin
/// used). Detecting that plist tells us the user had launch-at-startup ON under
/// the old mechanism: we remove the stale plist (so it can't double-launch the
/// app on reboot or point at a stale binary path) and return `true`, so the
/// caller can re-register a proper Login Item via the AppleScript launcher. A
/// user who never enabled it / turned it off has no plist -> returns `false`
/// and the caller leaves autostart untouched, preserving the choice. No-op
/// (returns `false`) on non-macOS.
#[tauri::command]
pub fn migrate_macos_autostart_launchagent<R: Runtime>(
    #[allow(unused_variables)] app: AppHandle<R>,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let home = app
            .path()
            .home_dir()
            .map_err(|e| format!("Failed to resolve home directory: {e}"))?;
        let app_name = app.package_info().name.clone();
        let plist = home
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{app_name}.plist"));
        if !plist.exists() {
            return Ok(false);
        }
        // Best-effort: unload from the current launchd session so the stale
        // agent doesn't linger; ignore errors (it may not be loaded).
        let _ = std::process::Command::new("launchctl")
            .args(["unload", &plist.to_string_lossy()])
            .output();
        fs::remove_file(&plist)
            .map_err(|e| format!("Failed to remove legacy autostart plist: {e}"))?;
        log::info!(
            "Migrated legacy macOS autostart LaunchAgent plist: {}",
            plist.display()
        );
        Ok(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app;
        Ok(false)
    }
}
