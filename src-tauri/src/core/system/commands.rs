use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use super::agent_terminal::{AgentTerminalInfo, TerminalOutcome};
use crate::core::app::commands::{
    default_data_folder_path, get_app_configurations, get_jan_data_folder_path,
    update_app_configuration,
};
use crate::core::app::constants::{
    BACKEND_PRESERVING_PROVIDERS, JAN_DATA_FILES, JAN_DATA_SUBDIRS,
};
use crate::core::app::models::AppConfiguration;
use crate::core::mcp::helpers::{stop_mcp_servers_with_context, ShutdownContext};
use crate::core::process_env::sanitize_std_command;
#[cfg(any(target_os = "linux", test))]
use crate::core::process_env::{strip_appimage_std_command, APPIMAGE_RUNTIME_ENV_VARS};
use crate::core::state::AppState;

use super::json_key_backup;

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

/// Move each preserving provider's `backends` folder out of the data folder, into `aside`.
/// Returns what was moved, as (provider, where it is now).
fn set_backends_aside(
    data_folder: &std::path::Path,
    aside: &std::path::Path,
) -> Vec<(&'static str, std::path::PathBuf)> {
    let mut moved = Vec::new();
    for provider in BACKEND_PRESERVING_PROVIDERS {
        let backends = data_folder.join(provider).join("backends");
        if !backends.is_dir() {
            continue;
        }
        let parked = aside.join(format!("atomic-chat-backends-preserve-{provider}"));
        if parked.exists() {
            let _ = fs::remove_dir_all(&parked);
        }
        match fs::rename(&backends, &parked) {
            Ok(()) => {
                log::info!("Preserved {provider} backends to temp dir");
                moved.push((*provider, parked));
            }
            Err(e) => log::warn!("Failed to preserve {provider} backends: {e}"),
        }
    }
    moved
}

fn put_backends_back(
    data_folder: &std::path::Path,
    preserved: Vec<(&'static str, std::path::PathBuf)>,
) {
    for (provider, parked) in preserved {
        let provider_dir = data_folder.join(provider);
        let _ = fs::create_dir_all(&provider_dir);
        match fs::rename(&parked, provider_dir.join("backends")) {
            Ok(()) => log::info!("Restored {provider} backends after factory reset"),
            Err(e) => log::warn!("Failed to restore {provider} backends: {e}"),
        }
    }
}

/// The core's key to this scope's folder in Atomic Chat's WSL distribution, where TensorRT-LLM
/// models live on Windows (change `add-tensorrt-llm-windows`, core ruling 2.6). Inside
/// `atomic-core/`, which a reset clears; without the key the models stay on disk but the next core
/// no longer finds them, and the spec keeps them available across a reset.
const GUEST_SCOPE_FILE: &str = "atomic-core/managed-runtimes/guest-scope.json";

/// The key's bytes, read before a reset clears the data folder; `None` where there is none
/// (Linux, macOS, Windows before the distribution).
fn keep_guest_scope(data_folder: &std::path::Path) -> Option<Vec<u8>> {
    fs::read(data_folder.join(GUEST_SCOPE_FILE)).ok()
}

/// Write the kept key into the data folder the app uses after the reset.
fn put_guest_scope(data_folder: &std::path::Path, kept: Option<Vec<u8>>) {
    let Some(bytes) = kept else { return };
    let path = data_folder.join(GUEST_SCOPE_FILE);
    let written = path
        .parent()
        .map_or(Ok(()), fs::create_dir_all)
        .and_then(|()| fs::write(&path, bytes));
    match written {
        Ok(()) => log::info!("Kept the TensorRT-LLM models' scope key across the factory reset"),
        Err(e) => log::warn!("Failed to keep the TensorRT-LLM models' scope key: {e}"),
    }
}

/// Detect the user's default shell and return the appropriate env file path.
/// Returns (shell_name, env_file_path).
pub(crate) fn detect_shell_env_file(home_dir: &str, is_macos: bool) -> (&'static str, String) {
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

#[tauri::command]
pub async fn factory_reset<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let previous_config = get_app_configurations(app_handle.clone());
    let autostart_preference = previous_config.autostart_preference;
    // The install stays the same analytics person across a reset
    // (docs/decisions/2026-10-22-keep-the-analytics-distinct-id-in-settings-json.md).
    let distinct_id = previous_config.distinct_id;

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

    let _ = stop_mcp_servers_with_context(&app_handle, &state, ShutdownContext::FactoryReset).await;

    {
        let mut active_servers = state.mcp_active_servers.lock().await;
        active_servers.clear();
    }

    use crate::core::mcp::lockfile::cleanup_own_locks;
    if let Err(e) = cleanup_own_locks(&app_handle) {
        log::warn!("Failed to cleanup lock files: {}", e);
    }
    // The core owns every model process and holds the data folder open (its lock, journal and
    // logs live inside it): stop it before the folder is deleted, or it keeps serving from a folder
    // that no longer exists and the next launch attaches to a stale owner.
    #[cfg(desktop)]
    crate::core::atomic_core::commands::shutdown(&app_handle).await;

    // Windows needs time to release file handles after TerminateProcess
    #[cfg(windows)]
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    let mut guest_scope = None;
    if data_folder.exists() {
        if !is_safe_to_delete(&data_folder) {
            log::error!(
                "Refusing factory reset: path is too close to filesystem root: {}",
                data_folder.display()
            );
            return Ok(());
        }

        // Preserve downloaded backends across factory reset so the user doesn't have to
        // re-download CUDA/Vulkan binaries (can be hundreds of MB).
        let preserved = set_backends_aside(&data_folder, &std::env::temp_dir());
        guest_scope = keep_guest_scope(&data_folder);

        remove_jan_data_contents(&data_folder);

        put_backends_back(&data_folder, preserved);
    }

    // Reset the configuration
    let mut default_config = AppConfiguration::default();
    default_config.data_folder = default_data_folder_path(app_handle.clone());
    default_config.autostart_preference = autostart_preference;
    default_config.distinct_id = distinct_id;
    // Into the folder the app comes back up on, which is the default one now.
    put_guest_scope(std::path::Path::new(&default_config.data_folder), guest_scope);
    let _ = update_app_configuration(app_handle.clone(), default_config);

    restart_app(&app_handle);
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
fn sanitized_appimage_restart_command(appimage: &std::ffi::OsStr) -> std::process::Command {
    let mut command = std::process::Command::new(appimage);
    command.args(std::env::args_os().skip(1));
    strip_appimage_std_command(&mut command);
    command
}

/// Restart without leaking AppRun's environment into host launchers.
///
/// The restart is *requested*, not performed here: `AppHandle::restart` called on the main thread
/// — where a synchronous command such as `relaunch` runs — replaces the process without
/// `RunEvent::Exit`, and that handler is the only place that stops the app's core and cleans up
/// its MCP servers. A core left running keeps the data folder's lock, and the app that comes up
/// next — after an update, a backend change, a data-folder move — has to wait out the vanished
/// app's client lease (about 45 s) before it can replace it.
fn restart_app<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "linux")]
    if let Some(appimage) = std::env::var_os("APPIMAGE") {
        app.cleanup_before_exit();
        match sanitized_appimage_restart_command(&appimage).spawn() {
            Ok(_) => std::process::exit(0),
            Err(error) => log::error!(
                "Failed to spawn {appimage:?} for sanitized restart: {error}; falling back"
            ),
        }
    }
    app.request_restart();
}

#[tauri::command]
pub fn relaunch<R: Runtime>(app: AppHandle<R>) {
    restart_app(&app)
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

/// Select a file or folder in the system file manager, from the blocking pool.
///
/// Do not call the opener plugin's own `reveal_item_in_dir` command from the
/// webview. It is an async command, so it runs on a tokio runtime worker, and
/// on Linux it asks the file manager over D-Bus through
/// `zbus::blocking::Connection`. This crate enables zbus's `tokio` feature, so
/// that blocking wrapper calls `Runtime::block_on` on the worker and panics
/// ("Cannot start a runtime from within a runtime"). Release builds use
/// `panic = "abort"`, so every "Show in folder" / "Open containing folder"
/// click closed the app on Linux. Same mechanism as
/// `show_desktop_notification` below. On a blocking-pool thread `block_on` is
/// allowed. macOS and Windows already ran the call off the main thread, so a
/// blocking-pool thread changes nothing for them.
#[tauri::command]
pub async fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || {
        tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Reveal task failed: {e}"))?
}

/// Deliver a desktop notification from the blocking pool.
///
/// On Linux, do not use the notification plugin: its builder `show()` is
/// fire-and-forget — it re-spawns the blocking `notify_rust` delivery onto a
/// tokio runtime worker (`tauri::async_runtime::spawn`). There, delivery goes
/// over D-Bus via `zbus`, whose `tokio`-feature blocking wrapper calls
/// `Runtime::block_on` — that panics on a runtime worker ("Cannot start a
/// runtime from within a runtime"), the detached task dies, and the
/// notification is silently dropped while the command still returns Ok.
/// Calling `notify_rust` directly from `spawn_blocking` keeps the zbus
/// `block_on` on a blocking-pool thread, where it is allowed.
#[tauri::command]
pub async fn show_desktop_notification<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: String,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(move || {
            notify_rust::Notification::new()
                .summary(&title)
                .body(&body)
                .auto_icon()
                .show()
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("Notification task failed: {e}"))?
    }
    #[cfg(not(target_os = "linux"))]
    {
        use tauri_plugin_notification::NotificationExt;
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| e.to_string())
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

#[derive(serde::Serialize)]
pub struct CliInstallStatus {
    pub installed: bool,
    pub path: Option<String>,
}

/// Name of the CLI command as it is installed on the user's PATH.
pub const CLI_COMMAND_NAME: &str = "atomic-chat-cli";

/// Name the CLI shipped under before the Atomic Chat rebrand. Older builds
/// installed it as plain `jan`, which collides with the unrelated Jan.ai CLI.
const LEGACY_CLI_COMMAND_NAME: &str = "jan";

/// Marker string embedded in every Atomic Chat CLI build. Used to confirm that a
/// leftover `jan` binary on PATH was written by us before we remove it — a `jan`
/// belonging to the actual Jan.ai app must never be touched.
const CLI_OWNERSHIP_MARKER: &[u8] = b"Atomic Chat";

/// Return true when `path` is a binary we shipped (contains [`CLI_OWNERSHIP_MARKER`]).
fn is_our_cli_binary(path: &std::path::Path) -> bool {
    use std::io::Read;

    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    // Scan in chunks with an overlap so a marker straddling a chunk boundary
    // is still found, without loading the whole binary into memory.
    let overlap = CLI_OWNERSHIP_MARKER.len() - 1;
    let mut buf = vec![0u8; 256 * 1024];
    let mut carry: Vec<u8> = Vec::with_capacity(overlap);
    loop {
        let read = match file.read(&mut buf[..]) {
            Ok(0) => return false,
            Ok(n) => n,
            Err(_) => return false,
        };
        let mut window = std::mem::take(&mut carry);
        window.extend_from_slice(&buf[..read]);
        if window
            .windows(CLI_OWNERSHIP_MARKER.len())
            .any(|w| w == CLI_OWNERSHIP_MARKER)
        {
            return true;
        }
        let keep = window.len().saturating_sub(overlap);
        carry = window[keep..].to_vec();
    }
}

/// Remove a legacy `jan` binary left behind by pre-rebrand installs, but only if
/// we can prove we wrote it. A foreign `jan` (i.e. Jan.ai's own CLI) is left alone.
fn remove_legacy_cli_binary(dir: &std::path::Path) {
    let name = if cfg!(windows) {
        "jan.exe"
    } else {
        LEGACY_CLI_COMMAND_NAME
    };
    let legacy = dir.join(name);
    if !legacy.exists() {
        return;
    }
    if !is_our_cli_binary(&legacy) {
        log::info!(
            "Leaving {} alone — not an Atomic Chat binary",
            legacy.display()
        );
        return;
    }
    match std::fs::remove_file(&legacy) {
        Ok(()) => log::info!("Removed legacy Atomic Chat CLI at {}", legacy.display()),
        Err(e) => log::warn!("Could not remove {}: {}", legacy.display(), e),
    }
}

/// Check if the `atomic-chat-cli` binary is accessible on PATH.
#[tauri::command]
pub async fn check_jan_cli_installed() -> CliInstallStatus {
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    let mut cmd = std::process::Command::new(which_cmd);
    cmd.arg(CLI_COMMAND_NAME);

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
///
/// The CLI is the bundled `atomic-chat-core` itself: it is copied from the app's
/// `resources/bin` and installed under [`CLI_COMMAND_NAME`].
pub fn install_jan_cli_sync<R: Runtime>(
    app_handle: &AppHandle<R>,
) -> Result<CliInstallStatus, String> {
    let bin_name = if cfg!(windows) {
        "atomic-chat-core.exe"
    } else {
        "atomic-chat-core"
    };
    let dest_bin_name = if cfg!(windows) {
        "atomic-chat-cli.exe"
    } else {
        CLI_COMMAND_NAME
    };
    let resource_bin_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("resources/bin");
    let bundled = resource_bin_dir.join(bin_name);
    let dest = resource_bin_dir.join(dest_bin_name);

    if !bundled.exists() && !dest.exists() {
        return Err("Atomic Chat CLI binary not bundled with this version of the app.".to_string());
    }

    #[cfg(windows)]
    {
        if bundled.exists() {
            let staged = dest.with_extension("exe.atomic-new");
            std::fs::copy(&bundled, &staged)
                .map_err(|e| format!("Could not stage the Atomic Chat CLI update: {e}"))?;
            if dest.exists() {
                std::fs::remove_file(&dest).map_err(|e| {
                    let _ = std::fs::remove_file(&staged);
                    format!(
                        "Could not update {} because the installed binary is in use: {e}",
                        dest.display()
                    )
                })?;
            }
            std::fs::rename(&staged, &dest).map_err(|e| {
                let _ = std::fs::remove_file(&staged);
                format!("Could not activate the Atomic Chat CLI update: {e}")
            })?;
        }
        // Older builds put `jan.exe` on PATH here; drop it so it stops shadowing Jan.ai.
        remove_legacy_cli_binary(&resource_bin_dir);
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

        let staged = install_dir.join(format!(".{dest_bin_name}.atomic-new"));
        std::fs::copy(&bundled, &staged).map_err(|e| {
            format!(
                "Failed to copy {} to {}: {}",
                CLI_COMMAND_NAME,
                staged.display(),
                e
            )
        })?;

        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
        std::fs::rename(&staged, &dest).map_err(|e| {
            let _ = std::fs::remove_file(&staged);
            format!("Failed to activate {}: {e}", dest.display())
        })?;

        // Older builds installed this binary as plain `jan` in the same directory.
        remove_legacy_cli_binary(&install_dir);

        Ok(CliInstallStatus {
            installed: true,
            path: Some(dest.to_string_lossy().into_owned()),
        })
    }
}

/// Copy the bundled `atomic-chat-core` onto the system PATH as `atomic-chat-cli` (Tauri command
/// wrapper).
#[tauri::command]
pub async fn install_jan_cli<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<CliInstallStatus, String> {
    install_jan_cli_sync(&app_handle)
}

/// Remove the installed `atomic-chat-cli` binary (plus any legacy `jan` we wrote).
#[tauri::command]
pub fn uninstall_jan_cli() -> Result<(), String> {
    #[cfg(windows)]
    {
        let bin_dir = jan_cli_bin_dir_windows()?;
        let path = bin_dir.join("atomic-chat-cli.exe");
        if path.exists() {
            if let Err(e) = std::fs::remove_file(&path) {
                log::warn!("Could not remove {}: {}", path.display(), e);
            }
        }
        remove_legacy_cli_binary(&bin_dir);
        remove_from_path_windows(&bin_dir)?;
        return Ok(());
    }

    #[cfg(unix)]
    {
        let install_dir = jan_cli_install_dir()?;
        let dest = install_dir.join(CLI_COMMAND_NAME);
        if dest.exists() {
            std::fs::remove_file(&dest).map_err(|e| {
                format!(
                    "Failed to remove the Atomic Chat CLI from {}: {}",
                    dest.display(),
                    e
                )
            })?;
        }
        remove_legacy_cli_binary(&install_dir);
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
    let home = std::env::var("HOME").map_err(|_| "Cannot determine home directory".to_string())?;
    Ok(PathBuf::from(home).join(".local").join("bin"))
}

/// Return the directory containing the bundled CLI binary on Windows.
#[cfg(windows)]
fn jan_cli_bin_dir_windows() -> Result<PathBuf, String> {
    let local_app_data =
        std::env::var("LOCALAPPDATA").map_err(|_| "Cannot determine LOCALAPPDATA".to_string())?;
    Ok(PathBuf::from(local_app_data)
        .join("Programs")
        .join("Atomic Chat")
        .join("resources")
        .join("bin"))
}

/// Add a directory to the front of the Windows user PATH, dropping the
/// pre-`resources\bin` entry older builds wrote. The value is edited as stored
/// (see `windows_path`), so other entries keep their characters, their
/// `%VAR%` references and the value its `REG_EXPAND_SZ` type.
#[cfg(windows)]
fn add_to_path_windows(install_dir: &PathBuf) -> Result<(), String> {
    use super::windows_path::{
        env_lookup, path_with_dir_first, read_user_path, strip_verbatim_prefix, write_user_path,
    };

    // Always write the normalized (non-verbatim) form to PATH.
    let install_dir_str = strip_verbatim_prefix(&install_dir.to_string_lossy());

    // Remove stale old-style PATH entry (..\\Programs\\Jan without \\resources\\bin)
    // left by previous versions that placed jan.exe next to the GUI binary.
    let old_jan_dir = install_dir
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_string_lossy().to_string());
    let stale: Vec<&str> = old_jan_dir.as_deref().into_iter().collect();

    let (current, vtype) = read_user_path()?;
    // Nothing to change: our clean entry already leads and no stale entries
    // needed removing. Skip the write to avoid touching the registry on every
    // launch.
    let Some(next) = path_with_dir_first(&current, &install_dir_str, &stale, &env_lookup) else {
        return Ok(());
    };
    write_user_path(&next, vtype)?;
    log::info!("Added {} to Windows user PATH", install_dir_str);
    Ok(())
}

/// Remove a directory from the Windows user PATH (any spelling of it,
/// including the legacy `\\?\`-prefixed one), leaving every other entry as is.
#[cfg(windows)]
fn remove_from_path_windows(dir: &PathBuf) -> Result<(), String> {
    use super::windows_path::{env_lookup, path_without_dir, read_user_path, write_user_path};

    let dir_str = dir.to_string_lossy().to_string();
    let (current, vtype) = read_user_path()?;
    if let Some(next) = path_without_dir(&current, &dir_str, &env_lookup) {
        write_user_path(&next, vtype)?;
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
    configure_hermes_at(
        &resolve_hermes_dir()?,
        api_url,
        model,
        api_key,
        context_length,
    )
}

/// The window written when the served one is unknown: Hermes refuses any
/// model below 64K (`MINIMUM_CONTEXT_LENGTH` in `agent/model_metadata.py`),
/// so a value is required. A known window is written as it is — Connect
/// serves Hermes at least this much.
const HERMES_MIN_CONTEXT_LENGTH: u32 = 65536;

/// The top-level `model:` keys Connect writes, in the order a new section
/// lists them.
///
/// Bare `custom` with `model.base_url` and `model.api_key` is the one route
/// that needs nothing outside this section: Hermes trusts `model.base_url`
/// while `model.provider` is `custom`, and takes the key from `model.api_key`
/// (`_resolve_openrouter_runtime` in `hermes_cli/runtime_provider_backends.py`).
/// A named `custom:atomic-chat` route would also need our `custom_providers`
/// entry, which cannot be written into an inline `custom_providers: [...]`
/// list. `context_length` sizes compaction for this route only (Hermes drops
/// it when another model or endpoint runs).
fn hermes_route(
    model: &str,
    api_url: &str,
    key: &str,
    context_length: u32,
) -> Vec<(&'static str, String)> {
    vec![
        ("default", model.to_string()),
        ("provider", "custom".to_string()),
        ("base_url", api_url.to_string()),
        ("api_key", key.to_string()),
        ("context_length", context_length.to_string()),
    ]
}

/// The server key as a YAML scalar (a JSON string is one, quotes and all), or
/// a placeholder: our server takes any key when it has none.
fn hermes_key_scalar(api_key: Option<&str>) -> String {
    serde_json::json!(api_key.filter(|key| !key.is_empty()).unwrap_or("atomic")).to_string()
}

fn configure_hermes_at(
    hermes_dir: &Path,
    api_url: String,
    model: String,
    api_key: Option<String>,
    context_length: Option<u32>,
) -> Result<(), String> {
    let config_path = hermes_dir.join("config.yaml");
    let env_path = hermes_dir.join(".env");

    // The installer runs with `-SkipSetup`, so on a fresh install (notably
    // Windows) no config.yaml exists yet; Hermes fills every key we do not
    // write with its own defaults.
    let content = match std::fs::read_to_string(&config_path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("Failed to read config.yaml: {}", e)),
    };
    let previous = read_hermes_backup(&config_path);

    let ctx = context_length.unwrap_or(HERMES_MIN_CONTEXT_LENGTH);
    let key = hermes_key_scalar(api_key.as_deref());
    let route = hermes_route(&model, &api_url, &key, ctx);

    let after_model = patch_hermes_model_section(&content, &route);
    // Our named entry too, so `hermes model` lists the endpoint and the
    // detection on the next start finds it. Other entries are left as they
    // are.
    let (after_cp, added_list) = upsert_atomic_provider(&after_model, &api_url, &model, ctx, &key);
    // Seed a per-request timeout for the underlying `custom` transport.
    // Hermes reads `providers.<id>.request_timeout_seconds`
    // (run_agent.py::get_provider_request_timeout); without it the legacy
    // 1800s default applies. Any value the user already set is preserved.
    let (final_content, mut created) =
        upsert_provider_request_timeout(&after_cp, "custom", HERMES_REQUEST_TIMEOUT_SECONDS);
    if added_list {
        created.push("custom_providers".to_string());
    }

    // --- Ensure NO_PROXY is set in .env to bypass system proxy for localhost ---
    if env_path.exists() {
        let env_content = std::fs::read_to_string(&env_path)
            .map_err(|e| format!("Failed to read .env: {}", e))?;
        if !env_content.contains("NO_PROXY=") && !env_content.contains("no_proxy=") {
            let separator = if env_content.ends_with('\n') {
                ""
            } else {
                "\n"
            };
            let patched = format!(
                "{}{}\n{}\n{}",
                env_content, separator, HERMES_NO_PROXY_LINE, HERMES_NO_PROXY_EXPORT_LINE
            );
            std::fs::write(&env_path, patched)
                .map_err(|e| format!("Failed to write .env: {}", e))?;
            created.push("env.no_proxy".to_string());
        }
    }

    let backup = hermes_backup(&content, &route, previous.as_ref(), created);
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create Hermes home directory: {}", e))?;
    }
    std::fs::write(&config_path, &final_content)
        .map_err(|e| format!("Failed to write config.yaml: {}", e))?;
    json_key_backup::write_text(&config_path, &render_hermes_backup(&backup))?;

    log::info!(
        "Hermes Agent configured: model={}, base_url={}, context_length={}, dir={}",
        model,
        api_url,
        ctx,
        hermes_dir.display()
    );
    Ok(())
}

/// Disconnect from the Settings page's old "Reset" too: it restores the route
/// Connect replaced instead of inventing one.
#[tauri::command]
pub fn clear_hermes_agent_config() -> Result<(), String> {
    disconnect_hermes_at(&resolve_hermes_dir()?)
}

/// Undo Connect: put back the `model:` keys it replaced (each one only while it
/// still holds our value), drop our `custom_providers` entry and whatever
/// Connect created (an empty `custom_providers` list, the request timeout, the
/// `.env` NO_PROXY lines). A config connected by an older release, which kept
/// no backup, loses our route keys so Hermes falls back to its own defaults.
pub(crate) fn disconnect_hermes_at(hermes_dir: &Path) -> Result<(), String> {
    let config_path = hermes_dir.join("config.yaml");
    let content = match std::fs::read_to_string(&config_path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return json_key_backup::discard(&config_path)
        }
        Err(e) => return Err(format!("Failed to read config.yaml: {}", e)),
    };
    let backup = read_hermes_backup(&config_path).unwrap_or_else(|| hermes_legacy_backup(&content));
    let restored = restore_hermes_config(&content, &backup);
    if restored != content {
        std::fs::write(&config_path, &restored)
            .map_err(|e| format!("Failed to write config.yaml: {}", e))?;
    }

    let env_path = hermes_dir.join(".env");
    if backup.created.iter().any(|c| c == "env.no_proxy") {
        if let Ok(env_content) = std::fs::read_to_string(&env_path) {
            let cleaned = remove_hermes_no_proxy(&env_content);
            if cleaned != env_content {
                std::fs::write(&env_path, cleaned)
                    .map_err(|e| format!("Failed to write .env: {}", e))?;
            }
        }
    }

    json_key_backup::discard(&config_path)?;
    log::info!("Hermes Agent disconnected: {}", hermes_dir.display());
    Ok(())
}

const HERMES_NO_PROXY_LINE: &str = "NO_PROXY=localhost,127.0.0.1,0.0.0.0";
const HERMES_NO_PROXY_EXPORT_LINE: &str = "export no_proxy=localhost,127.0.0.1,0.0.0.0";

/// `.env` without the two lines Connect appended (and the blank line before
/// them, when they are still the file's tail).
fn remove_hermes_no_proxy(content: &str) -> String {
    let tail = format!(
        "\n{}\n{}",
        HERMES_NO_PROXY_LINE, HERMES_NO_PROXY_EXPORT_LINE
    );
    for suffix in [format!("{tail}\n"), tail.clone()] {
        if let Some(rest) = content.strip_suffix(&suffix) {
            return rest.to_string();
        }
    }
    content
        .split_inclusive('\n')
        .filter(|line| {
            let line = line.trim_end_matches(['\r', '\n']);
            line != HERMES_NO_PROXY_LINE && line != HERMES_NO_PROXY_EXPORT_LINE
        })
        .collect()
}

/// What Connect changed in a Hermes `config.yaml`, kept in
/// `config.yaml.atomic-chat-backup.json`.
#[derive(Clone, Debug, Default, PartialEq)]
struct HermesBackup {
    /// The top-level `model:` line before Connect: `None` when there was no
    /// section, the line itself when it was a scalar (`model: <id>`) or a block.
    header: Option<String>,
    /// Per key Connect wrote: the lines it replaced (`None`: the key was
    /// absent) and the value it wrote.
    keys: Vec<HermesKeyBackup>,
    /// What Connect added that was not there at all: `custom_providers`,
    /// `providers`, `providers:{}`, `providers.custom`,
    /// `providers.custom.request_timeout_seconds`, `env.no_proxy`.
    created: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct HermesKeyBackup {
    key: String,
    before: Option<Vec<String>>,
    ours: String,
}

fn render_hermes_backup(backup: &HermesBackup) -> String {
    let mut keys = serde_json::Map::new();
    for entry in &backup.keys {
        let mut obj = serde_json::Map::new();
        if let Some(before) = &entry.before {
            obj.insert("before".to_string(), serde_json::json!(before));
        }
        obj.insert("ours".to_string(), serde_json::json!(entry.ours));
        keys.insert(entry.key.clone(), serde_json::Value::Object(obj));
    }
    let mut model = serde_json::Map::new();
    if let Some(header) = &backup.header {
        model.insert("header".to_string(), serde_json::json!(header));
    }
    model.insert("keys".to_string(), serde_json::Value::Object(keys));
    let mut created = backup.created.clone();
    created.sort();
    created.dedup();
    let root = serde_json::json!({ "created": created, "model": model });
    serde_json::to_string_pretty(&root).unwrap_or_default() + "\n"
}

fn parse_hermes_backup(text: &str) -> Option<HermesBackup> {
    let root: serde_json::Value = serde_json::from_str(text).ok()?;
    let model = root.get("model")?;
    let keys = model
        .get("keys")?
        .as_object()?
        .iter()
        .map(|(key, entry)| {
            let before = match entry.get("before") {
                None => None,
                Some(lines) => Some(
                    lines
                        .as_array()?
                        .iter()
                        .map(|l| l.as_str().map(str::to_string))
                        .collect::<Option<Vec<_>>>()?,
                ),
            };
            Some(HermesKeyBackup {
                key: key.clone(),
                before,
                ours: entry.get("ours")?.as_str()?.to_string(),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let created = root
        .get("created")?
        .as_array()?
        .iter()
        .map(|c| c.as_str().map(str::to_string))
        .collect::<Option<Vec<_>>>()?;
    Some(HermesBackup {
        header: model
            .get("header")
            .and_then(|h| h.as_str())
            .map(str::to_string),
        keys,
        created,
    })
}

fn read_hermes_backup(config_path: &Path) -> Option<HermesBackup> {
    let path = json_key_backup::backup_path(config_path);
    let text = std::fs::read_to_string(&path).ok()?;
    let parsed = parse_hermes_backup(&text);
    if parsed.is_none() {
        log::warn!("Ignoring an unreadable {}", path.display());
    }
    parsed
}

/// The backup of a Connect that wrote `route` over `content`. A key an earlier
/// Connect already recorded keeps that record's original while it still holds
/// the value that Connect wrote; otherwise the user changed it since, and the
/// current lines are the ones to return to.
fn hermes_backup(
    content: &str,
    route: &[(&'static str, String)],
    previous: Option<&HermesBackup>,
    created: Vec<String>,
) -> HermesBackup {
    let lines: Vec<String> = content.lines().map(str::to_string).collect();
    let section = hermes_model_section(&lines);
    let still_ours = |prev: &HermesBackup| {
        prev.keys.iter().all(|entry| {
            hermes_model_value(&lines, section.as_ref(), &entry.key)
                .is_some_and(|value| hermes_value_is_ours(&entry.key, &value, &entry.ours))
        })
    };
    let header = match previous {
        Some(prev) if still_ours(prev) => prev.header.clone(),
        _ => section.as_ref().map(|s| lines[s.header].clone()),
    };
    let keys = route
        .iter()
        .map(|(key, ours)| {
            let earlier = previous.and_then(|prev| prev.keys.iter().find(|e| e.key == *key));
            let current = hermes_model_value(&lines, section.as_ref(), key);
            let before = match earlier {
                Some(entry)
                    if current
                        .as_deref()
                        .is_some_and(|v| hermes_value_is_ours(key, v, &entry.ours)) =>
                {
                    entry.before.clone()
                }
                _ => section
                    .as_ref()
                    .and_then(|s| hermes_child_span(&lines, s, key))
                    .map(|(start, end)| {
                        lines[start..end]
                            .iter()
                            .filter(|l| !is_blank_or_yaml_comment(l))
                            .cloned()
                            .collect()
                    }),
            };
            HermesKeyBackup {
                key: key.to_string(),
                before,
                ours: ours.clone(),
            }
        })
        .collect();
    let mut all_created = previous.map(|p| p.created.clone()).unwrap_or_default();
    all_created.extend(created);
    all_created.sort();
    all_created.dedup();
    HermesBackup {
        header,
        keys,
        created: all_created,
    }
}

/// A backup for a config an older release connected, which kept none: when
/// the route is still ours (our named provider, or bare `custom` on our
/// entry's endpoint), its keys are dropped so Hermes falls back to its
/// defaults. Our entry goes either way.
fn hermes_legacy_backup(content: &str) -> HermesBackup {
    let lines: Vec<String> = content.lines().map(str::to_string).collect();
    let section = hermes_model_section(&lines);
    let value = |key: &str| hermes_model_value(&lines, section.as_ref(), key);
    let (_, entries, _) = split_custom_providers(content);
    let entry_url = entries.iter().find(|e| entry_is_ours(e)).and_then(|entry| {
        entry.iter().find_map(|l| {
            l.trim()
                .strip_prefix("base_url:")
                .map(|v| unquote_yaml(strip_yaml_comment(v).trim()).to_string())
        })
    });
    let provider = value("provider");
    let base_url = value("base_url");
    let ours = provider.as_deref() == Some(HERMES_LEGACY_PROVIDER)
        || (provider.as_deref() == Some("custom") && base_url.is_some() && base_url == entry_url);
    let keys = if ours {
        ["default", "provider", "base_url"]
            .into_iter()
            .filter_map(|key| {
                value(key).map(|ours| HermesKeyBackup {
                    key: key.to_string(),
                    before: None,
                    ours,
                })
            })
            .collect()
    } else {
        Vec::new()
    };
    HermesBackup {
        header: None,
        keys,
        created: Vec::new(),
    }
}

/// The provider older releases wrote: our named `custom_providers` entry.
const HERMES_LEGACY_PROVIDER: &str = "custom:atomic-chat";

/// Whether `current` is the value Connect wrote. Hermes may persist the bare
/// `custom` route under the name of the entry that owns its endpoint, which is
/// ours.
fn hermes_value_is_ours(key: &str, current: &str, ours: &str) -> bool {
    let current = unquote_yaml(current);
    current == unquote_yaml(ours)
        || (key == "provider" && ours == "custom" && current == HERMES_LEGACY_PROVIDER)
}

/// `value` without one pair of surrounding quotes.
fn unquote_yaml(value: &str) -> &str {
    for quote in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return &value[1..value.len() - 1];
        }
    }
    value
}

/// Undo what `backup` says Connect did to `content`.
fn restore_hermes_config(content: &str, backup: &HermesBackup) -> String {
    let mut lines: Vec<String> = content.lines().map(str::to_string).collect();

    if let Some(section) = hermes_model_section(&lines) {
        let mut section = section;
        for entry in &backup.keys {
            let Some((start, end)) = hermes_child_span(&lines, &section, &entry.key) else {
                continue;
            };
            let current = hermes_scalar(&lines[start]);
            if !hermes_value_is_ours(&entry.key, &current, &entry.ours) {
                continue;
            }
            // Comments interleaved with a nested value stay where they are.
            let comments: Vec<String> = lines[start + 1..end]
                .iter()
                .filter(|l| is_blank_or_yaml_comment(l))
                .cloned()
                .collect();
            let replacement: Vec<String> = entry
                .before
                .clone()
                .unwrap_or_default()
                .into_iter()
                .chain(comments)
                .collect();
            let removed = end - start;
            let added = replacement.len();
            lines.splice(start..end, replacement);
            section.end = section.end + added - removed;
        }
        let has_children = lines[section.header + 1..section.end]
            .iter()
            .any(|l| !is_blank_or_yaml_comment(l));
        if !has_children {
            match &backup.header {
                // There was no section: drop the one Connect added.
                None => {
                    let body_is_blank = lines[section.header + 1..section.end]
                        .iter()
                        .all(|l| l.trim().is_empty());
                    let end = if body_is_blank {
                        section.end
                    } else {
                        section.header + 1
                    };
                    lines.drain(section.header..end);
                }
                Some(header) => lines[section.header] = header.clone(),
            }
        }
    }

    let mut text = with_trailing_newline(lines.join("\n"));
    if lines.is_empty() {
        text = String::new();
    }
    text = remove_atomic_provider(&text);
    if backup.created.iter().any(|c| c == "custom_providers") {
        text = text
            .split_inclusive('\n')
            .filter(|l| l.trim_end() != "custom_providers: []")
            .collect();
    }
    text = remove_provider_request_timeout(
        &text,
        "custom",
        HERMES_REQUEST_TIMEOUT_SECONDS,
        &backup.created,
    );
    if text.trim().is_empty() {
        String::new()
    } else {
        text
    }
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

/// Drop a trailing `# comment` (YAML only starts one at the beginning of a
/// line or after whitespace).
fn strip_yaml_comment(text: &str) -> &str {
    let mut after_space = true;
    for (i, c) in text.char_indices() {
        if c == '#' && after_space {
            return &text[..i];
        }
        after_space = c.is_whitespace();
    }
    text
}

/// The key and the comment-free value of a top-level (column-0) mapping line.
fn top_level_yaml_key(line: &str) -> Option<(&str, &str)> {
    if !is_top_level_yaml_key(line) {
        return None;
    }
    let (key, value) = line.split_once(':')?;
    Some((key.trim(), strip_yaml_comment(value).trim()))
}

fn yaml_indent(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

fn is_blank_or_yaml_comment(line: &str) -> bool {
    let t = line.trim();
    t.is_empty() || t.starts_with('#')
}

fn with_trailing_newline(text: String) -> String {
    if text.ends_with('\n') {
        text
    } else {
        format!("{}\n", text)
    }
}

/// The top-level `model:` section of a Hermes `config.yaml`: its header line,
/// where it ends (the next column-0 key), and whether the header carries a
/// scalar (`model: <id>`, also valid Hermes).
struct HermesSection {
    header: usize,
    end: usize,
    is_scalar: bool,
}

fn hermes_model_section(lines: &[String]) -> Option<HermesSection> {
    let (header, is_scalar) =
        lines
            .iter()
            .enumerate()
            .find_map(|(i, line)| match top_level_yaml_key(line) {
                Some(("model", value)) => Some((i, !value.is_empty())),
                _ => None,
            })?;
    // The section runs to the next column-0 key; comments and blank lines in
    // it are kept.
    let end = (header + 1..lines.len())
        .find(|&i| is_top_level_yaml_key(&lines[i]))
        .unwrap_or(lines.len());
    Some(HermesSection {
        header,
        end,
        is_scalar,
    })
}

/// The indent of the section's direct children (two spaces when it has none).
fn hermes_child_indent(lines: &[String], section: &HermesSection) -> String {
    lines[section.header + 1..section.end]
        .iter()
        .find(|l| !is_blank_or_yaml_comment(l))
        .map_or_else(|| "  ".to_string(), |l| l[..yaml_indent(l)].to_string())
}

/// The lines of the direct child `key` of a block section: its own line and
/// the more-indented lines of a nested value after it (with any comments
/// between those).
fn hermes_child_span(
    lines: &[String],
    section: &HermesSection,
    key: &str,
) -> Option<(usize, usize)> {
    if section.is_scalar {
        return None;
    }
    let indent = hermes_child_indent(lines, section).len();
    let start = (section.header + 1..section.end).find(|&i| {
        let l = &lines[i];
        !is_blank_or_yaml_comment(l)
            && yaml_indent(l) == indent
            && l.trim()
                .strip_prefix(key)
                .is_some_and(|rest| rest.trim_start().starts_with(':'))
    })?;
    let mut end = start + 1;
    let mut i = start + 1;
    while i < section.end {
        if is_blank_or_yaml_comment(&lines[i]) {
            i += 1;
        } else if yaml_indent(&lines[i]) > indent {
            i += 1;
            end = i;
        } else {
            break;
        }
    }
    Some((start, end))
}

/// The value text of a `key: value` line, without its comment (quotes kept).
fn hermes_scalar(line: &str) -> String {
    line.split_once(':')
        .map(|(_, value)| strip_yaml_comment(value).trim().to_string())
        .unwrap_or_default()
}

/// The value of the direct child `key` of the `model:` section.
fn hermes_model_value(
    lines: &[String],
    section: Option<&HermesSection>,
    key: &str,
) -> Option<String> {
    let (start, _) = hermes_child_span(lines, section?, key)?;
    Some(hermes_scalar(&lines[start]))
}

/// Point the top-level `model:` section of Hermes' `config.yaml` at the given
/// route, and touch nothing outside it.
///
/// Hermes takes its chat route from `model.default` (`model.model` is an
/// alias), `model.provider` and `model.base_url` alone; a section it cannot
/// read leaves it on its built-in default, an empty model on provider `auto`,
/// which falls through to OpenRouter ("No models provided"). The same keys
/// recur under `auxiliary:`, `delegation:`, `cron:`, `moa:`, `tts:` and
/// others, so only direct children of the top-level `model:` key are ours. A
/// missing key is added at the section's indent, a nested value under a
/// replaced key is dropped, a scalar `model: <id>` (also valid Hermes) becomes
/// a block, and a file with no `model:` at all gets one appended. Mirrors
/// `patchModelSection` in atomic-chat-core.
fn patch_hermes_model_section(content: &str, wanted: &[(&str, String)]) -> String {
    let mut lines: Vec<String> = content.lines().map(str::to_string).collect();
    let block = |indent: &str| -> Vec<String> {
        wanted
            .iter()
            .map(|(key, value)| format!("{}{}: {}", indent, key, value))
            .collect()
    };

    let Some(HermesSection {
        header: header_idx,
        end,
        is_scalar,
    }) = hermes_model_section(&lines)
    else {
        while lines.last().is_some_and(|l| l.trim().is_empty()) {
            lines.pop();
        }
        lines.push("model:".to_string());
        lines.extend(block("  "));
        return with_trailing_newline(lines.join("\n"));
    };

    if is_scalar {
        // Anything still indented under a scalar `model: <id>` is that
        // scalar's continuation.
        let mut replacement = vec!["model:".to_string()];
        replacement.extend(block("  "));
        replacement.extend(
            lines[header_idx + 1..end]
                .iter()
                .filter(|l| is_blank_or_yaml_comment(l))
                .cloned(),
        );
        lines.splice(header_idx..end, replacement);
        return with_trailing_newline(lines.join("\n"));
    }

    let mut section: Vec<String> = lines[header_idx + 1..end].to_vec();
    let child_indent = section
        .iter()
        .find(|l| !is_blank_or_yaml_comment(l))
        .map_or_else(|| "  ".to_string(), |l| l[..yaml_indent(l)].to_string());
    let mut missing: Vec<String> = Vec::new();
    for (key, value) in wanted {
        let at = section.iter().position(|l| {
            !is_blank_or_yaml_comment(l)
                && yaml_indent(l) == child_indent.len()
                && l.trim()
                    .strip_prefix(key)
                    .is_some_and(|rest| rest.trim_start().starts_with(':'))
        });
        let Some(at) = at else {
            missing.push(format!("{}{}: {}", child_indent, key, value));
            continue;
        };
        section[at] = replace_yaml_scalar_value(&section[at], value);
        // A nested value (a mapping-valued `default`, a wrapped scalar) would
        // dangle under the new one.
        let mut i = at + 1;
        while i < section.len() {
            if is_blank_or_yaml_comment(&section[i]) {
                i += 1;
            } else if yaml_indent(&section[i]) > child_indent.len() {
                section.remove(i);
            } else {
                break;
            }
        }
    }
    lines.splice(header_idx + 1..end, missing.into_iter().chain(section));
    with_trailing_newline(lines.join("\n"))
}

/// True when the top-level `custom_providers:` holds an inline list with
/// entries. It cannot be spliced line by line, and rebuilding the block
/// around it would add a second `custom_providers:` key, which makes Hermes
/// reject the whole file and run on its defaults; such a file is left alone.
fn has_inline_custom_providers(content: &str) -> bool {
    content
        .lines()
        .find_map(|line| match top_level_yaml_key(line) {
            Some(("custom_providers", value)) => Some(value),
            _ => None,
        })
        .is_some_and(|value| {
            !value.is_empty() && value.split_whitespace().collect::<String>() != "[]"
        })
}

const ATOMIC_PROVIDER_NAME: &str = "atomic-chat";

/// Default per-request timeout (seconds) seeded for Hermes' `custom` provider.
/// Hermes otherwise defaults to 1800s (`HERMES_API_TIMEOUT`); a tighter cap
/// lets a wedged local turn fail fast without waiting half an hour.
const HERMES_REQUEST_TIMEOUT_SECONDS: u32 = 180;

/// Resolve the directory whose `config.yaml` the `hermes` CLI reads, mirroring
/// Hermes' own resolution (`hermes_constants.py::get_hermes_home()` and the
/// sticky-profile step of `hermes_cli/main.py::_apply_profile_override`):
///
/// - `HERMES_HOME`, with `~` and `$NAME`/`${NAME}`/`%NAME%` expanded, else the
///   platform default (`%LOCALAPPDATA%\\hermes` on Windows, `~/.hermes`
///   elsewhere), is the root;
/// - a `HERMES_HOME` that names a profile (`<root>/profiles/<name>`) is used
///   as it is;
/// - otherwise `hermes profile use <name>` leaves `<root>/active_profile`, and
///   every `hermes` started without `-p` runs that profile from
///   `<root>/profiles/<name>`. Writing the root's config then would configure
///   a profile the user does not run.
///
/// On Windows the native installer (`install.ps1`) sets `HERMES_HOME` via
/// `[Environment]::SetEnvironmentVariable(..., "User")` -- a registry write
/// that is invisible to Atomic Chat's own already-running process (which only
/// sees the environment block snapshotted at its own startup). So
/// `std::env::var("HERMES_HOME")` can be stale within the same app session
/// that just installed Hermes. Reading the registry value directly first
/// (mirroring Hermes' own official desktop app, which hit and fixed this
/// exact gap) avoids ever writing to a config file the `hermes` CLI won't
/// read.
pub(crate) fn resolve_hermes_dir() -> Result<std::path::PathBuf, String> {
    let home = PathBuf::from(agent_home_dir()?);
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    let raw = if cfg!(windows) {
        read_windows_user_env("HERMES_HOME")
            .filter(|v| !v.trim().is_empty())
            .or_else(|| var("HERMES_HOME"))
    } else {
        var("HERMES_HOME")
    };
    let env_home = raw.map(|raw| expand_hermes_home(raw.trim(), &var, &home));
    Ok(hermes_config_dir(
        &hermes_native_home(&var, &home),
        env_home,
    ))
}

/// Hermes' platform default home.
fn hermes_native_home(var: &dyn Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    if cfg!(windows) {
        var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"))
            .join("hermes")
    } else {
        home.join(".hermes")
    }
}

/// `HERMES_HOME` as Hermes reads it (`os.path.expanduser(os.path.expandvars(...))`):
/// `$NAME`, `${NAME}` and `%NAME%` take the variable's value (an unset one
/// stays as written), then a leading `~` is the user's home.
fn expand_hermes_home(raw: &str, var: &dyn Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    let is_name = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = String::new();
    let mut rest = raw;
    while let Some(c) = rest.chars().next() {
        let (name, len) = if let Some(after) = rest.strip_prefix("${") {
            match after.find('}') {
                Some(close) => (Some(&after[..close]), close + 3),
                None => (None, 1),
            }
        } else if let Some(after) = rest.strip_prefix('$') {
            let len = after.find(|c: char| !is_name(c)).unwrap_or(after.len());
            if len == 0 {
                (None, 1)
            } else {
                (Some(&after[..len]), len + 1)
            }
        } else if let Some(after) = rest.strip_prefix('%') {
            match after.find('%') {
                Some(close) if close > 0 => (Some(&after[..close]), close + 2),
                _ => (None, 1),
            }
        } else {
            (None, c.len_utf8())
        };
        match name.and_then(|n| var(n)) {
            Some(value) => out.push_str(&value),
            None => out.push_str(&rest[..len]),
        }
        rest = &rest[len..];
    }
    if out == "~" {
        return home.to_path_buf();
    }
    match out.strip_prefix("~/").or_else(|| out.strip_prefix("~\\")) {
        Some(tail) => home.join(tail),
        None => PathBuf::from(out),
    }
}

/// Where Hermes reads `config.yaml` from, given its platform default home and
/// the expanded `HERMES_HOME` (see [`resolve_hermes_dir`]).
fn hermes_config_dir(native: &Path, env_home: Option<PathBuf>) -> PathBuf {
    let is_profile =
        |p: &Path| p.parent().and_then(|parent| parent.file_name()) == Some("profiles".as_ref());
    if let Some(env) = env_home.as_deref() {
        if is_profile(env) {
            return env.to_path_buf();
        }
    }
    // The root holding `active_profile`: the platform default for anything
    // under it, else `HERMES_HOME` itself (Docker and custom roots).
    let root = match env_home.as_deref() {
        Some(env) if !env.starts_with(native) => env.to_path_buf(),
        _ => native.to_path_buf(),
    };
    let base = env_home.unwrap_or_else(|| native.to_path_buf());
    let active = std::fs::read_to_string(root.join("active_profile"))
        .map(|name| name.trim_start_matches('\u{feff}').trim().to_lowercase())
        .unwrap_or_default();
    if !active.is_empty() && active != "default" {
        let profile = base.join("profiles").join(&active);
        if profile.is_dir() {
            return profile;
        }
    }
    base
}

/// Read a single User-scope Windows environment variable fresh from the
/// registry (`HKCU\Environment`), bypassing the current process's stale
/// environment-block snapshot. Returns `None` off Windows, on read failure,
/// or when the value is empty/absent.
#[cfg(windows)]
fn read_windows_user_env(name: &str) -> Option<String> {
    // Straight from the registry: PowerShell's stdout is in the console code
    // page, which mangles a non-ASCII user name in the path it returns.
    super::windows_path::read_user_env(name)
}

#[cfg(not(windows))]
fn read_windows_user_env(_name: &str) -> Option<String> {
    None
}

/// Split the config into (before, entries, after) around `custom_providers:`.
/// `entries` is a Vec of Vec<String>, one per YAML list item.
pub(crate) fn split_custom_providers(
    content: &str,
) -> (Vec<String>, Vec<Vec<String>>, Vec<String>) {
    let mut before: Vec<String> = Vec::new();
    let mut block_lines: Vec<String> = Vec::new();
    let mut after: Vec<String> = Vec::new();

    #[derive(PartialEq)]
    enum Phase {
        Before,
        InBlock,
        After,
    }
    let mut phase = Phase::Before;

    for line in content.lines() {
        match phase {
            Phase::Before => {
                let t = strip_yaml_comment(line).trim();
                if t == "custom_providers:"
                    || t == "custom_providers: []"
                    || t == "custom_providers:[]"
                {
                    phase = if t.contains("[]") {
                        Phase::After
                    } else {
                        Phase::InBlock
                    };
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

pub(crate) fn entry_is_ours(entry: &[String]) -> bool {
    entry.iter().any(|l| {
        let t = l.trim();
        let name_val = if t.starts_with("- name:") {
            t.trim_start_matches("- name:").trim()
        } else if t.starts_with("name:") {
            t.trim_start_matches("name:").trim()
        } else {
            return false;
        };
        name_val == ATOMIC_PROVIDER_NAME || name_val == format!("\"{}\"", ATOMIC_PROVIDER_NAME)
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
    if out.ends_with('\n') {
        out
    } else {
        format!("{}\n", out)
    }
}

/// Add or update only the `atomic-chat` entry in `custom_providers`,
/// leaving all other user entries (Telegram, WhatsApp, etc.) intact. Also
/// says whether the `custom_providers` key itself was added.
fn upsert_atomic_provider(
    content: &str,
    api_url: &str,
    model: &str,
    context_length: u32,
    key: &str,
) -> (String, bool) {
    if has_inline_custom_providers(content) {
        return (with_trailing_newline(content.to_string()), false);
    }
    let had_key = content
        .lines()
        .any(|line| matches!(top_level_yaml_key(line), Some(("custom_providers", _))));

    let (before, mut entries, after) = split_custom_providers(content);

    entries.retain(|e| !entry_is_ours(e));

    entries.push(vec![
        format!("- name: {}", ATOMIC_PROVIDER_NAME),
        format!("  base_url: {}", api_url),
        format!("  api_key: {}", key),
        format!("  model: {}", model),
        "  models:".to_string(),
        format!("    {}:", model),
        format!("      context_length: {}", context_length),
    ]);

    (
        rebuild_custom_providers(&before, &entries, &after),
        !had_key,
    )
}

/// Remove only the `atomic-chat` entry from `custom_providers`,
/// leaving all other user entries intact. A file without our entry is
/// returned as it is.
fn remove_atomic_provider(content: &str) -> String {
    if has_inline_custom_providers(content) {
        return content.to_string();
    }
    let (before, mut entries, after) = split_custom_providers(content);
    if !entries.iter().any(|e| entry_is_ours(e)) {
        return content.to_string();
    }
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
/// untouched (we only fill the gap, never clobber). Also returns what it
/// created, for Disconnect: `providers` (the key), `providers:{}` (an empty
/// inline map turned into a block), `providers.<id>` and
/// `providers.<id>.request_timeout_seconds`.
fn upsert_provider_request_timeout(
    content: &str,
    provider_id: &str,
    seconds: u32,
) -> (String, Vec<String>) {
    let mut lines: Vec<String> = content.lines().map(|s| s.to_string()).collect();
    let mut created: Vec<String> = Vec::new();

    let prov_key_line = format!("  {}:", provider_id);
    let field_line = format!("    request_timeout_seconds: {}", seconds);
    let provider_label = format!("providers.{}", provider_id);
    let field_label = format!("providers.{}.request_timeout_seconds", provider_id);

    // Locate the top-level `providers:` key, whatever follows it on the line.
    let providers = lines
        .iter()
        .enumerate()
        .find_map(|(i, l)| match top_level_yaml_key(l) {
            Some(("providers", value)) => Some((i, value.split_whitespace().collect::<String>())),
            _ => None,
        });

    match providers {
        None => {
            while lines.last().map_or(false, |l| l.trim().is_empty()) {
                lines.pop();
            }
            lines.push("providers:".to_string());
            lines.push(prov_key_line);
            lines.push(field_line);
            created.extend(["providers".to_string(), provider_label, field_label]);
        }
        // Hermes' YAML loader rejects a duplicate key and then runs on its
        // defaults: an inline map we cannot edit line by line is left as it
        // is rather than shadowed by a second `providers:`.
        Some((_, value)) if !value.is_empty() && value != "{}" => {}
        Some((pidx, value)) => {
            if !value.is_empty() {
                lines[pidx] = "providers:".to_string();
                created.push("providers:{}".to_string());
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
            let prov_idx = (pidx + 1..block_end).find(|&i| lines[i].trim_end() == prov_key_line);

            match prov_idx {
                None => {
                    lines.insert(pidx + 1, field_line);
                    lines.insert(pidx + 1, prov_key_line);
                    created.extend([provider_label, field_label]);
                }
                Some(pk) => {
                    let sub_end = provider_sub_block_end(&lines, pk, block_end);
                    let has_field = (pk + 1..sub_end).any(|i| {
                        lines[i]
                            .trim_start()
                            .starts_with("request_timeout_seconds:")
                    });
                    if !has_field {
                        lines.insert(pk + 1, field_line);
                        created.push(field_label);
                    }
                }
            }
        }
    }

    (with_trailing_newline(lines.join("\n")), created)
}

/// End of a provider's sub-block inside `providers:`: the next key at indent
/// <= 2 (a sibling provider) or the block end.
fn provider_sub_block_end(lines: &[String], provider_idx: usize, block_end: usize) -> usize {
    (provider_idx + 1..block_end)
        .find(|&i| {
            let l = &lines[i];
            !l.trim().is_empty() && yaml_indent(l) <= 2
        })
        .unwrap_or(block_end)
}

/// Remove what [`upsert_provider_request_timeout`] created, as long as the
/// timeout still holds the value it wrote.
fn remove_provider_request_timeout(
    content: &str,
    provider_id: &str,
    seconds: u32,
    created: &[String],
) -> String {
    let made = |label: &str| created.iter().any(|c| c == label);
    let provider_label = format!("providers.{}", provider_id);
    let field_label = format!("providers.{}.request_timeout_seconds", provider_id);
    if !made(&field_label) {
        return content.to_string();
    }
    let mut lines: Vec<String> = content.lines().map(str::to_string).collect();
    let Some(pidx) = lines
        .iter()
        .position(|l| matches!(top_level_yaml_key(l), Some(("providers", ""))))
    else {
        return content.to_string();
    };
    let block_end = |lines: &[String]| {
        (pidx + 1..lines.len())
            .find(|&i| is_top_level_yaml_key(&lines[i]))
            .unwrap_or(lines.len())
    };
    let prov_key_line = format!("  {}:", provider_id);
    let Some(pk) = (pidx + 1..block_end(&lines)).find(|&i| lines[i].trim_end() == prov_key_line)
    else {
        return content.to_string();
    };
    let sub_end = provider_sub_block_end(&lines, pk, block_end(&lines));
    let Some(field) = (pk + 1..sub_end).find(|&i| {
        lines[i]
            .trim()
            .strip_prefix("request_timeout_seconds:")
            .is_some_and(|v| strip_yaml_comment(v).trim() == seconds.to_string())
    }) else {
        return content.to_string();
    };
    lines.remove(field);

    let sub_end = provider_sub_block_end(&lines, pk, block_end(&lines));
    if made(&provider_label) && lines[pk + 1..sub_end].iter().all(|l| l.trim().is_empty()) {
        lines.remove(pk);
    }
    let end = block_end(&lines);
    if lines[pidx + 1..end]
        .iter()
        .all(|l| is_blank_or_yaml_comment(l))
    {
        if made("providers") {
            lines.remove(pidx);
        } else if made("providers:{}") {
            lines[pidx] = "providers: {}".to_string();
        }
    }
    if lines.is_empty() {
        return String::new();
    }
    with_trailing_newline(lines.join("\n"))
}

// ---------------------------------------------------------------------------
// External coding-agent / assistant integrations (Launch page)
// ---------------------------------------------------------------------------

pub(crate) const ATOMIC_MANAGED_BEGIN: &str = "# >>> Atomic Chat (managed) >>>";
pub(crate) const ATOMIC_MANAGED_END: &str = "# <<< Atomic Chat (managed) <<<";

/// Resolve the user's home directory in a platform-aware way.
pub(crate) fn agent_home_dir() -> Result<String, String> {
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

/// Parse a leading `major.minor.patch` out of a `--version` line, tolerating a
/// `v` prefix and a `-beta.1` / `+build` suffix.
pub(crate) fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let core = text.trim().trim_start_matches('v');
    let core = core.split(['-', '+', ' ']).next()?;
    let mut parts = core.split('.');
    let major: u64 = parts.next()?.parse().ok()?;
    let minor: u64 = parts.next().unwrap_or("0").parse().ok()?;
    let patch: u64 = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// Run `<tool> --version` against the user's real PATH and parse the result.
///
/// Windows routes through `cmd /C` because `npm` there is `npm.cmd`, a batch
/// shim `CreateProcessW` refuses to execute directly (rust-lang/rust#37519) —
/// the same reason the npm installer below does it.
fn tool_version(tool: &str) -> Option<(u64, u64, u64)> {
    parse_version(&tool_version_text(tool)?)
}

/// What `<tool> --version` prints, for tools that put a name before the number.
pub(crate) fn tool_version_text(tool: &str) -> Option<String> {
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", tool, "--version"]);
        c
    } else {
        let mut c = std::process::Command::new(tool);
        c.arg("--version");
        c
    };
    apply_login_path(&mut cmd);
    apply_runtime_path(&mut cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// npm gained per-package lifecycle-script approval (`--allow-scripts=<pkg>`)
/// in 11.16; older npm rejects it as an unknown flag, so it has to be
/// version-gated rather than always passed. OpenClaw's install docs make the
/// same split ("On npm 11.15 and earlier, omit `--allow-scripts=openclaw`").
const NPM_ALLOW_SCRIPTS_MIN: (u64, u64, u64) = (11, 16, 0);

/// npm-installed agents whose package runs an install script (`npm view
/// <pkg> scripts`): the script is what links or downloads the binary, and npm
/// 12 skips unapproved install scripts while still reporting success.
const NPM_PACKAGES_WITH_INSTALL_SCRIPTS: &[&str] = &[
    "@anthropic-ai/claude-code",
    "opencode-ai",
    "@kilocode/cli",
    "cline",
    "droid",
    "@mimo-ai/cli",
    "openclaw",
];

/// The `--allow-scripts` flag an npm global install of `package` needs, given
/// the npm version on PATH: none for a package without install scripts, and
/// none when npm predates the flag (it runs every script anyway) or its
/// version could not be read.
fn npm_allow_scripts_arg(package: &str, npm: Option<(u64, u64, u64)>) -> Option<String> {
    let needs_scripts = NPM_PACKAGES_WITH_INSTALL_SCRIPTS.contains(&package);
    let understood = npm.is_some_and(|v| v >= NPM_ALLOW_SCRIPTS_MIN);
    (needs_scripts && understood).then(|| format!("--allow-scripts={}", package))
}

/// Arguments that run `script` in Windows PowerShell for an installer. The
/// default execution policy (Restricted on Windows client) refuses `.ps1`
/// files, and an installer script calling `npm` reaches npm's `npm.ps1` shim;
/// `Bypass` applies to this process only.
fn powershell_script(script: &str) -> Vec<String> {
    vec![
        "-NoProfile".to_string(),
        "-ExecutionPolicy".to_string(),
        "Bypass".to_string(),
        "-Command".to_string(),
        script.to_string(),
    ]
}

const CLAUDE_CODE_DOCS: &str = "https://code.claude.com/docs/en/setup";

/// The installer to try when an agent's own one fails: Claude Code's npm
/// package, behind its native installer.
fn agent_install_fallback(
    agent_id: &str,
) -> Option<(String, Vec<String>, &'static str, &'static str)> {
    (agent_id == "claude-code").then(|| {
        let (program, args) = npm_global_install("@anthropic-ai/claude-code");
        (program, args, "npm", CLAUDE_CODE_DOCS)
    })
}

/// `npm install -g <pkg>`. On Windows `npm` is `npm.cmd` (a batch shim).
/// Rust's `std::process::Command` spawns via `CreateProcessW`, which only
/// resolves `.exe` on PATH and refuses to execute `.cmd`/`.bat` directly
/// (rust-lang/rust#37519). Route through `cmd.exe` so the shim is found and run.
fn npm_global_install(pkg: &str) -> (String, Vec<String>) {
    if cfg!(windows) {
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
}

/// OpenClaw's published `engines`: `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`.
/// npm only *warns* on an engines mismatch, so on an unsupported Node the
/// install "succeeds" and every later `openclaw` invocation fails instead —
/// which reads as a broken integration rather than a Node problem.
fn node_meets_openclaw_engines((major, minor, patch): (u64, u64, u64)) -> bool {
    match major {
        ..=21 => false,
        22 => (minor, patch) >= (22, 3),
        23 => false, // explicitly unsupported, not merely old
        24 => minor >= 15,
        25 => minor >= 9,
        _ => true,
    }
}

/// Installer spec for an agent: (program, args, prerequisite_binary, docs_url).
/// Verified against each vendor's official install path:
///   - Claude Code ships a native installer (npm is its fallback, see
///     `agent_install_fallback`).
///   - Codex / OpenCode / OpenClaw ship as global npm packages.
///   - Hermes is a Python project installed via its official shell / PowerShell
///     bootstrap script (NOT npm).
///
/// Unix installers that pipe `curl` into a shell use Bash `pipefail`; otherwise
/// a download failure is hidden by the trailing shell's successful empty input.
fn agent_install_spec(
    agent_id: &str,
) -> Result<(String, Vec<String>, &'static str, &'static str), String> {
    let npm = npm_global_install;

    match agent_id {
        "claude-code" => {
            // Anthropic's native installer is the recommended path: npm 12
            // skips the npm package's postinstall, which is what puts the
            // binary in place, and the native install updates itself without
            // npm. It writes `~/.local/bin/claude` (`%USERPROFILE%\.local\bin`)
            // and leaves PATH alone, which detection covers. npm stays the
            // fallback (`agent_install_fallback`).
            let (program, args): (String, Vec<String>) = if cfg!(windows) {
                (
                    "powershell".to_string(),
                    powershell_script("irm https://claude.ai/install.ps1 | iex"),
                )
            } else {
                (
                    "bash".to_string(),
                    vec![
                        "-c".to_string(),
                        "set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash"
                            .to_string(),
                    ],
                )
            };
            let prereq = if cfg!(windows) { "powershell" } else { "curl" };
            Ok((program, args, prereq, CLAUDE_CODE_DOCS))
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
            Ok((
                p,
                a,
                "npm",
                "https://docs.cline.bot/cline-cli/getting-started",
            ))
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
        "dsh" => {
            let (p, a) = npm("@deepseek-ai/dsh");
            Ok((
                p,
                a,
                "npm",
                "https://github.com/deepseek-ai/deepseek-harness",
            ))
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
                    powershell_script("$env:CONFIGURE='false'; irm https://github.com/block/goose/releases/download/stable/download_cli.ps1 | iex"),
                )
            } else {
                (
                    "bash".to_string(),
                    vec![
                        "-c".to_string(),
                        "set -o pipefail; curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash".to_string(),
                    ],
                )
            };
            let prereq = if cfg!(windows) { "powershell" } else { "curl" };
            Ok((program, args, prereq, "https://block.github.io/goose/"))
        }
        "atomic-agent" => {
            // Atomic Agent ships as a Node SEA binary through its own bootstrap
            // script (NOT npm): the shell script drops the CLI plus its support
            // assets into `~/.local/bin`, the PowerShell one into
            // `%LOCALAPPDATA%\atomic-agent`, and both add that directory to the
            // user PATH. Neither prompts, so there is no wizard to skip — the
            // config is written by `configure_atomic_agent` either way.
            let (program, args): (String, Vec<String>) = if cfg!(windows) {
                (
                    "powershell".to_string(),
                    powershell_script("irm https://atomicagent.io/install.ps1 | iex"),
                )
            } else {
                (
                    "bash".to_string(),
                    vec![
                        "-c".to_string(),
                        "set -o pipefail; curl -fsSL https://atomicagent.io/install | sh"
                            .to_string(),
                    ],
                )
            };
            let prereq = if cfg!(windows) { "powershell" } else { "curl" };
            Ok((
                program,
                args,
                prereq,
                "https://github.com/AtomicBot-ai/atomic-agent",
            ))
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
                    powershell_script("iex \"& { $(irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1) } -SkipSetup -NonInteractive\""),
                )
            } else {
                (
                    "bash".to_string(),
                    vec![
                        "-c".to_string(),
                        "set -o pipefail; curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup --non-interactive".to_string(),
                    ],
                )
            };
            let prereq = if cfg!(windows) { "powershell" } else { "curl" };
            Ok((
                program,
                args,
                prereq,
                "https://github.com/NousResearch/hermes-agent",
            ))
        }
        "openclaude" => {
            let (p, a) = npm("@gitlawb/openclaude");
            Ok((p, a, "npm", "https://github.com/Gitlawb/openclaude"))
        }
        "poolside" => {
            // Poolside ships via an official shell / PowerShell bootstrap script.
            // `POOL_INSTALL_ACCEPT_EULA=1` skips the interactive EULA prompt so
            // the installer doesn't hang reading from /dev/tty when spawned from
            // the app, and `POOL_INSTALL_UPDATE_PATH=1` makes it drop the `pool`
            // binary onto PATH (via the user's shell rc) instead of the default
            // `ask` mode, which no-ops when there's no TTY — otherwise `pool`
            // installs to ~/.local/bin but stays undetectable. We still write the
            // agent's config ourselves via `configure_poolside`.
            //
            // On the Unix side the env vars MUST sit on the `sh` that actually
            // runs the piped script, NOT on the leading `curl`: in
            // `VAR=1 curl ... | sh` the assignment applies only to curl's
            // environment and the downstream `sh` never sees it, so the installer
            // fell back to the interactive EULA prompt and failed with
            // "/dev/tty: Device not configured" (ATO-… Poolside promo). Windows
            // is unaffected because `$env:` sets the var for the whole session
            // before `iex` runs, and PowerShell's installer defaults UpdatePath
            // to true.
            let (program, args): (String, Vec<String>) = if cfg!(windows) {
                (
                    "powershell".to_string(),
                    powershell_script("$env:POOL_INSTALL_ACCEPT_EULA='1'; irm https://downloads.poolside.ai/pool/install.ps1 | iex"),
                )
            } else {
                (
                    "bash".to_string(),
                    vec![
                        "-c".to_string(),
                        "set -o pipefail; curl -fsSL https://downloads.poolside.ai/pool/install.sh | POOL_INSTALL_ACCEPT_EULA=1 POOL_INSTALL_UPDATE_PATH=1 sh".to_string(),
                    ],
                )
            };
            let prereq = if cfg!(windows) { "powershell" } else { "curl" };
            Ok((program, args, prereq, "https://docs.poolside.ai/cli"))
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
                        // `Zed.Zed` is not in the winget catalog.
                        "ZedIndustries.Zed".to_string(),
                        "-e".to_string(),
                        "--accept-package-agreements".to_string(),
                        "--accept-source-agreements".to_string(),
                    ],
                    "winget",
                    "https://zed.dev/docs/windows",
                ))
            } else {
                Ok((
                    "bash".to_string(),
                    vec![
                        "-c".to_string(),
                        "set -o pipefail; curl -fsSL https://zed.dev/install.sh | sh".to_string(),
                    ],
                    "curl",
                    "https://zed.dev/docs/getting-started",
                ))
            }
        }
        "muse" => {
            // Meta ships Muse Code through an official shell installer only --
            // there is no PowerShell or npm equivalent (`/install.ps1` on the
            // same host is a 404). Windows users install it inside WSL and run
            // it from that shell, so fail with that instruction rather than
            // spawning an installer that cannot work.
            if cfg!(windows) {
                return Err(
                    "Muse Code has no native Windows installer. Install it inside WSL with \
                     'curl -fsSL https://dev.meta.ai/install.sh | bash' and run it from your \
                     WSL shell: https://developer.meta.com/ai/products/muse-code/"
                        .to_string(),
                );
            }
            // The script is bash (`[[ … ]]` throughout); `sh` is dash on
            // Debian/Ubuntu, where it fails on the first test.
            Ok((
                "bash".to_string(),
                vec![
                    "-c".to_string(),
                    "set -o pipefail; curl -fsSL https://dev.meta.ai/install.sh | bash".to_string(),
                ],
                "curl",
                "https://developer.meta.com/ai/products/muse-code/",
            ))
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
/// cached (one shell spawn, not one per probe) until an install changes it
/// ([`forget_login_shell_path`]).
///
/// A sentinel wraps the value so rc files that echo to stdout don't corrupt it.
/// Returns `None` on probe failure, or when the shell has not answered within
/// [`LOGIN_SHELL_TIMEOUT`] (an rc file waiting on the network or for input);
/// callers then fall back to the inherited PATH.
#[cfg(not(windows))]
pub(crate) fn login_shell_path() -> Option<String> {
    let mut cached = LOGIN_SHELL_PATH.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(path) = cached.as_ref() {
        return path.clone();
    }
    let probed = probe_login_shell_path();
    *cached = Some(probed.clone());
    probed
}

#[cfg(not(windows))]
static LOGIN_SHELL_PATH: std::sync::Mutex<Option<Option<String>>> = std::sync::Mutex::new(None);

/// How long the login shell may take to print its PATH.
#[cfg(not(windows))]
const LOGIN_SHELL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[cfg(not(windows))]
fn probe_login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // `-l` sources login files (.zprofile/.bash_profile, where Homebrew
    // shellenv usually lives); `-i` sources interactive rc files
    // (.zshrc/.bashrc, where nvm usually lives).
    let mut command = std::process::Command::new(&shell);
    command.args(["-lic", "printf '__OCPATH__%s__OCEND__' \"$PATH\""]);
    sanitize_std_command(&mut command);
    let Some((status, stdout)) = super::agent_process::output_within(command, LOGIN_SHELL_TIMEOUT)
    else {
        log::warn!(
            "{} did not print its PATH within {}s; using the inherited PATH",
            shell,
            LOGIN_SHELL_TIMEOUT.as_secs()
        );
        return None;
    };
    if !status.success() {
        return None;
    }
    login_path_from_output(&String::from_utf8_lossy(&stdout))
}

/// The PATH between the probe's sentinels, if it printed one.
#[cfg(not(windows))]
fn login_path_from_output(s: &str) -> Option<String> {
    let start = s.find("__OCPATH__")? + "__OCPATH__".len();
    let end = s[start..].find("__OCEND__")? + start;
    let path = s[start..end].trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

/// Read the login-shell PATH again on next use: an installer may have added a
/// directory to it (Poolside's, Goose's and uv's write a shell rc line).
pub(crate) fn forget_login_shell_path() {
    #[cfg(not(windows))]
    {
        *LOGIN_SHELL_PATH.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// Augment a spawned command's PATH with the user's login-shell PATH so GUI
/// builds can find user-installed tools (`npm`/`node`, agent binaries). No-op
/// on Windows, where processes inherit the registry (user/system) PATH.
#[cfg(not(windows))]
fn apply_login_path(cmd: &mut std::process::Command) {
    sanitize_std_command(cmd);
    if let Some(path) = login_shell_path() {
        cmd.env("PATH", path);
    }
}

#[cfg(windows)]
fn apply_login_path(_cmd: &mut std::process::Command) {}

/// The PATH a spawned tool lookup should see: the login shell's on
/// macOS/Linux, the freshly read registry PATH on Windows.
pub(crate) fn apply_tool_path(cmd: &mut std::process::Command) {
    apply_login_path(cmd);
    apply_runtime_path(cmd);
}

/// A console tool (`setx`, `reg`) started without flashing a console window
/// over the app on Windows.
pub(crate) fn hidden_console_command(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Re-read the persisted Windows PATH (User + Machine) from the registry and
/// merge it with the live process PATH. The GUI snapshots PATH once at startup
/// via `fix_path_env::fix()`, so a Node/npm installed after launch is invisible
/// to spawned subprocesses until restart; reading the registry here recovers it.
/// Returns the merged, de-duplicated PATH, or None if the registry read failed.
#[cfg(windows)]
fn refresh_windows_path() -> Option<String> {
    // Read from the registry, not through two PowerShell processes per probe
    // whose stdout is in the console code page (non-ASCII entries came back
    // mangled and never resolved). `REG_EXPAND_SZ` entries are expanded.
    let user = super::windows_path::read_scope_path(false);
    let machine = super::windows_path::read_scope_path(true);

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
    let chunks: Vec<&str> = [
        machine.as_deref(),
        user.as_deref(),
        npm_global.as_deref(),
        Some(live.as_str()),
    ]
    .into_iter()
    .flatten()
    .collect();
    super::windows_path::merge_path_lists(&chunks)
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
pub(crate) fn decode_console_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let code_page = unsafe { windows_sys::Win32::Globalization::GetOEMCP() };
            decode_oem(bytes, code_page).unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned())
        }
    }
}

/// Decode a byte buffer using a Windows code page (the current OEM page in production).
#[cfg(windows)]
fn decode_oem(bytes: &[u8], code_page: u32) -> Option<String> {
    use windows_sys::Win32::Globalization::MultiByteToWideChar;
    if bytes.is_empty() {
        return Some(String::new());
    }
    let len = bytes.len() as i32;
    // First pass: required wide-char count.
    let needed =
        unsafe { MultiByteToWideChar(code_page, 0, bytes.as_ptr(), len, std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return None;
    }
    let mut buf: Vec<u16> = vec![0; needed as usize];
    let written =
        unsafe { MultiByteToWideChar(code_page, 0, bytes.as_ptr(), len, buf.as_mut_ptr(), needed) };
    if written <= 0 {
        return None;
    }
    buf.truncate(written as usize);
    Some(String::from_utf16_lossy(&buf))
}

#[cfg(not(windows))]
pub(crate) fn decode_console_bytes(bytes: &[u8]) -> String {
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
    for (key, value) in proxy_env_vars(proxy) {
        cmd.env(key, value);
    }
}

/// The variables [`apply_proxy_env`] sets, for a child that gets them some
/// other way (the agent launcher script exports them). Empty without a URL.
pub(crate) fn proxy_env_vars(proxy: &ProxyEnv) -> Vec<(String, String)> {
    let url = proxy.url.trim();
    if url.is_empty() {
        return Vec::new();
    }
    let full = proxy_url_with_auth(url, proxy.username.as_deref(), proxy.password.as_deref());
    let mut vars: Vec<(String, String)> = Vec::new();

    for key in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        vars.push((key.to_string(), full.clone()));
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
    vars.push(("NO_PROXY".to_string(), no_proxy.clone()));
    vars.push(("no_proxy".to_string(), no_proxy));
    vars
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

/// Launcher locations an agent's installer can write to without ever putting
/// the binary on `PATH`, keyed by detect binary.
///
/// OpenClaw is the case that forced this. Its prefix installer (`install-cli.sh`)
/// writes the launcher to `<prefix>/bin/openclaw` and leaves `PATH` alone, and
/// the macOS app runs exactly that installer during its own onboarding — so
/// *every* user who installed the desktop app rather than the npm package has a
/// working OpenClaw that `which openclaw` cannot see. The git method of
/// `install.sh` / `install.ps1` lands in `~/.local/bin` for the same reason.
/// Without these candidates the Launch page reports OpenClaw as missing and
/// offers to install a second copy on top of the app's.
///
/// ZCode is a desktop app that never touches `PATH` outside Linux, so its
/// candidates are the app executables its installers write
/// ([`zcode_app_candidates`]). The editors are found through their app
/// bundles and install folders when their command-line launcher is not on
/// `PATH` ([`editor_launcher_candidates`]): Zed's DMG links no `zed`, VS Code
/// and JetBrains IDEs link theirs only on request, and Xcode has none.
///
/// Every terminal agent can also sit in a per-user bin directory its installer
/// wrote without the current PATH knowing yet: `~/.local/bin` (Claude Code's
/// native installer, Goose, Poolside, Hermes), uv's tool bin directory
/// (OpenHands) and, on Windows, `%APPDATA%\npm`. npm's configured global bin
/// directory costs an `npm` run, so only [`resolve_off_path`] asks for it.
/// Editors and desktop apps get no guesses beyond their own.
pub fn off_path_candidates(bin: &str) -> Vec<PathBuf> {
    match bin {
        "openclaw" => {
            let mut candidates = openclaw_off_path_candidates();
            candidates.extend(user_bin_candidates(bin, None));
            candidates
        }
        "zcode" => zcode_app_candidates(),
        "zed" | "code" | "idea" | "xcode" => match agent_home_dir() {
            Ok(home) => editor_launcher_candidates(
                bin,
                HostOs::current(),
                Path::new(&home),
                Path::new("/Applications"),
                &process_env,
            ),
            Err(_) => Vec::new(),
        },
        _ => user_bin_candidates(bin, None),
    }
}

/// A terminal agent's launcher in the per-user bin directories, plus
/// `npm_bin` when given (see [`super::agent_lookup::terminal_agent_candidates`]).
fn user_bin_candidates(bin: &str, npm_bin: Option<&Path>) -> Vec<PathBuf> {
    let Ok(home) = agent_home_dir() else {
        return Vec::new();
    };
    super::agent_lookup::terminal_agent_candidates(
        bin,
        Path::new(&home),
        &|name| std::env::var(name).ok(),
        npm_bin,
        cfg!(windows),
    )
}

fn openclaw_off_path_candidates() -> Vec<PathBuf> {
    let Ok(home) = agent_home_dir() else {
        return Vec::new();
    };
    let home = PathBuf::from(home);

    // `--prefix` / `OPENCLAW_PREFIX` relocates the whole install, so honour an
    // explicit prefix before falling back to the installer's defaults.
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(prefix) = std::env::var("OPENCLAW_PREFIX")
        .ok()
        .filter(|p| !p.trim().is_empty())
    {
        roots.push(PathBuf::from(prefix));
    }
    roots.push(home.join(".openclaw"));
    roots.push(home.join(".local"));

    // Windows launchers are `.cmd` shims; POSIX ones are extensionless.
    let names: &[&str] = if cfg!(windows) {
        &["openclaw.cmd", "openclaw.exe", "openclaw"]
    } else {
        &["openclaw"]
    };

    let mut out = Vec::with_capacity(roots.len() * names.len());
    for root in roots {
        for name in names {
            out.push(root.join("bin").join(name));
        }
    }
    out
}

/// First [`off_path_candidates`] entry that exists on disk, then (terminal
/// agents only) the launcher in npm's global bin directory. Blocking: the npm
/// lookup runs `npm prefix -g` once per session.
pub fn resolve_off_path(bin: &str) -> Option<PathBuf> {
    if let Some(found) = off_path_candidates(bin).into_iter().find(|p| p.is_file()) {
        return Some(found);
    }
    if !super::agent_lookup::is_terminal_agent(bin) {
        return None;
    }
    let npm_bin = super::agent_lookup::npm_global_bin()?;
    user_bin_candidates(bin, Some(&npm_bin))
        .into_iter()
        .find(|p| p.is_file())
}

/// Result of probing whether an external CLI agent is reachable.
///
/// `rename_all` matters: the Launch page reads `viaWsl`, and without it serde
/// emits `via_wsl`, so the "Installed (WSL)" badge never rendered.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetection {
    /// Whether the binary was found (native PATH, WSL, or a user-supplied path).
    pub installed: bool,
    /// True only when the binary was found inside a WSL distribution (Windows),
    /// where it is reachable via `wsl.exe` but not from the native Win32 PATH.
    pub via_wsl: bool,
    /// Absolute path to the launcher when it was found *off* `PATH` — either a
    /// user-supplied custom path or one of
    /// [`integrations::off_path_candidates`]. `None` when the bare name
    /// resolves on `PATH`, so callers keep opening terminals with the short
    /// command instead of an absolute path nobody wants to read.
    pub path: Option<String>,
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
///
/// Each probe can boot the WSL VM, so the answers are kept for the session:
/// which distribution to ask (none when the only ones are Atomic Chat's own
/// or Docker Desktop's) and, per binary, whether it was there.
#[cfg(windows)]
async fn detect_via_wsl(bin: &str) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static DISTRIBUTION: OnceLock<Option<String>> = OnceLock::new();
    static FOUND: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();

    let bin = bin.to_string();
    tokio::task::spawn_blocking(move || {
        let found = FOUND.get_or_init(|| Mutex::new(HashMap::new()));
        if let Some(known) = found.lock().ok().and_then(|f| f.get(&bin).copied()) {
            return known;
        }
        let present = match DISTRIBUTION.get_or_init(wsl_user_distribution) {
            Some(distribution) => wsl_has_command(distribution, &bin),
            None => false,
        };
        if let Ok(mut f) = found.lock() {
            f.insert(bin, present);
        }
        present
    })
    .await
    .unwrap_or(false)
}

/// `wsl.exe` with output in UTF-8 where WSL supports it, and no console window.
#[cfg(windows)]
fn wsl_command() -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.env("WSL_UTF8", "1");
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}

/// The user's WSL distribution to look in. Listing does not start the VM.
#[cfg(windows)]
fn wsl_user_distribution() -> Option<String> {
    let mut cmd = wsl_command();
    cmd.args(["--list", "--verbose"]);
    let (status, out) =
        super::agent_process::output_within(cmd, std::time::Duration::from_secs(10))?;
    if !status.success() {
        return None;
    }
    super::agent_lookup::pick_wsl_distribution(&super::agent_lookup::decode_wsl_output(&out))
}

#[cfg(windows)]
fn wsl_has_command(distribution: &str, bin: &str) -> bool {
    let mut cmd = wsl_command();
    cmd.args([
        "-d",
        distribution,
        "-e",
        "sh",
        "-lc",
        &format!("command -v {}", bin),
    ]);
    matches!(
        super::agent_process::output_within(cmd, std::time::Duration::from_secs(20)),
        Some((status, out)) if status.success() && !String::from_utf8_lossy(&out).trim().is_empty()
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
pub async fn detect_agent_installed(bin: String, custom_path: Option<String>) -> AgentDetection {
    if let Some(path) = custom_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        let installed = std::path::Path::new(path).is_file();
        return AgentDetection {
            installed,
            via_wsl: false,
            path: installed.then(|| path.to_string()),
        };
    }

    if detect_on_native_path(&bin).await {
        return AgentDetection {
            installed: true,
            via_wsl: false,
            path: None,
        };
    }

    // Prefix installers (the one the macOS OpenClaw app runs during its own
    // onboarding included) never touch PATH, so probe their known locations
    // before declaring the agent missing and offering to install a second copy.
    let off_path_bin = bin.clone();
    if let Some(found) = tokio::task::spawn_blocking(move || resolve_off_path(&off_path_bin))
        .await
        .ok()
        .flatten()
    {
        return AgentDetection {
            installed: true,
            via_wsl: false,
            path: Some(found.to_string_lossy().into_owned()),
        };
    }

    #[cfg(windows)]
    {
        if detect_via_wsl(&bin).await {
            return AgentDetection {
                installed: true,
                via_wsl: true,
                path: None,
            };
        }
    }

    AgentDetection {
        installed: false,
        via_wsl: false,
        path: None,
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
    if !detect_on_native_path("winget").await {
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
        use super::agent_process::{run_streaming, StreamEnd, INSTALLER_TIMEOUT};
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        let mut cmd = Command::new("winget");
        cmd.args([
            "install",
            "--id",
            "OpenJS.NodeJS.LTS",
            "-e",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
        ]);
        apply_runtime_path(&mut cmd);
        if let Some(ref proxy) = proxy {
            apply_proxy_env(&mut cmd, proxy);
        }
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        let log = app.clone();
        let log_event = ev.clone();
        match run_streaming(cmd, INSTALLER_TIMEOUT, |line| {
            let _ = log.emit(&log_event, line);
        }) {
            Ok((StreamEnd::Exited(status), _)) => status.success(),
            Ok((StreamEnd::TimedOut, _)) => {
                let _ = app.emit(
                    &ev,
                    format!(
                        "winget did not finish within {} minutes and was stopped.",
                        INSTALLER_TIMEOUT.as_secs() / 60
                    ),
                );
                false
            }
            Err(e) => {
                let _ = app.emit(&ev, format!("Failed to spawn winget: {}", e));
                false
            }
        }
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

    // winget adds the Node install dir to PATH; `detect_on_native_path`
    // re-reads the registry PATH at runtime, so npm is found without a restart.
    // (Not `detect_agent_installed`: an npm inside WSL cannot run this install.)
    detect_on_native_path("npm").await
}

#[cfg(not(windows))]
async fn try_bootstrap_npm_via_winget<R: Runtime>(
    _app_handle: &AppHandle<R>,
    _event: &str,
    _proxy: Option<ProxyEnv>,
) -> bool {
    false
}

/// (program, args, prerequisite binary, docs URL), as `agent_install_spec`
/// returns it.
type InstallSpec = (String, Vec<String>, &'static str, &'static str);

/// Install an external agent by spawning its official installer, streaming
/// stdout/stderr to the UI via the `agent_install_log:<agent_id>` event.
/// Claude Code's npm package is tried when its native installer cannot run or
/// fails.
#[tauri::command]
pub async fn install_agent<R: Runtime>(
    app_handle: AppHandle<R>,
    agent_id: String,
    proxy: Option<ProxyEnv>,
) -> Result<(), String> {
    let primary = agent_install_spec(&agent_id)?;
    let attempts: Vec<InstallSpec> = std::iter::once(primary)
        .chain(agent_install_fallback(&agent_id))
        .collect();
    let result = install_agent_attempts(&app_handle, &agent_id, attempts, proxy).await;
    // Whatever the installer got to, it may have created a bin directory or
    // added a PATH line: detection has to look again instead of answering
    // from what it cached before.
    super::agent_lookup::forget_install_lookups();
    result
}

async fn install_agent_attempts<R: Runtime>(
    app_handle: &AppHandle<R>,
    agent_id: &str,
    attempts: Vec<InstallSpec>,
    proxy: Option<ProxyEnv>,
) -> Result<(), String> {
    let event = format!("agent_install_log:{}", agent_id);
    let count = attempts.len();
    let mut last_error = String::new();
    for (index, (program, args, prereq, docs)) in attempts.into_iter().enumerate() {
        let has_fallback = index + 1 < count;
        let attempt = async {
            let program = installer_program(
                app_handle,
                &event,
                program,
                prereq,
                docs,
                proxy.clone(),
                !has_fallback,
            )
            .await?;
            let args = installer_args(agent_id, args, prereq, docs).await?;
            run_installer(app_handle, &event, agent_id, program, args, proxy.clone()).await
        };
        match attempt.await {
            Ok(()) => {
                log::info!("Agent '{}' installed successfully", agent_id);
                return Ok(());
            }
            Err(e) if has_fallback => {
                log::warn!(
                    "Installer for '{}' failed, trying the next one: {}",
                    agent_id,
                    e
                );
                let _ = app_handle.emit(&event, format!("{} Trying npm instead...", e));
                last_error = e;
            }
            Err(e) => return Err(e),
        }
    }
    Err(last_error)
}

/// The program to start for an installer whose prerequisite is `prereq`:
/// `program` when the prerequisite is on PATH, the app's bundled `uv` when
/// that is the missing one, and npm after installing Node.js through winget
/// when `may_bootstrap` (the last installer tried). Otherwise an error that
/// says what to install.
async fn installer_program<R: Runtime>(
    app_handle: &AppHandle<R>,
    event: &str,
    program: String,
    prereq: &'static str,
    docs: &'static str,
    proxy: Option<ProxyEnv>,
    may_bootstrap: bool,
) -> Result<String, String> {
    // `detect_on_native_path` re-reads the registry PATH at runtime on Windows
    // so a Node/npm installed after the app launched (or present in the registry
    // but not the GUI's snapshotted PATH) is found without an app restart.
    if detect_on_native_path(prereq).await {
        return Ok(program);
    }
    // OpenHands installs through `uv tool install`; the app ships uv for its
    // MCP servers, so a machine without uv on PATH can still install it.
    if prereq == "uv" {
        if let Some(uv) = bundled_uv(app_handle) {
            let _ = app_handle.emit(
                event,
                format!("uv not found on PATH; using {}", uv.display()),
            );
            return Ok(uv.to_string_lossy().into_owned());
        }
    }
    // For npm-based agents on Windows, try to auto-install Node.js (which
    // bundles npm) via winget before giving up, so the Launch flow works on
    // a fresh machine. Falls back to the actionable error when winget is
    // unavailable or the install fails.
    if prereq == "npm"
        && may_bootstrap
        && try_bootstrap_npm_via_winget(app_handle, event, proxy).await
    {
        return Ok(program);
    }
    Err(format!(
        "'{}' is required to install this agent but was not found on PATH. \
         Install it (Node.js from https://nodejs.org for npm-based agents), \
         then restart Atomic Chat and try again: {}",
        prereq, docs
    ))
}

/// The bundled `uv`: next to the app executable (Tauri `externalBin`), or in
/// the bundled `resources/bin` of a dev build.
fn bundled_uv<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        dirs.push(dir);
    }
    if let Ok(resources) = app_handle.path().resource_dir() {
        dirs.push(resources.join("resources").join("bin"));
    }
    super::agent_lookup::bundled_tool(&dirs, "uv")
}

/// The installer's arguments once the prerequisite has settled: npm installs
/// get `--allow-scripts=<pkg>` where npm needs it (see
/// [`npm_allow_scripts_arg`]), and OpenClaw refuses a Node it does not support.
async fn installer_args(
    agent_id: &str,
    mut args: Vec<String>,
    prereq: &str,
    docs: &str,
) -> Result<Vec<String>, String> {
    if prereq != "npm" {
        return Ok(args);
    }
    // OpenClaw pins a narrow set of Node releases. Checked after the npm
    // prerequisite (and any winget bootstrap) has settled, so we read the
    // Node that will actually run the agent.
    if agent_id == "openclaw" {
        let node = tokio::task::spawn_blocking(|| tool_version("node"))
            .await
            .unwrap_or(None);
        // A missing/unparsable version is not treated as a failure: npm was
        // found, so Node exists, and guessing wrong here would block a working
        // install.
        if let Some(version) = node.filter(|v| !node_meets_openclaw_engines(*v)) {
            return Err(format!(
                "OpenClaw requires Node.js 22.22.3+, 24.15+ or 25.9+ (Node 23 is not supported), \
                 but v{}.{}.{} is on your PATH. Update Node from https://nodejs.org, \
                 then restart Atomic Chat and try again: {}",
                version.0, version.1, version.2, docs
            ));
        }
    }
    // The package is the last argument of `npm install -g <pkg>`.
    let package = args.last().cloned().unwrap_or_default();
    if NPM_PACKAGES_WITH_INSTALL_SCRIPTS.contains(&package.as_str()) {
        let npm = tokio::task::spawn_blocking(|| tool_version("npm"))
            .await
            .unwrap_or(None);
        args.extend(npm_allow_scripts_arg(&package, npm));
    }
    Ok(args)
}

/// Run one installer to its end (or [`super::agent_process::INSTALLER_TIMEOUT`]),
/// streaming its log, and say why it failed.
async fn run_installer<R: Runtime>(
    app_handle: &AppHandle<R>,
    event: &str,
    agent_id: &str,
    program: String,
    args: Vec<String>,
    proxy: Option<ProxyEnv>,
) -> Result<(), String> {
    use super::agent_process::{run_streaming, StreamEnd, INSTALLER_TIMEOUT};

    let app = app_handle.clone();
    let ev = event.to_string();
    let (end, captured) = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(&program);
        cmd.args(&args);
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
        run_streaming(cmd, INSTALLER_TIMEOUT, |line| {
            let _ = app.emit(&ev, line);
        })
        .map_err(|e| format!("Failed to spawn '{}': {}", program, e))
    })
    .await
    .map_err(|e| e.to_string())??;

    match end {
        StreamEnd::Exited(status) if status.success() => Ok(()),
        StreamEnd::TimedOut => Err(format!(
            "The installer for '{}' did not finish within {} minutes and was stopped. \
             It may be waiting for input or a stalled download; check your network or \
             proxy and try again. See the install log for details.",
            agent_id,
            INSTALLER_TIMEOUT.as_secs() / 60
        )),
        StreamEnd::Exited(_) if output_indicates_network_failure(&captured) => Err(format!(
            "The installer for '{}' could not reach the network (DNS/connection \
             failure). If you are behind a region block, configure a proxy in \
             Settings -> HTTPS Proxy and try again. Note: SOCKS proxies may not \
             work for npm/PowerShell-based installers - prefer an HTTP/HTTPS \
             proxy for these. See the install log for details.",
            agent_id
        )),
        StreamEnd::Exited(_) => Err(format!(
            "The installer for '{}' exited with a non-zero status. See the install log for details.",
            agent_id
        )),
    }
}

/// Configure Codex CLI: write Atomic Chat's own profile, which the Launch page
/// starts Codex with (`codex --profile atomic-chat`). The shared
/// `~/.codex/config.toml` is only touched to take out what an earlier release
/// wrote there; see `codex_config`.
#[tauri::command]
pub async fn configure_codex(
    api_url: String,
    model: String,
    api_key: Option<String>,
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    let keyed = api_key.as_deref().is_some_and(|k| !k.is_empty());
    let profile = tauri::async_runtime::spawn_blocking({
        let (api_url, model) = (api_url.clone(), model.clone());
        move || super::codex_config::configure(&api_url, &model, keyed, context_length)
    })
    .await
    .map_err(|e| e.to_string())??;
    log::info!(
        "Codex configured: profile={}, base_url={}, model={}",
        profile.display(),
        api_url,
        model
    );
    Ok(())
}

/// Configure OpenCode by upserting `provider.atomic` in its global config
/// (`opencode.jsonc` when there is one, else `opencode.json`; see
/// `opencode_family`) and selecting our model; Disconnect puts back what this
/// replaced.
#[tauri::command]
pub fn configure_opencode(
    api_url: String,
    model: String,
    api_key: Option<String>,
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    let paths = super::opencode_family::FamilyPaths::resolve()?;
    super::opencode_family::connect_opencode_style(
        &paths.opencode,
        &super::opencode_family::OPENCODE,
        &api_url,
        &model,
        api_key.as_deref(),
        context_length,
    )?;
    log::info!(
        "OpenCode configured: config={}, baseURL={}, model={}",
        paths.opencode.file.display(),
        api_url,
        model
    );
    Ok(())
}

/// Configure OpenClaude by upserting an `atomic-chat` provider profile in its
/// global config (`~/.openclaude.json`; `$OPENCLAUDE_CONFIG_DIR` and the legacy
/// `.config.json` are honoured) and syncing the startup profile file
/// (`.openclaude-profile.json`). OpenClaude explicitly does not read
/// `~/.claude` / `~/.claude.json` (see its README's "OpenClaude config cutover"
/// section), so there is no legacy path to fall back to. OpenClaude routes
/// atomic-chat through its OpenAI-compatible shim, including bearer
/// authentication. The values replaced are kept for Disconnect (`claude_config`).
#[tauri::command]
pub fn configure_openclaude(
    api_url: String,
    model: String,
    api_key: Option<String>,
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    let paths = super::claude_config::resolve_openclaude_paths()?;
    super::claude_config::connect_openclaude(
        &paths,
        &api_url,
        &model,
        api_key.as_deref(),
        context_length,
        &chrono::Utc::now().to_rfc3339(),
    )?;
    log::info!(
        "OpenClaude configured: baseURL={}, model={}, context={:?}, config={}",
        api_url,
        model,
        context_length,
        paths.config.display()
    );
    Ok(())
}

/// Configure MiMo Code by upserting `provider.atomic` in its global config
/// (`mimocode.jsonc` when there is one, else `mimocode.json`). MiMo Code is a
/// fork of OpenCode, so its config system is OpenCode's field-for-field; only
/// the paths and `$schema` differ.
#[tauri::command]
pub fn configure_mimo(
    api_url: String,
    model: String,
    api_key: Option<String>,
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    let paths = super::opencode_family::FamilyPaths::resolve()?;
    super::opencode_family::connect_opencode_style(
        &paths.mimo,
        &super::opencode_family::MIMO,
        &api_url,
        &model,
        api_key.as_deref(),
        context_length,
    )?;
    log::info!(
        "MiMo Code configured: config={}, baseURL={}, model={}",
        paths.mimo.file.display(),
        api_url,
        model
    );
    Ok(())
}

/// Configure Factory.ai Droid by upserting our entry in the `customModels`
/// array of `~/.factory/settings.json` (strict JSON, other models preserved)
/// and making it the default for new sessions; see `droid_config`. Droid
/// speaks OpenAI Chat Completions via `generic-chat-completion-api`, so
/// `api_url` carries the `/v1` suffix.
#[tauri::command]
pub fn configure_droid(
    api_url: String,
    model: String,
    api_key: Option<String>,
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    let home = agent_home_dir()?;
    let path = super::droid_config::settings_path(Path::new(&home));
    let selector = super::droid_config::configure_in(
        &path,
        &api_url,
        &model,
        api_key.as_deref(),
        context_length,
    )?;
    log::info!(
        "Droid configured: baseUrl={}, model={}, selector={}",
        api_url,
        model,
        selector
    );
    Ok(())
}

/// The desktop OS a path resolver answers for. Production passes
/// [`HostOs::current`]; tests pass each one, so every OS's rules run anywhere.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HostOs {
    Macos,
    Windows,
    Linux,
}

impl HostOs {
    pub(crate) fn current() -> Self {
        if cfg!(target_os = "macos") {
            HostOs::Macos
        } else if cfg!(windows) {
            HostOs::Windows
        } else {
            HostOs::Linux
        }
    }
}

/// Reads an environment variable for a path resolver; blank counts as unset.
pub(crate) type EnvLookup<'a> = &'a dyn Fn(&str) -> Option<String>;

/// The [`EnvLookup`] production uses: this process's environment.
pub(crate) fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// Sidecar next to an editor's config file that holds what a Connect replaced
/// there (`{ "<key path>": <previous value> }`), so Disconnect can put it back.
fn editor_sidecar_path(config: &Path) -> PathBuf {
    let mut name = config.file_name().unwrap_or_default().to_os_string();
    name.push(".atomic-chat-backup.json");
    config.with_file_name(name)
}

/// Remember the value a Connect is about to replace at `key`, or forget an
/// older one when there is none. Called only while the value is the user's.
fn editor_sidecar_remember(
    config: &Path,
    key: &str,
    previous: Option<&serde_json::Value>,
) -> Result<(), String> {
    let sidecar = editor_sidecar_path(config);
    let Some(previous) = previous else {
        editor_sidecar_forget(config);
        return Ok(());
    };
    let mut text = serde_json::to_string_pretty(&serde_json::json!({ key: previous }))
        .map_err(|e| e.to_string())?;
    text.push('\n');
    std::fs::write(&sidecar, text)
        .map_err(|e| format!("Failed to write {}: {}", sidecar.display(), e))
}

/// The value remembered for `key`, if the sidecar has one.
fn editor_sidecar_recall(config: &Path, key: &str) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(editor_sidecar_path(config)).ok()?;
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()?
        .get(key)
        .cloned()
}

fn editor_sidecar_forget(config: &Path) {
    let _ = std::fs::remove_file(editor_sidecar_path(config));
}

/// Display name (and provider id) of the custom provider we register in Zed.
pub(crate) const ZED_PROVIDER_ID: &str = "Atomic Chat";
/// Zed requires a `max_tokens` for every model. With the served window
/// unknown, write what earlier releases always wrote.
const ZED_FALLBACK_CONTEXT: u32 = 32768;
const ZED_MAX_OUTPUT_TOKENS: u32 = 8192;
/// Sidecar key for the agent model a Connect replaced.
const ZED_DEFAULT_MODEL_KEY: &str = "agent.default_model";

/// Zed's config directory, resolved the way Zed's own `paths::config_dir`
/// does: `%APPDATA%\Zed` on Windows, `$XDG_CONFIG_HOME/zed` (else
/// `~/.config/zed`) on Linux, `~/.config/zed` on macOS.
pub(crate) fn zed_config_dir_for(os: HostOs, home: &Path, env: EnvLookup) -> PathBuf {
    match os {
        HostOs::Windows => env("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("Zed"),
        HostOs::Linux => env("XDG_CONFIG_HOME")
            .filter(|dir| dir.starts_with('/'))
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
            .join("zed"),
        HostOs::Macos => home.join(".config").join("zed"),
    }
}

/// [`zed_config_dir_for`] on this machine.
pub(crate) fn zed_config_dir() -> Result<PathBuf, String> {
    let home = agent_home_dir()?;
    Ok(zed_config_dir_for(
        HostOs::current(),
        Path::new(&home),
        &process_env,
    ))
}

/// `max_tokens` and `max_output_tokens` for the served model: its real window
/// and a quarter of it for output (at most 8192), so Zed compacts in time.
fn zed_model_limits(context_length: Option<u32>) -> (u32, u32) {
    let context = context_length
        .filter(|c| *c > 0)
        .unwrap_or(ZED_FALLBACK_CONTEXT);
    (context, (context / 4).clamp(1, ZED_MAX_OUTPUT_TOKENS))
}

fn zed_selection_is_ours(selection: Option<&serde_json::Value>) -> bool {
    selection.is_some_and(|s| s.get("provider").and_then(|p| p.as_str()) == Some(ZED_PROVIDER_ID))
}

/// Read Zed's `settings.json` the way Zed does (JSONC). `None` when it is
/// missing or blank.
fn read_zed_settings(path: &Path) -> Result<Option<serde_json::Value>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Failed to read {}: {}", path.display(), e)),
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    json5::from_str(&text).map(Some).map_err(|e| {
        format!(
            "Could not parse {}: {}. Fix the reported location and try again.",
            path.display(),
            e
        )
    })
}

fn write_zed_settings(path: &Path, root: &serde_json::Value) -> Result<(), String> {
    let pretty = serde_json::to_string_pretty(root).map_err(|e| e.to_string())?;
    std::fs::write(path, pretty + "\n")
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

/// Filesystem half of [`configure_zed`], on a resolved Zed config directory.
fn configure_zed_in(
    dir: &Path,
    api_url: &str,
    model: Option<&str>,
    context_length: Option<u32>,
) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
    let path = dir.join("settings.json");

    let mut root = read_zed_settings(&path)?.unwrap_or_else(|| serde_json::json!({}));
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
    let model = model.filter(|m| !m.is_empty());
    let mut available_models = Vec::new();
    if let Some(model) = model {
        let (max_tokens, max_output_tokens) = zed_model_limits(context_length);
        available_models.push(serde_json::json!({
            "name": model,
            "display_name": model,
            "max_tokens": max_tokens,
            "max_output_tokens": max_output_tokens,
            "capabilities": {
                "tools": true,
                // Zed's own default: the app does not know whether the served
                // model takes images, and a text-only one rejects them.
                "images": false,
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
    // key we just used (ZED_PROVIDER_ID). The user's own pick is kept aside
    // for Disconnect.
    if let Some(model) = model {
        let agent = obj.entry("agent").or_insert_with(|| serde_json::json!({}));
        if !agent.is_object() {
            *agent = serde_json::json!({});
        }
        let agent = agent.as_object_mut().unwrap();
        let previous = agent.get("default_model");
        if !zed_selection_is_ours(previous) {
            editor_sidecar_remember(&path, ZED_DEFAULT_MODEL_KEY, previous)?;
        }
        agent.insert(
            "default_model".to_string(),
            serde_json::json!({ "provider": ZED_PROVIDER_ID, "model": model }),
        );
    }

    write_zed_settings(&path, &root)?;
    log::info!(
        "Zed configured: api_url={}, model={:?}, file={}",
        api_url,
        model,
        path.display()
    );
    Ok(())
}

/// Configure Zed by upserting a custom OpenAI-compatible provider named
/// "Atomic Chat" under `language_models.openai_compatible` in Zed's
/// `settings.json` ([`zed_config_dir`]), and (when a model is running)
/// selecting it as the agent's default model.
///
/// `openai_compatible` ships in every stock Zed release. Its tradeoffs: Zed
/// can't auto-discover models (we list the running one with its real window),
/// and it marks the provider "authenticated" only once a key is present — so
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
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    let _ = api_key;
    configure_zed_in(
        &zed_config_dir()?,
        &api_url,
        model.as_deref(),
        context_length,
    )
}

/// Undo [`configure_zed_in`]: drop our provider and, while the agent still
/// defaults to it, put back the model the user had before (or no default).
/// A default the user changed since is theirs and stays.
pub(crate) fn disconnect_zed_in(dir: &Path) -> Result<(), String> {
    let path = dir.join("settings.json");
    let Some(mut root) = read_zed_settings(&path)? else {
        editor_sidecar_forget(&path);
        return Ok(());
    };
    let mut changed = false;
    if let Some(obj) = root.as_object_mut() {
        if let Some(language_models) = obj
            .get_mut("language_models")
            .and_then(|v| v.as_object_mut())
        {
            if let Some(compatible) = language_models
                .get_mut("openai_compatible")
                .and_then(|v| v.as_object_mut())
            {
                if compatible.remove(ZED_PROVIDER_ID).is_some() {
                    changed = true;
                    if compatible.is_empty() {
                        language_models.remove("openai_compatible");
                    }
                }
            }
            if changed && language_models.is_empty() {
                obj.remove("language_models");
            }
        }
        if let Some(agent) = obj.get_mut("agent").and_then(|v| v.as_object_mut()) {
            if zed_selection_is_ours(agent.get("default_model")) {
                match editor_sidecar_recall(&path, ZED_DEFAULT_MODEL_KEY) {
                    Some(previous) => agent.insert("default_model".to_string(), previous),
                    None => agent.remove("default_model"),
                };
                changed = true;
                if agent.is_empty() {
                    obj.remove("agent");
                }
            }
        }
    }
    if changed {
        write_zed_settings(&path, &root)?;
        log::info!("Zed disconnected from Atomic Chat: {}", path.display());
    }
    editor_sidecar_forget(&path);
    Ok(())
}

/// Where Zed's installers put its `zed` CLI when it is not on `PATH`: the
/// macOS app bundle (the DMG install never links one), `~/.local/bin` (the
/// install script's link, often not on `PATH`), the Linux tarball, and the
/// Windows installer's `bin` folder (per user, or for all users).
fn zed_cli_candidates(os: HostOs, home: &Path, env: EnvLookup) -> Vec<PathBuf> {
    match os {
        HostOs::Macos => {
            let mut out = vec![home.join(".local").join("bin").join("zed")];
            for root in [PathBuf::from("/Applications"), home.join("Applications")] {
                for app in ["Zed.app", "Zed Preview.app"] {
                    out.push(root.join(app).join("Contents").join("MacOS").join("cli"));
                }
            }
            out
        }
        HostOs::Linux => vec![
            home.join(".local").join("bin").join("zed"),
            home.join(".local").join("zed.app").join("bin").join("zed"),
            home.join(".local")
                .join("zed-preview.app")
                .join("bin")
                .join("zed"),
        ],
        HostOs::Windows => zed_windows_install_dirs(home, env)
            .into_iter()
            .map(|dir| dir.join("bin").join("zed.exe"))
            .collect(),
    }
}

/// Zed's editor executables, started directly when no CLI can be run.
fn zed_app_candidates(os: HostOs, home: &Path, env: EnvLookup) -> Vec<PathBuf> {
    match os {
        HostOs::Macos => [PathBuf::from("/Applications"), home.join("Applications")]
            .into_iter()
            .map(|root| {
                root.join("Zed.app")
                    .join("Contents")
                    .join("MacOS")
                    .join("zed")
            })
            .collect(),
        HostOs::Linux => Vec::new(),
        HostOs::Windows => zed_windows_install_dirs(home, env)
            .into_iter()
            .map(|dir| dir.join("Zed.exe"))
            .collect(),
    }
}

/// The Inno Setup installer's `{autopf}\Zed`: per user unless run elevated.
fn zed_windows_install_dirs(home: &Path, env: EnvLookup) -> Vec<PathBuf> {
    let local = env("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData").join("Local"));
    let mut out = vec![local.join("Programs").join("Zed")];
    if let Some(program_files) = env("ProgramFiles") {
        out.push(PathBuf::from(program_files).join("Zed"));
    }
    out
}

/// Whether a Zed launcher is the editor itself (started as is) rather than
/// the `zed` CLI (started with `--foreground` so the editor inherits our env).
fn zed_is_app_binary(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let parent = path
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match name.as_str() {
        "zed-editor" => true,
        "zed" => parent == "macos",
        "zed.exe" => parent != "bin",
        _ => false,
    }
}

/// What `launch_zed` tries, in order: the launcher detection found, the `zed`
/// on `PATH`, then every known install location.
fn zed_launch_candidates(
    os: HostOs,
    home: &Path,
    env: EnvLookup,
    detected: Option<&Path>,
) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = detected.into_iter().map(Path::to_path_buf).collect();
    out.push(PathBuf::from("zed"));
    for candidate in zed_cli_candidates(os, home, env)
        .into_iter()
        .chain(zed_app_candidates(os, home, env))
    {
        if candidate.is_file() && !out.contains(&candidate) {
            out.push(candidate);
        }
    }
    out
}

/// Launch the Zed editor GUI.
///
/// Unlike the CLI agents we spawn in a terminal, Zed is a desktop editor whose
/// agent lives in its own window, so we start the app directly: through the
/// launcher detection found (`path`), else the `zed` CLI on the user's PATH
/// (login-shell PATH on macOS/Linux, the registry's on Windows), else the
/// CLI or editor executable at Zed's install locations.
///
/// We seed `ATOMIC_CHAT_API_KEY` so the custom openai_compatible provider is
/// authenticated without the user pasting a key: stock Zed reads the provider
/// key from the `<PROVIDER_ID>_API_KEY` env var and treats any non-empty value
/// as authenticated. A running editor cannot inherit a changed key; ask the
/// user to quit it before reopening, preserving any unsaved work.
#[tauri::command]
pub fn launch_zed(api_key: Option<String>, path: Option<String>) -> Result<(), String> {
    let processes = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::nothing().with_processes(sysinfo::ProcessRefreshKind::nothing()),
    );
    ensure_zed_stopped(processes.processes().values().any(|process| {
        // Linux packages name the editor process `zed-editor`.
        matches!(
            process.name().to_string_lossy().to_lowercase().as_str(),
            "zed" | "zed.exe" | "zed-editor"
        )
    }))?;

    let home = agent_home_dir()?;
    let detected = path.map(PathBuf::from).filter(|p| p.is_file());
    for launcher in zed_launch_candidates(
        HostOs::current(),
        Path::new(&home),
        &process_env,
        detected.as_deref(),
    ) {
        let mut cmd =
            zed_launch_command(&launcher, api_key.as_deref(), !zed_is_app_binary(&launcher));
        apply_login_path(&mut cmd);
        apply_runtime_path(&mut cmd);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        if cmd.spawn().is_ok() {
            log::info!("Launched Zed via {}", launcher.display());
            return Ok(());
        }
    }

    Err("Could not launch Zed. Is it installed and on your PATH?".to_string())
}

fn ensure_zed_stopped(running: bool) -> Result<(), String> {
    if running {
        Err("Quit Zed, then connect again to apply the current Atomic Chat API key. Save any unsaved work before quitting.".to_string())
    } else {
        Ok(())
    }
}

fn zed_launch_command(binary: &Path, api_key: Option<&str>, cli: bool) -> std::process::Command {
    let mut cmd = std::process::Command::new(binary);
    // The ordinary macOS CLI delegates to LaunchServices, which need not
    // inherit its environment. Foreground mode spawns the editor directly.
    if cli {
        cmd.arg("--foreground");
    }
    cmd.env(
        "ATOMIC_CHAT_API_KEY",
        api_key.filter(|key| !key.is_empty()).unwrap_or("atomic"),
    );
    cmd
}

// --- ZCode ------------------------------------------------------------------
//
// ZCode (github.com/zai-org/ZCode) is Z.ai's Electron desktop app. It ignores
// OPENAI_BASE_URL and friends: the only source of custom providers is
// `<dataBase>/.zcode/v2/provider_config.json`, shared by the desktop app, its
// web UI and its CLI, and polled once a second — so writing that file is the
// whole integration, and a running ZCode picks the change up by itself.
//
// The file is validated with strict Zod schemas, and an invalid file is not
// rejected loudly: ZCode treats it as empty, so every custom provider the user
// has silently disappears until it is fixed. Hence the care below — patch only
// the entries we own, refuse rather than guess on anything unexpected, and write
// under ZCode's own lock with a rename.

/// Provider id we own inside `provider_config.json`. Personal providers may use
/// any id that does not start with `account:`.
pub(crate) const ZCODE_PROVIDER_ID: &str = "atomic-chat";
const ZCODE_PROVIDER_NAME: &str = "Atomic Chat";
/// ZCode only admits a provider whose API key is non-blank; the local server
/// ignores it when auth is off.
const ZCODE_KEY_PLACEHOLDER: &str = "atomic";
/// Output cap per turn; with the served window known, a quarter of it at most.
const ZCODE_MAX_OUTPUT_TOKENS: u32 = 8192;
/// Sidecar key for the default model selection a Connect replaced.
const ZCODE_SELECTION_KEY: &str = "config.defaultModelSelection";
/// ZCode's default request mapping for `openai-chat-completions` sends
/// `thinking`, `enable_thinking`, `reasoning_effort` and `reasoning`, none of
/// which llama-server reads, so its reasoning toggle would do nothing. llama-server
/// does read `chat_template_kwargs`, and `enable_thinking` is the switch the
/// Qwen3 / GLM / DeepSeek templates expose; templates without it ignore it.
const ZCODE_REASONING_MAP: &str =
    r#"{"chat_template_kwargs": {"enable_thinking": reasoningLevel == "enabled"}}"#;
/// `max_completion_tokens` (ZCode's default) is an OpenAI-only alias;
/// `max_tokens` is what every local backend understands.
const ZCODE_MAX_TOKENS_MAP: &str = "{'max_tokens': maxOutputTokens}";
/// ZCode's own writers wait up to 8 s for the lock.
const ZCODE_LOCK_MAX_WAIT: std::time::Duration = std::time::Duration::from_secs(8);
/// A ZCode write holds the lock for milliseconds. One this old was left behind
/// by a process that died holding it.
const ZCODE_LOCK_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(60);

/// ZCode's `.zcode/v2` directory, resolved the way the desktop app does it:
/// `dataBaseDir` from `~/.zcode/v2/setting.json` (set when the user moves the
/// data folder in ZCode's settings), then `$ZCODE_DATA_BASE_DIR`, then home.
pub(crate) fn zcode_config_dir(home: &Path, env_base: Option<&str>) -> PathBuf {
    let from_setting = std::fs::read_to_string(home.join(".zcode").join("v2").join("setting.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| {
            v.get("dataBaseDir")
                .and_then(|d| d.as_str())
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .map(PathBuf::from)
        });
    let base = from_setting
        .or_else(|| {
            env_base
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| home.to_path_buf());
    base.join(".zcode").join("v2")
}

/// Borrow `parent[key]` as a JSON array, creating it when absent. A value of the
/// wrong type means the file is already invalid for ZCode; we refuse to paper
/// over that.
fn zcode_array<'a>(
    parent: &'a mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    path: &str,
) -> Result<&'a mut Vec<serde_json::Value>, String> {
    parent
        .entry(key)
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .ok_or_else(|| format!("{path} in provider_config.json is not an array"))
}

/// Borrow `parent[key]` as a JSON object, creating it when absent.
fn zcode_object<'a>(
    parent: &'a mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    path: &str,
) -> Result<&'a mut serde_json::Map<String, serde_json::Value>, String> {
    parent
        .entry(key)
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| format!("{path} in provider_config.json is not an object"))
}

/// Apply Atomic Chat's provider, its model rule and the default selection to a
/// parsed `provider_config.json` (`None` when the file does not exist yet).
///
/// Only entries whose `providerId` is ours are replaced; every other provider,
/// rule and key is carried over untouched. Split out from
/// [`configure_zcode_in`] so the merge rules are testable without the disk.
///
/// `context_length` is the served window: written as the model's
/// `contextWindow` so ZCode compacts in time. Unknown, ZCode's own default
/// stands.
fn zcode_patch_provider_config(
    existing: Option<serde_json::Value>,
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
    context_length: Option<u32>,
) -> Result<serde_json::Value, String> {
    let model = model.trim();
    if model.is_empty() {
        return Err("ZCode needs a model: load one in a chat first.".to_string());
    }
    let key = api_key
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .unwrap_or(ZCODE_KEY_PLACEHOLDER);

    let mut root = existing.unwrap_or_else(|| serde_json::json!({ "schemaVersion": 1 }));
    let root_obj = root
        .as_object_mut()
        .ok_or_else(|| "provider_config.json is not a JSON object".to_string())?;
    // ZCode refuses a file without a version, and one newer than it knows. We
    // know exactly one shape, so anything else is left for ZCode to handle.
    match root_obj.get("schemaVersion").and_then(|v| v.as_u64()) {
        Some(1) => {}
        Some(v) => {
            return Err(format!(
                "ZCode's provider_config.json uses schemaVersion {v}, which this version of \
                 Atomic Chat does not know. Update Atomic Chat, or add the provider in \
                 ZCode's Model Settings."
            ))
        }
        None => {
            return Err(
                "ZCode's provider_config.json has no schemaVersion, so ZCode is ignoring it. \
                 Open Model Settings in ZCode to repair it, then try again."
                    .to_string(),
            )
        }
    }
    let config = zcode_object(root_obj, "config", "config")?;

    let provider = serde_json::json!({
        "providerId": ZCODE_PROVIDER_ID,
        "providerName": ZCODE_PROVIDER_NAME,
        "enabled": true,
        "config": {
            "group": "standard-personal",
            "access": { "type": "api-key", "apiKey": key },
            "api": {
                "type": "openai-chat-completions",
                "baseUrl": api_url,
                "headers": null
            },
            // Local servers expose no model catalogue ZCode can discover, so
            // the provider lists exactly the model Run was pressed for.
            "personalModelIds": [model],
            "modelOrder": [model]
        }
    });
    let provider_rules = zcode_array(
        zcode_object(config, "providerConfigRules", "config.providerConfigRules")?,
        "providerRules",
        "config.providerConfigRules.providerRules",
    )?;
    match provider_rules
        .iter()
        .position(|rule| rule["providerId"] == ZCODE_PROVIDER_ID)
    {
        Some(i) => provider_rules[i] = provider,
        None => provider_rules.push(provider),
    }

    // `providerOrder` is optional; ZCode appends unlisted providers itself, so
    // only an existing list needs us added — at the top, where Run expects us.
    if config.contains_key("providerOrder") {
        let order = zcode_array(config, "providerOrder", "config.providerOrder")?;
        if !order.iter().any(|id| *id == ZCODE_PROVIDER_ID) {
            order.insert(0, serde_json::json!(ZCODE_PROVIDER_ID));
        }
    }

    let model_rules = zcode_object(config, "modelConfigRules", "config.modelConfigRules")?;
    // ZCode rejects the whole file when one provider/model pair has both a
    // regular and a manual rule — and a manual rule is what its Advanced model
    // settings write. So a rule of ours can only live in one of the two lists:
    // drop our old rules from both before adding the new one.
    let manual = zcode_array(
        model_rules,
        "manualProviderModelRules",
        "config.modelConfigRules.manualProviderModelRules",
    )?;
    manual.retain(|rule| rule["providerId"] != ZCODE_PROVIDER_ID);
    let rules = zcode_array(
        model_rules,
        "providerModelRules",
        "config.modelConfigRules.providerModelRules",
    )?;
    rules.retain(|rule| rule["providerId"] != ZCODE_PROVIDER_ID);
    let context_length = context_length.filter(|c| *c > 0);
    let mut properties = serde_json::Map::new();
    if let Some(context) = context_length {
        properties.insert("contextWindow".to_string(), serde_json::json!(context));
    }
    // A model id that happens to match one of ZCode's built-in vision patterns
    // would otherwise inherit image input a text-only GGUF cannot take.
    properties.insert(
        "inputFormat".to_string(),
        serde_json::json!({ "supportsImage": false }),
    );
    let max_output = context_length.map_or(ZCODE_MAX_OUTPUT_TOKENS, |c| {
        (c / 4).clamp(1, ZCODE_MAX_OUTPUT_TOKENS)
    });
    rules.push(serde_json::json!({
        "providerId": ZCODE_PROVIDER_ID,
        "modelId": model,
        "config": {
            "properties": properties,
            "optionSpecs": {
                "maxOutputTokens": {
                    "max": max_output,
                    "map": ZCODE_MAX_TOKENS_MAP
                },
                "reasoningLevel": {
                    "values": ["disabled", "enabled"],
                    "map": ZCODE_REASONING_MAP
                }
            }
        }
    }));

    // A selection has to name a reasoning level the model allows. `enabled` is
    // what ZCode itself picks for a newly chosen model (the highest level).
    config.insert(
        "defaultModelSelection".to_string(),
        serde_json::json!({
            "providerId": ZCODE_PROVIDER_ID,
            "modelId": model,
            "options": { "reasoningLevel": "enabled" }
        }),
    );

    Ok(root)
}

fn zcode_selection_is_ours(selection: Option<&serde_json::Value>) -> bool {
    selection.is_some_and(|s| s["providerId"] == ZCODE_PROVIDER_ID)
}

/// Undo [`zcode_patch_provider_config`] in place: drop our provider, its place
/// in `providerOrder` and our model rules, and while the default selection is
/// still ours, put back `previous` (the user's selection before Connect) or
/// remove it. Returns whether anything changed.
fn zcode_unpatch_provider_config(
    root: &mut serde_json::Value,
    previous: Option<serde_json::Value>,
) -> Result<bool, String> {
    let Some(root_obj) = root.as_object_mut() else {
        return Ok(false);
    };
    match root_obj.get("schemaVersion").and_then(|v| v.as_u64()) {
        Some(1) => {}
        _ => {
            return Err(
                "ZCode's provider_config.json is in a format this version of Atomic Chat does \
                 not know. Remove the Atomic Chat provider in ZCode's Model Settings."
                    .to_string(),
            )
        }
    }
    let Some(config) = root_obj.get_mut("config").and_then(|v| v.as_object_mut()) else {
        return Ok(false);
    };
    let mut changed = false;
    let mut drop_ours = |list: Option<&mut serde_json::Value>| {
        if let Some(list) = list.and_then(|v| v.as_array_mut()) {
            let before = list.len();
            list.retain(|item| {
                item["providerId"] != ZCODE_PROVIDER_ID && *item != ZCODE_PROVIDER_ID
            });
            changed |= list.len() != before;
        }
    };
    drop_ours(
        config
            .get_mut("providerConfigRules")
            .and_then(|v| v.get_mut("providerRules")),
    );
    drop_ours(config.get_mut("providerOrder"));
    if let Some(model_rules) = config.get_mut("modelConfigRules") {
        drop_ours(model_rules.get_mut("providerModelRules"));
        drop_ours(model_rules.get_mut("manualProviderModelRules"));
    }
    if zcode_selection_is_ours(config.get("defaultModelSelection")) {
        match previous {
            Some(previous) => config.insert("defaultModelSelection".to_string(), previous),
            None => config.remove("defaultModelSelection"),
        };
        changed = true;
    }
    Ok(changed)
}

/// ZCode's lock around a config file (`packages/shared/src/node/atomicFileLock.ts`):
/// a `<file>.lock` directory holding one `owner-<token>.json`. Taking it keeps a
/// Run from interleaving with a save made in ZCode's own settings at that moment.
/// Released on drop.
struct ZcodeFileLock {
    dir: PathBuf,
    owner: PathBuf,
}

impl Drop for ZcodeFileLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.owner);
        let _ = std::fs::remove_dir(&self.dir);
    }
}

/// Whether a lock directory was left behind: judged by its newest entry, so a
/// lock that was just re-taken by someone else is never reclaimed.
fn zcode_lock_is_stale(dir: &Path, stale_after: std::time::Duration) -> bool {
    let mut newest = std::fs::metadata(dir).and_then(|m| m.modified()).ok();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                newest = Some(newest.map_or(modified, |n| n.max(modified)));
            }
        }
    }
    // A timestamp in the future (clock skew, coarse filesystem clocks) reads as
    // brand new rather than as abandoned.
    newest
        .map(|n| n.elapsed().unwrap_or_default())
        .is_some_and(|age| age >= stale_after)
}

/// Remove an abandoned lock directory, reporting whether it is gone.
fn zcode_remove_lock(dir: &Path) -> bool {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    std::fs::remove_dir(dir).is_ok()
}

fn acquire_zcode_lock(
    file: &Path,
    max_wait: std::time::Duration,
    stale_after: std::time::Duration,
) -> Result<ZcodeFileLock, String> {
    const RETRY_DELAYS_MS: [u64; 5] = [25, 50, 100, 200, 400];

    let mut dir = file.as_os_str().to_owned();
    dir.push(".lock");
    let dir = PathBuf::from(dir);
    let started = std::time::Instant::now();
    let mut attempt = 0;

    loop {
        match std::fs::create_dir(&dir) {
            Ok(()) => {
                let created_at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or_default();
                let token = format!("{}-{}-atomic-chat", std::process::id(), created_at);
                let owner = dir.join(format!("owner-{token}.json"));
                let payload = serde_json::json!({
                    "pid": std::process::id(),
                    "createdAt": created_at,
                    "token": token,
                });
                let lock = ZcodeFileLock {
                    dir: dir.clone(),
                    owner: owner.clone(),
                };
                std::fs::write(&owner, format!("{payload}\n"))
                    .map_err(|e| format!("Failed to write {}: {}", owner.display(), e))?;
                return Ok(lock);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // A lock we cannot remove falls through to the timeout below
                // instead of being retried in a tight loop.
                if zcode_lock_is_stale(&dir, stale_after) && zcode_remove_lock(&dir) {
                    log::warn!("Reclaimed a stale ZCode lock at {}", dir.display());
                    continue;
                }
                if started.elapsed() >= max_wait {
                    return Err(
                        "ZCode is saving its model settings right now. Try again in a moment."
                            .to_string(),
                    );
                }
                let delay = RETRY_DELAYS_MS[attempt.min(RETRY_DELAYS_MS.len() - 1)];
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(delay));
            }
            Err(e) => return Err(format!("Failed to lock {}: {}", file.display(), e)),
        }
    }
}

/// Filesystem half of [`configure_zcode`], taking the resolved `.zcode/v2`
/// directory so it is testable.
fn configure_zcode_in(
    dir: &Path,
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
    context_length: Option<u32>,
) -> Result<(), String> {
    let path = dir.join("provider_config.json");

    // ZCode imports the providers from its pre-3.x `config.json` exactly once:
    // on the first start that finds no `provider_config.json`. Creating that
    // file first would skip the import for good and the user's old providers
    // would never come back. Let ZCode migrate them before we write anything.
    if !path.exists() && dir.join("config.json").exists() {
        return Err(
            "Open ZCode once so it can import your existing model providers, then click \
             Run again."
                .to_string(),
        );
    }

    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
    let _lock = acquire_zcode_lock(&path, ZCODE_LOCK_MAX_WAIT, ZCODE_LOCK_STALE_AFTER)?;

    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("Failed to read {}: {}", path.display(), e)),
    };
    let existing = if text.trim().is_empty() {
        None
    } else {
        Some(
            serde_json::from_str::<serde_json::Value>(&text).map_err(|e| {
                format!(
                    "Could not parse {}: {}. ZCode ignores the file while it is invalid, so fix \
                     or remove it and try again.",
                    path.display(),
                    e
                )
            })?,
        )
    };

    let previous = existing
        .as_ref()
        .and_then(|root| root.pointer("/config/defaultModelSelection"))
        .cloned();
    let patched = zcode_patch_provider_config(existing, api_url, model, api_key, context_length)?;
    let mut serialized = serde_json::to_string_pretty(&patched).map_err(|e| e.to_string())?;
    serialized.push('\n');
    // The user's own default model, kept aside for Disconnect.
    if !zcode_selection_is_ours(previous.as_ref()) {
        editor_sidecar_remember(&path, ZCODE_SELECTION_KEY, previous.as_ref())?;
    }

    // A file ZCode cannot validate costs the user every custom provider they
    // have, so keep the pre-Atomic version once. It holds their API keys too,
    // hence owner-only like the file itself.
    if !text.trim().is_empty() {
        let backup = dir.join("provider_config.json.atomic-backup");
        if !backup.exists() && std::fs::write(&backup, &text).is_ok() {
            restrict_to_owner(&backup);
        }
    }

    write_atomically(&path, serialized.as_bytes())?;
    restrict_to_owner(&path);

    log::info!(
        "ZCode configured: baseUrl={}, model={}, file={}",
        api_url,
        model,
        path.display()
    );
    Ok(())
}

/// Point ZCode at the local server by upserting an "Atomic Chat" provider, a
/// rule for the running model and the default model selection in its
/// `provider_config.json`. ZCode polls that file, so no restart is needed.
#[tauri::command]
pub fn configure_zcode(
    api_url: String,
    model: String,
    api_key: Option<String>,
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    configure_zcode_in(
        &resolve_zcode_config_dir()?,
        &api_url,
        &model,
        api_key.as_deref(),
        context_length,
    )
}

/// [`zcode_config_dir`] on this machine.
pub(crate) fn resolve_zcode_config_dir() -> Result<PathBuf, String> {
    let home = agent_home_dir()?;
    let env_base = std::env::var("ZCODE_DATA_BASE_DIR").ok();
    Ok(zcode_config_dir(Path::new(&home), env_base.as_deref()))
}

/// Undo [`configure_zcode_in`] under ZCode's lock: see
/// [`zcode_unpatch_provider_config`]. Nothing of ours there is a success.
pub(crate) fn disconnect_zcode_in(dir: &Path) -> Result<(), String> {
    let path = dir.join("provider_config.json");
    if !path.exists() {
        editor_sidecar_forget(&path);
        return Ok(());
    }
    let _lock = acquire_zcode_lock(&path, ZCODE_LOCK_MAX_WAIT, ZCODE_LOCK_STALE_AFTER)?;
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    if !text.trim().is_empty() {
        let mut root = serde_json::from_str::<serde_json::Value>(&text).map_err(|e| {
            format!(
                "Could not parse {}: {}. Fix or remove it, then disconnect again.",
                path.display(),
                e
            )
        })?;
        let previous = editor_sidecar_recall(&path, ZCODE_SELECTION_KEY);
        if zcode_unpatch_provider_config(&mut root, previous)? {
            let mut serialized = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
            serialized.push('\n');
            write_atomically(&path, serialized.as_bytes())?;
            restrict_to_owner(&path);
            log::info!("ZCode disconnected from Atomic Chat: {}", path.display());
        }
    }
    editor_sidecar_forget(&path);
    Ok(())
}

/// Where each ZCode installer puts the desktop app's executable. The app puts
/// nothing on `PATH` except on Linux, where the deb/rpm packages also link
/// `/usr/bin/zcode`, so without these the Launch page reports ZCode missing.
/// Covers the "ZCode Preview" flavor, AppImages in the usual download folders
/// and, on Windows, a folder the user picked in the installer.
fn zcode_app_candidates() -> Vec<PathBuf> {
    let Ok(home) = agent_home_dir() else {
        return Vec::new();
    };
    #[allow(unused_mut)]
    let mut out = zcode_app_candidates_for(HostOs::current(), Path::new(&home), &process_env);
    #[cfg(windows)]
    out.extend(zcode_registered_executables());
    out
}

/// [`zcode_app_candidates`] without the registry, for any OS.
fn zcode_app_candidates_for(os: HostOs, home: &Path, env: EnvLookup) -> Vec<PathBuf> {
    const FLAVORS: [(&str, &str); 2] = [("ZCode", "zcode"), ("ZCode Preview", "zcode-preview")];
    let mut out = Vec::new();
    match os {
        HostOs::Macos => {
            for root in [PathBuf::from("/Applications"), home.join("Applications")] {
                for (product, _) in FLAVORS {
                    out.push(
                        root.join(format!("{product}.app"))
                            .join("Contents")
                            .join("MacOS")
                            .join(product),
                    );
                }
            }
        }
        HostOs::Windows => {
            // NSIS installs per user under `%LOCALAPPDATA%\Programs` and for
            // all users under `%ProgramFiles%`; both are the installer's
            // defaults.
            let roots = [
                env("LOCALAPPDATA").map(|root| PathBuf::from(root).join("Programs")),
                env("ProgramFiles").map(PathBuf::from),
            ];
            for root in roots.into_iter().flatten() {
                for (product, _) in FLAVORS {
                    out.push(root.join(product).join(format!("{product}.exe")));
                }
            }
        }
        HostOs::Linux => {
            for (product, exe) in FLAVORS {
                out.push(PathBuf::from("/opt").join(product).join(exe));
                if exe != "zcode" {
                    out.push(PathBuf::from("/usr/bin").join(exe));
                }
            }
            out.extend(zcode_appimages(&[
                home.join("Applications"),
                home.join("AppImages"),
                home.join("Downloads"),
                home.join(".local").join("bin"),
            ]));
        }
    }
    out
}

/// `ZCode*.AppImage` files directly in `dirs`, newest first.
fn zcode_appimages(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = dirs
        .iter()
        .filter_map(|dir| std::fs::read_dir(dir).ok())
        .flat_map(|entries| entries.flatten())
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            name.starts_with("zcode") && name.ends_with(".appimage")
        })
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, entry.path()))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, path)| path).collect()
}

/// The executable an uninstall entry's `DisplayIcon` names
/// (`"C:\…\ZCode.exe",0` as electron-builder writes it).
#[cfg_attr(not(windows), allow(dead_code))]
fn exe_from_display_icon(icon: &str) -> Option<PathBuf> {
    let icon = icon.trim();
    let icon = match icon.rsplit_once(',') {
        Some((path, index)) if index.trim().parse::<i32>().is_ok() => path,
        _ => icon,
    };
    let path = icon.trim().trim_matches('"');
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// ZCode installs registered in the Windows uninstall list, which is where a
/// folder picked in the installer (`allowToChangeInstallationDirectory`)
/// is recorded.
#[cfg(windows)]
fn zcode_registered_executables() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    const UNINSTALL: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
    let mut out = Vec::new();
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let Ok(uninstall) = RegKey::predef(hive).open_subkey(UNINSTALL) else {
            continue;
        };
        for key_name in uninstall.enum_keys().flatten() {
            let Ok(entry) = uninstall.open_subkey(&key_name) else {
                continue;
            };
            let name: String = entry.get_value("DisplayName").unwrap_or_default();
            if !name.starts_with("ZCode") {
                continue;
            }
            let icon: String = entry.get_value("DisplayIcon").unwrap_or_default();
            if let Some(exe) = exe_from_display_icon(&icon) {
                out.push(exe);
            }
        }
    }
    out
}

/// The `.app` bundle an executable at `X.app/Contents/MacOS/<exe>` belongs to.
fn macos_app_bundle(exe: &Path) -> Option<PathBuf> {
    let bundle = exe.parent()?.parent()?.parent()?;
    (bundle.extension()? == "app").then(|| bundle.to_path_buf())
}

/// Whether ZCode's desktop app is installed, and whether we brought it up.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZcodeAppStatus {
    pub installed: bool,
    pub launched: bool,
}

/// Open ZCode after [`configure_zcode`], if it is installed.
///
/// Best effort by design: the config is already written and ZCode reads it
/// whenever it next runs, so a missing app is reported rather than failed.
/// `path` is the launcher the Launch page detected off `PATH` (a custom binary
/// path, or one of [`zcode_app_candidates`]).
#[tauri::command]
#[cfg_attr(feature = "e2e", allow(unreachable_code))]
pub fn launch_zcode(path: Option<String>) -> ZcodeAppStatus {
    use std::process::{Command, Stdio};

    let exe = path
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .or_else(|| resolve_off_path("zcode"));
    let found = exe.is_some();

    // An end-to-end build must not open a desktop app on the machine of whoever runs the tests;
    // like `open_agent_terminal`, it writes down what it would have opened.
    #[cfg(feature = "e2e")]
    {
        let program = exe
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "zcode".to_string());
        let _ = crate::core::e2e::record_terminal(
            &crate::core::e2e::data_root(),
            &format!("zcode {program}"),
        );
        return ZcodeAppStatus {
            installed: found,
            launched: found,
        };
    }

    let mut cmd = match exe {
        Some(exe) => match macos_app_bundle(&exe).filter(|_| cfg!(target_os = "macos")) {
            // Through LaunchServices, which also just focuses a running instance.
            Some(bundle) => {
                let mut c = Command::new("open");
                c.arg("-a").arg(bundle);
                c
            }
            None => Command::new(exe),
        },
        // Linux packages link `/usr/bin/zcode`, which the login PATH resolves.
        None if cfg!(all(unix, not(target_os = "macos"))) => Command::new("zcode"),
        None => {
            return ZcodeAppStatus {
                installed: false,
                launched: false,
            }
        }
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    apply_login_path(&mut cmd);

    match cmd.spawn() {
        Ok(_) => {
            log::info!("Launched ZCode");
            ZcodeAppStatus {
                installed: true,
                launched: true,
            }
        }
        // For the bare Linux name, a failed spawn just means it is not there.
        Err(e) => {
            log::warn!("Could not launch ZCode: {e}");
            ZcodeAppStatus {
                installed: found,
                launched: false,
            }
        }
    }
}

/// Whether OpenClaw's desktop app is installed, whether we brought it up, and
/// whether a Gateway owns the CLI's state directory.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenclawAppStatus {
    /// The desktop app is present on this machine.
    pub installed: bool,
    /// We were able to bring it to the front.
    pub launched: bool,
    /// A Gateway runs for `~/.openclaw`: `openclaw chat` (the embedded runtime,
    /// `tui --local`) refuses to start then, and `openclaw tui` joins it.
    pub gateway_running: bool,
}

/// Report (and on macOS, open) OpenClaw's desktop app, and whether its Gateway
/// runs.
///
/// The macOS app and the CLI share `~/.openclaw/openclaw.json`, and the
/// Gateway watches that file and hot-reloads it, so `configure_openclaw` is the
/// whole integration for app users too — this only saves them from going to
/// find the app afterwards, the way `launch_zed` does for Zed.
///
/// The Windows Hub ("OpenClaw Companion") is deliberately not a destination:
/// its Gateway runs in WSL (or as a packaged native Gateway) with a state
/// directory and config of its own, not the `%USERPROFILE%\.openclaw` file we
/// write, so it would answer with the user's previous model. The terminal CLI
/// reads our file, so Windows always gets the terminal.
#[tauri::command]
pub fn launch_openclaw_app() -> OpenclawAppStatus {
    let home = agent_home_dir().ok();
    let gateway_running = home
        .as_deref()
        .is_some_and(|home| openclaw_gateway_running(&openclaw_state_dir(home)));

    #[cfg(target_os = "macos")]
    {
        let mut candidates = vec![PathBuf::from("/Applications/OpenClaw.app")];
        if let Some(home) = &home {
            candidates.push(PathBuf::from(home).join("Applications/OpenClaw.app"));
        }
        let Some(app) = candidates.into_iter().find(|p| p.exists()) else {
            return OpenclawAppStatus {
                installed: false,
                launched: false,
                gateway_running,
            };
        };
        let launched = std::process::Command::new("open")
            .arg("-a")
            .arg(&app)
            .spawn()
            .is_ok();
        if launched {
            log::info!("Launched {}", app.display());
        } else {
            log::warn!("Found {} but could not open it", app.display());
        }
        return OpenclawAppStatus {
            installed: true,
            launched,
            gateway_running,
        };
    }

    #[allow(unreachable_code)]
    OpenclawAppStatus {
        installed: false,
        launched: false,
        gateway_running,
    }
}

/// OpenClaw's state directory: `$OPENCLAW_STATE_DIR` (`~` expanded), else
/// `~/.openclaw` (`resolveStateDir` in `src/config/state-dir.ts`).
fn openclaw_state_dir(home: &str) -> PathBuf {
    match std::env::var("OPENCLAW_STATE_DIR")
        .ok()
        .map(|dir| dir.trim().to_string())
        .filter(|dir| !dir.is_empty())
    {
        Some(dir) if dir == "~" => PathBuf::from(home),
        Some(dir) => match dir.strip_prefix("~/").or_else(|| dir.strip_prefix("~\\")) {
            Some(rest) => PathBuf::from(home).join(rest),
            None => PathBuf::from(dir),
        },
        None => PathBuf::from(home).join(".openclaw"),
    }
}

/// Whether a Gateway owns `state_dir`. A running Gateway records itself in
/// `<state dir>/tmp/openclaw-<uid>/gateway.*.lock` (`resolveGatewayLockDir` in
/// `src/config/paths.ts`; builds up to 2026.6.33 used the process temp
/// directory instead), a JSON payload naming its role and listening port —
/// the same files `openclaw chat` checks before refusing. A lock left behind
/// by a dead Gateway names a port nothing listens on, so the port is probed
/// too.
fn openclaw_gateway_running(state_dir: &Path) -> bool {
    #[cfg(unix)]
    let lock_dir = format!("openclaw-{}", unsafe { libc::getuid() });
    #[cfg(not(unix))]
    let lock_dir = "openclaw".to_string();
    let dirs = [
        state_dir.join("tmp").join(&lock_dir),
        std::env::temp_dir().join(&lock_dir),
    ];
    openclaw_gateway_ports(&dirs)
        .into_iter()
        .any(loopback_port_is_listening)
}

/// The ports Gateway locks in `dirs` say a Gateway listens on.
fn openclaw_gateway_ports(dirs: &[PathBuf]) -> Vec<u16> {
    let mut ports = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !(name.starts_with("gateway.") && name.ends_with(".lock")) {
                continue;
            }
            let Some(payload) = std::fs::read_to_string(entry.path())
                .ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            else {
                continue;
            };
            let role = payload.get("role").and_then(|r| r.as_str());
            if role.is_some_and(|role| role != "gateway") {
                continue;
            }
            if let Some(port) = payload
                .get("port")
                .and_then(|p| p.as_u64())
                .and_then(|p| u16::try_from(p).ok())
                .filter(|p| *p > 0)
            {
                ports.push(port);
            }
        }
    }
    ports
}

fn loopback_port_is_listening(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::time::Duration::from_millis(300),
    )
    .is_ok()
}

/// Provider id we own inside `openclaw.json`. Model refs are `<provider>/<id>`,
/// so this is also the prefix of every ref we write.
pub(crate) const OPENCLAW_PROVIDER_ID: &str = "atomic";

/// Per-request budget on our provider (`models.providers.atomic.timeoutSeconds`):
/// it covers connecting, the response headers and streaming the body, and
/// raises the ~120 s idle watchdog for this provider only — a long prompt on a
/// slow machine needs more before the first token. Unlike
/// `agents.defaults.timeoutSeconds`, it leaves every other model alone.
const OPENCLAW_PROVIDER_TIMEOUT_SECONDS: u32 = 600;

/// `agents.defaults.timeoutSeconds` older releases seeded, which capped every
/// model's attempt (cloud ones included; OpenClaw's own default is 48 hours).
const OPENCLAW_LEGACY_AGENT_TIMEOUT_SECONDS: u64 = 240;

/// Whether an `agents.defaults.modelPolicy.allow` list already permits
/// `model_ref`. OpenClaw matches exact refs plus trailing prefix wildcards
/// (`provider/*`, `provider/namespace/*`), so both forms are honoured here.
fn model_policy_allows(list: &[serde_json::Value], model_ref: &str) -> bool {
    list.iter()
        .filter_map(|entry| entry.as_str())
        .any(|entry| match entry.strip_suffix('*') {
            Some(prefix) => model_ref.starts_with(prefix),
            None => entry == model_ref,
        })
}

/// The output cap written next to a known window: a quarter of it, at most
/// 8192 tokens, so the prompt keeps most of the window.
pub(crate) fn output_cap_for(context_length: u32) -> u32 {
    (context_length / 4).min(8192)
}

/// The keys Connect may overwrite besides our own provider entry; Disconnect
/// puts back each one that still holds our value.
fn openclaw_tracked_paths(model_ref: &str) -> Vec<Vec<String>> {
    use json_key_backup::path_of;
    vec![
        path_of(&["models", "mode"]),
        path_of(&["gateway", "mode"]),
        path_of(&["gateway", "auth", "mode"]),
        path_of(&["agents", "defaults", "model", "primary"]),
        path_of(&["agents", "defaults", "models", model_ref]),
        path_of(&["agents", "defaults", "modelPolicy", "allow"]),
    ]
}

/// Bring a parsed `openclaw.json` into the shape the merge works on, without
/// changing what it means: a plain-string `agents.defaults.model` becomes
/// `{ "primary": <it> }` (both forms are accepted, but only the object has
/// room for the fallbacks OpenClaw writes itself), and the
/// `agents.defaults.timeoutSeconds: 240` older releases seeded goes.
fn openclaw_normalize(root: &mut serde_json::Value) {
    let Some(defaults) = root
        .get_mut("agents")
        .and_then(|a| a.get_mut("defaults"))
        .and_then(|d| d.as_object_mut())
    else {
        return;
    };
    if defaults.get("timeoutSeconds").and_then(|t| t.as_u64())
        == Some(OPENCLAW_LEGACY_AGENT_TIMEOUT_SECONDS)
    {
        defaults.remove("timeoutSeconds");
    }
    if let Some(primary) = defaults
        .get("model")
        .and_then(|m| m.as_str())
        .map(str::to_string)
    {
        defaults.insert(
            "model".to_string(),
            serde_json::json!({ "primary": primary }),
        );
    }
}

/// Apply Atomic Chat's provider, primary model and policy edits to a parsed
/// (and normalised) `openclaw.json`, returning the updated document.
///
/// Split out from [`configure_openclaw`] so the merge rules — which of the
/// user's keys we overwrite, which we only seed, and how an existing
/// `modelPolicy.allow` is widened — are testable without touching the disk.
/// `gateway_secret_in_env` is whether `OPENCLAW_GATEWAY_TOKEN` or
/// `OPENCLAW_GATEWAY_PASSWORD` is set, which configures Gateway auth as much
/// as a token in the file does.
fn openclaw_patch_config(
    mut root: serde_json::Value,
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
    context_length: Option<u32>,
    gateway_secret_in_env: bool,
) -> Result<serde_json::Value, String> {
    let obj = root
        .as_object_mut()
        .ok_or_else(|| "openclaw.json is not a JSON object".to_string())?;

    let model_ref = format!("{}/{}", OPENCLAW_PROVIDER_ID, model);
    let key_val = api_key
        .as_deref()
        .filter(|k| !k.is_empty())
        .unwrap_or("atomic");

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
    // A known window lets OpenClaw compact before the server refuses; an
    // unknown one is left to OpenClaw's own default rather than invented.
    let mut model_entry = serde_json::json!({ "id": model, "name": model });
    if let Some(ctx) = context_length {
        model_entry["contextWindow"] = serde_json::json!(ctx);
        model_entry["maxTokens"] = serde_json::json!(output_cap_for(ctx));
    }
    providers_obj.insert(
        OPENCLAW_PROVIDER_ID.to_string(),
        serde_json::json!({
            "baseUrl": api_url,
            "apiKey": key_val,
            "api": "openai-completions",
            "timeoutSeconds": OPENCLAW_PROVIDER_TIMEOUT_SECONDS,
            "models": [model_entry],
        }),
    );

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
    // The local Gateway (ws://127.0.0.1:18789) refuses its websocket without
    // connection auth, and with no mode set it expects a token. When there is
    // no token or password to expect (in the file or the environment), seed
    // "none" (private-ingress open auth) so it is reachable at all; a
    // configured secret means token auth is in use, and "none" would switch it
    // off.
    let auth_is_set = gateway_obj.get("auth").is_some_and(|auth| {
        ["mode", "token", "password"].iter().any(|key| {
            auth.get(key)
                .is_some_and(|v| !v.is_null() && v.as_str().map_or(true, |s| !s.is_empty()))
        })
    });
    if !auth_is_set && !gateway_secret_in_env {
        let auth = gateway_obj
            .entry("auth")
            .or_insert_with(|| serde_json::json!({}));
        auth.as_object_mut()
            .ok_or_else(|| "gateway.auth is not a JSON object".to_string())?
            .insert("mode".to_string(), serde_json::json!("none"));
    }

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
    // Point the agent at our model via `model.primary`, preserving sibling
    // `model.*` keys. Run is explicit "use this", so we overwrite primary to
    // keep it synced with the active model.
    let model_entry = defaults_obj
        .entry("model")
        .or_insert_with(|| serde_json::json!({}));
    if !model_entry.is_object() {
        *model_entry = serde_json::json!({});
    }
    model_entry["primary"] = serde_json::json!(model_ref.clone());
    // `agents.defaults.models` holds aliases and per-model settings. It used to
    // double as the allowlist, and pre-migration OpenClaw builds still read it
    // that way, so keep seeding an entry — but it no longer restricts anything
    // on current builds ("adding an entry does not restrict model overrides").
    let settings = defaults_obj
        .entry("models")
        .or_insert_with(|| serde_json::json!({}));
    let settings_obj = settings
        .as_object_mut()
        .ok_or_else(|| "agents.defaults.models is not a JSON object".to_string())?;
    settings_obj
        .entry(model_ref.clone())
        .or_insert_with(|| serde_json::json!({}));
    // The allowlist that actually gates model selection is
    // `agents.defaults.modelPolicy.allow`: when it is non-empty it governs
    // `/model`, session overrides and `--model`, and anything outside it is
    // rejected before a reply is generated. So a user who restricted their agent
    // to a cloud provider would watch Run "succeed" and then be told our model
    // is not allowed. Widen an existing policy with a provider wildcard.
    //
    // Only when the user actually has one: an absent key or `[]` already means
    // "allow any model", and writing a list there would *introduce* a
    // restriction nobody asked for. Per-agent `agents.entries.*.modelPolicy`
    // replaces this default for that agent and is deliberately left alone —
    // those are explicit per-agent decisions, not the default Run targets.
    if let Some(list) = defaults_obj
        .get_mut("modelPolicy")
        .and_then(|policy| policy.as_object_mut())
        .and_then(|policy| policy.get_mut("allow"))
        .and_then(|allow| allow.as_array_mut())
    {
        if !list.is_empty() && !model_policy_allows(list, &model_ref) {
            list.push(serde_json::json!(format!("{}/*", OPENCLAW_PROVIDER_ID)));
        }
    }

    Ok(root)
}

/// Undo [`openclaw_patch_config`]: put back the keys `backup` recorded (those
/// still holding our value), drop our provider, and drop a primary model that
/// would now name a provider that is gone. With no backup (a connection an
/// older release made) the edits that are recognisably ours go: the
/// `atomic/*` policy wildcard, empty `atomic/...` settings rows and the 240 s
/// agent timeout.
fn openclaw_unpatch_config(
    mut root: serde_json::Value,
    backup: Option<&json_key_backup::Backup>,
) -> serde_json::Value {
    use json_key_backup::{get, path_of, remove};
    let ours = |value: &str| value.starts_with(&format!("{}/", OPENCLAW_PROVIDER_ID));
    match backup {
        Some(backup) => {
            json_key_backup::restore(&mut root, &backup.keys);
        }
        None => {
            if let Some(defaults) = root
                .get_mut("agents")
                .and_then(|a| a.get_mut("defaults"))
                .and_then(|d| d.as_object_mut())
            {
                if defaults.get("timeoutSeconds").and_then(|t| t.as_u64())
                    == Some(OPENCLAW_LEGACY_AGENT_TIMEOUT_SECONDS)
                {
                    defaults.remove("timeoutSeconds");
                }
                if let Some(settings) = defaults.get_mut("models").and_then(|m| m.as_object_mut()) {
                    settings.retain(|key, value| !(ours(key) && *value == serde_json::json!({})));
                }
                if let Some(allow) = defaults
                    .get_mut("modelPolicy")
                    .and_then(|p| p.get_mut("allow"))
                    .and_then(|a| a.as_array_mut())
                {
                    let wildcard = format!("{}/*", OPENCLAW_PROVIDER_ID);
                    allow.retain(|entry| entry.as_str() != Some(wildcard.as_str()));
                }
            }
        }
    }
    remove(
        &mut root,
        &path_of(&["models", "providers", OPENCLAW_PROVIDER_ID]),
    );
    let primary = path_of(&["agents", "defaults", "model", "primary"]);
    if get(&root, &primary)
        .and_then(|p| p.as_str())
        .is_some_and(ours)
    {
        remove(&mut root, &primary);
    }
    root
}

/// `openclaw.json` location: `$OPENCLAW_CONFIG_PATH` when set, else
/// `~/.openclaw/openclaw.json`.
pub(crate) fn openclaw_config_path(home: &str) -> PathBuf {
    std::env::var("OPENCLAW_CONFIG_PATH")
        .ok()
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home).join(".openclaw").join("openclaw.json"))
}

/// Parse `openclaw.json` the way OpenClaw does: as JSON5 (comments, unquoted
/// keys, trailing commas), or we would reject configs OpenClaw happily accepts
/// (ATO-87). json5 deserializes into the same serde_json::Value, and we always
/// re-serialize as strict JSON on write, which normalizes (and silently drops
/// comments from) the file.
fn read_openclaw_config(config_path: &Path) -> Result<Option<serde_json::Value>, String> {
    if !config_path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(config_path).map_err(|e| e.to_string())?;
    if text.trim().is_empty() {
        return Ok(Some(serde_json::json!({})));
    }
    json5::from_str(&text).map(Some).map_err(|e| {
        format!(
            "Could not parse {}: {}. Fix the reported location and try again.",
            config_path.display(),
            e
        )
    })
}

/// Configure OpenClaw by upserting `models.providers.atomic`, the agent's
/// primary model, and its per-model settings entry in `~/.openclaw/openclaw.json`.
///
/// The macOS app reads the same file through the same Gateway, and the
/// Gateway watches it and hot-reloads, so this one write covers both the CLI
/// and the app with no restart.
#[tauri::command]
pub fn configure_openclaw(
    api_url: String,
    model: String,
    api_key: Option<String>,
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    let home = agent_home_dir()?;
    let gateway_secret_in_env = ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"]
        .iter()
        .any(|name| std::env::var(name).is_ok_and(|v| !v.trim().is_empty()));
    configure_openclaw_at(
        &openclaw_config_path(&home),
        &api_url,
        &model,
        api_key.as_deref(),
        context_length,
        gateway_secret_in_env,
    )
}

fn configure_openclaw_at(
    config_path: &Path,
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
    context_length: Option<u32>,
    gateway_secret_in_env: bool,
) -> Result<(), String> {
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }

    let mut base = read_openclaw_config(config_path)?.unwrap_or_else(|| serde_json::json!({}));
    openclaw_normalize(&mut base);
    let patched = openclaw_patch_config(
        base.clone(),
        api_url,
        model,
        api_key,
        context_length,
        gateway_secret_in_env,
    )?;
    let previous = json_key_backup::read(config_path).unwrap_or_default();
    let model_ref = format!("{}/{}", OPENCLAW_PROVIDER_ID, model);
    let backup = json_key_backup::Backup {
        keys: json_key_backup::track(
            &base,
            &patched,
            &openclaw_tracked_paths(&model_ref),
            &previous.keys,
        ),
        seeded: Vec::new(),
    };

    let pretty = serde_json::to_string_pretty(&patched).map_err(|e| e.to_string())?;
    std::fs::write(config_path, pretty + "\n")
        .map_err(|e| format!("Failed to write {}: {}", config_path.display(), e))?;
    json_key_backup::write(config_path, &backup)?;
    log::info!("OpenClaw configured: baseUrl={}, model={}", api_url, model);
    Ok(())
}

/// Disconnect OpenClaw (see [`openclaw_unpatch_config`]).
pub(crate) fn disconnect_openclaw() -> Result<(), String> {
    disconnect_openclaw_at(&openclaw_config_path(&agent_home_dir()?))
}

fn disconnect_openclaw_at(config_path: &Path) -> Result<(), String> {
    let Some(root) = read_openclaw_config(config_path)? else {
        return json_key_backup::discard(config_path);
    };
    let backup = json_key_backup::read(config_path);
    let restored = openclaw_unpatch_config(root.clone(), backup.as_ref());
    if restored != root {
        let pretty = serde_json::to_string_pretty(&restored).map_err(|e| e.to_string())?;
        std::fs::write(config_path, pretty + "\n")
            .map_err(|e| format!("Failed to write {}: {}", config_path.display(), e))?;
    }
    json_key_backup::discard(config_path)?;
    log::info!("OpenClaw disconnected: {}", config_path.display());
    Ok(())
}

/// Configure Claude Code by upserting `settings.json` in its config directory
/// (`$CLAUDE_CONFIG_DIR`, else `~/.claude`) so it points at the local Atomic
/// Chat server and uses the active model. Values go into the `env` block —
/// Claude reads it at startup regardless of how `claude` was launched, it wins
/// over the shell, and `ANTHROPIC_MODEL` there overrides any stale top-level
/// `model`. The values replaced are kept for Disconnect (`claude_config`); all
/// other user settings are preserved.
#[tauri::command]
pub fn configure_claude_code(
    api_url: String,
    model: Option<String>,
    api_key: Option<String>,
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    let settings = super::claude_config::resolve_claude_settings_path()?;
    super::claude_config::connect_claude_code(
        &settings,
        &api_url,
        model.as_deref(),
        api_key.as_deref(),
        context_length,
    )?;
    // The old Claude Code settings page exported the endpoint for every program.
    // The settings win over it, but it would outlive a Disconnect.
    if let Some(server) = super::claude_config::OurServer::from_url(&api_url) {
        let home = agent_home_dir()?;
        if let Err(e) =
            super::claude_config::forget_legacy_claude_code_env(Path::new(&home), &server)
        {
            log::warn!("{e}");
        }
    }
    log::info!(
        "Claude Code configured: base_url={}, model={:?}, context={:?}, settings={}",
        api_url,
        model,
        context_length,
        settings.display()
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

/// Environment variables Copilot CLI reads for BYOK — what earlier releases
/// persisted to the user's shell rc (`setx` on Windows) and the old
/// `atomic-chat-cli launch` set on the child. `configure_copilot` now writes
/// `providers.json` instead and removes these.
pub fn copilot_env_vars(
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
) -> Vec<(String, String)> {
    let mut env_vars: Vec<(String, String)> = Vec::with_capacity(5);
    env_vars.push(("COPILOT_PROVIDER_BASE_URL".to_string(), api_url.to_string()));
    env_vars.push(("COPILOT_PROVIDER_TYPE".to_string(), "openai".to_string()));
    env_vars.push(("COPILOT_MODEL".to_string(), model.to_string()));
    env_vars.push(("COPILOT_OFFLINE".to_string(), "true".to_string()));
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        env_vars.push(("COPILOT_PROVIDER_API_KEY".to_string(), key.to_string()));
    }
    env_vars
}

/// Configure GitHub Copilot CLI: an `atomic-chat` provider and model in its
/// `providers.json`, which the Launch page starts with
/// `copilot --model atomic-chat/<model>`. The variables earlier releases
/// persisted user-wide are removed; see `copilot_config`.
#[tauri::command]
pub fn configure_copilot(
    api_url: String,
    model: String,
    api_key: Option<String>,
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    let path =
        super::copilot_config::configure(&api_url, &model, api_key.as_deref(), context_length)?;
    log::info!(
        "Copilot configured: base_url={}, model={}, providers={}",
        api_url,
        model,
        path.display()
    );
    Ok(())
}

/// Configure Pi by upserting the `atomic` provider in `<agent dir>/models.json`
/// and pointing `<agent dir>/settings.json` at it (both strict JSON, all other
/// providers / keys preserved; the agent dir is `$PI_CODING_AGENT_DIR`, else
/// `~/.pi/agent`). Pi speaks OpenAI Chat Completions, so `api_url` carries the
/// `/v1` suffix.
#[tauri::command]
pub fn configure_pi(
    api_url: String,
    model: String,
    api_key: Option<String>,
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    let paths = super::opencode_family::FamilyPaths::resolve()?;
    super::opencode_family::connect_pi(
        &paths.pi_dir,
        &api_url,
        &model,
        api_key.as_deref(),
        context_length,
    )?;
    log::info!(
        "Pi configured: dir={}, baseUrl={}, model={}",
        paths.pi_dir.display(),
        api_url,
        model
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// DeepSeek Harness (`dsh`)
// ---------------------------------------------------------------------------

/// The harness plugin namespace that owns hand-declared provider routes. It is
/// mounted dormant by the shipped base bundle — zero routes until a `llm-pi-ai:`
/// section supplies profiles, at which point they register live with no
/// restart, so writing the file is the whole integration.
pub(crate) const DSH_SECTION: &str = "llm-pi-ai";
/// Our route id. It doubles as the stem of the credential reference below, and
/// as the settings key the harness' own Models page addresses, so it must stay
/// a lowercase-leading POSIX-identifier-safe word.
pub(crate) const DSH_ROUTE_ID: &str = "atomic";
/// Credential *reference* (an env var name, never the secret). The harness'
/// Models page derives `<ROUTE>_API_KEY` for routes it creates, so matching
/// that derivation keeps our route editable — and deletable — from inside dsh.
const DSH_KEY_ENV: &str = "ATOMIC_API_KEY";
/// The section of the legacy `settings.yaml` (and the profile entry) holding
/// the default model for new sessions.
const DSH_DEFAULT_MODEL_SECTION: &str = "agent-default-model";

fn ykey(s: &str) -> serde_yaml::Value {
    serde_yaml::Value::String(s.to_string())
}

/// Borrow `parent[key]` as a mapping, creating it when absent.
///
/// A bare `llm-pi-ai:` (or `providers:`) with nothing under it parses to
/// `Value::Null`, which is a hole to fill rather than data to protect — those
/// are healed. Anything else non-mapping is real user content and errors out.
/// The JSON siblings clobber in this position (`if !x.is_object() { *x = {} }`);
/// we deliberately do not, because `settings.yaml` is shared with every other
/// harness plugin and a silent overwrite would delete config we do not own.
fn dsh_child_mapping<'a>(
    parent: &'a mut serde_yaml::Mapping,
    key: &str,
    label: &str,
) -> Result<&'a mut serde_yaml::Mapping, String> {
    let k = ykey(key);
    let vacant = match parent.get(&k) {
        None => true,
        Some(v) => v.is_null(),
    };
    if vacant {
        parent.insert(
            k.clone(),
            serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
        );
    }
    parent
        .get_mut(&k)
        .and_then(|v| v.as_mapping_mut())
        .ok_or_else(|| {
            format!(
                "`{}` in {} is not a mapping. Fix or remove it and try again.",
                label, "settings.yaml"
            )
        })
}

/// Build the `llm-pi-ai.providers.atomic` route node.
///
/// dsh refuses a hand-declared route unless `api`, `baseURL` and a NON-EMPTY
/// `models` list are all present, and it refuses the *whole* section when one
/// route is invalid — which is why the caller validates before we get here.
///
/// `apiKeyEnv` names an env var; it is never the secret. dsh fails requests with
/// MISSING_CREDENTIAL when the field is present but resolves to nothing, so the
/// keyless path omits the field rather than writing an empty string, leaving a
/// plainly unauthenticated route.
///
/// A model the pi-ai catalog does not ship falls back to `defaultContextWindow`
/// 262144 / `defaultMaxTokens` 32768. With the served window known, the model
/// declares it, and a reply of a quarter of it (8192 at most); unknown, dsh's
/// defaults stand.
fn dsh_route_node(
    api_url: &str,
    model: &str,
    with_key: bool,
    context: Option<u32>,
) -> serde_yaml::Value {
    use serde_yaml::{Mapping, Value};

    let mut model_entry = Mapping::new();
    model_entry.insert(ykey("id"), Value::String(model.to_string()));
    if let Some(context) = context.filter(|c| *c > 0) {
        model_entry.insert(ykey("contextWindow"), Value::from(context));
        model_entry.insert(
            ykey("maxTokens"),
            Value::from(super::agent_files::output_cap(context)),
        );
    }

    let mut route = Mapping::new();
    route.insert(
        ykey("displayName"),
        Value::String("Atomic Chat".to_string()),
    );
    route.insert(ykey("api"), Value::String("openai-completions".to_string()));
    route.insert(ykey("baseURL"), Value::String(api_url.to_string()));
    if with_key {
        route.insert(ykey("apiKeyEnv"), Value::String(DSH_KEY_ENV.to_string()));
    }
    route.insert(
        ykey("models"),
        Value::Sequence(vec![Value::Mapping(model_entry)]),
    );
    Value::Mapping(route)
}

/// Upsert our route into an already-parsed `settings.yaml` tree. Pure: no IO,
/// no environment.
///
/// Everything outside `llm-pi-ai.providers.atomic` is preserved — other plugin
/// sections, other keys inside the section, other provider routes — including
/// relative order, since `serde_yaml::Mapping` is insertion-ordered and
/// `insert` on an existing key keeps its position.
///
/// The route is replaced WHOLESALE, never deep-merged: a merge would let a
/// stale `apiKeyEnv` from an earlier keyed run survive into a keyless run and
/// break every request with MISSING_CREDENTIAL.
fn apply_dsh_provider(
    root: &mut serde_yaml::Value,
    api_url: &str,
    model: &str,
    with_key: bool,
    context: Option<u32>,
) -> Result<(), String> {
    use serde_yaml::{Mapping, Value};

    dsh_validate_route(api_url, model)?;

    // An empty, whitespace-only, or comment-only document parses to Null rather
    // than erroring (unlike serde_json, which rejects ""), so one heal covers
    // all three.
    if root.is_null() {
        *root = Value::Mapping(Mapping::new());
    }
    let root_map = root
        .as_mapping_mut()
        .ok_or_else(|| "settings.yaml top level is not a YAML mapping".to_string())?;

    let section = dsh_child_mapping(root_map, DSH_SECTION, DSH_SECTION)?;
    let providers = dsh_child_mapping(section, "providers", &format!("{}.providers", DSH_SECTION))?;
    providers.insert(
        ykey(DSH_ROUTE_ID),
        dsh_route_node(api_url, model, with_key, context),
    );
    Ok(())
}

/// An invalid route does not merely fail to help: dsh rejects the entire
/// `llm-pi-ai` section, taking the user's other providers down with it. So
/// refuse to write one, before touching anything.
fn dsh_validate_route(api_url: &str, model: &str) -> Result<(), String> {
    if api_url.trim().is_empty() {
        return Err("No local server URL. Start the local API server and try again.".to_string());
    }
    if model.trim().is_empty() {
        return Err(
            "No model selected. DeepSeek Harness rejects a provider with an empty model \
             list, which would also disable any other provider configured in that section."
                .to_string(),
        );
    }
    Ok(())
}

/// Resolve dsh's home from a `DSH_HOME` value and the user's home directory.
/// Pure half of {@link dsh_home_dir}.
fn dsh_home_from(dsh_home_env: Option<&str>, user_home: &Path) -> PathBuf {
    match dsh_home_env.map(str::trim).filter(|v| !v.is_empty()) {
        // A `DSH_HOME="~/dev/dsh"` written with quotes in an rc file is never
        // tilde-expanded by the shell, so a literal `~` can reach us.
        Some("~") => user_home.to_path_buf(),
        Some(v) if v.starts_with("~/") || v.starts_with("~\\") => user_home.join(&v[2..]),
        Some(v) => PathBuf::from(v),
        None => user_home.join(".dsh"),
    }
}

/// Resolve dsh's home directory: `$DSH_HOME` as the `dsh` we start will see it
/// (an `export DSH_HOME=...` in `~/.zshrc` is invisible to a Finder/Dock
/// launched app), else `~/.dsh`.
pub(crate) fn dsh_home_dir() -> Result<PathBuf, String> {
    let from_env = super::agent_user_env::agent_env_var("DSH_HOME");
    let home = agent_home_dir()?;
    Ok(dsh_home_from(from_env.as_deref(), Path::new(&home)))
}

/// Write `bytes` to `path` via a temp sibling and a rename, so a crash or a full
/// disk cannot leave a truncated file behind.
///
/// The existing `configure_*` commands use a plain `std::fs::write`, which is
/// tolerable for a config file we are the sole author of. DeepSeek Harness's
/// `settings.yaml` and ZCode's `provider_config.json` hold configuration we do
/// not own, so a half-written file destroys it. Symlinks are resolved first:
/// renaming onto a link would replace it with a regular file and silently
/// detach a dotfile managed by stow/chezmoi.
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;

    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let stem = target
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("atomic");
    let tmp = target.with_file_name(format!(".{}.atomic-tmp-{}", stem, std::process::id()));

    let result = (|| -> Result<(), String> {
        let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &target).map_err(|e| e.to_string())
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map_err(|e| format!("Failed to write {}: {}", target.display(), e))
}

/// Restrict a credential-bearing file to its owner. Best-effort: a permissions
/// failure must not fail the configure.
#[cfg(unix)]
fn restrict_to_owner(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_to_owner(_path: &Path) {}

/// Reject a value no dotenv line can carry.
///
/// An unquoted dotenv value ends at whitespace or `#`; a newline would inject a
/// second assignment outright. The message names the variable and never the
/// value, so a rejected key cannot leak through an error toast or the log.
fn dsh_validate_env_value(name: &str, value: &str) -> Result<(), String> {
    if value.contains(['\n', '\r', '#', '"', '\'']) || value.chars().any(char::is_whitespace) {
        return Err(format!(
            "{} contains characters that cannot be stored in a .env file",
            name
        ));
    }
    Ok(())
}

/// Upsert — or, with an empty `vars`, remove — an Atomic-Chat-managed block in a
/// dotenv file, preserving every line outside it. `#` starts a comment in dotenv
/// too, so the markers are inert to any reader.
///
/// Deliberately not `write_marked_env_to_shell`: that one emits shell
/// `export K='V'` syntax, uses a different single-line marker scheme, and always
/// appends a fresh block — it cannot express "remove the block and write
/// nothing", which is exactly what the keyless path needs.
fn dsh_write_managed_env(path: &Path, vars: &[(&str, &str)]) -> Result<(), String> {
    for (name, value) in vars {
        dsh_validate_env_value(name, value)?;
    }

    let existing = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if vars.is_empty() {
                // Nothing to clear; do not create the file just to leave it empty.
                return Ok(());
            }
            String::new()
        }
        Err(e) => return Err(format!("Failed to read {}: {}", path.display(), e)),
    };

    // The shared stripper removes every block we ever wrote, so reruns cannot
    // accumulate duplicates.
    let kept = strip_atomic_managed_block(&existing);
    let kept = kept.trim_end();

    let out = if vars.is_empty() {
        if kept.is_empty() {
            String::new()
        } else {
            format!("{}\n", kept)
        }
    } else {
        let body: String = vars
            .iter()
            .map(|(name, value)| format!("{}={}\n", name, value))
            .collect();
        let block = format!("{}\n{}{}\n", ATOMIC_MANAGED_BEGIN, body, ATOMIC_MANAGED_END);
        if kept.is_empty() {
            block
        } else {
            format!("{}\n\n{}", kept, block)
        }
    };

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }
    write_atomically(path, out.as_bytes())?;
    restrict_to_owner(path);
    Ok(())
}

/// Filesystem half of {@link configure_dsh}, taking an explicit dsh home so it
/// is testable.
fn configure_dsh_at(
    home: &Path,
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
    context: Option<u32>,
) -> Result<(), String> {
    let key = api_key.map(str::trim).filter(|k| !k.is_empty());

    // Validate everything before writing anything, so an unusable key cannot
    // leave a route pointing at a reference we then failed to store.
    dsh_validate_route(api_url, model)?;
    if let Some(k) = key {
        dsh_validate_env_value(DSH_KEY_ENV, k)?;
    }

    // A `settings.yaml` that is still there is read live by dsh before 0.2,
    // and merged once into the profile by 0.2+ — over what we write there. Keep
    // it in step; never create one, and never touch `settings.yaml.imported`.
    let settings_path = home.join("settings.yaml");
    let legacy = match super::agent_files::read_text(&settings_path)? {
        Some(text) => Some(dsh_legacy_settings(
            &settings_path,
            &text,
            api_url,
            model,
            key.is_some(),
            context,
        )?),
        None => None,
    };

    let route = dsh_route_node(api_url, model, key.is_some(), context);
    let profile = super::dsh_config::configure_profile(home, DSH_ROUTE_ID, route, model)?;

    if let Some((text, serialized, previous_default)) = legacy {
        // The round trip drops comments and expands anchors, so keep one copy
        // of whatever the user had before we first touched it. Only ever
        // written once, so a later run cannot overwrite the pre-Atomic state.
        let backup = home.join("settings.yaml.atomic-backup");
        if !text.is_empty() && !backup.exists() {
            let _ = std::fs::write(&backup, &text);
        }
        write_atomically(&settings_path, serialized.as_bytes())?;
        if let Some(previous) = previous_default {
            super::agent_files::write_sidecar(
                &settings_path,
                &serde_json::json!({ "previous": { "defaultModel": previous } }),
            )?;
        }
    }

    // The secret itself never enters a config file. dsh resolves the reference
    // from, in order: the inherited environment, `$DSH_HOME/.credentials.yaml`,
    // the invoking directory's `.env`, then `$DSH_HOME/.env` — we write the
    // last, lowest-precedence layer, so anything the user sets deliberately
    // (including through dsh's own Models page) still wins.
    let env_path = home.join(".env");
    match key {
        Some(k) => dsh_write_managed_env(&env_path, &[(DSH_KEY_ENV, k)])?,
        // Keyless: the route carries no `apiKeyEnv`, so a leftover value would
        // be a secret outliving its use. Clear it.
        None => dsh_write_managed_env(&env_path, &[])?,
    }

    log::info!(
        "DeepSeek Harness configured: baseURL={}, model={}, profile={}, key={}",
        api_url,
        model,
        profile.display(),
        if key.is_some() { "yes" } else { "no" }
    );
    Ok(())
}

/// The legacy `settings.yaml` with our route, and our default model when the
/// file names one (which a 0.2+ import would otherwise lay over ours): the
/// original text, the new text, and — the first time — the default it had.
fn dsh_legacy_settings(
    path: &Path,
    text: &str,
    api_url: &str,
    model: &str,
    keyed: bool,
    context: Option<u32>,
) -> Result<(String, String, Option<serde_json::Value>), String> {
    let mut root: serde_yaml::Value = serde_yaml::from_str(text).map_err(|e| {
        format!(
            "Could not parse {}: {}. Fix or remove the file and try again.",
            path.display(),
            e
        )
    })?;
    apply_dsh_provider(&mut root, api_url, model, keyed, context)?;
    let mut previous_default = None;
    let ours = super::dsh_config::default_selection(DSH_ROUTE_ID, model);
    if let Some(map) = root.as_mapping_mut() {
        if let Some(current) = map.get(DSH_DEFAULT_MODEL_SECTION).cloned() {
            let already_ours =
                current.get("provider").and_then(|p| p.as_str()) == Some(DSH_ROUTE_ID);
            if !already_ours {
                previous_default = Some(serde_json::to_value(&current).map_err(|e| e.to_string())?);
            }
            map.insert(ykey(DSH_DEFAULT_MODEL_SECTION), ours);
        }
    }
    let mut serialized = serde_yaml::to_string(&root)
        .map_err(|e| format!("Failed to serialize {}: {}", path.display(), e))?;
    if !serialized.ends_with('\n') {
        serialized.push('\n');
    }
    Ok((text.to_string(), serialized, previous_default))
}

/// Point DeepSeek Harness (`dsh`) at the local Atomic Chat server: the
/// `atomic` route and the default model in the `web` profile's
/// `cordis.patch.yml` (see `dsh_config`), the key in `$DSH_HOME/.env`, and —
/// while an older dsh still reads it — the route in `$DSH_HOME/settings.yaml`.
/// dsh picks the changes up without a restart.
#[tauri::command]
pub fn configure_dsh(
    api_url: String,
    model: String,
    api_key: Option<String>,
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    let home = dsh_home_dir()?;
    configure_dsh_at(&home, &api_url, &model, api_key.as_deref(), context_length)
}

/// Undo {@link configure_dsh_at}: our route and default leave the profile (the
/// previous default comes back), the legacy `settings.yaml` loses our route,
/// and our key leaves `.env`.
pub(crate) fn disconnect_dsh_at(home: &Path) -> Result<(), String> {
    super::dsh_config::disconnect_profile(home, DSH_ROUTE_ID)?;

    let settings_path = home.join("settings.yaml");
    if let Some(text) = super::agent_files::read_text(&settings_path)? {
        let mut root: serde_yaml::Value = serde_yaml::from_str(&text).map_err(|e| {
            format!(
                "Could not parse {}: {}. Fix or remove the file and try again.",
                settings_path.display(),
                e
            )
        })?;
        let mut changed = false;
        if let Some(providers) = root
            .get_mut(DSH_SECTION)
            .and_then(|s| s.get_mut("providers"))
            .and_then(|p| p.as_mapping_mut())
        {
            changed |= providers.remove(DSH_ROUTE_ID).is_some();
        }
        if let Some(map) = root.as_mapping_mut() {
            let ours = map
                .get(DSH_DEFAULT_MODEL_SECTION)
                .and_then(|d| d.get("provider"))
                .and_then(|p| p.as_str())
                == Some(DSH_ROUTE_ID);
            if ours {
                let previous = super::agent_files::read_sidecar(&settings_path)
                    .and_then(|b| b.get("previous")?.get("defaultModel").cloned());
                match previous {
                    Some(previous) => {
                        let value = serde_yaml::to_value(&previous).map_err(|e| e.to_string())?;
                        map.insert(ykey(DSH_DEFAULT_MODEL_SECTION), value);
                    }
                    None => {
                        map.remove(DSH_DEFAULT_MODEL_SECTION);
                    }
                }
                changed = true;
            }
        }
        if changed {
            let serialized = serde_yaml::to_string(&root)
                .map_err(|e| format!("Failed to serialize {}: {}", settings_path.display(), e))?;
            write_atomically(&settings_path, serialized.as_bytes())?;
        }
    }
    super::agent_files::remove_sidecar(&settings_path)?;

    dsh_write_managed_env(&home.join(".env"), &[])
}

/// Goose gets its settings at launch, in the environment of the one
/// `goose session` the Launch page starts, so a connection writes nothing.
/// What earlier releases saved user-wide instead (a shell rc block, `setx`) is
/// taken out here; see `goose_config`.
#[tauri::command]
pub async fn configure_goose(
    api_url: String,
    model: String,
    api_key: Option<String>,
    // The window goes into the launch environment instead.
    context_length: Option<u32>,
) -> Result<(), String> {
    let _ = context_length;
    tauri::async_runtime::spawn_blocking(move || {
        super::goose_config::remove_legacy(api_key.as_deref())
    })
    .await
    .map_err(|e| e.to_string())??;
    log::info!("Goose configured: host={}, model={}", api_url, model);
    Ok(())
}

/// What an older release persisted for an agent that now gets its environment
/// at launch only (OpenHands, Poolside, Muse Code): the marker that opens and
/// closes its shell-rc block, and the User-scope variables `setx` wrote on
/// Windows.
struct LegacyEnvAgent {
    marker: &'static str,
    vars: &'static [&'static str],
    /// The variable holding the server key: `atomic` (our placeholder) or the
    /// server's own key there marks the whole set as ours.
    key_var: &'static str,
    /// The variable holding our endpoint, when the agent has one.
    url_var: Option<&'static str>,
}

fn legacy_env_agent(agent_id: &str) -> Option<LegacyEnvAgent> {
    match agent_id {
        "openhands" => Some(LegacyEnvAgent {
            marker: "# Atomic Chat - OpenHands Config",
            vars: &["LLM_MODEL", "LLM_BASE_URL", "LLM_API_KEY"],
            key_var: "LLM_API_KEY",
            url_var: Some("LLM_BASE_URL"),
        }),
        "poolside" => Some(LegacyEnvAgent {
            marker: "# Atomic Chat - Poolside Config",
            vars: &[
                "POOLSIDE_STANDALONE_BASE_URL",
                "POOLSIDE_API_KEY",
                "POOLSIDE_STANDALONE_MODEL",
            ],
            key_var: "POOLSIDE_API_KEY",
            url_var: Some("POOLSIDE_STANDALONE_BASE_URL"),
        }),
        "muse" => Some(LegacyEnvAgent {
            marker: "# Atomic Chat - Muse Code Config",
            vars: &["META_API_KEY"],
            key_var: "META_API_KEY",
            url_var: None,
        }),
        _ => None,
    }
}

/// `content` without the region between (and including) the paired `marker`
/// lines — exactly the block `write_marked_env_to_shell` appended. Every
/// other line stays, the user's own exports of the same variables included.
pub(crate) fn remove_marked_env_block(content: &str, marker: &str) -> String {
    if !content.split('\n').any(|line| line.starts_with(marker)) {
        return content.to_string();
    }
    let mut in_block = false;
    content
        .split('\n')
        .filter(|line| {
            if line.starts_with(marker) {
                in_block = !in_block;
                return false;
            }
            !in_block
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The shell rc files older releases may have written an env block to: the
/// one `detect_shell_env_file` picks depends on `$SHELL`, which may have
/// changed since.
fn legacy_shell_env_files(home: &Path) -> [PathBuf; 3] {
    [
        home.join(".zshenv"),
        home.join(".bash_profile"),
        home.join(".bashrc"),
    ]
}

/// Remove the shell-rc block of `agent` from every rc file under `home`.
fn remove_legacy_env_blocks(home: &Path, agent: &LegacyEnvAgent) -> Result<(), String> {
    for path in legacy_shell_env_files(home) {
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let cleaned = remove_marked_env_block(&content, agent.marker);
        if cleaned != content {
            std::fs::write(&path, cleaned)
                .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
            log::info!("Removed the {} block from {}", agent.marker, path.display());
        }
    }
    Ok(())
}

/// Whether the User-scope variables `values` (one per `agent.vars`) are the
/// set an older release wrote: its key is our placeholder or this server's
/// key, or its endpoint is this server's (with or without the `/v1` older
/// Poolside setups dropped).
fn legacy_env_values_are_ours(
    agent: &LegacyEnvAgent,
    value: &dyn Fn(&str) -> Option<String>,
    server_key: Option<&str>,
    api_url: Option<&str>,
) -> bool {
    let key = value(agent.key_var);
    let key_is_ours = key
        .as_deref()
        .is_some_and(|k| k == "atomic" || server_key.is_some_and(|s| !s.is_empty() && s == k));
    let url_is_ours = match (agent.url_var.and_then(|v| value(v)), api_url) {
        (Some(url), Some(api_url)) => {
            let api_url = api_url.trim_end_matches('/');
            let url = url.trim_end_matches('/');
            url == api_url || Some(url) == api_url.strip_suffix("/v1")
        }
        _ => false,
    };
    key_is_ours || url_is_ours
}

/// Remove what an older Atomic Chat release persisted for `agent_id`, which
/// now gets its environment inline at launch: its marked shell-rc block, and on
/// Windows the User-scope variables `setx` wrote, when they are recognisably
/// ours (see [`legacy_env_values_are_ours`]). A user's own lines and values
/// are never touched. `server_key` and `api_url` describe the server being
/// connected (none on Disconnect, where only our placeholder key identifies
/// them).
pub(crate) fn remove_legacy_env_agent_config(
    agent_id: &str,
    server: Option<(&str, Option<&str>)>,
) -> Result<(), String> {
    let Some(agent) = legacy_env_agent(agent_id) else {
        return Ok(());
    };
    if cfg!(windows) {
        let ours = legacy_env_values_are_ours(
            &agent,
            &|name| read_windows_user_env(name),
            server.and_then(|(_, key)| key),
            server.map(|(url, _)| url),
        );
        if ours {
            remove_windows_user_env(agent.vars)?;
        }
        return Ok(());
    }
    remove_legacy_env_blocks(Path::new(&agent_home_dir()?), &agent)
}

/// Delete User-scope environment variables the way `setx` set them, through
/// .NET so the change is broadcast to new processes.
#[cfg(windows)]
fn remove_windows_user_env(names: &[&str]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let script = names
        .iter()
        .map(|name| {
            format!(
                "[Environment]::SetEnvironmentVariable('{}', $null, 'User')",
                name
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", &script]);
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to clear {}: {}", names.join(", "), e))?;
    if !output.status.success() {
        return Err(format!(
            "Failed to clear {}: {}",
            names.join(", "),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    log::info!("Removed {} from the user environment", names.join(", "));
    Ok(())
}

#[cfg(not(windows))]
fn remove_windows_user_env(_names: &[&str]) -> Result<(), String> {
    Ok(())
}

/// Connect for an agent that takes its endpoint from the environment only:
/// nothing is persisted any more — the terminal Atomic Chat opens passes the
/// variables inline (`integration-agent-run.ts`), and a user-wide variable or
/// rc export would capture every other use of the agent (a cloud key replaced
/// by our placeholder, a dead localhost after Atomic Chat quits). What an
/// older release persisted is removed; failing to is not worth failing
/// Connect over.
fn connect_env_agent(agent_id: &str, name: &str, api_url: &str, api_key: Option<&str>) {
    if let Err(e) = remove_legacy_env_agent_config(agent_id, Some((api_url, api_key))) {
        log::warn!("Could not remove the environment an older release saved for {name}: {e}");
    }
    log::info!("{name} connected: base_url={api_url}, environment passed at launch");
}

/// Configure OpenHands: its CLI reads `LLM_MODEL` (with litellm's `openai/`
/// prefix, required for a custom OpenAI-compatible base URL), `LLM_BASE_URL`
/// (with `/v1`) and `LLM_API_KEY` only when launched with
/// `--override-with-envs`, which is how the terminal starts it. See
/// [`connect_env_agent`].
#[tauri::command]
pub fn configure_openhands(
    api_url: String,
    model: String,
    api_key: Option<String>,
    context_length: Option<u32>,
) -> Result<(), String> {
    let _ = (model, context_length);
    connect_env_agent("openhands", "OpenHands", &api_url, api_key.as_deref());
    Ok(())
}

/// Configure KiloCode by upserting the `atomic` provider in `kilo.jsonc`
/// (`$KILO_CONFIG_DIR`, else `~/.config/kilo`) and selecting our model (other
/// providers preserved). The file is JSONC (comments / trailing commas), so we
/// parse it with json5 — the same leniency KiloCode applies — and re-serialize
/// as strict JSON on write. Kilo's own saved pick still wins over the config's
/// `model`, so the Launch page also starts it with `--model atomic/<id>`.
/// KiloCode speaks OpenAI Chat Completions, so `api_url` carries the `/v1`
/// suffix.
#[tauri::command]
pub fn configure_kilo(
    api_url: String,
    model: String,
    api_key: Option<String>,
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    let paths = super::opencode_family::FamilyPaths::resolve()?;
    super::opencode_family::connect_opencode_style(
        &paths.kilo,
        &super::opencode_family::KILO,
        &api_url,
        &model,
        api_key.as_deref(),
        context_length,
    )?;
    log::info!(
        "KiloCode configured: config={}, baseURL={}, model={}",
        paths.kilo.file.display(),
        api_url,
        model
    );
    Ok(())
}

/// Configure Poolside CLI, whose standalone mode reads
/// `POOLSIDE_STANDALONE_BASE_URL` (with `/v1`, per its docs),
/// `POOLSIDE_API_KEY`, `POOLSIDE_STANDALONE_MODEL` and
/// `POOLSIDE_STANDALONE_CONTEXT_LENGTH` from the environment; the terminal
/// passes them. See [`connect_env_agent`].
#[tauri::command]
pub fn configure_poolside(
    api_url: String,
    model: String,
    api_key: Option<String>,
    context_length: Option<u32>,
) -> Result<(), String> {
    let _ = (model, context_length);
    connect_env_agent("poolside", "Poolside", &api_url, api_key.as_deref());
    Ok(())
}

/// Configure Muse Code. It has no writable endpoint configuration:
/// `~/.config/muse/settings.json` holds UI, tool and MCP preferences, while the
/// provider is chosen per invocation with `--provider meta --base-url <url>
/// --model <id>`, and Muse only checks that `META_API_KEY` is present -- the
/// call goes wherever `--base-url` points. The terminal passes all of it. See
/// [`connect_env_agent`].
#[tauri::command]
pub fn configure_muse(
    api_url: String,
    model: String,
    api_key: Option<String>,
    context_length: Option<u32>,
) -> Result<(), String> {
    let _ = (model, context_length);
    connect_env_agent("muse", "Muse Code", &api_url, api_key.as_deref());
    Ok(())
}

/// Configure Cline CLI by RUNNING its official non-interactive setup command
/// (`cline auth ...`), the path `ollama launch cline` takes too, rather than
/// writing the provider ourselves. `cline auth` has no flag for the context
/// window, so that is set on the entry it saved afterwards, and what it
/// replaced is kept for Disconnect; see `cline_config`. `cline` is guaranteed
/// on PATH by the time this runs (handleRun installs the agent first).
#[tauri::command]
pub fn configure_cline(
    api_url: String,
    model: String,
    api_key: Option<String>,
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    // What Disconnect restores, read before `cline auth` rewrites it.
    let providers_path = super::cline_config::resolve_providers_path()?;
    let snapshot = super::cline_config::snapshot(&providers_path)?;
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

    // `cline auth` has no flag for the window; set it on the entry it saved.
    super::cline_config::finish(&providers_path, snapshot, &api_url, &model, context_length)?;
    log::info!("Cline configured: baseUrl={}, model={}", api_url, model);
    Ok(())
}

// ---------------------------------------------------------------------------
// Atomic Agent integration
// ---------------------------------------------------------------------------

/// Provider id written into Atomic Agent's `llm.providers` registry. Must match
/// its `PROVIDER_ID_RE` (`^[a-z][a-z0-9-]{0,31}$`, `src/config/llm-config.ts`).
pub(crate) const ATOMIC_AGENT_PROVIDER_ID: &str = "atomic-chat";

/// The `llama-server` provider Atomic Agent synthesises for itself when the
/// config file carries no `llm` block (`parseUserLlmFileConfig`'s defaults in
/// `src/config/config-schema.ts`). `llm.activeEmbeddingProvider` must name an
/// entry that exists in `llm.providers`, so this is both what we seed a new
/// block with and the only target we ever repair a dangling one to — pointing
/// embeddings at Atomic Chat instead would silently repoint the agent's memory
/// recall, which is not what Run asked for.
const ATOMIC_AGENT_LOCAL_PROVIDER_ID: &str = "local-llama";

/// Fallback for `localModels.url`, matching `USER_CONFIG_DEFAULTS` in
/// Atomic Agent's `src/config/config-schema.ts`.
const ATOMIC_AGENT_DEFAULT_LLAMA_URL: &str = "http://127.0.0.1:8080";

/// Fallback for `localModels.managed.port`, from the same defaults. Used only
/// when the config selects `mode: "managed"` without naming a port.
const ATOMIC_AGENT_DEFAULT_MANAGED_PORT: u64 = 19_091;

/// Fallback for `localModels.embeddings.port`, from the same defaults. The
/// agent derives `localModels.embeddings.url` from it when the file names a
/// port but no url (`config-schema.ts`'s `embeddingsDaemon`).
const ATOMIC_AGENT_DEFAULT_EMBEDDINGS_PORT: u64 = 19_092;

/// Per-request timeout seeded on our provider entry. Atomic Agent's
/// OpenAI-compatible provider otherwise defaults to 600_000 ms
/// (`src/llm/provider/openai/openai-provider.ts`), so a wedged local turn would
/// hang for ten minutes before failing. Any value already on our entry wins.
const ATOMIC_AGENT_REQUEST_TIMEOUT_MS: u64 = 300_000;

/// Resolve Atomic Agent's state directory, mirroring `loadConfig()` in its
/// `src/config/load-config.ts`: an explicit `ATOMIC_AGENT_STATE_DIR` wins, else
/// `~/.atomic-agent` on every platform (the agent expands `~` through Node's
/// `os.homedir()`, which is `%USERPROFILE%` on Windows).
///
/// The Windows registry read comes first for the same reason as Hermes': a
/// User-scope variable set after this process started is invisible to
/// `std::env::var`, which only sees the block snapshotted at app startup — see
/// `docs/decisions/2026-07-01-fix-hermes-agent-config-on-windows-writing-to-the-wrong-file.md`.
pub(crate) fn resolve_atomic_agent_state_dir() -> Result<PathBuf, String> {
    if let Some(dir) =
        read_windows_user_env("ATOMIC_AGENT_STATE_DIR").filter(|s| !s.trim().is_empty())
    {
        return Ok(PathBuf::from(dir.trim()));
    }
    if let Ok(dir) = std::env::var("ATOMIC_AGENT_STATE_DIR") {
        if !dir.trim().is_empty() {
            return Ok(PathBuf::from(dir.trim()));
        }
    }
    Ok(PathBuf::from(agent_home_dir()?).join(".atomic-agent"))
}

/// The `llama-server` entry Atomic Agent would synthesise for itself, built
/// from the same inputs its parser uses (`parseUserLlmFileConfig`'s defaults in
/// `src/config/config-schema.ts`). The URL is mode-aware: under
/// `localModels.mode: "managed"` the agent ignores `localModels.url` and talks
/// to the daemon it runs on `localModels.managed.port`.
///
/// `url` carries chat, `baseUrl` carries embeddings — see
/// `atomic_agent_embedding_base_url` for why the two can differ and why
/// omitting the second would move a working embeddings setup.
fn atomic_agent_local_llama_entry(
    root: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Value {
    let local_models = root.get("localModels");
    let managed = local_models.and_then(|v| v.get("managed"));
    let url = if local_models
        .and_then(|v| v.get("mode"))
        .and_then(|v| v.as_str())
        == Some("managed")
    {
        let port = managed
            .and_then(|v| v.get("port"))
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(ATOMIC_AGENT_DEFAULT_MANAGED_PORT);
        format!("http://127.0.0.1:{}", port)
    } else {
        local_models
            .and_then(|v| v.get("url"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(ATOMIC_AGENT_DEFAULT_LLAMA_URL)
            .to_string()
    };

    serde_json::json!({
        "id": ATOMIC_AGENT_LOCAL_PROVIDER_ID,
        "kind": "llama-server",
        "baseUrl": atomic_agent_embedding_base_url(root, &url),
        "url": url,
    })
}

/// Where the agent would look for embeddings if we were not writing an `llm`
/// block at all — the no-block branch of `resolveEmbeddingLlmConfig`
/// (`src/memory/embeddings/embedding-provider-registry.ts`), which reads
/// `embeddings.enabled ? embeddings.url : localModels.url`. `chat_url` is the
/// mode-aware URL already computed for this entry, because `localModels.url`
/// is itself resolved to the managed daemon before that branch sees it
/// (`src/config/load-config.ts`).
///
/// Seeding this matters because the embedding path resolves a provider entry
/// as `baseUrl ?? url`: without it, creating the `llm` block would silently
/// repoint embeddings at the chat daemon for everyone running the embeddings
/// daemon. The agent's own synthesised entry sets `baseUrl` unconditionally to
/// the embeddings daemon URL, but copying that literally would point a default
/// install at a port with nothing listening — the branch that governs the
/// files we convert is the no-`llm`-block one, so that is the one we mirror.
fn atomic_agent_embedding_base_url(
    root: &serde_json::Map<String, serde_json::Value>,
    chat_url: &str,
) -> String {
    let embeddings = root.get("localModels").and_then(|v| v.get("embeddings"));
    let enabled = embeddings
        .and_then(|v| v.get("enabled"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if !enabled {
        return chat_url.to_string();
    }
    embeddings
        .and_then(|v| v.get("url"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            let port = embeddings
                .and_then(|v| v.get("port"))
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(ATOMIC_AGENT_DEFAULT_EMBEDDINGS_PORT);
            format!("http://127.0.0.1:{}", port)
        })
}

/// Upsert the Atomic Chat provider into an Atomic Agent `config.json` payload.
///
/// Split out from the command so the merge is unit-testable without touching a
/// real state directory. Everything outside `llm` is left byte-for-byte alone;
/// inside `llm`, only our own provider entry and `activeTextProvider` are
/// rewritten (plus `activeEmbeddingProvider` when it is absent or dangling,
/// which the agent would otherwise refuse to load, and `fallback` when there
/// is none). Unknown keys survive because Atomic Agent's parser carries
/// unknown top-level keys through verbatim.
fn atomic_agent_patch_config(
    mut root: serde_json::Value,
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
    context_length: Option<u32>,
) -> Result<serde_json::Value, String> {
    // The agent's `parseOptionalString` rejects `""` outright rather than
    // treating it as absent, so an empty model would take the whole file down
    // at its next start. Both callers already guarantee a model; failing here
    // makes that the writer's own contract instead of an inherited one.
    if model.trim().is_empty() {
        return Err("Atomic Agent needs a model: none is running.".to_string());
    }

    let obj = root
        .as_object_mut()
        .ok_or_else(|| "config.json is not a JSON object".to_string())?;

    // Read before the `llm` block is borrowed mutably; never written back.
    let local_llama = atomic_agent_local_llama_entry(obj);

    let llm = obj.entry("llm").or_insert_with(|| serde_json::json!({}));
    if !llm.is_object() {
        *llm = serde_json::json!({});
    }
    let llm = llm.as_object_mut().unwrap();

    // Read before `llm.providers` is borrowed mutably below.
    let current_embedding = llm
        .get("activeEmbeddingProvider")
        .and_then(|v| v.as_str())
        .map(str::to_string);

    // Embeddings drive memory recall, not chat, so a working selection is left
    // alone. A missing or dangling one is repaired rather than carried forward,
    // because Atomic Agent rejects the whole file when
    // `activeEmbeddingProvider` names a provider that is not in the list.
    let repair_embedding = {
        let providers = llm
            .entry("providers")
            .or_insert_with(|| serde_json::json!([]));
        if !providers.is_array() {
            *providers = serde_json::json!([]);
        }
        let providers = providers.as_array_mut().unwrap();

        // A brand-new block needs the agent's own default entry alongside ours,
        // so `activeEmbeddingProvider` has something valid to point at.
        if providers.is_empty() {
            providers.push(local_llama.clone());
        }

        let existing = providers
            .iter()
            .position(|p| p.get("id").and_then(|v| v.as_str()) == Some(ATOMIC_AGENT_PROVIDER_ID));

        // Atomic Chat usually runs without auth, but the entry is stored as an
        // `openai-compatible` provider and most such clients reject an empty key.
        let key_val = api_key
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .unwrap_or("atomic");

        // A timeout the user tuned on our entry is theirs; we only fill the gap.
        let timeout = existing
            .and_then(|i| providers[i].get("requestTimeoutMs").cloned())
            .filter(|v| v.is_number())
            .unwrap_or_else(|| serde_json::json!(ATOMIC_AGENT_REQUEST_TIMEOUT_MS));

        let mut entry = serde_json::json!({
            "id": ATOMIC_AGENT_PROVIDER_ID,
            "kind": "openai-compatible",
            "baseUrl": api_url,
            "apiKey": key_val,
            "defaultChatModel": model.trim(),
            "supportsTools": true,
            "requestTimeoutMs": timeout,
        });
        // `userModels` outranks the bundled catalog in the agent's
        // `resolveModel`; without it a local model is assumed to hold 128K
        // and is never compacted before the server refuses. An unknown window
        // is left to the agent rather than invented.
        if let Some(ctx) = context_length {
            entry["userModels"] = serde_json::json!([{
                "id": model.trim(),
                "kind": "chat",
                "contextWindow": ctx,
            }]);
        }
        match existing {
            Some(i) => providers[i] = entry,
            None => providers.push(entry),
        }

        let repair = !current_embedding
            .as_deref()
            .is_some_and(|id| atomic_agent_lists(providers, id));
        // The repair target is always `local-llama` — the agent's own default,
        // seeded here when the file does not carry it. Falling back to our own
        // id would quietly hand memory recall to Atomic Chat, which is not what
        // Run asked for.
        if repair && !atomic_agent_lists(providers, ATOMIC_AGENT_LOCAL_PROVIDER_ID) {
            providers.push(local_llama);
        }
        repair
    };

    // Pressing Run is an explicit "use this", so the text provider is switched
    // outright — same contract as OpenCode's `model` key.
    llm.insert(
        "activeTextProvider".to_string(),
        serde_json::json!(ATOMIC_AGENT_PROVIDER_ID),
    );
    if repair_embedding {
        llm.insert(
            "activeEmbeddingProvider".to_string(),
            serde_json::json!(ATOMIC_AGENT_LOCAL_PROVIDER_ID),
        );
    }
    // With no `fallback` block the agent appends its `llama-server` provider
    // to every chain (`appendLocal` defaults to true), so any failure of ours —
    // a 404 for a model the server stopped serving included — is retried
    // against `local-llama` on :8080, where nothing listens, and reported as
    // "The local model isn't running". A chain the user configured is theirs.
    if llm.get("fallback").map_or(true, serde_json::Value::is_null) {
        llm.insert(
            "fallback".to_string(),
            serde_json::json!({ "appendLocal": false }),
        );
    }

    Ok(root)
}

/// The `llm` keys Connect may overwrite besides our provider entry.
fn atomic_agent_tracked_paths() -> Vec<Vec<String>> {
    use json_key_backup::path_of;
    vec![
        path_of(&["llm", "activeTextProvider"]),
        path_of(&["llm", "activeEmbeddingProvider"]),
        path_of(&["llm", "fallback"]),
    ]
}

/// Undo [`atomic_agent_patch_config`] on `root`: put back the `llm` keys
/// `backup` recorded (those still holding our value) and drop our provider
/// entry. The `local-llama` entry Connect seeded goes only when nothing else
/// is left, so the agent synthesizes its own defaults again; otherwise it is
/// what the active providers fall back to. Every reference to our provider
/// that would be left dangling — which the agent refuses to load — is
/// cleared, whether a backup exists (a connection by an older release keeps
/// none) or not.
fn atomic_agent_unpatch_config(
    mut root: serde_json::Value,
    backup: Option<&json_key_backup::Backup>,
) -> serde_json::Value {
    use json_key_backup::{path_of, remove};
    if let Some(backup) = backup {
        json_key_backup::restore(&mut root, &backup.keys);
    }
    let Some(llm) = root.get_mut("llm").and_then(|l| l.as_object_mut()) else {
        return root;
    };
    let Some(providers) = llm.get_mut("providers").and_then(|p| p.as_array_mut()) else {
        return root;
    };
    providers.retain(|p| p.get("id").and_then(|v| v.as_str()) != Some(ATOMIC_AGENT_PROVIDER_ID));
    let seeded = backup.map(|b| b.seeded.as_slice()).unwrap_or_default();
    if providers.len() == 1 && seeded.contains(&providers[0]) {
        providers.clear();
    }
    let remaining: Vec<String> = providers
        .iter()
        .filter_map(|p| p.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    if remaining.is_empty() {
        llm.remove("providers");
    }
    for key in ["activeTextProvider", "activeEmbeddingProvider"] {
        if llm.get(key).and_then(|v| v.as_str()) != Some(ATOMIC_AGENT_PROVIDER_ID) {
            continue;
        }
        // The agent's default is `local-llama`, which it synthesizes when
        // there is no provider list at all.
        if remaining.is_empty()
            || remaining
                .iter()
                .any(|id| id == ATOMIC_AGENT_LOCAL_PROVIDER_ID)
        {
            llm.remove(key);
        } else {
            llm.insert(key.to_string(), serde_json::json!(remaining[0]));
        }
    }
    if let Some(chain) = llm
        .get_mut("fallback")
        .and_then(|f| f.get_mut("chain"))
        .and_then(|c| c.as_array_mut())
    {
        chain.retain(|id| id.as_str() != Some(ATOMIC_AGENT_PROVIDER_ID));
    }
    if llm.is_empty() {
        remove(&mut root, &path_of(&["llm"]));
    }
    root
}

/// Whether `providers` already carries an entry with this id.
fn atomic_agent_lists(providers: &[serde_json::Value], id: &str) -> bool {
    providers
        .iter()
        .any(|p| p.get("id").and_then(|v| v.as_str()) == Some(id))
}

fn read_atomic_agent_config(path: &Path) -> Result<Option<serde_json::Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    if text.trim().is_empty() {
        return Ok(Some(serde_json::json!({})));
    }
    serde_json::from_str(&text).map(Some).map_err(|e| {
        format!(
            "Could not parse {}: {}. Fix or remove the file and try again.",
            path.display(),
            e
        )
    })
}

/// Configure Atomic Agent by upserting an `atomic-chat` provider in its user
/// config (`<state dir>/config.json`, default `~/.atomic-agent/config.json`)
/// and selecting it as the active text provider.
///
/// The file is the agent's own trust surface, so the write is a merge, never a
/// replacement: other providers, keys and blocks are preserved, and the
/// `version` field is deliberately not stamped — the agent fills it (and every
/// missing block) with its own defaults on the next start.
#[tauri::command]
pub fn configure_atomic_agent(
    api_url: String,
    model: String,
    api_key: Option<String>,
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    configure_atomic_agent_at(
        &resolve_atomic_agent_state_dir()?,
        &api_url,
        &model,
        api_key.as_deref(),
        context_length,
    )
}

fn configure_atomic_agent_at(
    state_dir: &Path,
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
    context_length: Option<u32>,
) -> Result<(), String> {
    let path = state_dir.join("config.json");
    let root = read_atomic_agent_config(&path)?.unwrap_or_else(|| serde_json::json!({}));
    let patched = atomic_agent_patch_config(root.clone(), api_url, model, api_key, context_length)?;

    let previous = json_key_backup::read(&path).unwrap_or_default();
    let ids = |value: &serde_json::Value| -> Vec<serde_json::Value> {
        json_key_backup::get(value, &json_key_backup::path_of(&["llm", "providers"]))
            .and_then(|p| p.as_array())
            .cloned()
            .unwrap_or_default()
    };
    // The `local-llama` entry this Connect added, or an earlier one did.
    let before = ids(&root);
    let mut seeded = previous.seeded.clone();
    for entry in ids(&patched) {
        let id = entry.get("id").and_then(|v| v.as_str());
        if id == Some(ATOMIC_AGENT_LOCAL_PROVIDER_ID)
            && !before.contains(&entry)
            && !seeded.contains(&entry)
        {
            seeded.push(entry);
        }
    }
    let backup = json_key_backup::Backup {
        keys: json_key_backup::track(
            &root,
            &patched,
            &atomic_agent_tracked_paths(),
            &previous.keys,
        ),
        seeded,
    };

    std::fs::create_dir_all(state_dir)
        .map_err(|e| format!("Failed to create {}: {}", state_dir.display(), e))?;
    let pretty = serde_json::to_string_pretty(&patched).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty + "\n")
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    json_key_backup::write(&path, &backup)?;

    log::info!(
        "Atomic Agent configured: baseUrl={}, model={}",
        api_url,
        model
    );
    Ok(())
}

/// Disconnect Atomic Agent (see [`atomic_agent_unpatch_config`]).
pub(crate) fn disconnect_atomic_agent() -> Result<(), String> {
    disconnect_atomic_agent_at(&resolve_atomic_agent_state_dir()?)
}

fn disconnect_atomic_agent_at(state_dir: &Path) -> Result<(), String> {
    let path = state_dir.join("config.json");
    let Some(root) = read_atomic_agent_config(&path)? else {
        return json_key_backup::discard(&path);
    };
    let backup = json_key_backup::read(&path);
    let restored = atomic_agent_unpatch_config(root.clone(), backup.as_ref());
    if restored != root {
        let pretty = serde_json::to_string_pretty(&restored).map_err(|e| e.to_string())?;
        std::fs::write(&path, pretty + "\n")
            .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    }
    json_key_backup::discard(&path)?;
    log::info!("Atomic Agent disconnected: {}", path.display());
    Ok(())
}

/// Open the OS terminal and run `command` interactively, so the user can start
/// using a just-configured agent in one click. The terminal stays open after
/// the command (it launches an interactive TUI agent like codex/claude).
///
/// `agent` names what the window is for: its title, the line printed before
/// the agent starts, and (macOS) the window the next call for the same agent
/// brings forward while the agent still runs there. See `agent_terminal`.
#[tauri::command]
#[cfg_attr(feature = "e2e", allow(unreachable_code, unused_variables))]
pub async fn open_agent_terminal(
    command: String,
    proxy: Option<ProxyEnv>,
    agent: Option<AgentTerminalInfo>,
) -> Result<TerminalOutcome, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("Empty terminal command".to_string());
    }
    // An end-to-end build must not open terminal windows on the desktop of
    // whoever runs the tests; it writes down what it would have run instead.
    #[cfg(feature = "e2e")]
    return crate::core::e2e::record_terminal(&crate::core::e2e::data_root(), &command)
        .map(|()| TerminalOutcome::Opened);

    #[cfg(target_os = "macos")]
    {
        // The proxy and any key travel inside a launcher script, never typed
        // into the shell; osascript is waited on, so a refused launch fails.
        let proxy_env = proxy.as_ref().map(proxy_env_vars).unwrap_or_default();
        return tokio::task::spawn_blocking(move || {
            super::agent_terminal::open_macos(&command, &proxy_env, agent.as_ref())
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // `start "<title>" cmd /K <cmd>` opens a fresh console that stays open
        // so the interactive agent keeps running. The new console inherits this
        // command's environment, so the proxy env applied below reaches the
        // interactive agent. The line is passed raw: Rust's argument quoting
        // (`\"`) means nothing to cmd.exe and broke quoted launcher paths.
        let title = agent
            .as_ref()
            .map(|a| super::agent_terminal::windows_title(&a.agent_name));
        let command = match agent.as_ref() {
            Some(a) => format!(
                "echo {}& {}",
                super::agent_terminal::windows_echo_line(a),
                command
            ),
            None => command,
        };
        let mut cmd = std::process::Command::new("cmd");
        cmd.raw_arg(windows_terminal_args(title.as_deref(), &command));
        // Start in the user's home, not in Atomic Chat's install folder.
        if let Some(home) = agent_home_dir().ok().filter(|h| Path::new(h).is_dir()) {
            cmd.current_dir(home);
        }
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
        // The line can carry the server key: log that it opened, not what it runs.
        log::info!("Opened cmd for an agent terminal");
        return Ok(TerminalOutcome::Opened);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let proxy_env = proxy.as_ref().map(proxy_env_vars).unwrap_or_default();
        return tokio::task::spawn_blocking(move || {
            // The emulator itself has to be found and start cleanly: the
            // login-shell PATH, no AppImage runtime leftovers.
            let prepare = |cmd: &mut std::process::Command| {
                apply_login_path(cmd);
                apply_runtime_path(cmd);
            };
            super::agent_terminal::open_linux(&command, &proxy_env, agent.as_ref(), &prepare)
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    #[allow(unreachable_code)]
    Ok(TerminalOutcome::Opened)
}

/// Launchers JetBrains IDEs ship, IntelliJ IDEA first: the executable in each
/// macOS bundle, `<name>64.exe` on Windows, and the names Toolbox gives its
/// shell scripts.
const JETBRAINS_LAUNCHERS: [&str; 10] = [
    "idea",
    "pycharm",
    "webstorm",
    "phpstorm",
    "rubymine",
    "clion",
    "goland",
    "rider",
    "datagrip",
    "rustrover",
];

/// Where an editor's launcher lives when it is not on `PATH`, keyed by its
/// detect binary (`integrations.ts`). `system_apps` is macOS's
/// `/Applications`; tests point it, `home` and `env` at a temp dir.
fn editor_launcher_candidates(
    bin: &str,
    os: HostOs,
    home: &Path,
    system_apps: &Path,
    env: EnvLookup,
) -> Vec<PathBuf> {
    let mac_roots = [system_apps.to_path_buf(), home.join("Applications")];
    let local = env("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData").join("Local"));
    let program_files = env("ProgramFiles").map(PathBuf::from);
    match (bin, os) {
        ("zed", _) => zed_cli_candidates(os, home, env)
            .into_iter()
            .chain(zed_app_candidates(os, home, env))
            .collect(),
        ("code", HostOs::Macos) => mac_roots
            .iter()
            .map(|root| {
                root.join("Visual Studio Code.app")
                    .join("Contents")
                    .join("Resources")
                    .join("app")
                    .join("bin")
                    .join("code")
            })
            .collect(),
        // The user installer's default, then the system installer's.
        ("code", HostOs::Windows) => [Some(local.join("Programs")), program_files]
            .into_iter()
            .flatten()
            .map(|root| root.join("Microsoft VS Code").join("Code.exe"))
            .collect(),
        ("idea", HostOs::Macos) => {
            let mut out = app_bundle_executables(&mac_roots, |_| true, &JETBRAINS_LAUNCHERS);
            out.extend(files_named(
                &home
                    .join("Library")
                    .join("Application Support")
                    .join("JetBrains")
                    .join("Toolbox")
                    .join("scripts"),
                JETBRAINS_LAUNCHERS.iter().map(|name| name.to_string()),
            ));
            out
        }
        ("idea", HostOs::Windows) => {
            // Toolbox's shell scripts, then the IDEs Toolbox 2 installs under
            // `%LOCALAPPDATA%\Programs\<IDE>` and the standalone installers
            // put under `%ProgramFiles%\JetBrains\<IDE> <version>`.
            let mut out = files_named(
                &local.join("JetBrains").join("Toolbox").join("scripts"),
                JETBRAINS_LAUNCHERS.iter().map(|name| format!("{name}.cmd")),
            );
            let roots: Vec<PathBuf> = [
                Some(local.join("Programs")),
                program_files.map(|root| root.join("JetBrains")),
            ]
            .into_iter()
            .flatten()
            .collect();
            for name in JETBRAINS_LAUNCHERS {
                out.extend(files_one_level_down(
                    &roots,
                    &Path::new("bin").join(format!("{name}64.exe")),
                ));
            }
            out
        }
        ("idea", HostOs::Linux) => files_named(
            &home
                .join(".local")
                .join("share")
                .join("JetBrains")
                .join("Toolbox")
                .join("scripts"),
            JETBRAINS_LAUNCHERS.iter().map(|name| name.to_string()),
        ),
        // Every Xcode the user keeps (`Xcode.app`, `Xcode-beta.app`, …);
        // `/usr/bin/xed` is a shim present without Xcode, so it proves nothing.
        ("xcode", HostOs::Macos) => {
            app_bundle_executables(&mac_roots, |name| name.starts_with("Xcode"), &["Xcode"])
        }
        _ => Vec::new(),
    }
}

/// `<bundle>.app/Contents/MacOS/<exe>` for the app bundles directly in `roots`
/// whose name passes `wanted`: by `exes` preference, then shortest bundle name
/// first (`Xcode.app` before `Xcode-beta.app`).
fn app_bundle_executables(
    roots: &[PathBuf],
    wanted: impl Fn(&str) -> bool,
    exes: &[&str],
) -> Vec<PathBuf> {
    let mut bundles: Vec<PathBuf> = roots
        .iter()
        .filter_map(|root| std::fs::read_dir(root).ok())
        .flat_map(|entries| entries.flatten())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().is_some_and(|ext| ext == "app")
                && path
                    .file_stem()
                    .is_some_and(|stem| wanted(&stem.to_string_lossy()))
        })
        .collect();
    bundles.sort_by_key(|bundle| {
        let name = bundle.file_name().unwrap_or_default().to_os_string();
        (name.len(), name)
    });
    let mut out = Vec::new();
    for exe in exes {
        for bundle in &bundles {
            let candidate = bundle.join("Contents").join("MacOS").join(exe);
            if candidate.is_file() && !out.contains(&candidate) {
                out.push(candidate);
            }
        }
    }
    out
}

/// The files among `names` that exist in `dir`, in `names` order.
fn files_named(dir: &Path, names: impl Iterator<Item = String>) -> Vec<PathBuf> {
    names
        .map(|name| dir.join(name))
        .filter(|path| path.is_file())
        .collect()
}

/// `<root>/<any folder>/<rel>` files, for installs whose folder carries a
/// product name or version.
fn files_one_level_down(roots: &[PathBuf], rel: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = roots
        .iter()
        .filter_map(|root| std::fs::read_dir(root).ok())
        .flat_map(|entries| entries.flatten())
        .map(|entry| entry.path().join(rel))
        .filter(|path| path.is_file())
        .collect();
    out.sort();
    out
}

/// The `.app` bundle a path sits in, at any depth.
fn enclosing_app_bundle(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .skip(1)
        .find(|dir| dir.extension().is_some_and(|ext| ext == "app"))
        .map(Path::to_path_buf)
}

/// The first `<dir>/<name>.<ext>` along `path`, trying `exts` in order in
/// each folder — how cmd.exe resolves a bare `code` to `code.cmd`, which
/// `Command::new` does not (it only appends `.exe`).
fn find_launcher_in_path(name: &str, path: &std::ffi::OsStr, exts: &[&str]) -> Option<PathBuf> {
    std::env::split_paths(path).find_map(|dir| {
        exts.iter()
            .map(|ext| dir.join(format!("{name}.{ext}")))
            .find(|candidate| candidate.is_file())
    })
}

/// How to start an editor launcher: an app inside a macOS bundle through
/// LaunchServices (which also just focuses a running one), a Windows
/// `.cmd`/`.bat` script (VS Code's `bin\code.cmd`, Toolbox's scripts) through
/// `cmd /C`, anything else directly.
fn editor_command(os: HostOs, launcher: &Path) -> std::process::Command {
    use std::process::Command;
    if os == HostOs::Macos {
        if let Some(bundle) = enclosing_app_bundle(launcher) {
            let mut cmd = Command::new("open");
            cmd.arg("-a").arg(bundle);
            return cmd;
        }
    }
    let script = launcher
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));
    if os == HostOs::Windows && script {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(launcher);
        return cmd;
    }
    Command::new(launcher)
}

/// The arguments after `cmd` that open a titled console running `command`:
/// `/C start "<title>" cmd /K "<command>"`.
///
/// Two cmd.exe parsers read the line. The inner `cmd /K` strips the outer
/// pair of quotes around `command`, so `command` keeps its own quoting (a
/// quoted absolute launcher path followed by arguments). The outer `cmd /C`
/// sees the same text first, where a `&`, `|`, `<`, `>`, `^`, `(` or `)` that
/// falls outside its idea of quotes would split or redirect the line; those
/// are `^`-escaped for it, and reach the inner one as plain characters.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_terminal_args(title: Option<&str>, command: &str) -> String {
    let title: String = title
        .unwrap_or("")
        .chars()
        .filter(|c| !matches!(c, '"' | '%') && !c.is_control())
        .take(120)
        .collect();
    let wrapped = format!("\"{}\"", command);
    let mut escaped = String::with_capacity(wrapped.len() + 8);
    let mut quoted = false;
    for c in wrapped.chars() {
        if c == '"' {
            quoted = !quoted;
        } else if !quoted && matches!(c, '&' | '|' | '<' | '>' | '^' | '(' | ')') {
            escaped.push('^');
        }
        escaped.push(c);
    }
    format!("/C start \"{}\" cmd /K {}", title.trim(), escaped)
}

/// Launch a GUI editor for the "IDEs & Editors" integrations (VS Code,
/// JetBrains, Xcode).
///
/// Unlike the CLI coding agents, these editors have no writable provider config
/// — VS Code keeps custom endpoints in its own model settings, and
/// JetBrains/Xcode keep the provider in IDE settings — so this command only
/// *opens* the editor. The connection details still have to be pasted into the
/// editor's own UI (the card shows those manual steps and a "Copy settings"
/// button).
///
/// Resolution order: the editor's command-line launcher(s) on the user's PATH
/// first (so custom installs are respected; on Windows the registry's PATH,
/// re-read so a fresh install counts, and `.cmd` launchers run through
/// `cmd /C`), then its install locations ([`editor_launcher_candidates`]), then
/// the macOS app launcher (`open -a`). Returns an error if nothing was found.
#[tauri::command]
pub fn launch_editor(editor_id: String) -> Result<(), String> {
    use std::process::Stdio;

    // Spawn a detached GUI process, returning whether it started. A missing
    // binary makes `spawn` fail, which is how we fall through to the next
    // candidate / the platform launcher.
    fn try_spawn(mut cmd: std::process::Command) -> bool {
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // Find user-installed launchers (`code`, `idea`, …) even when Atomic
        // Chat was started from Finder/Dock with a minimal PATH, and on
        // Windows give the editor the PATH a fresh install wrote.
        apply_login_path(&mut cmd);
        apply_runtime_path(&mut cmd);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        cmd.spawn().is_ok()
    }

    // (CLI launchers to try in order, detect binary, macOS .app name).
    let (clis, detect_bin, mac_app): (&[&str], &str, Option<&str>) = match editor_id.as_str() {
        "vscode" => (&["code"], "code", Some("Visual Studio Code")),
        // JetBrains Toolbox installs a different launcher per IDE; try the
        // common ones so any installed JetBrains IDE opens.
        "jetbrains" => (&JETBRAINS_LAUNCHERS, "idea", Some("IntelliJ IDEA")),
        // Xcode is macOS-only and ships no general-purpose launcher binary
        // (`xed` needs a file argument), so we open the app directly.
        "xcode" => (&[], "xcode", Some("Xcode")),
        other => return Err(format!("Unknown editor: {}", other)),
    };

    let os = HostOs::current();
    let search_path = {
        #[cfg(windows)]
        let fresh = refresh_windows_path().map(std::ffi::OsString::from);
        #[cfg(not(windows))]
        let fresh: Option<std::ffi::OsString> = None;
        fresh.or_else(|| std::env::var_os("PATH"))
    };
    for cli in clis {
        let launcher = if os == HostOs::Windows {
            search_path
                .as_deref()
                .and_then(|path| find_launcher_in_path(cli, path, &["exe", "cmd", "bat"]))
        } else {
            Some(PathBuf::from(cli))
        };
        if let Some(launcher) = launcher {
            if try_spawn(editor_command(os, &launcher)) {
                log::info!(
                    "Launched editor '{}' via '{}'",
                    editor_id,
                    launcher.display()
                );
                return Ok(());
            }
        }
    }

    for launcher in off_path_candidates(detect_bin)
        .into_iter()
        .filter(|path| path.is_file())
    {
        if try_spawn(editor_command(os, &launcher)) {
            log::info!(
                "Launched editor '{}' via '{}'",
                editor_id,
                launcher.display()
            );
            return Ok(());
        }
    }

    #[cfg(target_os = "macos")]
    if let Some(app) = mac_app {
        let mut cmd = std::process::Command::new("open");
        cmd.args(["-a", app]);
        if try_spawn(cmd) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_utf8_console_output() {
        let text = "Привет, café, 日本語\r\n";
        assert_eq!(decode_console_bytes(text.as_bytes()), text);
        assert_eq!(decode_console_bytes(b""), "");
    }

    #[cfg(windows)]
    #[test]
    fn decodes_russian_cmd_diagnostics_in_oem_866() {
        // The native stderr bytes behind the unreadable chat error report.
        let bytes = b"\x8e\xe2\xaa\xa0\xa7\xa0\xad\xae \xa2 \xa4\xae\xe1\xe2\xe3\xaf\xa5.\r\n";
        assert_eq!(
            decode_oem(bytes, 866).as_deref(),
            Some("Отказано в доступе.\r\n")
        );
    }

    /// A file in a throwaway directory that is removed when the guard drops,
    /// so repeated test runs don't pile up directories under `target/`.
    struct TempFile(std::path::PathBuf);

    impl std::ops::Deref for TempFile {
        type Target = std::path::Path;
        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            if let Some(dir) = self.0.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    fn temp_file(name: &str, contents: &[u8]) -> TempFile {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("cli-marker-tests")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join(name);
        std::fs::write(&path, contents).expect("write temp file");
        TempFile(path)
    }

    /// `remove_legacy_cli_binary` deletes files on the user's PATH, so the
    /// ownership check must only ever accept binaries we shipped.
    #[test]
    fn is_our_cli_binary_detects_marker() {
        let mut ours = vec![0u8; 700_000];
        ours.extend_from_slice(CLI_OWNERSHIP_MARKER);
        ours.extend_from_slice(&[0u8; 1024]);
        assert!(is_our_cli_binary(&temp_file("ours", &ours)));
    }

    /// A foreign `jan` binary (i.e. Jan.ai's own CLI) must never be claimed.
    #[test]
    fn is_our_cli_binary_rejects_foreign_binary() {
        let foreign = b"\x7fELF some other cli named jan, definitely not ours".to_vec();
        assert!(!is_our_cli_binary(&temp_file("foreign", &foreign)));
    }

    /// The marker must still be found when it straddles a read-chunk boundary.
    #[test]
    fn is_our_cli_binary_finds_marker_across_chunk_boundary() {
        // Chunks are 256 KiB; land the marker a few bytes before the boundary.
        let mut bytes = vec![0u8; 256 * 1024 - 4];
        bytes.extend_from_slice(CLI_OWNERSHIP_MARKER);
        bytes.extend_from_slice(&[0u8; 64]);
        assert!(is_our_cli_binary(&temp_file("split", &bytes)));
    }

    #[test]
    fn is_our_cli_binary_rejects_missing_file() {
        assert!(!is_our_cli_binary(std::path::Path::new(
            "/nonexistent/atomic-chat-cli"
        )));
    }

    /// Regression test for the SIGABRT after MCP tool-call replies: delivering
    /// a desktop notification must be safe from a tokio runtime worker thread.
    /// The plugin's own `notify` command called blocking `show()` (zbus
    /// `Runtime::block_on` on Linux) directly on a worker and aborted with
    /// "Cannot start a runtime from within a runtime".
    #[test]
    fn show_desktop_notification_is_safe_on_runtime_worker() {
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_notification::init())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("failed to build mock app");
        let handle = app.handle().clone();

        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("failed to build runtime");

        rt.block_on(async move {
            // Run on a worker thread (not the test thread driving block_on) to
            // mirror how Tauri executes async commands.
            tokio::spawn(async move {
                // Delivery may fail (no notification daemon in CI); the test
                // only asserts the call does not panic inside the runtime.
                let _ = show_desktop_notification(handle, "test".into(), "test".into()).await;
            })
            .await
            .expect("notification task panicked");
        });
    }

    /// Regression test for the abort on "Open containing folder" (Linux
    /// AppImage, 2.2.14): the opener plugin's async `reveal_item_in_dir`
    /// command opened a blocking zbus connection on a runtime worker and
    /// panicked with "Cannot start a runtime from within a runtime". Linux
    /// only: on macOS and Windows a successful call opens a real file manager
    /// window.
    #[cfg(target_os = "linux")]
    #[test]
    fn reveal_in_file_manager_is_safe_on_runtime_worker() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("failed to build runtime");

        // An existing path, so the call gets past canonicalization and reaches
        // the D-Bus code that used to panic.
        let path = std::env::temp_dir().to_string_lossy().to_string();
        rt.block_on(async move {
            tokio::spawn(async move {
                // CI has no session bus or file manager, so the reveal may
                // fail; the test only asserts it does not panic.
                let _ = reveal_in_file_manager(path).await;
            })
            .await
            .expect("reveal task panicked");
        });
    }

    #[test]
    fn appimage_restart_strips_runtime_environment() {
        let command =
            sanitized_appimage_restart_command(std::ffi::OsStr::new("/tmp/atomic-chat.AppImage"));
        let removed: Vec<_> = command
            .get_envs()
            .filter_map(|(key, value)| value.is_none().then(|| key.to_os_string()))
            .collect();

        for variable in APPIMAGE_RUNTIME_ENV_VARS {
            assert!(
                removed.iter().any(|key| key == variable),
                "{variable} must be removed"
            );
        }
        for variable in ["HOME", "PATH", "XDG_DATA_DIRS"] {
            assert!(
                !removed.iter().any(|key| key == variable),
                "{variable} must be preserved"
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn curl_agent_installers_propagate_download_failures() {
        for agent_id in [
            "claude-code",
            "goose",
            "atomic-agent",
            "hermes",
            "poolside",
            "zed",
            "muse",
        ] {
            let (program, arguments, prerequisite, _) =
                agent_install_spec(agent_id).expect("known install spec");
            assert_eq!(program, "bash", "{agent_id} must support pipefail");
            assert_eq!(prerequisite, "curl");
            assert_eq!(arguments.first().map(String::as_str), Some("-c"));
            assert!(
                arguments
                    .get(1)
                    .is_some_and(|argument| argument.starts_with("set -o pipefail; curl -fsSL ")),
                "{agent_id} must fail when curl fails: {arguments:?}"
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn bash_installers_are_piped_into_bash() {
        // Muse's and Claude Code's scripts use bash syntax; `sh` is dash on
        // Debian/Ubuntu and stops at the first `[[`.
        for agent_id in ["claude-code", "muse"] {
            let (_, arguments, _, _) = agent_install_spec(agent_id).expect("known install spec");
            assert!(
                arguments[1].ends_with("| bash"),
                "{agent_id}: {}",
                arguments[1]
            );
        }
        let (_, claude, _, _) = agent_install_spec("claude-code").unwrap();
        assert!(claude[1].contains("https://claude.ai/install.sh"));
    }

    #[test]
    fn claude_code_falls_back_to_npm_and_nothing_else_does() {
        let (program, arguments, prerequisite, _) =
            agent_install_fallback("claude-code").expect("npm fallback");
        assert_eq!(prerequisite, "npm");
        assert_eq!(
            arguments.last().map(String::as_str),
            Some("@anthropic-ai/claude-code")
        );
        assert_eq!(program, if cfg!(windows) { "cmd" } else { "npm" });
        for agent_id in ["codex", "opencode", "openclaw", "zed", "muse"] {
            assert!(agent_install_fallback(agent_id).is_none(), "{agent_id}");
        }
    }

    #[test]
    fn npm_installs_ask_for_install_scripts_only_where_needed() {
        let npm12 = Some((12, 2, 1));
        for package in [
            "@anthropic-ai/claude-code",
            "opencode-ai",
            "@kilocode/cli",
            "cline",
            "droid",
            "@mimo-ai/cli",
            "openclaw",
        ] {
            assert_eq!(
                npm_allow_scripts_arg(package, npm12),
                Some(format!("--allow-scripts={package}"))
            );
            // npm before 11.16 runs every script and rejects the flag.
            assert_eq!(npm_allow_scripts_arg(package, Some((11, 15, 9))), None);
            assert_eq!(npm_allow_scripts_arg(package, Some((10, 9, 4))), None);
            assert_eq!(npm_allow_scripts_arg(package, None), None);
        }
        assert_eq!(
            npm_allow_scripts_arg("opencode-ai", Some((11, 16, 0))),
            Some("--allow-scripts=opencode-ai".to_string())
        );
        for package in ["@openai/codex", "@github/copilot", "@gitlawb/openclaude"] {
            assert_eq!(npm_allow_scripts_arg(package, npm12), None, "{package}");
        }
        // Every package the flag is for is one an agent installs with npm.
        for (agent_id, package) in [
            ("opencode", "opencode-ai"),
            ("kilo", "@kilocode/cli"),
            ("cline", "cline"),
            ("droid", "droid"),
            ("mimo", "@mimo-ai/cli"),
            ("openclaw", "openclaw"),
        ] {
            let (_, arguments, prerequisite, _) = agent_install_spec(agent_id).unwrap();
            assert_eq!(prerequisite, "npm");
            assert_eq!(arguments.last().map(String::as_str), Some(package));
        }
    }

    #[test]
    fn powershell_installers_bypass_the_execution_policy() {
        let arguments = powershell_script("irm https://example.invalid/install.ps1 | iex");
        assert_eq!(
            arguments[..4],
            ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command"]
        );
        assert_eq!(
            arguments[4],
            "irm https://example.invalid/install.ps1 | iex"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_installers_use_the_catalog_ids_and_policy() {
        let (program, arguments, _, _) = agent_install_spec("zed").unwrap();
        assert_eq!(program, "winget");
        assert!(arguments.contains(&"ZedIndustries.Zed".to_string()));
        for agent_id in ["claude-code", "goose", "atomic-agent", "hermes", "poolside"] {
            let (program, arguments, _, _) = agent_install_spec(agent_id).unwrap();
            assert_eq!(program, "powershell", "{agent_id}");
            assert_eq!(
                arguments[1..3],
                ["-ExecutionPolicy", "Bypass"],
                "{agent_id}"
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn login_path_is_read_between_the_sentinels() {
        assert_eq!(
            login_path_from_output("motd\n__OCPATH__/opt/homebrew/bin:/usr/bin__OCEND__"),
            Some("/opt/homebrew/bin:/usr/bin".to_string())
        );
        assert_eq!(login_path_from_output("__OCPATH____OCEND__"), None);
        assert_eq!(login_path_from_output("no sentinel"), None);
    }

    #[test]
    fn windows_terminal_line_keeps_quoted_launchers_intact() {
        assert_eq!(
            windows_terminal_args(Some("Atomic Chat – Codex"), "codex"),
            r#"/C start "Atomic Chat – Codex" cmd /K "codex""#
        );
        // A quoted absolute path with spaces and an argument: the inner
        // `cmd /K` strips only the outer pair.
        assert_eq!(
            windows_terminal_args(
                Some("Atomic Chat – OpenClaw"),
                r#""C:\Users\John Smith\.openclaw\bin\openclaw.cmd" chat"#
            ),
            r#"/C start "Atomic Chat – OpenClaw" cmd /K ""C:\Users\John Smith\.openclaw\bin\openclaw.cmd" chat""#
        );
        // Metacharacters the outer `cmd /C` reads outside quotes are escaped
        // for it; the inner one sees them inside the launcher's quotes.
        assert_eq!(
            windows_terminal_args(None, r#""C:\R&D (x86)\claude.exe""#),
            r#"/C start "" cmd /K ""C:\R^&D ^(x86^)\claude.exe"""#
        );
        assert_eq!(
            windows_terminal_args(
                Some(r#"Say "hi" %PATH%"#),
                "powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand JABlAA=="
            ),
            r#"/C start "Say hi PATH" cmd /K "powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand JABlAA==""#
        );
    }
}

#[cfg(test)]
mod dsh_tests {
    use super::*;

    const URL: &str = "http://127.0.0.1:1337/v1";

    fn parse(text: &str) -> serde_yaml::Value {
        serde_yaml::from_str(text).expect("fixture must be valid YAML")
    }

    /// `llm-pi-ai.providers.atomic` as a mapping, or panic.
    fn route(root: &serde_yaml::Value) -> &serde_yaml::Mapping {
        root.get(DSH_SECTION)
            .and_then(|s| s.get("providers"))
            .and_then(|p| p.get(DSH_ROUTE_ID))
            .and_then(|r| r.as_mapping())
            .expect("the atomic route must exist")
    }

    #[test]
    fn empty_document_becomes_a_complete_section() {
        let mut root = parse("");
        apply_dsh_provider(&mut root, URL, "qwen3-4b", false, Some(32768)).unwrap();

        let r = route(&root);
        assert_eq!(r.get("api").unwrap().as_str(), Some("openai-completions"));
        assert_eq!(r.get("baseURL").unwrap().as_str(), Some(URL));
        assert_eq!(r.get("displayName").unwrap().as_str(), Some("Atomic Chat"));

        // A hand-declared route is refused by dsh without a non-empty model list.
        let models = r.get("models").unwrap().as_sequence().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].get("id").unwrap().as_str(), Some("qwen3-4b"));
        // The served window, and a reply of a quarter of it (8192 at most).
        assert_eq!(
            models[0].get("contextWindow").unwrap().as_u64(),
            Some(32768)
        );
        assert_eq!(models[0].get("maxTokens").unwrap().as_u64(), Some(8192));

        // Unknown, dsh keeps its own defaults.
        let mut root = parse("");
        apply_dsh_provider(&mut root, URL, "qwen3-4b", false, None).unwrap();
        let models = route(&root).get("models").unwrap().as_sequence().unwrap();
        assert!(models[0].get("contextWindow").is_none());
        assert!(models[0].get("maxTokens").is_none());
    }

    #[test]
    fn preserves_other_plugin_sections() {
        let mut root =
            parse("web-app:\n  port: 3080\nsession-persistence-jsonl:\n  root: /tmp/x\n");
        apply_dsh_provider(&mut root, URL, "m", false, None).unwrap();

        assert_eq!(
            root.get("web-app").unwrap().get("port").unwrap().as_u64(),
            Some(3080)
        );
        assert_eq!(
            root.get("session-persistence-jsonl")
                .unwrap()
                .get("root")
                .unwrap()
                .as_str(),
            Some("/tmp/x")
        );
    }

    #[test]
    fn preserves_sibling_routes_and_other_section_keys() {
        let mut root = parse(
            "llm-pi-ai:\n  \
             defaultInput: [text]\n  \
             providers:\n    \
             openai:\n      apiKeyEnv: OPENAI_API_KEY\n    \
             mygateway:\n      baseURL: https://gw.example/v1\n",
        );
        apply_dsh_provider(&mut root, URL, "m", false, None).unwrap();

        let providers = root.get(DSH_SECTION).unwrap().get("providers").unwrap();
        assert_eq!(
            providers
                .get("openai")
                .unwrap()
                .get("apiKeyEnv")
                .unwrap()
                .as_str(),
            Some("OPENAI_API_KEY")
        );
        assert_eq!(
            providers
                .get("mygateway")
                .unwrap()
                .get("baseURL")
                .unwrap()
                .as_str(),
            Some("https://gw.example/v1")
        );
        // A key beside `providers` inside our own section survives too.
        assert!(root.get(DSH_SECTION).unwrap().get("defaultInput").is_some());
    }

    /// The headline regression: the route is replaced wholesale, never merged.
    /// A surviving `apiKeyEnv` would point at a variable the keyless path never
    /// sets, and dsh fails every request with MISSING_CREDENTIAL rather than
    /// falling back to an unauthenticated call.
    #[test]
    fn rewrites_the_route_wholesale_dropping_stale_fields() {
        let mut root = parse(
            "llm-pi-ai:\n  providers:\n    atomic:\n      \
             apiKeyEnv: ATOMIC_API_KEY\n      \
             baseURL: http://127.0.0.1:9999/v1\n      \
             leftoverJunk: true\n",
        );
        apply_dsh_provider(&mut root, URL, "m", false, None).unwrap();

        let r = route(&root);
        assert!(
            r.get("apiKeyEnv").is_none(),
            "stale credential reference must be gone"
        );
        assert!(r.get("leftoverJunk").is_none(), "stale fields must be gone");
        assert_eq!(r.get("baseURL").unwrap().as_str(), Some(URL));
    }

    #[test]
    fn api_key_env_tracks_whether_a_key_exists() {
        let mut keyed = parse("");
        apply_dsh_provider(&mut keyed, URL, "m", true, None).unwrap();
        assert_eq!(
            route(&keyed).get("apiKeyEnv").unwrap().as_str(),
            Some(DSH_KEY_ENV)
        );

        let mut keyless = parse("");
        apply_dsh_provider(&mut keyless, URL, "m", false, None).unwrap();
        assert!(route(&keyless).get("apiKeyEnv").is_none());
    }

    #[test]
    fn bare_section_and_providers_keys_are_healed() {
        // Both parse to Null, which is a hole to fill rather than data to protect.
        for fixture in ["llm-pi-ai:\n", "llm-pi-ai:\n  providers:\n"] {
            let mut root = parse(fixture);
            apply_dsh_provider(&mut root, URL, "m", false, None).unwrap();
            assert_eq!(route(&root).get("baseURL").unwrap().as_str(), Some(URL));
        }
    }

    #[test]
    fn refuses_to_overwrite_a_non_mapping_section() {
        for fixture in [
            "llm-pi-ai: some-scalar\n",
            "llm-pi-ai:\n  providers: [a, b]\n",
        ] {
            let mut root = parse(fixture);
            let before = root.clone();
            assert!(apply_dsh_provider(&mut root, URL, "m", false, None).is_err());
            assert_eq!(root, before, "a refused write must not mutate the tree");
        }
    }

    #[test]
    fn refuses_a_non_mapping_root() {
        let mut root = parse("- a\n- b\n");
        assert!(apply_dsh_provider(&mut root, URL, "m", false, None).is_err());
    }

    /// An invalid route makes dsh reject the whole `llm-pi-ai` section, so this
    /// must fail loudly instead of writing something the user's other providers
    /// would go down with.
    #[test]
    fn refuses_an_empty_model_or_url() {
        let mut root = parse("");
        let before = root.clone();
        assert!(apply_dsh_provider(&mut root, URL, "   ", false, None).is_err());
        assert!(apply_dsh_provider(&mut root, "", "m", false, None).is_err());
        assert_eq!(root, before);
    }

    /// Model ids are quoted by serde_yaml rather than concatenated in, so an id
    /// that looks like another YAML type still round-trips as a string.
    #[test]
    fn model_ids_that_look_like_other_types_round_trip() {
        for id in ["yes", "no", "7", "1.0", "null", "on"] {
            let mut root = parse("");
            apply_dsh_provider(&mut root, URL, id, false, None).unwrap();
            let reparsed = parse(&serde_yaml::to_string(&root).unwrap());
            let models = route(&reparsed)
                .get("models")
                .unwrap()
                .as_sequence()
                .unwrap();
            assert_eq!(models[0].get("id").unwrap().as_str(), Some(id));
        }
    }

    #[test]
    fn is_idempotent() {
        let fixture = "other:\n  a: 1\nllm-pi-ai:\n  providers:\n    openai: {}\n";
        let mut once = parse(fixture);
        apply_dsh_provider(&mut once, URL, "m", true, None).unwrap();
        let mut twice = once.clone();
        apply_dsh_provider(&mut twice, URL, "m", true, None).unwrap();
        assert_eq!(
            serde_yaml::to_string(&once).unwrap(),
            serde_yaml::to_string(&twice).unwrap()
        );
    }

    #[test]
    fn dsh_home_falls_back_and_expands_tilde() {
        let home = Path::new("/Users/tester");
        assert_eq!(
            dsh_home_from(None, home),
            PathBuf::from("/Users/tester/.dsh")
        );
        assert_eq!(
            dsh_home_from(Some("   "), home),
            PathBuf::from("/Users/tester/.dsh")
        );
        assert_eq!(
            dsh_home_from(Some("/opt/dsh"), home),
            PathBuf::from("/opt/dsh")
        );
        // A quoted `DSH_HOME="~/dev/dsh"` in an rc file reaches us unexpanded.
        assert_eq!(
            dsh_home_from(Some("~/dev/dsh"), home),
            PathBuf::from("/Users/tester/dev/dsh")
        );
        assert_eq!(
            dsh_home_from(Some("~"), home),
            PathBuf::from("/Users/tester")
        );
    }

    #[test]
    fn rejects_credentials_a_dotenv_line_cannot_carry() {
        assert!(dsh_validate_env_value(DSH_KEY_ENV, "sk-plain-value").is_ok());
        for bad in ["has space", "two\nlines", "hash#comment", "quo'te"] {
            let err = dsh_validate_env_value(DSH_KEY_ENV, bad).unwrap_err();
            assert!(err.contains(DSH_KEY_ENV));
            assert!(!err.contains(bad), "the error must never echo the value");
        }
    }

    fn profile_rows(home: &Path) -> serde_yaml::Value {
        let text =
            std::fs::read_to_string(super::super::dsh_config::profile_patch_path(home)).unwrap();
        serde_yaml::from_str(&text).unwrap()
    }

    #[test]
    fn configure_writes_the_profile_and_never_creates_settings_yaml() {
        let home = tempfile::tempdir().unwrap();
        configure_dsh_at(home.path(), URL, "qwen3", Some("sk-1"), Some(16384)).unwrap();
        let rows = profile_rows(home.path());
        let route = &rows[0]["config"]["providers"][DSH_ROUTE_ID];
        assert_eq!(route["baseURL"].as_str(), Some(URL));
        assert_eq!(route["apiKeyEnv"].as_str(), Some(DSH_KEY_ENV));
        assert_eq!(route["models"][0]["contextWindow"].as_u64(), Some(16384));
        assert_eq!(route["models"][0]["maxTokens"].as_u64(), Some(4096));
        assert_eq!(rows[1]["id"].as_str(), Some(DSH_DEFAULT_MODEL_SECTION));
        assert_eq!(rows[1]["config"]["model"].as_str(), Some("qwen3"));
        assert!(!home.path().join("settings.yaml").exists());
        let env = std::fs::read_to_string(home.path().join(".env")).unwrap();
        assert!(env.contains("ATOMIC_API_KEY=sk-1"));

        disconnect_dsh_at(home.path()).unwrap();
        assert_eq!(
            profile_rows(home.path()),
            serde_yaml::Value::Sequence(vec![])
        );
        assert!(!std::fs::read_to_string(home.path().join(".env"))
            .unwrap()
            .contains("sk-1"));
        // A second Disconnect, or one with nothing connected, is a no-op.
        disconnect_dsh_at(home.path()).unwrap();
        disconnect_dsh_at(&home.path().join("never")).unwrap();
    }

    /// Byte-identical to the core writer's `dsh.test.ts` ("replaces the empty
    /// list of a new profile"), so either side can rewrite the other's rows.
    #[test]
    fn the_profile_rows_match_the_core_writer() {
        let home = tempfile::tempdir().unwrap();
        let template =
            "# Your patch layer for this dsh profile, applied after every bundle layer:\n\
# a top-level YAML array of loader patch entries (id-targeted config\n\
# overrides, disables, and insert lists; `!!js` expressions allowed).\n";
        let path = super::super::dsh_config::profile_patch_path(home.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, format!("{template}[]\n")).unwrap();
        configure_dsh_at(
            home.path(),
            URL,
            "AtomicChat/Qwen3.5-9B-GGUF",
            Some("sk"),
            Some(32768),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format!(
                "{template}- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n    \
                 providers:\n      atomic:\n        displayName: Atomic Chat\n        \
                 api: openai-completions\n        baseURL: {URL}\n        \
                 apiKeyEnv: ATOMIC_API_KEY\n        models:\n        \
                 - id: AtomicChat/Qwen3.5-9B-GGUF\n          contextWindow: 32768\n          \
                 maxTokens: 8192\n\
                 - id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n  \
                 config:\n    provider: atomic\n    model: AtomicChat/Qwen3.5-9B-GGUF\n"
            )
        );
    }

    #[test]
    fn a_legacy_settings_yaml_is_kept_in_step_and_restored() {
        let home = tempfile::tempdir().unwrap();
        let settings = home.path().join("settings.yaml");
        let imported = home.path().join("settings.yaml.imported");
        std::fs::write(
            &settings,
            "agent-default-model:\n  provider: deepseek-official\n  model: deepseek-flash\n",
        )
        .unwrap();
        std::fs::write(&imported, "llm-pi-ai: {}\n").unwrap();
        configure_dsh_at(home.path(), URL, "qwen3", None, None).unwrap();
        configure_dsh_at(home.path(), URL, "qwen3", None, None).unwrap();
        let root = parse(&std::fs::read_to_string(&settings).unwrap());
        assert_eq!(route(&root).get("baseURL").unwrap().as_str(), Some(URL));
        assert_eq!(
            root[DSH_DEFAULT_MODEL_SECTION]["provider"].as_str(),
            Some(DSH_ROUTE_ID)
        );
        assert_eq!(
            std::fs::read_to_string(&imported).unwrap(),
            "llm-pi-ai: {}\n"
        );

        disconnect_dsh_at(home.path()).unwrap();
        let root = parse(&std::fs::read_to_string(&settings).unwrap());
        assert!(root[DSH_SECTION]["providers"].get(DSH_ROUTE_ID).is_none());
        assert_eq!(
            root[DSH_DEFAULT_MODEL_SECTION]["provider"].as_str(),
            Some("deepseek-official")
        );
        assert_eq!(
            std::fs::read_to_string(&imported).unwrap(),
            "llm-pi-ai: {}\n"
        );
    }

    #[test]
    fn an_invalid_route_writes_nothing() {
        let home = tempfile::tempdir().unwrap();
        assert!(configure_dsh_at(home.path(), URL, " ", None, None).is_err());
        assert!(configure_dsh_at(home.path(), URL, "m", Some("has space"), None).is_err());
        assert!(std::fs::read_dir(home.path()).unwrap().next().is_none());
    }
}

#[cfg(test)]
mod atomic_agent_tests {
    use super::*;

    const URL: &str = "http://127.0.0.1:1337/v1";

    fn patch(input: serde_json::Value) -> serde_json::Value {
        atomic_agent_patch_config(input, URL, "qwen3-4b", Some(""), None)
            .expect("merge must succeed")
    }

    fn provider<'a>(root: &'a serde_json::Value, id: &str) -> &'a serde_json::Value {
        root["llm"]["providers"]
            .as_array()
            .expect("providers must be an array")
            .iter()
            .find(|p| p["id"] == id)
            .unwrap_or_else(|| panic!("no provider {id}"))
    }

    /// A fresh install has no `config.json` at all. The block we create has to
    /// validate on its own — including `activeEmbeddingProvider`, which the
    /// agent rejects when it names a provider that is not in the list.
    #[test]
    fn seeds_a_self_consistent_block_from_nothing() {
        let out = patch(serde_json::json!({}));
        assert_eq!(out["llm"]["activeTextProvider"], ATOMIC_AGENT_PROVIDER_ID);
        assert_eq!(
            out["llm"]["activeEmbeddingProvider"],
            ATOMIC_AGENT_LOCAL_PROVIDER_ID
        );

        let ours = provider(&out, ATOMIC_AGENT_PROVIDER_ID);
        assert_eq!(ours["kind"], "openai-compatible");
        assert_eq!(ours["baseUrl"], URL);
        assert_eq!(ours["defaultChatModel"], "qwen3-4b");
        // An empty server key must not reach the file: the OpenAI-compatible
        // transport sends it as a bearer token.
        assert_eq!(ours["apiKey"], "atomic");
        assert_eq!(
            ours["requestTimeoutMs"],
            serde_json::json!(ATOMIC_AGENT_REQUEST_TIMEOUT_MS)
        );

        // The seeded llama-server entry follows the user's own local URL.
        let local = provider(&out, ATOMIC_AGENT_LOCAL_PROVIDER_ID);
        assert_eq!(local["kind"], "llama-server");
        assert_eq!(local["url"], ATOMIC_AGENT_DEFAULT_LLAMA_URL);
    }

    #[test]
    fn seeded_llama_entry_follows_local_models_url() {
        let out = patch(serde_json::json!({
            "localModels": { "url": "http://127.0.0.1:9999" }
        }));
        assert_eq!(
            provider(&out, ATOMIC_AGENT_LOCAL_PROVIDER_ID)["url"],
            "http://127.0.0.1:9999"
        );
    }

    /// Under `mode: "managed"` the agent ignores `localModels.url` and talks to
    /// the daemon on `managed.port`, so the seeded entry has to as well.
    #[test]
    fn seeded_llama_entry_is_managed_mode_aware() {
        let out = patch(serde_json::json!({
            "localModels": { "url": "http://127.0.0.1:9999", "mode": "managed",
                             "managed": { "port": 20002 } }
        }));
        assert_eq!(
            provider(&out, ATOMIC_AGENT_LOCAL_PROVIDER_ID)["url"],
            "http://127.0.0.1:20002"
        );

        // `managed` without an explicit port falls back to the agent's default.
        let out = patch(serde_json::json!({
            "localModels": { "url": "http://127.0.0.1:9999", "mode": "managed" }
        }));
        assert_eq!(
            provider(&out, ATOMIC_AGENT_LOCAL_PROVIDER_ID)["url"],
            format!("http://127.0.0.1:{ATOMIC_AGENT_DEFAULT_MANAGED_PORT}")
        );
    }

    /// Chat and embeddings are two different daemons. The embedding path
    /// resolves a provider entry as `baseUrl ?? url`
    /// (`src/memory/embeddings/embedding-provider-registry.ts`), so an entry
    /// carrying only `url` would send embeddings to the chat server the moment
    /// we create the `llm` block. `baseUrl` therefore mirrors the branch the
    /// agent uses for a file with no `llm` block at all:
    /// `embeddings.enabled ? embeddings.url : localModels.url`.
    #[test]
    fn seeded_llama_entry_keeps_embeddings_on_the_embeddings_daemon() {
        let base_url = |local_models: serde_json::Value| {
            patch(serde_json::json!({ "localModels": local_models }))["llm"]["providers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["id"] == ATOMIC_AGENT_LOCAL_PROVIDER_ID)
                .expect("local-llama must be seeded")["baseUrl"]
                .as_str()
                .expect("baseUrl must be written")
                .to_string()
        };

        // Daemon off: embeddings ride the chat URL, exactly as today.
        assert_eq!(
            base_url(serde_json::json!({})),
            ATOMIC_AGENT_DEFAULT_LLAMA_URL
        );
        assert_eq!(
            base_url(serde_json::json!({ "url": "http://127.0.0.1:9000" })),
            "http://127.0.0.1:9000"
        );
        assert_eq!(
            base_url(serde_json::json!({ "mode": "managed", "managed": { "port": 20001 } })),
            "http://127.0.0.1:20001"
        );

        // Daemon on: embeddings stay on the daemon, in either mode.
        assert_eq!(
            base_url(serde_json::json!({
                "embeddings": { "enabled": true, "url": "http://127.0.0.1:19092" }
            })),
            "http://127.0.0.1:19092"
        );
        assert_eq!(
            base_url(serde_json::json!({
                "mode": "managed",
                "embeddings": { "enabled": true, "url": "http://127.0.0.1:19092" }
            })),
            "http://127.0.0.1:19092"
        );
        // A port with no url: the agent derives the url from it, so we do too.
        assert_eq!(
            base_url(serde_json::json!({
                "embeddings": { "enabled": true, "port": 20500 }
            })),
            "http://127.0.0.1:20500"
        );
        assert_eq!(
            base_url(serde_json::json!({ "embeddings": { "enabled": true } })),
            format!("http://127.0.0.1:{ATOMIC_AGENT_DEFAULT_EMBEDDINGS_PORT}")
        );
    }

    /// The model is validated trimmed, so it has to be stored trimmed as well —
    /// otherwise `" qwen "` reaches the file and the agent asks the server for
    /// a model no server has.
    #[test]
    fn writes_the_model_trimmed() {
        let out = atomic_agent_patch_config(serde_json::json!({}), URL, "  qwen3-4b\n", None, None)
            .expect("merge must succeed");
        assert_eq!(
            provider(&out, ATOMIC_AGENT_PROVIDER_ID)["defaultChatModel"],
            "qwen3-4b"
        );
    }

    /// The file is the agent's trust surface: everything we did not come for
    /// survives verbatim, including blocks this build has never heard of.
    #[test]
    fn preserves_other_blocks_and_providers() {
        let out = patch(serde_json::json!({
            "version": 44,
            "agent": { "approvalLevel": 3 },
            "somethingNewer": { "keep": true },
            "llm": {
                "activeTextProvider": "openrouter",
                "activeEmbeddingProvider": "openrouter",
                "toolTransport": "grammar",
                "providers": [
                    { "id": "openrouter", "kind": "openrouter", "apiKey": "sk-user" }
                ]
            }
        }));
        assert_eq!(out["version"], 44);
        assert_eq!(out["agent"]["approvalLevel"], 3);
        assert_eq!(out["somethingNewer"]["keep"], true);
        // The user's own provider and their tool transport are untouched…
        assert_eq!(provider(&out, "openrouter")["apiKey"], "sk-user");
        assert_eq!(out["llm"]["toolTransport"], "grammar");
        // …and embeddings stay where they were: Run selects a chat provider.
        assert_eq!(out["llm"]["activeEmbeddingProvider"], "openrouter");
        // …but the text provider switches, because that is what Run means.
        assert_eq!(out["llm"]["activeTextProvider"], ATOMIC_AGENT_PROVIDER_ID);
    }

    /// Re-running Run must not multiply entries, and must not clobber a
    /// timeout the user tuned on our own provider.
    #[test]
    fn upsert_is_idempotent_and_keeps_a_tuned_timeout() {
        let first = patch(serde_json::json!({}));
        let mut tuned = first.clone();
        tuned["llm"]["providers"][1]["requestTimeoutMs"] = serde_json::json!(60_000);

        let out = atomic_agent_patch_config(tuned, URL, "gemma-4-12b", Some("sk-local"), None)
            .expect("merge must succeed");
        let providers = out["llm"]["providers"].as_array().unwrap();
        assert_eq!(providers.len(), 2, "one entry per provider id");

        let ours = provider(&out, ATOMIC_AGENT_PROVIDER_ID);
        assert_eq!(ours["requestTimeoutMs"], serde_json::json!(60_000));
        assert_eq!(ours["defaultChatModel"], "gemma-4-12b");
        assert_eq!(ours["apiKey"], "sk-local");
    }

    /// A dangling or absent `activeEmbeddingProvider` would make the agent
    /// reject the whole file, so it is repaired rather than carried forward —
    /// and the repair lands on the agent's own `local-llama` default, seeding
    /// that entry when the file does not already carry it. Repairing toward
    /// `atomic-chat` would hand memory recall to Atomic Chat, which is exactly
    /// what this writer refuses to do.
    #[test]
    fn repairs_a_dangling_embedding_provider_to_local_llama() {
        for llm in [
            serde_json::json!({
                "activeEmbeddingProvider": "deleted-provider",
                "providers": [{ "id": "groq", "kind": "openai-compatible" }]
            }),
            // Absent entirely, with a non-empty provider list — so the
            // empty-array seed above never fires.
            serde_json::json!({
                "providers": [{ "id": "groq", "kind": "openai-compatible" }]
            }),
        ] {
            let out = patch(serde_json::json!({ "llm": llm }));
            assert_eq!(
                out["llm"]["activeEmbeddingProvider"],
                ATOMIC_AGENT_LOCAL_PROVIDER_ID
            );
            assert_eq!(
                provider(&out, ATOMIC_AGENT_LOCAL_PROVIDER_ID)["kind"],
                "llama-server",
                "the repair target has to be listed, not just named"
            );
        }
    }

    /// An embedding provider the user actually has is theirs; Run selects a
    /// chat provider and nothing else.
    #[test]
    fn leaves_a_working_embedding_selection_alone() {
        let out = patch(serde_json::json!({
            "llm": {
                "activeEmbeddingProvider": "groq",
                "providers": [{ "id": "groq", "kind": "openai-compatible" }]
            }
        }));
        assert_eq!(out["llm"]["activeEmbeddingProvider"], "groq");
        assert!(
            out["llm"]["providers"]
                .as_array()
                .unwrap()
                .iter()
                .all(|p| p["id"] != ATOMIC_AGENT_LOCAL_PROVIDER_ID),
            "no reason to seed local-llama when the selection already works"
        );
    }

    /// `toolTransport` is deliberately not written: the agent defaults an
    /// absent one to `"auto"` itself, so writing it would only add a key.
    #[test]
    fn never_writes_tool_transport() {
        let out = patch(serde_json::json!({}));
        assert!(out["llm"].get("toolTransport").is_none());

        let out = patch(serde_json::json!({ "llm": { "toolTransport": "grammar" } }));
        assert_eq!(out["llm"]["toolTransport"], "grammar");
    }

    /// The agent's `parseOptionalString` rejects `""` rather than treating it
    /// as absent, so an empty model would take the whole file down at its next
    /// start. Fail before writing instead.
    #[test]
    fn refuses_to_write_an_empty_model() {
        assert!(atomic_agent_patch_config(serde_json::json!({}), URL, "  ", None, None).is_err());
    }

    /// With no `fallback` block the agent retries every failure of ours on
    /// its own `local-llama` (:8080) and reports "The local model isn't
    /// running"; a block the user wrote is theirs.
    #[test]
    fn turns_off_the_local_fallback_only_when_none_is_configured() {
        let out = patch(serde_json::json!({}));
        assert_eq!(
            out["llm"]["fallback"],
            serde_json::json!({ "appendLocal": false })
        );

        let chain = serde_json::json!({ "chain": ["openrouter"], "appendLocal": true });
        let out = patch(serde_json::json!({ "llm": { "fallback": chain.clone() } }));
        assert_eq!(out["llm"]["fallback"], chain);
    }

    #[test]
    fn tells_the_agent_the_served_window_when_known() {
        let out =
            atomic_agent_patch_config(serde_json::json!({}), URL, "qwen3-4b", None, Some(32768))
                .unwrap();
        assert_eq!(
            provider(&out, ATOMIC_AGENT_PROVIDER_ID)["userModels"],
            serde_json::json!([{ "id": "qwen3-4b", "kind": "chat", "contextWindow": 32768 }])
        );
        let out = patch(serde_json::json!({}));
        assert!(provider(&out, ATOMIC_AGENT_PROVIDER_ID)
            .get("userModels")
            .is_none());
    }

    fn connect_at(dir: &Path, model: &str) {
        configure_atomic_agent_at(dir, URL, model, None, Some(65536)).unwrap();
    }

    fn read_config(dir: &Path) -> serde_json::Value {
        serde_json::from_str(&fs::read_to_string(dir.join("config.json")).unwrap()).unwrap()
    }

    /// Connect twice, then Disconnect: the user's providers and selections
    /// are what they were, and a file Connect created is empty again.
    #[test]
    fn disconnect_restores_what_connect_overwrote() {
        let dir = tempfile::tempdir().unwrap();
        let seed = serde_json::json!({
            "llm": {
                "activeTextProvider": "openrouter",
                "activeEmbeddingProvider": "local-llama",
                "providers": [
                    { "id": "local-llama", "kind": "llama-server", "url": "http://127.0.0.1:8080" },
                    { "id": "openrouter", "kind": "openrouter", "apiKey": "sk-or" }
                ]
            },
            "ui": { "theme": "dark" }
        });
        fs::write(dir.path().join("config.json"), seed.to_string()).unwrap();
        connect_at(dir.path(), "qwen3-4b");
        connect_at(dir.path(), "gemma-4");
        assert_eq!(
            read_config(dir.path())["llm"]["activeTextProvider"],
            ATOMIC_AGENT_PROVIDER_ID
        );
        disconnect_atomic_agent_at(dir.path()).unwrap();
        assert_eq!(read_config(dir.path()), seed);
        assert!(!json_key_backup::backup_path(&dir.path().join("config.json")).exists());

        let fresh = tempfile::tempdir().unwrap();
        connect_at(fresh.path(), "qwen3-4b");
        disconnect_atomic_agent_at(fresh.path()).unwrap();
        assert_eq!(read_config(fresh.path()), serde_json::json!({}));
        // Never connected: nothing to do.
        disconnect_atomic_agent_at(&fresh.path().join("missing")).unwrap();
    }

    /// No provider may be left naming ours (the agent rejects the whole
    /// file), whether the user picked it again after Connect or an older
    /// release connected without a backup.
    #[test]
    fn disconnect_leaves_no_reference_to_our_provider() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("config.json"),
            serde_json::json!({ "llm": {
                "activeTextProvider": ATOMIC_AGENT_PROVIDER_ID,
                "activeEmbeddingProvider": "local-llama",
                "fallback": { "chain": [ATOMIC_AGENT_PROVIDER_ID, "openrouter"] },
                "providers": [
                    { "id": "local-llama", "kind": "llama-server" },
                    { "id": "openrouter", "kind": "openrouter" },
                    { "id": ATOMIC_AGENT_PROVIDER_ID, "kind": "openai-compatible" }
                ]
            } })
            .to_string(),
        )
        .unwrap();
        disconnect_atomic_agent_at(dir.path()).unwrap();
        assert_eq!(
            read_config(dir.path()),
            serde_json::json!({ "llm": {
                "activeEmbeddingProvider": "local-llama",
                "fallback": { "chain": ["openrouter"] },
                "providers": [
                    { "id": "local-llama", "kind": "llama-server" },
                    { "id": "openrouter", "kind": "openrouter" }
                ]
            } })
        );

        // Without `local-llama` the next provider takes over.
        fs::write(
            dir.path().join("config.json"),
            serde_json::json!({ "llm": {
                "activeTextProvider": ATOMIC_AGENT_PROVIDER_ID,
                "activeEmbeddingProvider": "openrouter",
                "providers": [
                    { "id": "openrouter", "kind": "openrouter" },
                    { "id": ATOMIC_AGENT_PROVIDER_ID, "kind": "openai-compatible" }
                ]
            } })
            .to_string(),
        )
        .unwrap();
        disconnect_atomic_agent_at(dir.path()).unwrap();
        assert_eq!(
            read_config(dir.path())["llm"]["activeTextProvider"],
            "openrouter"
        );
    }

    #[test]
    fn rejects_a_config_file_that_is_not_an_object() {
        assert!(atomic_agent_patch_config(serde_json::json!([]), URL, "m", None, None).is_err());
    }
}

/// Config-merge and environment-probe rules for the OpenClaw integration. The
/// desktop apps and the CLI share one `openclaw.json`, so these rules decide
/// what both of them end up running.
#[cfg(test)]
mod openclaw_tests {
    use super::*;

    const OC_URL: &str = "http://127.0.0.1:1337/v1";

    fn patch_openclaw(root: serde_json::Value) -> serde_json::Value {
        openclaw_patch_config(root, OC_URL, "gemma-4", Some("atomic"), None, false)
            .expect("patch must succeed")
    }

    #[test]
    fn openclaw_seeds_provider_and_primary_model() {
        let out = patch_openclaw(serde_json::json!({}));
        assert_eq!(out["models"]["providers"]["atomic"]["baseUrl"], OC_URL);
        assert_eq!(
            out["models"]["providers"]["atomic"]["api"],
            "openai-completions"
        );
        // The catalog id stays bare; OpenClaw builds the ref as provider/id.
        assert_eq!(
            out["models"]["providers"]["atomic"]["models"][0]["id"],
            "gemma-4"
        );
        assert_eq!(
            out["agents"]["defaults"]["model"]["primary"],
            "atomic/gemma-4"
        );
        assert!(out["agents"]["defaults"]["models"]["atomic/gemma-4"].is_object());
    }

    /// A non-empty `modelPolicy.allow` gates `/model`, session overrides and
    /// `--model`, so without widening it our model is rejected at use time even
    /// though the write "succeeded".
    #[test]
    fn openclaw_widens_a_restrictive_model_policy() {
        let out = patch_openclaw(serde_json::json!({
            "agents": { "defaults": { "modelPolicy": { "allow": ["anthropic/*"] } } }
        }));
        let allow = out["agents"]["defaults"]["modelPolicy"]["allow"]
            .as_array()
            .expect("allow stays an array");
        assert_eq!(
            allow,
            &vec![
                serde_json::json!("anthropic/*"),
                serde_json::json!("atomic/*"),
            ]
        );
    }

    /// Absent or `[]` already means "allow any model". Writing a list into
    /// either would introduce a restriction the user never asked for.
    #[test]
    fn openclaw_does_not_invent_a_model_policy() {
        let out = patch_openclaw(serde_json::json!({}));
        assert!(out["agents"]["defaults"].get("modelPolicy").is_none());

        let out = patch_openclaw(serde_json::json!({
            "agents": { "defaults": { "modelPolicy": { "allow": [] } } }
        }));
        assert_eq!(
            out["agents"]["defaults"]["modelPolicy"]["allow"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn openclaw_leaves_a_policy_that_already_covers_us_untouched() {
        for existing in [
            serde_json::json!(["atomic/*"]),
            serde_json::json!(["atomic/gemma-4"]),
            serde_json::json!(["openai/gpt-5.4", "atomic/*"]),
        ] {
            let before = existing.as_array().unwrap().len();
            let out = patch_openclaw(serde_json::json!({
                "agents": { "defaults": { "modelPolicy": { "allow": existing } } }
            }));
            assert_eq!(
                out["agents"]["defaults"]["modelPolicy"]["allow"]
                    .as_array()
                    .unwrap()
                    .len(),
                before,
                "an allow list that already covers us must not grow"
            );
        }
    }

    /// Both `model` shapes are valid OpenClaw config; older builds of ours wrote
    /// the plain string. Normalize to the object form without losing siblings.
    #[test]
    fn openclaw_normalizes_a_plain_string_model() {
        let out = patch_openclaw(serde_json::json!({
            "agents": { "defaults": { "model": "atomic/stale-model" } }
        }));
        assert_eq!(
            out["agents"]["defaults"]["model"]["primary"],
            "atomic/gemma-4"
        );

        let out = patch_openclaw(serde_json::json!({
            "agents": { "defaults": { "model": { "fallbacks": ["anthropic/claude"] } } }
        }));
        assert_eq!(
            out["agents"]["defaults"]["model"]["primary"],
            "atomic/gemma-4"
        );
        assert_eq!(
            out["agents"]["defaults"]["model"]["fallbacks"][0],
            "anthropic/claude"
        );
    }

    /// Gateway keys are seeded for a fresh loopback setup but never overwritten:
    /// a user on a remote gateway or token auth must keep it.
    #[test]
    fn openclaw_preserves_deliberate_gateway_settings() {
        let out = patch_openclaw(serde_json::json!({}));
        assert_eq!(out["gateway"]["mode"], "local");
        assert_eq!(out["gateway"]["auth"]["mode"], "none");

        let out = patch_openclaw(serde_json::json!({
            "gateway": { "mode": "remote", "auth": { "mode": "token" } }
        }));
        assert_eq!(out["gateway"]["mode"], "remote");
        assert_eq!(out["gateway"]["auth"]["mode"], "token");
    }

    /// A known window is written with an output cap; an unknown one is left
    /// to OpenClaw. The request budget sits on our provider, not on every
    /// model the agent runs.
    #[test]
    fn openclaw_tells_the_model_entry_the_served_window() {
        let out = openclaw_patch_config(
            serde_json::json!({}),
            OC_URL,
            "gemma-4",
            None,
            Some(32768),
            false,
        )
        .unwrap();
        let provider = &out["models"]["providers"]["atomic"];
        assert_eq!(provider["models"][0]["contextWindow"], 32768);
        assert_eq!(provider["models"][0]["maxTokens"], 8192);
        assert_eq!(
            provider["timeoutSeconds"],
            OPENCLAW_PROVIDER_TIMEOUT_SECONDS
        );
        assert!(out["agents"]["defaults"].get("timeoutSeconds").is_none());

        let small =
            openclaw_patch_config(serde_json::json!({}), OC_URL, "m", None, Some(16384), false)
                .unwrap();
        assert_eq!(
            small["models"]["providers"]["atomic"]["models"][0]["maxTokens"],
            4096
        );

        let unknown = patch_openclaw(serde_json::json!({}));
        let entry = &unknown["models"]["providers"]["atomic"]["models"][0];
        assert!(entry.get("contextWindow").is_none() && entry.get("maxTokens").is_none());
    }

    /// The 240 s every model's attempt was capped at by older releases goes;
    /// a value the user chose stays.
    #[test]
    fn openclaw_drops_only_the_agent_timeout_older_releases_seeded() {
        let mut root = serde_json::json!({ "agents": { "defaults": { "timeoutSeconds": 240 } } });
        openclaw_normalize(&mut root);
        assert!(root["agents"]["defaults"].get("timeoutSeconds").is_none());
        let mut root = serde_json::json!({ "agents": { "defaults": { "timeoutSeconds": 900 } } });
        openclaw_normalize(&mut root);
        assert_eq!(root["agents"]["defaults"]["timeoutSeconds"], 900);
    }

    /// "none" is seeded only when the Gateway has no secret to expect: with a
    /// token configured it would switch token auth off.
    #[test]
    fn openclaw_seeds_open_gateway_auth_only_without_a_secret() {
        let with_token = patch_openclaw(serde_json::json!({
            "gateway": { "auth": { "token": "t0k3n" } }
        }));
        assert!(with_token["gateway"]["auth"].get("mode").is_none());
        assert_eq!(with_token["gateway"]["auth"]["token"], "t0k3n");

        let with_ref = patch_openclaw(serde_json::json!({
            "gateway": { "auth": { "password": { "source": "env", "id": "PW" } } }
        }));
        assert!(with_ref["gateway"]["auth"].get("mode").is_none());

        let env_secret =
            openclaw_patch_config(serde_json::json!({}), OC_URL, "m", None, None, true).unwrap();
        assert!(env_secret["gateway"].get("auth").is_none());
    }

    fn write_openclaw(path: &Path, value: &serde_json::Value) {
        fs::write(path, serde_json::to_string_pretty(value).unwrap() + "\n").unwrap();
    }

    fn read_openclaw(path: &Path) -> serde_json::Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    /// Connect twice (another model the second time), then Disconnect: the
    /// file is what it was, the string model included.
    #[test]
    fn openclaw_disconnect_restores_what_connect_overwrote() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("openclaw.json");
        let seed = serde_json::json!({
            "agents": { "defaults": {
                "model": "anthropic/claude-opus-4-6",
                "modelPolicy": { "allow": ["anthropic/*"] },
                "models": { "anthropic/claude-opus-4-6": { "alias": "opus" } }
            } },
            "gateway": { "mode": "remote", "remote": { "url": "wss://x" } },
            "models": { "providers": { "anthropic": { "apiKey": "sk-ant" } } }
        });
        write_openclaw(&config, &seed);
        configure_openclaw_at(&config, OC_URL, "gemma-4", None, Some(32768), false).unwrap();
        configure_openclaw_at(&config, OC_URL, "qwen-3", None, None, false).unwrap();
        let connected = read_openclaw(&config);
        assert_eq!(
            connected["agents"]["defaults"]["model"]["primary"],
            "atomic/qwen-3"
        );
        assert!(json_key_backup::backup_path(&config).exists());

        disconnect_openclaw_at(&config).unwrap();
        let mut expected = seed.clone();
        // The plain string is restored in its equivalent object form.
        expected["agents"]["defaults"]["model"] =
            serde_json::json!({ "primary": "anthropic/claude-opus-4-6" });
        assert_eq!(read_openclaw(&config), expected);
        assert!(!json_key_backup::backup_path(&config).exists());

        // From nothing back to nothing.
        let fresh = dir.path().join("fresh.json");
        configure_openclaw_at(&fresh, OC_URL, "gemma-4", None, None, false).unwrap();
        disconnect_openclaw_at(&fresh).unwrap();
        assert_eq!(read_openclaw(&fresh), serde_json::json!({}));
        // Never connected: nothing to do.
        disconnect_openclaw_at(&dir.path().join("missing.json")).unwrap();
    }

    #[test]
    fn openclaw_disconnect_leaves_what_the_user_changed_after_connect() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("openclaw.json");
        write_openclaw(
            &config,
            &serde_json::json!({ "agents": { "defaults": {
            "model": { "primary": "openai/gpt-5.4" } } } }),
        );
        configure_openclaw_at(&config, OC_URL, "gemma-4", None, None, false).unwrap();
        let mut edited = read_openclaw(&config);
        edited["agents"]["defaults"]["model"]["primary"] = serde_json::json!("google/gemini-3");
        edited["gateway"]["mode"] = serde_json::json!("remote");
        write_openclaw(&config, &edited);

        disconnect_openclaw_at(&config).unwrap();
        let out = read_openclaw(&config);
        assert_eq!(
            out["agents"]["defaults"]["model"]["primary"],
            "google/gemini-3"
        );
        assert_eq!(out["gateway"]["mode"], "remote");
        assert!(out["models"].get("providers").is_none());
    }

    /// A connection made by an older release kept no backup; what is
    /// recognisably ours goes, and the primary model no longer names a
    /// provider that is gone.
    #[test]
    fn openclaw_disconnect_of_an_older_connection() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("openclaw.json");
        write_openclaw(
            &config,
            &serde_json::json!({
                "agents": { "defaults": {
                    "model": { "primary": "atomic/gemma-4", "fallbacks": ["openai/gpt-5.4"] },
                    "models": { "atomic/gemma-4": {}, "openai/gpt-5.4": {} },
                    "modelPolicy": { "allow": ["openai/*", "atomic/*"] },
                    "timeoutSeconds": 240
                } },
                "models": { "mode": "merge", "providers": { "atomic": { "baseUrl": OC_URL } } }
            }),
        );
        disconnect_openclaw_at(&config).unwrap();
        assert_eq!(
            read_openclaw(&config),
            serde_json::json!({
                "agents": { "defaults": {
                    "model": { "fallbacks": ["openai/gpt-5.4"] },
                    "models": { "openai/gpt-5.4": {} },
                    "modelPolicy": { "allow": ["openai/*"] }
                } },
                "models": { "mode": "merge" }
            })
        );
    }

    #[test]
    fn openclaw_gateway_is_running_only_when_its_lock_names_a_live_port() {
        let dir = tempfile::tempdir().unwrap();
        let locks = dir.path().join("tmp").join("openclaw-501");
        fs::create_dir_all(&locks).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let live = listener.local_addr().unwrap().port();
        let dead = {
            let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            closed.local_addr().unwrap().port()
        };
        let lock = |payload: serde_json::Value| {
            fs::write(locks.join("gateway.state.lock"), payload.to_string()).unwrap();
            openclaw_gateway_ports(&[locks.clone()])
                .into_iter()
                .any(loopback_port_is_listening)
        };
        assert!(!lock(
            serde_json::json!({ "pid": 1, "role": "gateway", "port": dead })
        ));
        assert!(!lock(
            serde_json::json!({ "pid": 1, "role": "agent-embedded", "port": live })
        ));
        assert!(!lock(serde_json::json!({ "pid": 1, "role": "gateway" })));
        assert!(lock(
            serde_json::json!({ "pid": 1, "role": "gateway", "port": live })
        ));
        assert!(lock(serde_json::json!({ "pid": 1, "port": live })));
        fs::write(locks.join("gateway.state.lock"), "not json").unwrap();
        assert!(openclaw_gateway_ports(&[locks.clone()]).is_empty());
        assert!(openclaw_gateway_ports(&[dir.path().join("missing")]).is_empty());
    }

    #[test]
    fn model_policy_matching_handles_exact_refs_and_wildcards() {
        let list = vec![
            serde_json::json!("anthropic/claude-opus-4-6"),
            serde_json::json!("openai/*"),
        ];
        assert!(model_policy_allows(&list, "anthropic/claude-opus-4-6"));
        assert!(model_policy_allows(&list, "openai/gpt-5.4"));
        assert!(!model_policy_allows(&list, "anthropic/claude-sonnet-4-6"));
        assert!(!model_policy_allows(&list, "atomic/gemma-4"));

        // Multi-segment refs and namespace wildcards.
        let ns = vec![serde_json::json!("atomic/vendor/*")];
        assert!(model_policy_allows(&ns, "atomic/vendor/gemma-4"));
        assert!(!model_policy_allows(&ns, "atomic/gemma-4"));
    }

    /// OpenClaw's engines: `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`.
    #[test]
    fn node_engine_gate_matches_openclaws_ranges() {
        assert!(node_meets_openclaw_engines((22, 22, 3)));
        assert!(node_meets_openclaw_engines((22, 23, 0)));
        assert!(!node_meets_openclaw_engines((22, 22, 2)));
        assert!(!node_meets_openclaw_engines((20, 19, 0)));
        // 23 is explicitly unsupported, not merely old.
        assert!(!node_meets_openclaw_engines((23, 11, 0)));
        assert!(!node_meets_openclaw_engines((24, 14, 9)));
        assert!(node_meets_openclaw_engines((24, 15, 0)));
        assert!(!node_meets_openclaw_engines((25, 8, 9)));
        assert!(node_meets_openclaw_engines((25, 9, 0)));
        assert!(node_meets_openclaw_engines((26, 0, 0)));
    }

    #[test]
    fn version_parsing_tolerates_prefixes_and_prereleases() {
        assert_eq!(parse_version("v22.22.3\n"), Some((22, 22, 3)));
        assert_eq!(parse_version("11.16.0"), Some((11, 16, 0)));
        assert_eq!(parse_version("12.0.0-beta.1"), Some((12, 0, 0)));
        assert_eq!(parse_version("13"), Some((13, 0, 0)));
        assert_eq!(parse_version("not a version"), None);
    }

    /// Terminal agents are looked for in the per-user bin directories their
    /// installers write; OpenClaw's launcher, ZCode's desktop app and the
    /// editors have candidates of their own, tested with them.
    #[test]
    fn off_path_candidates_cover_terminal_agents() {
        let home = PathBuf::from(agent_home_dir().expect("home"));
        let local_bin = home.join(".local").join("bin");
        let claude = off_path_candidates("claude");
        let native = if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        };
        assert!(claude.contains(&local_bin.join(native)), "{claude:?}");
        assert!(off_path_candidates("codex")
            .iter()
            .all(|p| p.file_stem().is_some_and(|s| s == "codex")));

        let candidates = off_path_candidates("openclaw");
        assert!(!candidates.is_empty());
        assert!(
            candidates
                .iter()
                .all(|p| p.parent().is_some_and(|d| d.ends_with("bin"))),
            "every candidate must sit in a <prefix>/bin directory"
        );
        // The macOS app's own installer default has to be covered.
        assert!(candidates
            .iter()
            .any(|p| p.to_string_lossy().contains(".openclaw")));
    }
}

#[cfg(test)]
mod zcode_tests {
    use super::*;
    use serde_json::json;

    const URL: &str = "http://127.0.0.1:1337/v1";

    fn patch(existing: Option<serde_json::Value>, model: &str) -> serde_json::Value {
        zcode_patch_provider_config(existing, URL, model, None, None).expect("patch must succeed")
    }

    fn providers(root: &serde_json::Value) -> &Vec<serde_json::Value> {
        root["config"]["providerConfigRules"]["providerRules"]
            .as_array()
            .expect("providerRules must be an array")
    }

    fn model_rules<'a>(root: &'a serde_json::Value, list: &str) -> &'a Vec<serde_json::Value> {
        root["config"]["modelConfigRules"][list]
            .as_array()
            .expect("model rule lists must be arrays")
    }

    fn ours(rules: &[serde_json::Value]) -> Vec<&serde_json::Value> {
        rules
            .iter()
            .filter(|r| r["providerId"] == ZCODE_PROVIDER_ID)
            .collect()
    }

    /// A user's own provider as ZCode's Model Settings writes it.
    fn user_file() -> serde_json::Value {
        json!({
            "schemaVersion": 1,
            "config": {
                "providerOrder": ["new-provider"],
                "providerConfigRules": { "providerRules": [{
                    "providerId": "new-provider",
                    "providerName": "OpenRouter",
                    "enabled": true,
                    "config": {
                        "group": "standard-personal",
                        "access": { "type": "api-key", "apiKey": "sk-user" },
                        "api": { "type": "openai-chat-completions", "baseUrl": "https://openrouter.ai/api/v1" },
                        "personalModelIds": ["glm-5"]
                    }
                }] },
                "modelConfigRules": {
                    "providerModelRules": [
                        { "providerId": "new-provider", "modelId": "glm-5", "config": { "enabled": true } }
                    ],
                    "manualProviderModelRules": []
                },
                "defaultModelSelection": { "providerId": "new-provider", "modelId": "glm-5" }
            }
        })
    }

    /// The file ZCode creates has to validate on its own: both model rule lists
    /// are required, the provider needs a group, a non-blank key and an API.
    #[test]
    fn seeds_a_complete_file_from_nothing() {
        let out = patch(None, "qwen3-4b");
        assert_eq!(out["schemaVersion"], 1);

        let provider = &providers(&out)[0];
        assert_eq!(provider["providerId"], ZCODE_PROVIDER_ID);
        assert_eq!(provider["enabled"], true);
        let config = &provider["config"];
        assert_eq!(config["group"], "standard-personal");
        assert_eq!(config["access"]["type"], "api-key");
        assert_eq!(config["access"]["apiKey"], ZCODE_KEY_PLACEHOLDER);
        assert_eq!(config["api"]["type"], "openai-chat-completions");
        assert_eq!(config["api"]["baseUrl"], URL);
        assert_eq!(config["personalModelIds"], json!(["qwen3-4b"]));

        assert!(model_rules(&out, "manualProviderModelRules").is_empty());
        let rule = &model_rules(&out, "providerModelRules")[0];
        assert_eq!(rule["modelId"], "qwen3-4b");
        // With the served window unknown, ZCode's own default stands.
        assert!(rule["config"]["properties"].get("contextWindow").is_none());
        assert_eq!(
            rule["config"]["optionSpecs"]["maxOutputTokens"]["max"],
            8192
        );
        assert_eq!(
            rule["config"]["optionSpecs"]["reasoningLevel"]["map"],
            ZCODE_REASONING_MAP
        );
        assert_eq!(
            out["config"]["defaultModelSelection"],
            json!({
                "providerId": ZCODE_PROVIDER_ID,
                "modelId": "qwen3-4b",
                "options": { "reasoningLevel": "enabled" }
            })
        );
        // A file ZCode never had gets no order list invented for it.
        assert!(out["config"].get("providerOrder").is_none());
    }

    #[test]
    fn uses_the_server_key_when_there_is_one() {
        let out = zcode_patch_provider_config(None, URL, "m", Some(" sk-local "), None).unwrap();
        assert_eq!(providers(&out)[0]["config"]["access"]["apiKey"], "sk-local");
    }

    #[test]
    fn keeps_the_users_providers_and_rules() {
        let out = patch(Some(user_file()), "qwen3-4b");

        let all = providers(&out);
        assert_eq!(all.len(), 2);
        assert_eq!(
            all[0],
            user_file()["config"]["providerConfigRules"]["providerRules"][0]
        );

        let rules = model_rules(&out, "providerModelRules");
        assert!(rules.iter().any(|r| r["providerId"] == "new-provider"));
        assert_eq!(
            out["config"]["providerOrder"],
            json!([ZCODE_PROVIDER_ID, "new-provider"])
        );
        // Run means "use this model": the default moves to ours.
        assert_eq!(
            out["config"]["defaultModelSelection"]["providerId"],
            ZCODE_PROVIDER_ID
        );
    }

    #[test]
    fn running_again_or_switching_model_leaves_one_entry_of_ours() {
        let once = patch(Some(user_file()), "qwen3-4b");
        let twice = patch(Some(once.clone()), "qwen3-4b");
        assert_eq!(once, twice, "a repeated Run must not change the file");

        let switched = patch(Some(twice), "gemma-4");
        assert_eq!(ours(providers(&switched)).len(), 1);
        assert_eq!(
            ours(providers(&switched))[0]["config"]["personalModelIds"],
            json!(["gemma-4"])
        );
        let rules = ours(model_rules(&switched, "providerModelRules"));
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0]["modelId"], "gemma-4");
        let order = switched["config"]["providerOrder"].as_array().unwrap();
        assert_eq!(
            order.iter().filter(|id| **id == ZCODE_PROVIDER_ID).count(),
            1
        );
    }

    /// ZCode rejects the whole file when a provider/model pair has both a
    /// regular and a manual rule; its Advanced model settings write the manual one.
    #[test]
    fn drops_our_manual_rule_so_the_file_stays_valid() {
        let mut file = user_file();
        file["config"]["modelConfigRules"]["manualProviderModelRules"] = json!([
            { "providerId": ZCODE_PROVIDER_ID, "modelId": "qwen3-4b", "config": {} },
            { "providerId": "new-provider", "modelId": "glm-5", "config": {} }
        ]);
        let out = patch(Some(file), "qwen3-4b");
        let manual = model_rules(&out, "manualProviderModelRules");
        assert_eq!(manual.len(), 1);
        assert_eq!(manual[0]["providerId"], "new-provider");
    }

    #[test]
    fn refuses_files_it_does_not_understand() {
        for bad in [
            json!({ "schemaVersion": 2, "config": {} }),
            json!({ "config": {} }),
            json!([]),
            json!({ "schemaVersion": 1, "config": { "providerConfigRules": { "providerRules": {} } } }),
            json!({ "schemaVersion": 1, "config": { "providerOrder": "atomic-chat" } }),
        ] {
            assert!(
                zcode_patch_provider_config(Some(bad.clone()), URL, "m", None, None).is_err(),
                "{bad} must be refused"
            );
        }
        assert!(zcode_patch_provider_config(None, URL, "  ", None, None).is_err());
    }

    #[test]
    fn config_dir_follows_zcodes_own_resolution_order() {
        let home = tempfile::tempdir().unwrap();
        let v2 = home.path().join(".zcode").join("v2");

        assert_eq!(zcode_config_dir(home.path(), None), v2);
        assert_eq!(
            zcode_config_dir(home.path(), Some("/data")),
            Path::new("/data").join(".zcode").join("v2")
        );

        std::fs::create_dir_all(&v2).unwrap();
        std::fs::write(v2.join("setting.json"), r#"{"dataBaseDir":"  "}"#).unwrap();
        assert_eq!(zcode_config_dir(home.path(), None), v2);

        std::fs::write(v2.join("setting.json"), r#"{"dataBaseDir":"/moved"}"#).unwrap();
        assert_eq!(
            zcode_config_dir(home.path(), Some("/data")),
            Path::new("/moved").join(".zcode").join("v2")
        );
    }

    #[test]
    fn waits_for_zcode_to_import_its_legacy_config_first() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), "{}").unwrap();

        let err = configure_zcode_in(dir.path(), URL, "m", None, None).unwrap_err();
        assert!(err.contains("Open ZCode once"), "{err}");
        assert!(!dir.path().join("provider_config.json").exists());

        // Once ZCode has migrated, the legacy file is only a rollback copy.
        std::fs::write(
            dir.path().join("provider_config.json"),
            user_file().to_string(),
        )
        .unwrap();
        configure_zcode_in(dir.path(), URL, "m", None, None).unwrap();
    }

    #[test]
    fn writes_the_file_and_backs_up_the_users_version_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("provider_config.json");
        let original = user_file().to_string();
        std::fs::write(&path, &original).unwrap();

        configure_zcode_in(dir.path(), URL, "qwen3-4b", None, None).unwrap();
        configure_zcode_in(dir.path(), URL, "gemma-4", None, None).unwrap();

        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            written["config"]["defaultModelSelection"]["modelId"],
            "gemma-4"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("provider_config.json.atomic-backup")).unwrap(),
            original
        );
        assert!(!dir.path().join("provider_config.json.lock").exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn leaves_an_unparseable_file_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("provider_config.json");
        std::fs::write(&path, "{ not json").unwrap();

        assert!(configure_zcode_in(dir.path(), URL, "m", None, None).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
    }

    #[test]
    fn respects_a_live_lock_and_reclaims_an_abandoned_one() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("provider_config.json");
        let lock_dir = dir.path().join("provider_config.json.lock");
        std::fs::create_dir(&lock_dir).unwrap();
        std::fs::write(lock_dir.join("owner-1-2-x.json"), "{}").unwrap();

        let short = std::time::Duration::from_millis(60);
        let err = acquire_zcode_lock(&file, short, std::time::Duration::from_secs(60))
            .err()
            .expect("a fresh lock must be waited for");
        assert!(err.contains("Try again"), "{err}");
        assert!(lock_dir.exists());

        let lock = acquire_zcode_lock(&file, short, std::time::Duration::ZERO)
            .expect("an abandoned lock must be reclaimed");
        assert_eq!(std::fs::read_dir(&lock_dir).unwrap().count(), 1);
        drop(lock);
        assert!(!lock_dir.exists());
    }

    #[test]
    fn finds_the_bundle_of_a_macos_app_executable() {
        assert_eq!(
            macos_app_bundle(Path::new("/Applications/ZCode.app/Contents/MacOS/ZCode")),
            Some(PathBuf::from("/Applications/ZCode.app"))
        );
        assert_eq!(macos_app_bundle(Path::new("/usr/bin/zcode")), None);
    }

    #[test]
    fn writes_the_served_window_and_a_quarter_of_it_for_output() {
        for (context, max_output) in [(65536, 8192), (16384, 4096), (8192, 2048)] {
            let out = zcode_patch_provider_config(None, URL, "m", None, Some(context)).unwrap();
            let rule = &model_rules(&out, "providerModelRules")[0]["config"];
            assert_eq!(rule["properties"]["contextWindow"], context);
            assert_eq!(rule["optionSpecs"]["maxOutputTokens"]["max"], max_output);
        }
        // A reconnect with another window rewrites it.
        let first = patch(None, "m");
        let again = zcode_patch_provider_config(Some(first), URL, "m", None, Some(32768)).unwrap();
        let rules = model_rules(&again, "providerModelRules");
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0]["config"]["properties"]["contextWindow"], 32768);
    }

    fn read(dir: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(dir.join("provider_config.json")).unwrap())
            .unwrap()
    }

    #[test]
    fn disconnect_removes_ours_and_restores_the_users_default_model() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("provider_config.json");
        std::fs::write(&path, user_file().to_string()).unwrap();

        configure_zcode_in(dir.path(), URL, "qwen3-4b", None, Some(32768)).unwrap();
        // A second Connect must not overwrite the remembered selection with ours.
        configure_zcode_in(dir.path(), URL, "gemma-4", None, None).unwrap();
        assert!(dir
            .path()
            .join("provider_config.json.atomic-chat-backup.json")
            .exists());

        disconnect_zcode_in(dir.path()).unwrap();
        let after = read(dir.path());
        assert_eq!(after["config"], user_file()["config"]);
        assert!(!dir
            .path()
            .join("provider_config.json.atomic-chat-backup.json")
            .exists());
        assert!(!dir.path().join("provider_config.json.lock").exists());

        // Nothing of ours left: a second Disconnect is a no-op success.
        let text = std::fs::read_to_string(&path).unwrap();
        disconnect_zcode_in(dir.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn disconnect_keeps_a_default_the_user_picked_after_connect() {
        let dir = tempfile::tempdir().unwrap();
        configure_zcode_in(dir.path(), URL, "qwen3-4b", None, None).unwrap();
        let mut picked = read(dir.path());
        picked["config"]["defaultModelSelection"] =
            json!({ "providerId": "new-provider", "modelId": "glm-5" });
        std::fs::write(dir.path().join("provider_config.json"), picked.to_string()).unwrap();

        disconnect_zcode_in(dir.path()).unwrap();
        let after = read(dir.path());
        assert_eq!(
            after["config"]["defaultModelSelection"],
            json!({ "providerId": "new-provider", "modelId": "glm-5" })
        );
        assert!(ours(providers(&after)).is_empty());
        assert!(ours(model_rules(&after, "providerModelRules")).is_empty());
    }

    #[test]
    fn disconnect_without_a_previous_default_removes_the_selection() {
        let dir = tempfile::tempdir().unwrap();
        configure_zcode_in(dir.path(), URL, "qwen3-4b", None, None).unwrap();
        disconnect_zcode_in(dir.path()).unwrap();
        let after = read(dir.path());
        assert!(after["config"].get("defaultModelSelection").is_none());
        assert!(providers(&after).is_empty());
    }

    #[test]
    fn disconnect_of_a_zcode_never_connected_touches_nothing() {
        let dir = tempfile::tempdir().unwrap();
        disconnect_zcode_in(dir.path()).unwrap();
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);

        let path = dir.path().join("provider_config.json");
        let text = user_file().to_string();
        std::fs::write(&path, &text).unwrap();
        disconnect_zcode_in(dir.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn app_candidates_cover_preview_builds_and_each_installer() {
        let env = |name: &str| match name {
            "LOCALAPPDATA" => Some(r"C:\Users\u\AppData\Local".to_string()),
            "ProgramFiles" => Some(r"C:\Program Files".to_string()),
            _ => None,
        };
        let home = Path::new("/Users/u");
        let mac = zcode_app_candidates_for(HostOs::Macos, home, &env);
        assert!(mac.contains(&PathBuf::from(
            "/Applications/ZCode Preview.app/Contents/MacOS/ZCode Preview"
        )));
        assert!(mac.contains(&home.join("Applications/ZCode.app/Contents/MacOS/ZCode")));

        let win = zcode_app_candidates_for(HostOs::Windows, home, &env);
        assert!(win.contains(
            &PathBuf::from(r"C:\Users\u\AppData\Local")
                .join("Programs")
                .join("ZCode")
                .join("ZCode.exe")
        ));
        assert!(win.contains(
            &PathBuf::from(r"C:\Program Files")
                .join("ZCode Preview")
                .join("ZCode Preview.exe")
        ));

        let linux_home = tempfile::tempdir().unwrap();
        let downloads = linux_home.path().join("Downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        std::fs::write(downloads.join("ZCode-1.4.0-linux-x86_64.AppImage"), "").unwrap();
        std::fs::write(downloads.join("Other-1.0.AppImage"), "").unwrap();
        let linux = zcode_app_candidates_for(HostOs::Linux, linux_home.path(), &env);
        assert!(linux.contains(&PathBuf::from("/opt/ZCode Preview/zcode-preview")));
        assert!(linux.contains(&PathBuf::from("/usr/bin/zcode-preview")));
        assert!(linux.contains(&downloads.join("ZCode-1.4.0-linux-x86_64.AppImage")));
        assert!(!linux.contains(&downloads.join("Other-1.0.AppImage")));
    }

    #[test]
    fn reads_the_executable_from_an_uninstall_display_icon() {
        assert_eq!(
            exe_from_display_icon(r#""D:\Tools\ZCode\ZCode.exe",0"#),
            Some(PathBuf::from(r"D:\Tools\ZCode\ZCode.exe"))
        );
        assert_eq!(
            exe_from_display_icon(r"D:\Tools\ZCode\ZCode.exe"),
            Some(PathBuf::from(r"D:\Tools\ZCode\ZCode.exe"))
        );
        assert_eq!(exe_from_display_icon("  "), None);
    }
}

#[cfg(test)]
mod editor_tests {
    use super::*;
    use serde_json::json;

    const URL: &str = "http://127.0.0.1:1337/v1";

    fn env_of(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let vars: Vec<(String, String)> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name| vars.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
    }

    fn settings(dir: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap()
    }

    #[test]
    fn zed_config_dir_matches_zed_on_each_os() {
        let home = Path::new("/home/u");
        let none = env_of(&[]);
        assert_eq!(
            zed_config_dir_for(HostOs::Macos, home, &none),
            home.join(".config").join("zed")
        );
        // Linux honours an absolute XDG_CONFIG_HOME, as Zed (via `dirs`) does.
        assert_eq!(
            zed_config_dir_for(HostOs::Linux, home, &env_of(&[("XDG_CONFIG_HOME", "/xdg")])),
            PathBuf::from("/xdg").join("zed")
        );
        assert_eq!(
            zed_config_dir_for(HostOs::Linux, home, &env_of(&[("XDG_CONFIG_HOME", "rel")])),
            home.join(".config").join("zed")
        );
        assert_eq!(
            zed_config_dir_for(HostOs::Linux, home, &none),
            home.join(".config").join("zed")
        );
        // Windows: Roaming AppData, never `%USERPROFILE%\.config`.
        let win_home = Path::new(r"C:\Users\u");
        assert_eq!(
            zed_config_dir_for(
                HostOs::Windows,
                win_home,
                &env_of(&[("APPDATA", r"C:\Users\u\AppData\Roaming")])
            ),
            PathBuf::from(r"C:\Users\u\AppData\Roaming").join("Zed")
        );
        assert_eq!(
            zed_config_dir_for(HostOs::Windows, win_home, &none),
            win_home.join("AppData").join("Roaming").join("Zed")
        );
    }

    #[test]
    fn zed_gets_the_served_window_and_no_image_input() {
        let dir = tempfile::tempdir().unwrap();
        configure_zed_in(dir.path(), URL, Some("qwen"), Some(16384)).unwrap();
        let model = &settings(dir.path())["language_models"]["openai_compatible"][ZED_PROVIDER_ID]
            ["available_models"][0];
        assert_eq!(model["max_tokens"], 16384);
        assert_eq!(model["max_output_tokens"], 4096);
        assert_eq!(model["capabilities"]["images"], false);
        assert_eq!(model["capabilities"]["tools"], true);

        // Every Connect rewrites the window; unknown falls back to what Zed
        // always got (it requires a value).
        configure_zed_in(dir.path(), URL, Some("qwen"), Some(131072)).unwrap();
        let model = &settings(dir.path())["language_models"]["openai_compatible"][ZED_PROVIDER_ID]
            ["available_models"][0];
        assert_eq!(model["max_tokens"], 131072);
        assert_eq!(model["max_output_tokens"], 8192);
        configure_zed_in(dir.path(), URL, Some("qwen"), None).unwrap();
        let model = &settings(dir.path())["language_models"]["openai_compatible"][ZED_PROVIDER_ID]
            ["available_models"][0];
        assert_eq!(model["max_tokens"], 32768);
        assert_eq!(model["max_output_tokens"], 8192);
    }

    #[test]
    fn zed_disconnect_restores_the_users_default_model() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{
  // mine
  "theme": "One Dark",
  "language_models": { "ollama": { "api_url": "http://localhost:11434" } },
  "agent": { "version": "2", "default_model": { "provider": "ollama", "model": "llama3.2" } },
}"#,
        )
        .unwrap();

        configure_zed_in(dir.path(), URL, Some("qwen"), Some(32768)).unwrap();
        configure_zed_in(dir.path(), URL, Some("gemma"), Some(32768)).unwrap();
        assert_eq!(
            settings(dir.path())["agent"]["default_model"],
            json!({ "provider": ZED_PROVIDER_ID, "model": "gemma" })
        );

        disconnect_zed_in(dir.path()).unwrap();
        assert_eq!(
            settings(dir.path()),
            json!({
                "theme": "One Dark",
                "language_models": { "ollama": { "api_url": "http://localhost:11434" } },
                "agent": { "version": "2", "default_model": { "provider": "ollama", "model": "llama3.2" } }
            })
        );
        assert!(!dir
            .path()
            .join("settings.json.atomic-chat-backup.json")
            .exists());
    }

    #[test]
    fn zed_disconnect_leaves_a_default_the_user_picked_since() {
        let dir = tempfile::tempdir().unwrap();
        configure_zed_in(dir.path(), URL, Some("qwen"), None).unwrap();
        let mut root = settings(dir.path());
        root["agent"]["default_model"] = json!({ "provider": "anthropic", "model": "claude" });
        std::fs::write(dir.path().join("settings.json"), root.to_string()).unwrap();

        disconnect_zed_in(dir.path()).unwrap();
        assert_eq!(
            settings(dir.path()),
            json!({ "agent": { "default_model": { "provider": "anthropic", "model": "claude" } } })
        );
    }

    #[test]
    fn zed_disconnect_without_a_previous_default_drops_ours_entirely() {
        let dir = tempfile::tempdir().unwrap();
        configure_zed_in(dir.path(), URL, Some("qwen"), None).unwrap();
        disconnect_zed_in(dir.path()).unwrap();
        assert_eq!(settings(dir.path()), json!({}));
    }

    #[test]
    fn zed_disconnect_of_nothing_is_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        disconnect_zed_in(dir.path()).unwrap();
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);

        let text = "{\n  // mine\n  \"theme\": \"One Dark\",\n}\n";
        std::fs::write(dir.path().join("settings.json"), text).unwrap();
        disconnect_zed_in(dir.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("settings.json")).unwrap(),
            text
        );
    }

    #[test]
    fn zed_launchers_cover_every_installer() {
        let env = env_of(&[
            ("LOCALAPPDATA", r"C:\Users\u\AppData\Local"),
            ("ProgramFiles", r"C:\Program Files"),
        ]);
        let home = Path::new("/Users/u");
        let mac = zed_cli_candidates(HostOs::Macos, home, &env);
        assert!(mac.contains(&home.join(".local/bin/zed")));
        assert!(mac.contains(&PathBuf::from("/Applications/Zed.app/Contents/MacOS/cli")));
        assert!(mac.contains(&home.join("Applications/Zed.app/Contents/MacOS/cli")));

        let linux = zed_cli_candidates(HostOs::Linux, Path::new("/home/u"), &env);
        assert!(linux.contains(&PathBuf::from("/home/u/.local/zed.app/bin/zed")));

        let local = PathBuf::from(r"C:\Users\u\AppData\Local");
        let win_cli = zed_cli_candidates(HostOs::Windows, home, &env);
        assert_eq!(
            win_cli[0],
            local
                .join("Programs")
                .join("Zed")
                .join("bin")
                .join("zed.exe")
        );
        let win_app = zed_app_candidates(HostOs::Windows, home, &env);
        assert_eq!(
            win_app[0],
            local.join("Programs").join("Zed").join("Zed.exe")
        );
    }

    #[test]
    fn zed_is_started_as_an_app_or_through_its_cli() {
        for app in [
            "/Applications/Zed.app/Contents/MacOS/zed",
            "/home/u/.local/zed.app/libexec/zed-editor",
            r"C:\Users\u\AppData\Local\Programs\Zed\Zed.exe",
        ] {
            let path = PathBuf::from(app.replace('\\', "/"));
            assert!(zed_is_app_binary(&path), "{app}");
        }
        for cli in [
            "/Applications/Zed.app/Contents/MacOS/cli",
            "/Users/u/.local/bin/zed",
            "zed",
            "C:/Users/u/AppData/Local/Programs/Zed/bin/zed.exe",
        ] {
            assert!(!zed_is_app_binary(Path::new(cli)), "{cli}");
        }
    }

    #[test]
    fn zed_launch_tries_the_detected_launcher_first() {
        let dir = tempfile::tempdir().unwrap();
        let detected = dir.path().join("zed");
        std::fs::write(&detected, "").unwrap();
        let none = env_of(&[]);
        let order = zed_launch_candidates(HostOs::Linux, dir.path(), &none, Some(&detected));
        assert_eq!(order[0], detected);
        assert_eq!(order[1], PathBuf::from("zed"));
        // Install locations that do not exist are not tried.
        assert_eq!(order.len(), 2);
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "").unwrap();
    }

    #[test]
    fn macos_editors_are_found_through_their_app_bundles() {
        let root = tempfile::tempdir().unwrap();
        let apps = root.path().join("Applications");
        let home = root.path().join("home");
        touch(&apps.join("Visual Studio Code.app/Contents/Resources/app/bin/code"));
        touch(&apps.join("Xcode-beta.app/Contents/MacOS/Xcode"));
        touch(&apps.join("Xcode.app/Contents/MacOS/Xcode"));
        touch(&apps.join("PyCharm CE.app/Contents/MacOS/pycharm"));
        touch(&home.join("Applications/IntelliJ IDEA Ultimate.app/Contents/MacOS/idea"));
        let none = env_of(&[]);
        let found = |bin| {
            editor_launcher_candidates(bin, HostOs::Macos, &home, &apps, &none)
                .into_iter()
                .filter(|p| p.is_file())
                .collect::<Vec<_>>()
        };

        assert_eq!(
            found("code"),
            vec![apps.join("Visual Studio Code.app/Contents/Resources/app/bin/code")]
        );
        assert_eq!(
            found("xcode"),
            vec![
                apps.join("Xcode.app/Contents/MacOS/Xcode"),
                apps.join("Xcode-beta.app/Contents/MacOS/Xcode"),
            ]
        );
        // IntelliJ IDEA wins over other JetBrains IDEs wherever it is.
        assert_eq!(
            found("idea"),
            vec![
                home.join("Applications/IntelliJ IDEA Ultimate.app/Contents/MacOS/idea"),
                apps.join("PyCharm CE.app/Contents/MacOS/pycharm"),
            ]
        );
        assert!(found("zcode-unknown").is_empty());
    }

    #[test]
    fn windows_editors_are_found_in_their_install_folders() {
        let root = tempfile::tempdir().unwrap();
        let local = root.path().join("Local");
        let program_files = root.path().join("Program Files");
        touch(&program_files.join("Microsoft VS Code/Code.exe"));
        touch(&program_files.join("JetBrains/IntelliJ IDEA 2026.2/bin/idea64.exe"));
        touch(&local.join("Programs/PyCharm/bin/pycharm64.exe"));
        touch(&local.join("JetBrains/Toolbox/scripts/webstorm.cmd"));
        let env = env_of(&[
            ("LOCALAPPDATA", local.to_str().unwrap()),
            ("ProgramFiles", program_files.to_str().unwrap()),
        ]);
        let found = |bin| {
            editor_launcher_candidates(bin, HostOs::Windows, root.path(), root.path(), &env)
                .into_iter()
                .filter(|p| p.is_file())
                .collect::<Vec<_>>()
        };

        assert_eq!(
            found("code"),
            vec![program_files.join("Microsoft VS Code/Code.exe")]
        );
        assert_eq!(
            found("idea"),
            vec![
                local.join("JetBrains/Toolbox/scripts/webstorm.cmd"),
                program_files.join("JetBrains/IntelliJ IDEA 2026.2/bin/idea64.exe"),
                local.join("Programs/PyCharm/bin/pycharm64.exe"),
            ]
        );
        // Xcode does not exist off macOS.
        assert!(found("xcode").is_empty());
    }

    #[test]
    fn a_bare_launcher_name_resolves_to_its_cmd_script_on_path() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first");
        let second = root.path().join("second");
        touch(&second.join("code.cmd"));
        touch(&second.join("code"));
        let path = std::env::join_paths([&first, &second]).unwrap();
        assert_eq!(
            find_launcher_in_path("code", &path, &["exe", "cmd", "bat"]),
            Some(second.join("code.cmd"))
        );
        assert_eq!(find_launcher_in_path("idea", &path, &["exe", "cmd"]), None);
    }

    #[test]
    fn editor_launchers_start_the_right_way_on_each_os() {
        let program = |cmd: &std::process::Command| {
            std::iter::once(cmd.get_program())
                .chain(cmd.get_args())
                .map(|s| s.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        let script = Path::new("C:/Toolbox/scripts/idea.cmd");
        assert_eq!(
            program(&editor_command(HostOs::Windows, script)),
            vec!["cmd", "/C", "C:/Toolbox/scripts/idea.cmd"]
        );
        let exe = Path::new("C:/VS Code/Code.exe");
        assert_eq!(
            program(&editor_command(HostOs::Windows, exe)),
            vec!["C:/VS Code/Code.exe"]
        );
        let bundled =
            Path::new("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code");
        assert_eq!(
            program(&editor_command(HostOs::Macos, bundled)),
            vec!["open", "-a", "/Applications/Visual Studio Code.app"]
        );
        assert_eq!(
            program(&editor_command(HostOs::Macos, Path::new("code"))),
            vec!["code"]
        );
    }
}

#[cfg(test)]
mod factory_reset_tests {
    use super::{
        keep_guest_scope, put_backends_back, put_guest_scope, remove_jan_data_contents,
        set_backends_aside, GUEST_SCOPE_FILE,
    };
    use std::fs;

    #[test]
    fn a_reset_keeps_the_key_to_the_models_in_the_wsl_distribution() {
        // Change add-tensorrt-llm-windows: TensorRT-LLM models live in Atomic Chat's WSL
        // distribution under this scope's key; without the key they would stay on disk, unseen.
        let data = tempfile::tempdir().unwrap();
        let next = tempfile::tempdir().unwrap();
        let root = data.path();
        fs::create_dir_all(root.join("atomic-core/managed-runtimes")).unwrap();
        fs::write(root.join("atomic-core/credentials.json"), "{\"openai\":\"sk-secret\"}").unwrap();
        let key = "{\"schema_version\":1,\"scope_key\":\"0b9e\"}";
        fs::write(root.join(GUEST_SCOPE_FILE), key).unwrap();

        let kept = keep_guest_scope(root);
        remove_jan_data_contents(root);
        // The reset also points the app at the default data folder, which may be another one.
        put_guest_scope(next.path(), kept);

        assert_eq!(fs::read_to_string(next.path().join(GUEST_SCOPE_FILE)).unwrap(), key);
        assert!(!root.join("atomic-core/credentials.json").exists());
    }

    #[test]
    fn a_reset_without_a_wsl_distribution_writes_no_key() {
        let data = tempfile::tempdir().unwrap();
        let kept = keep_guest_scope(data.path());
        put_guest_scope(data.path(), kept);
        assert!(!data.path().join("atomic-core").exists());
    }

    #[test]
    fn a_reset_removes_the_cores_keys_and_keeps_both_providers_backends() {
        let data = tempfile::tempdir().unwrap();
        let aside = tempfile::tempdir().unwrap();
        let root = data.path();
        for dir in [
            "threads/t1",
            "atomic-core",
            "db",
            "llamacpp/backends/b1/macos-arm64",
            "llamacpp/models/m",
            "llamacpp-upstream/backends/b2/macos-arm64",
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        fs::write(root.join("atomic-core/credentials.json"), "{\"openai\":\"sk-secret\"}").unwrap();
        fs::write(root.join("atomic-chatgpt-auth.json"), "{\"refresh_token\":\"secret\"}").unwrap();
        fs::write(root.join("local-api-server.json"), "{}").unwrap();
        fs::write(root.join("llamacpp-upstream/backends/b2/macos-arm64/llama-server"), "bin").unwrap();
        fs::write(root.join("users-own-file.txt"), "not the app's to delete").unwrap();

        let preserved = set_backends_aside(root, aside.path());
        remove_jan_data_contents(root);
        put_backends_back(root, preserved);

        for gone in [
            "threads",
            "db",
            "atomic-core",
            "atomic-chatgpt-auth.json",
            "local-api-server.json",
            "llamacpp/models",
        ] {
            assert!(!root.join(gone).exists(), "{gone} survived the reset");
        }
        assert!(root.join("llamacpp/backends/b1/macos-arm64").is_dir());
        assert!(root.join("llamacpp-upstream/backends/b2/macos-arm64/llama-server").is_file());
        assert!(root.join("users-own-file.txt").is_file());
        assert_eq!(fs::read_dir(aside.path()).unwrap().count(), 0);
    }
}

#[cfg(test)]
mod integration_auth_tests {
    use super::*;

    #[test]
    fn zed_launch_paths_inherit_current_key_and_refuse_reusing_a_running_editor() {
        for cli in [true, false] {
            for key in [None, Some(""), Some("current-key"), Some("rotated'key")] {
                let command = zed_launch_command(Path::new("zed"), key, cli);
                let value = command
                    .get_envs()
                    .find(|(name, _)| *name == "ATOMIC_CHAT_API_KEY")
                    .unwrap()
                    .1
                    .unwrap();
                assert_eq!(value, key.filter(|key| !key.is_empty()).unwrap_or("atomic"));
                assert_eq!(command.get_args().count(), usize::from(cli));
            }
        }
        assert!(ensure_zed_stopped(false).is_ok());
        assert!(ensure_zed_stopped(true).unwrap_err().contains("Quit Zed"));
    }
}

#[cfg(test)]
mod hermes_config_tests {
    use super::*;

    const URL: &str = "http://127.0.0.1:1337/v1";
    const MODEL: &str = "unsloth/Qwen3_5-4B-GGUF-Qwen3_5-4B-IQ4_XS";
    const PROVIDER: &str = "custom";

    /// The head of Hermes' shipped `cli-config.yaml.example` (v0.22.6), which
    /// its installer copies in.
    const UPSTREAM_EXAMPLE: &str = r##"# Hermes Agent CLI Configuration
_config_version: 52

database:
  journal_mode: "wal"  # Supported values: "wal", "delete"

plugins:
  clone_timeout_seconds: 300

model:
  # Default model to use (can be overridden with --model flag)
  default: "anthropic/claude-opus-4.6"

  # Inference provider selection:
  #   "custom"       - Any other OpenAI-compatible endpoint. Set base_url below.
  provider: "auto"

  # api_key: "your-key-here"  # Uncomment to set here instead of .env
  base_url: "https://openrouter.ai/api/v1"

  # Azure Foundry keyless auth example:
  # provider: "azure-foundry"
  # default: "gpt-4o"          # Deployment/model name
# providers:
#   my-proxy:
#     base_url: "https://llm.internal.example.com/v1"

compression:
  enabled: true
"##;

    /// Hermes reads config.yaml with ruamel, which rejects duplicate keys;
    /// serde_yaml does the same.
    fn hermes_view(text: &str) -> serde_yaml::Value {
        serde_yaml::from_str(text).unwrap_or_else(|e| panic!("unreadable config ({e}):\n{text}"))
    }

    fn patch(content: &str) -> String {
        patch_hermes_model_section(
            content,
            &[
                ("default", MODEL.to_string()),
                ("provider", PROVIDER.to_string()),
                ("base_url", URL.to_string()),
            ],
        )
    }

    fn ours(indent: &str) -> String {
        format!("{indent}default: {MODEL}\n{indent}provider: {PROVIDER}\n{indent}base_url: {URL}\n")
    }

    #[test]
    fn hermes_view_rejects_duplicate_keys_like_hermes() {
        assert!(serde_yaml::from_str::<serde_yaml::Value>("a: 1\na: 2\n").is_err());
    }

    #[test]
    fn hermes_patch_keeps_the_upstream_example_byte_for_byte_but_the_route() {
        let expected = UPSTREAM_EXAMPLE
            .replace(
                "  default: \"anthropic/claude-opus-4.6\"",
                &format!("  default: {MODEL}"),
            )
            .replace("  provider: \"auto\"", &format!("  provider: {PROVIDER}"))
            .replace(
                "  base_url: \"https://openrouter.ai/api/v1\"",
                &format!("  base_url: {URL}"),
            );
        assert_eq!(patch(UPSTREAM_EXAMPLE), expected);
    }

    #[test]
    fn hermes_patch_leaves_the_same_keys_alone_in_every_other_block() {
        // The old first-match patch rewrote auxiliary and moa here (breaking
        // the YAML) and left model on an empty default and provider auto:
        // either way Hermes sent an empty model to OpenRouter.
        let before = "auxiliary:\n  vision:\n    provider: auto\n    model: \"\"\n    base_url: \"\"\n\
                      cron:\n  provider: \"\"\n\
                      moa:\n  presets:\n    default:\n      aggregator: {provider: openrouter, model: x}\n";
        let after =
            "delegation:\n  provider: openrouter\n  base_url: https://openrouter.ai/api/v1\n";
        let out = patch(&format!(
            "{before}model:\n  default: \"\"\n  provider: auto\n  base_url: \"\"\n{after}"
        ));
        assert_eq!(out, format!("{before}model:\n{}{after}", ours("  ")));
    }

    #[test]
    fn hermes_patch_turns_a_scalar_model_into_a_block() {
        for scalar in [
            "anthropic/claude-opus-4.6",
            "\"\"",
            "{}",
            "'' # picked by setup",
        ] {
            let out = patch(&format!(
                "model: {scalar}\ndelegation:\n  provider: openrouter\n"
            ));
            assert_eq!(
                out,
                format!(
                    "model:\n{}delegation:\n  provider: openrouter\n",
                    ours("  ")
                ),
                "{scalar}"
            );
        }
    }

    #[test]
    fn hermes_patch_appends_a_model_section_to_a_config_without_one() {
        let out = patch("_config_version: 52\ntts:\n  provider: edge\n\n");
        assert_eq!(
            out,
            format!(
                "_config_version: 52\ntts:\n  provider: edge\nmodel:\n{}",
                ours("  ")
            )
        );
    }

    #[test]
    fn hermes_patch_adds_missing_keys_at_the_block_indent_and_drops_a_nested_default() {
        let out = patch(
            "model:\n    # picked in the wizard\n    default:\n      model: old\n      provider: openrouter\n    \
             api_mode: chat_completions\n    model: alias\n",
        );
        assert_eq!(
            out,
            format!(
                "model:\n    provider: {PROVIDER}\n    base_url: {URL}\n    # picked in the wizard\n    \
                 default: {MODEL}\n    api_mode: chat_completions\n    model: alias\n"
            )
        );
        // `default` wins over the `model` alias in Hermes, so the stale alias
        // is harmless.
        let view = hermes_view(&out);
        assert_eq!(view["model"]["default"].as_str(), Some(MODEL));
        assert_eq!(view["model"]["provider"].as_str(), Some(PROVIDER));
        assert_eq!(view["model"]["base_url"].as_str(), Some(URL));
    }

    #[test]
    fn hermes_patch_fills_an_empty_model_block() {
        assert_eq!(
            patch("model:\nother: 1\n"),
            format!("model:\n{}other: 1\n", ours("  "))
        );
    }

    #[test]
    fn hermes_custom_providers_are_found_behind_a_trailing_comment() {
        for line in [
            "custom_providers: []",
            "custom_providers:[]",
            "  custom_providers: []",
            "custom_providers: []  # bridges",
        ] {
            let (before, entries, _) = split_custom_providers(&format!("a: 1\n{line}\nb: 2\n"));
            assert!(entries.is_empty(), "{line}");
            assert_eq!(before, vec!["a: 1"], "{line}");
        }
        let (_, entries, after) =
            split_custom_providers("custom_providers:  # bridges\n- name: one\ntools: {}\n");
        assert_eq!(entries, vec![vec!["- name: one"]]);
        assert_eq!(after, vec!["tools: {}"]);
    }

    #[test]
    fn hermes_inline_custom_providers_are_left_alone_rather_than_duplicated() {
        let inline = "custom_providers: [{name: bridge, base_url: \"http://localhost:9000\"}]\n";
        assert_eq!(
            upsert_atomic_provider(inline, "http://u", "m", 64, "\"atomic\""),
            (inline.to_string(), false)
        );
        assert_eq!(remove_atomic_provider(inline), inline);
    }

    #[test]
    fn hermes_removing_our_entry_from_a_file_without_one_changes_nothing() {
        for text in ["a: 1\n", "custom_providers:\n- name: keep\n", ""] {
            assert_eq!(remove_atomic_provider(text), text);
        }
    }

    #[test]
    fn hermes_provider_timeout_rewrites_an_empty_inline_map_into_a_block() {
        let (out, created) =
            upsert_provider_request_timeout("a: 1\nproviders: {}\nb: 2\n", "custom", 180);
        assert_eq!(
            out,
            "a: 1\nproviders:\n  custom:\n    request_timeout_seconds: 180\nb: 2\n"
        );
        assert_eq!(
            remove_provider_request_timeout(&out, "custom", 180, &created),
            "a: 1\nproviders: {}\nb: 2\n"
        );
    }

    #[test]
    fn hermes_provider_timeout_never_adds_a_second_providers_key() {
        let seed = "providers:  # named endpoints\n  x: {}\n";
        let (out, created) = upsert_provider_request_timeout(seed, "custom", 180);
        assert_eq!(
            out,
            "providers:  # named endpoints\n  custom:\n    request_timeout_seconds: 180\n  x: {}\n"
        );
        assert_eq!(
            remove_provider_request_timeout(&out, "custom", 180, &created),
            seed
        );
        let inline = "providers: {openai: {request_timeout_seconds: 60}}\n";
        assert_eq!(
            upsert_provider_request_timeout(inline, "custom", 180),
            (inline.to_string(), vec![])
        );
    }

    #[test]
    fn hermes_provider_timeout_removal_keeps_what_the_user_owns() {
        // A timeout the user set is never recorded as ours.
        let seed = "providers:\n  custom:\n    request_timeout_seconds: 60\n";
        let (out, created) = upsert_provider_request_timeout(seed, "custom", 180);
        assert_eq!((out.as_str(), created.len()), (seed, 0));
        // Ours, retuned by the user after Connect, stays theirs.
        let (_, created) = upsert_provider_request_timeout("", "custom", 180);
        let tuned = "providers:\n  custom:\n    request_timeout_seconds: 900\n";
        assert_eq!(
            remove_provider_request_timeout(tuned, "custom", 180, &created),
            tuned
        );
    }

    fn connect(dir: &Path, key: Option<&str>, ctx: Option<u32>) -> String {
        configure_hermes_at(dir, URL.into(), MODEL.into(), key.map(str::to_string), ctx).unwrap();
        fs::read_to_string(dir.join("config.yaml")).unwrap()
    }

    #[test]
    fn hermes_connect_patches_only_the_top_level_model_block() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.yaml");
        fs::write(
            &config,
            "model:\n  default: old\n  provider: auto\n  base_url: https://x\n\
             other:\n  default: untouched\ncustom_providers: []\n",
        )
        .unwrap();
        configure_hermes_at(dir.path(), URL.into(), "m".into(), None, None).unwrap();
        let out = fs::read_to_string(&config).unwrap();
        assert!(out.contains("  default: m\n"), "{out}");
        assert!(out.contains("  default: untouched\n"), "{out}");
    }

    #[test]
    fn hermes_connect_routes_to_the_local_endpoint_from_every_shape_idempotently() {
        let shapes = [
            UPSTREAM_EXAMPLE,
            // A model: block after other blocks with the same keys.
            "auxiliary:\n  vision:\n    provider: auto\n    base_url: \"\"\ndelegation:\n  default: fast\n\
             \x20 provider: openrouter\nmodel:\n  default: \"\"\n  provider: auto\n",
            "model: anthropic/claude-opus-4.6\ncron:\n  provider: \"\"\n",
            "_config_version: 52\nmemory:\n  provider: \"\"\n",
            "model:  # main chat\n  default: x\ncustom_providers: []  # none\n\
             providers:  # named\n  x:\n    base_url: http://x\n",
            "",
        ];
        for seed in shapes {
            let dir = tempfile::tempdir().unwrap();
            fs::write(dir.path().join("config.yaml"), seed).unwrap();

            let first = connect(dir.path(), Some("sk-test"), Some(32768));
            let view = hermes_view(&first);
            assert_eq!(view["model"]["default"].as_str(), Some(MODEL), "{first}");
            assert_eq!(
                view["model"]["provider"].as_str(),
                Some("custom"),
                "{first}"
            );
            assert_eq!(view["model"]["base_url"].as_str(), Some(URL), "{first}");
            assert_eq!(
                view["model"]["api_key"].as_str(),
                Some("sk-test"),
                "{first}"
            );
            assert_eq!(view["model"]["context_length"].as_u64(), Some(32768));
            let entries = view["custom_providers"].as_sequence().unwrap();
            assert_eq!(entries.len(), 1, "{first}");
            assert_eq!(entries[0]["name"].as_str(), Some(ATOMIC_PROVIDER_NAME));
            assert_eq!(entries[0]["base_url"].as_str(), Some(URL));
            assert_eq!(entries[0]["api_key"].as_str(), Some("sk-test"));
            assert_eq!(entries[0]["model"].as_str(), Some(MODEL));
            assert_eq!(
                entries[0]["models"][MODEL]["context_length"].as_u64(),
                Some(32768)
            );
            assert_eq!(
                view["providers"]["custom"]["request_timeout_seconds"].as_u64(),
                Some(180),
                "{first}"
            );

            assert_eq!(connect(dir.path(), Some("sk-test"), Some(32768)), first);
        }
    }

    /// Hermes cannot run below a 64K window, so an unknown one is written as
    /// that floor; a known one is written as served (Connect guarantees the
    /// floor), never raised to it.
    #[test]
    fn hermes_writes_the_served_window_and_the_floor_only_when_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let view = hermes_view(&connect(dir.path(), None, None));
        assert_eq!(view["model"]["context_length"].as_u64(), Some(65536));
        let view = hermes_view(&connect(dir.path(), None, Some(131072)));
        assert_eq!(view["model"]["context_length"].as_u64(), Some(131072));
        assert_eq!(view["model"]["api_key"].as_str(), Some("atomic"));
    }

    /// The route lives in the `model:` section alone, so it works when the
    /// user keeps their bridges in an inline list we cannot add an entry to.
    #[test]
    fn hermes_route_does_not_depend_on_our_entry() {
        let dir = tempfile::tempdir().unwrap();
        let inline = "custom_providers: [{name: bridge, base_url: \"http://localhost:9000\"}]\n";
        fs::write(dir.path().join("config.yaml"), inline).unwrap();
        let out = connect(dir.path(), Some("sk-test"), None);
        let view = hermes_view(&out);
        assert_eq!(view["model"]["provider"].as_str(), Some("custom"));
        assert_eq!(view["model"]["api_key"].as_str(), Some("sk-test"));
        assert_eq!(view["custom_providers"].as_sequence().unwrap().len(), 1);
    }

    #[test]
    fn hermes_rotates_the_key_without_touching_other_entries() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("config.yaml"),
            "custom_providers:\n- name: personal\n  base_url: https://example.com/v1\n  api_key: personal-key\n",
        )
        .unwrap();
        for key in [Some("first'key#quoted"), Some("rotated"), None, Some("")] {
            let doc = hermes_view(&connect(dir.path(), key, None));
            let expected = key.filter(|k| !k.is_empty()).unwrap_or("atomic");
            assert_eq!(doc["model"]["api_key"].as_str(), Some(expected));
            let providers = doc["custom_providers"].as_sequence().unwrap();
            assert_eq!(providers.len(), 2);
            assert_eq!(providers[0]["api_key"].as_str(), Some("personal-key"));
            assert_eq!(providers[1]["api_key"].as_str(), Some(expected));
        }
    }

    /// Disconnect returns the file to what it was, whatever shape the route had
    /// — not to an OpenRouter default — and however many times Connect ran.
    #[test]
    fn hermes_disconnect_restores_the_file_connect_found() {
        let shapes = [
            UPSTREAM_EXAMPLE,
            "auxiliary:\n  vision:\n    provider: auto\n    base_url: \"\"\n\
             model:\n  default: anthropic/claude-opus-4.6\n  provider: auto\n  \
             base_url: https://openrouter.ai/api/v1\n  api_key: sk-or-mine  # personal\n\
             custom_providers:\n- name: personal\n  base_url: https://example.com/v1\n\
             delegation:\n  provider: openrouter\n",
            "model: anthropic/claude-opus-4.6\ncron:\n  provider: \"\"\n",
            "_config_version: 52\nmemory:\n  provider: \"\"\n",
            "model:\n  default:\n    nested: value\n  provider: nous\nproviders: {}\n",
            "providers:\n  custom:\n    api_mode: chat\ncustom_providers: []\n",
            "",
        ];
        for seed in shapes {
            let dir = tempfile::tempdir().unwrap();
            let config = dir.path().join("config.yaml");
            fs::write(&config, seed).unwrap();
            connect(dir.path(), Some("sk-test"), Some(65536));
            connect(dir.path(), None, Some(131072));
            disconnect_hermes_at(dir.path()).unwrap();
            assert_eq!(fs::read_to_string(&config).unwrap(), seed, "{seed}");
            assert!(!json_key_backup::backup_path(&config).exists());
        }
    }

    #[test]
    fn hermes_disconnect_leaves_what_the_user_changed_after_connect() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.yaml");
        fs::write(
            &config,
            "model:\n  default: old\n  provider: openrouter\n  base_url: https://openrouter.ai/api/v1\n",
        )
        .unwrap();
        let connected = connect(dir.path(), None, None);
        // `hermes model` picked another model on our endpoint.
        fs::write(
            &config,
            connected.replace(&format!("  default: {MODEL}"), "  default: other-model"),
        )
        .unwrap();
        disconnect_hermes_at(dir.path()).unwrap();
        let out = fs::read_to_string(&config).unwrap();
        assert!(out.contains("  default: other-model\n"), "{out}");
        assert!(out.contains("  provider: openrouter\n"), "{out}");
        assert!(!out.contains("atomic-chat"), "{out}");
    }

    #[test]
    fn hermes_disconnect_of_an_older_connection_drops_our_route() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.yaml");
        fs::write(
            &config,
            "model:\n  default: m\n  provider: custom:atomic-chat\n  base_url: http://127.0.0.1:1337/v1\n  \
             streaming: false\ncustom_providers:\n- name: personal\n  base_url: https://example.com/v1\n\
             - name: atomic-chat\n  base_url: http://127.0.0.1:1337/v1\n  model: m\n",
        )
        .unwrap();
        disconnect_hermes_at(dir.path()).unwrap();
        assert_eq!(
            fs::read_to_string(&config).unwrap(),
            "model:\n  streaming: false\ncustom_providers:\n- name: personal\n  base_url: https://example.com/v1\n"
        );
        // Nothing of ours, nothing to do.
        let untouched = "model:\n  default: x\n  provider: openrouter\n";
        fs::write(&config, untouched).unwrap();
        disconnect_hermes_at(dir.path()).unwrap();
        assert_eq!(fs::read_to_string(&config).unwrap(), untouched);
        // No config at all.
        let empty = tempfile::tempdir().unwrap();
        disconnect_hermes_at(empty.path()).unwrap();
        assert!(!empty.path().join("config.yaml").exists());
    }

    #[test]
    fn hermes_disconnect_removes_only_the_no_proxy_lines_connect_added() {
        let dir = tempfile::tempdir().unwrap();
        let env = dir.path().join(".env");
        fs::write(&env, "OPENROUTER_API_KEY=x\n").unwrap();
        connect(dir.path(), None, None);
        assert!(fs::read_to_string(&env).unwrap().contains("NO_PROXY="));
        disconnect_hermes_at(dir.path()).unwrap();
        assert_eq!(fs::read_to_string(&env).unwrap(), "OPENROUTER_API_KEY=x\n");

        // A NO_PROXY the user set is theirs.
        let own = "NO_PROXY=corp.example\n";
        fs::write(&env, own).unwrap();
        connect(dir.path(), None, None);
        disconnect_hermes_at(dir.path()).unwrap();
        assert_eq!(fs::read_to_string(&env).unwrap(), own);
    }

    #[test]
    fn hermes_home_expands_like_hermes() {
        let home = Path::new("/Users/tester");
        let var = |name: &str| match name {
            "DATA" => Some("/srv/data".to_string()),
            "LOCALAPPDATA" => Some("C:\\Users\\t\\AppData\\Local".to_string()),
            _ => None,
        };
        assert_eq!(expand_hermes_home("~", &var, home), home);
        assert_eq!(
            expand_hermes_home("~/hermes-x", &var, home),
            home.join("hermes-x")
        );
        assert_eq!(
            expand_hermes_home("$DATA/hermes", &var, home),
            PathBuf::from("/srv/data/hermes")
        );
        assert_eq!(
            expand_hermes_home("${DATA}/h", &var, home),
            PathBuf::from("/srv/data/h")
        );
        assert_eq!(
            expand_hermes_home("%LOCALAPPDATA%\\hermes", &var, home),
            PathBuf::from("C:\\Users\\t\\AppData\\Local\\hermes")
        );
        // An unset variable stays as written, as in Python's expandvars.
        assert_eq!(
            expand_hermes_home("$UNSET/x%NOPE%", &var, home),
            PathBuf::from("$UNSET/x%NOPE%")
        );
    }

    #[test]
    fn hermes_writes_to_the_profile_hermes_runs() {
        let root = tempfile::tempdir().unwrap();
        let native = root.path().join(".hermes");
        fs::create_dir_all(native.join("profiles").join("work")).unwrap();
        assert_eq!(hermes_config_dir(&native, None), native);

        // `hermes profile use work` is sticky for every `hermes` without -p.
        fs::write(native.join("active_profile"), "work\n").unwrap();
        assert_eq!(
            hermes_config_dir(&native, None),
            native.join("profiles").join("work")
        );
        // A profile that no longer exists is not written into being.
        fs::write(native.join("active_profile"), "gone\n").unwrap();
        assert_eq!(hermes_config_dir(&native, None), native);
        fs::write(native.join("active_profile"), "default\n").unwrap();
        assert_eq!(hermes_config_dir(&native, None), native);

        // HERMES_HOME naming a profile is that profile.
        let pinned = native.join("profiles").join("coder");
        assert_eq!(hermes_config_dir(&native, Some(pinned.clone())), pinned);

        // A custom root keeps its own profiles and sticky profile.
        let custom = root.path().join("opt-data");
        fs::create_dir_all(custom.join("profiles").join("ops")).unwrap();
        assert_eq!(hermes_config_dir(&native, Some(custom.clone())), custom);
        fs::write(custom.join("active_profile"), "ops").unwrap();
        assert_eq!(
            hermes_config_dir(&native, Some(custom.clone())),
            custom.join("profiles").join("ops")
        );
    }
}

/// OpenHands, Poolside and Muse Code get their environment at launch only;
/// Connect and Disconnect remove what older releases persisted, and nothing
/// the user wrote.
#[cfg(test)]
mod legacy_env_agent_tests {
    use super::*;

    const OLD_POOLSIDE: &str = "# Atomic Chat - Poolside Config\n\
        export POOLSIDE_STANDALONE_BASE_URL='http://127.0.0.1:1337'\n\
        export POOLSIDE_API_KEY='atomic'\n\
        export POOLSIDE_STANDALONE_MODEL='qwen'\n\
        \n\
        # Atomic Chat - Poolside Config\n";

    #[test]
    fn only_the_marked_block_goes() {
        let user = "export PATH=\"$HOME/bin:$PATH\"\nexport POOLSIDE_API_KEY='my-cloud-key'\n";
        let rc = format!("{user}{OLD_POOLSIDE}export META_API_KEY='meta-real'\n");
        assert_eq!(
            remove_marked_env_block(&rc, "# Atomic Chat - Poolside Config"),
            format!("{user}export META_API_KEY='meta-real'\n")
        );
        // Another agent's block and a file without ours are left alone.
        assert_eq!(
            remove_marked_env_block(&rc, "# Atomic Chat - Muse Code Config"),
            rc
        );
    }

    #[test]
    fn every_rc_file_an_older_release_may_have_used_is_cleaned() {
        let home = tempfile::tempdir().unwrap();
        for name in [".zshenv", ".bash_profile", ".bashrc"] {
            fs::write(home.path().join(name), format!("# mine\n{OLD_POOLSIDE}")).unwrap();
        }
        let agent = legacy_env_agent("poolside").unwrap();
        remove_legacy_env_blocks(home.path(), &agent).unwrap();
        for name in [".zshenv", ".bash_profile", ".bashrc"] {
            assert_eq!(
                fs::read_to_string(home.path().join(name)).unwrap(),
                "# mine\n"
            );
        }
        // Missing files are not created.
        let empty = tempfile::tempdir().unwrap();
        remove_legacy_env_blocks(empty.path(), &agent).unwrap();
        assert_eq!(fs::read_dir(empty.path()).unwrap().count(), 0);
    }

    /// On Windows `setx` left plain user variables: they are ours only when
    /// the key is our placeholder or this server's key, or the endpoint is
    /// this server's.
    #[test]
    fn user_variables_are_ours_only_when_recognisably_so() {
        let agent = legacy_env_agent("openhands").unwrap();
        let values = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == name)
                    .map(|(_, v)| v.to_string())
            }
        };
        let url = Some("http://127.0.0.1:1337/v1");
        let placeholder = values(&[("LLM_API_KEY", "atomic"), ("LLM_BASE_URL", "http://h:1/v1")]);
        assert!(legacy_env_values_are_ours(&agent, &placeholder, None, None));
        let server_key = values(&[
            ("LLM_API_KEY", "sk-server"),
            ("LLM_BASE_URL", "http://h:1/v1"),
        ]);
        assert!(legacy_env_values_are_ours(
            &agent,
            &server_key,
            Some("sk-server"),
            url
        ));
        assert!(!legacy_env_values_are_ours(&agent, &server_key, None, None));
        let same_url = values(&[
            ("LLM_API_KEY", "x"),
            ("LLM_BASE_URL", "http://127.0.0.1:1337/v1/"),
        ]);
        assert!(legacy_env_values_are_ours(
            &agent,
            &same_url,
            Some("sk"),
            url
        ));
        // The user's own local setup on another server.
        let own = values(&[
            ("LLM_API_KEY", "ollama"),
            ("LLM_BASE_URL", "http://localhost:11434/v1"),
        ]);
        assert!(!legacy_env_values_are_ours(&agent, &own, Some("sk"), url));

        // Older Poolside setups stored the endpoint without `/v1`.
        let pool = legacy_env_agent("poolside").unwrap();
        let old = values(&[
            ("POOLSIDE_API_KEY", "x"),
            ("POOLSIDE_STANDALONE_BASE_URL", "http://127.0.0.1:1337"),
        ]);
        assert!(legacy_env_values_are_ours(&pool, &old, None, url));

        let muse = legacy_env_agent("muse").unwrap();
        let meta = values(&[("META_API_KEY", "meta-real")]);
        assert!(!legacy_env_values_are_ours(&muse, &meta, Some("sk"), url));
        assert!(legacy_env_agent("goose").is_none());
    }
}

/// The golden agent-config fixtures atomic-chat-core replays against its own
/// writers (`test/contract/agent-config.test.ts`), replayed against these: the
/// desktop and the `atomic-chat launch` CLI must leave the same bytes behind,
/// backups included.
#[cfg(test)]
mod agent_config_fixture_tests {
    use super::*;

    fn tree(dir: &Path) -> std::collections::BTreeMap<String, String> {
        let mut out = std::collections::BTreeMap::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(current) = stack.pop() {
            for entry in fs::read_dir(&current).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    let rel = path
                        .strip_prefix(dir)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/");
                    out.insert(rel, fs::read_to_string(&path).unwrap());
                }
            }
        }
        out
    }

    fn run(home: &Path, agent: &str, run: &serde_json::Value) -> Result<(), String> {
        let url = run["api_url"].as_str().unwrap();
        let model = run["model"].as_str().unwrap();
        let key = run["api_key"].as_str();
        match agent {
            "hermes" => configure_hermes_at(
                &home.join(".hermes"),
                url.into(),
                model.into(),
                key.map(str::to_string),
                None,
            ),
            "openclaw" => configure_openclaw_at(
                &home.join(".openclaw").join("openclaw.json"),
                url,
                model,
                key,
                None,
                false,
            ),
            "atomic-agent" => {
                configure_atomic_agent_at(&home.join(".atomic-agent"), url, model, key, None)
            }
            _ => remove_legacy_env_blocks(home, &legacy_env_agent(agent).unwrap()),
        }
    }

    #[test]
    fn rust_writers_leave_what_the_core_writers_leave() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/core-contracts/agent-config");
        let mut replayed = 0;
        let mut mismatches = Vec::new();
        for entry in fs::read_dir(&root).unwrap().flatten() {
            let fixture: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(entry.path()).unwrap()).unwrap();
            let agent = fixture["input"]["agent"].as_str().unwrap_or_default();
            if ![
                "hermes",
                "openclaw",
                "atomic-agent",
                "openhands",
                "poolside",
                "muse",
            ]
            .contains(&agent)
            {
                continue;
            }
            let home = tempfile::tempdir().unwrap();
            for (path, text) in fixture["input"]["seed_files"].as_object().unwrap() {
                let target = home.path().join(path);
                fs::create_dir_all(target.parent().unwrap()).unwrap();
                fs::write(target, text.as_str().unwrap()).unwrap();
            }
            for prior in fixture["input"]["prior_runs"]
                .as_array()
                .cloned()
                .unwrap_or_default()
            {
                run(home.path(), agent, &prior).unwrap();
            }
            let ok = run(home.path(), agent, &fixture["input"]).is_ok();
            let expected: std::collections::BTreeMap<String, String> = fixture["expected"]["files"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
                .collect();
            let name = fixture["name"].as_str().unwrap();
            if ok != fixture["expected"]["ok"].as_bool().unwrap() || tree(home.path()) != expected {
                mismatches.push(format!(
                    "{name}:\n{:#?}\n--- expected ---\n{:#?}",
                    tree(home.path()),
                    expected
                ));
            }
            replayed += 1;
        }
        assert_eq!(replayed, 45);
        assert!(mismatches.is_empty(), "{}", mismatches.join("\n====\n"));
    }
}
