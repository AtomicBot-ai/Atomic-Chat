use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

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
    configure_hermes_at(
        &resolve_hermes_dir()?,
        api_url,
        model,
        api_key,
        context_length,
    )
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
    // Windows) no config.yaml exists yet. Seed a default skeleton instead of
    // failing outright.
    if !config_path.exists() {
        std::fs::create_dir_all(hermes_dir)
            .map_err(|e| format!("Failed to create Hermes home directory: {}", e))?;
        std::fs::write(&config_path, HERMES_DEFAULT_CONFIG)
            .map_err(|e| format!("Failed to create config.yaml: {}", e))?;
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config.yaml: {}", e))?;

    // --- Patch the top-level model section only ---
    // `custom:atomic-chat` selects our named entry below, which carries the key.
    let after_model_patch =
        patch_hermes_model_section(&content, &model, "custom:atomic-chat", &api_url);

    // --- Upsert only our entry in custom_providers (preserves user's other providers) ---
    // Hermes Agent rejects any model whose context window is below 64K, so the
    // fallback must satisfy that floor too (the UI passes 65536 explicitly).
    let ctx = context_length.unwrap_or(65536);
    let after_cp = upsert_atomic_provider(
        &after_model_patch,
        &api_url,
        &model,
        ctx,
        api_key.as_deref(),
    );

    // Seed a per-request timeout for the underlying `custom` transport.
    // Hermes reads `providers.<id>.request_timeout_seconds`
    // (run_agent.py::get_provider_request_timeout); without it the legacy
    // 1800s default applies. Any value the user already set is preserved.
    let after_timeout =
        upsert_provider_request_timeout(&after_cp, "custom", HERMES_REQUEST_TIMEOUT_SECONDS);

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
            let separator = if env_content.ends_with('\n') {
                ""
            } else {
                "\n"
            };
            let patched = format!(
                "{}{}\n{}\n{}",
                env_content, separator, no_proxy_line, no_proxy_lower
            );
            std::fs::write(&env_path, patched)
                .map_err(|e| format!("Failed to write .env: {}", e))?;
        }
    }

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
    clear_hermes_at(&resolve_hermes_dir()?)
}

fn clear_hermes_at(hermes_dir: &Path) -> Result<(), String> {
    let config_path = hermes_dir.join("config.yaml");

    if !config_path.exists() {
        return Ok(());
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config.yaml: {}", e))?;

    // Restore the defaults in the top-level model section only, as Connect
    // never writes anywhere else.
    let after_model_patch = patch_hermes_model_section(
        &content,
        "anthropic/claude-opus-4.6",
        "auto",
        "https://openrouter.ai/api/v1",
    );

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
        std::fs::write(&env_path, cleaned).map_err(|e| format!("Failed to write .env: {}", e))?;
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
fn patch_hermes_model_section(
    content: &str,
    model: &str,
    provider: &str,
    base_url: &str,
) -> String {
    let mut lines: Vec<String> = content.lines().map(str::to_string).collect();
    let wanted = [
        ("default", model),
        ("provider", provider),
        ("base_url", base_url),
    ];
    let block = |indent: &str| -> Vec<String> {
        wanted
            .iter()
            .map(|(key, value)| format!("{}{}: {}", indent, key, value))
            .collect()
    };

    let header = lines
        .iter()
        .enumerate()
        .find_map(|(i, line)| match top_level_yaml_key(line) {
            Some(("model", value)) => Some((i, !value.is_empty())),
            _ => None,
        });
    let Some((header_idx, is_scalar)) = header else {
        while lines.last().is_some_and(|l| l.trim().is_empty()) {
            lines.pop();
        }
        lines.push("model:".to_string());
        lines.extend(block("  "));
        return with_trailing_newline(lines.join("\n"));
    };

    // The section runs to the next column-0 key; comments and blank lines in
    // it are kept.
    let end = (header_idx + 1..lines.len())
        .find(|&i| is_top_level_yaml_key(&lines[i]))
        .unwrap_or(lines.len());

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

/// Minimal Hermes `config.yaml` skeleton seeded when none exists yet.
///
/// The installer is spawned with `-SkipSetup`/`--skip-setup`, which skips the
/// interactive wizard that would otherwise create `~/.hermes/config.yaml`. On
/// Windows the install script writes no config at all, so `configure_*` had
/// nothing to patch. This skeleton mirrors the `model:` block of Hermes' own
/// `cli-config.yaml.example`, which the macOS/Linux installer copies in
/// instead; `configure_hermes_agent` then rewrites it to point at the local
/// server. Values mirror the Hermes defaults restored by
/// `clear_hermes_agent_config`.
const HERMES_DEFAULT_CONFIG: &str = "model:
  default: anthropic/claude-opus-4.6
  provider: auto
  base_url: https://openrouter.ai/api/v1
custom_providers: []
";

/// Resolve the Hermes Agent home directory, mirroring the resolution order of
/// Hermes' own `hermes_constants.py::get_hermes_home()`: an explicit
/// `HERMES_HOME` env var wins, else the platform-native default
/// (`%LOCALAPPDATA%\hermes` on Windows, `~/.hermes` elsewhere).
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
    if cfg!(windows) {
        if let Some(home) = read_windows_user_env("HERMES_HOME").filter(|s| !s.is_empty()) {
            return Ok(std::path::PathBuf::from(home));
        }
        if let Ok(home) = std::env::var("HERMES_HOME") {
            if !home.is_empty() {
                return Ok(std::path::PathBuf::from(home));
            }
        }
        let local_appdata = std::env::var("LOCALAPPDATA").map_err(|e| e.to_string())?;
        Ok(std::path::PathBuf::from(local_appdata).join("hermes"))
    } else {
        let home_dir = std::env::var("HOME").map_err(|e| e.to_string())?;
        Ok(std::path::PathBuf::from(home_dir).join(".hermes"))
    }
}

/// Read a single User-scope Windows environment variable fresh from the
/// registry (`HKCU\Environment`), bypassing the current process's stale
/// environment-block snapshot. Returns `None` off Windows, on read failure,
/// or when the value is empty/absent.
#[cfg(windows)]
fn read_windows_user_env(name: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-Command",
        &format!("[Environment]::GetEnvironmentVariable('{}', 'User')", name),
    ]);
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
/// leaving all other user entries (Telegram, WhatsApp, etc.) intact.
fn upsert_atomic_provider(
    content: &str,
    api_url: &str,
    model: &str,
    context_length: u32,
    api_key: Option<&str>,
) -> String {
    if has_inline_custom_providers(content) {
        return with_trailing_newline(content.to_string());
    }

    let (before, mut entries, after) = split_custom_providers(content);

    entries.retain(|e| !entry_is_ours(e));

    entries.push(vec![
        format!("- name: {}", ATOMIC_PROVIDER_NAME),
        format!("  base_url: {}", api_url),
        // JSON strings are valid YAML scalars, including quotes and newlines.
        format!(
            "  api_key: {}",
            serde_json::json!(api_key.filter(|key| !key.is_empty()).unwrap_or("atomic"))
        ),
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
    if has_inline_custom_providers(content) {
        return with_trailing_newline(content.to_string());
    }

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
        }
        // Hermes' YAML loader rejects a duplicate key and then runs on its
        // defaults: an inline map we cannot edit line by line is left as it
        // is rather than shadowed by a second `providers:`.
        Some((_, value)) if !value.is_empty() && value != "{}" => {}
        Some((pidx, value)) => {
            if !value.is_empty() {
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
            let prov_idx = (pidx + 1..block_end).find(|&i| lines[i].trim_end() == prov_key_line);

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
                        lines[i]
                            .trim_start()
                            .starts_with("request_timeout_seconds:")
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
///   - Claude Code / Codex / OpenCode / OpenClaw ship as global npm packages.
///   - Hermes is a Python project installed via its official shell / PowerShell
///     bootstrap script (NOT npm).
///
/// Unix installers that pipe `curl` into a shell use Bash `pipefail`; otherwise
/// a download failure is hidden by the trailing shell's successful empty input.
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
            Ok((
                p,
                a,
                "npm",
                "https://docs.anthropic.com/en/docs/claude-code",
            ))
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
                    vec![
                        "-NoProfile".to_string(),
                        "-Command".to_string(),
                        "$env:CONFIGURE='false'; irm https://github.com/block/goose/releases/download/stable/download_cli.ps1 | iex".to_string(),
                    ],
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
                    vec![
                        "-NoProfile".to_string(),
                        "-Command".to_string(),
                        "irm https://atomicagent.io/install.ps1 | iex".to_string(),
                    ],
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
                    vec![
                        "-NoProfile".to_string(),
                        "-Command".to_string(),
                        "iex \"& { $(irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1) } -SkipSetup -NonInteractive\"".to_string(),
                    ],
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
                    vec![
                        "-NoProfile".to_string(),
                        "-Command".to_string(),
                        "$env:POOL_INSTALL_ACCEPT_EULA='1'; irm https://downloads.poolside.ai/pool/install.ps1 | iex".to_string(),
                    ],
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
                     'curl -fsSL https://dev.meta.ai/install.sh | sh' and run it from your \
                     WSL shell: https://developer.meta.com/ai/products/muse-code/"
                        .to_string(),
                );
            }
            Ok((
                "bash".to_string(),
                vec![
                    "-c".to_string(),
                    "set -o pipefail; curl -fsSL https://dev.meta.ai/install.sh | sh".to_string(),
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
/// cached for the process lifetime (one shell spawn, not one per probe).
///
/// A sentinel wraps the value so rc files that echo to stdout don't corrupt it.
/// Returns `None` on probe failure; callers then fall back to the inherited PATH.
#[cfg(not(windows))]
pub(crate) fn login_shell_path() -> Option<String> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            // `-l` sources login files (.zprofile/.bash_profile, where Homebrew
            // shellenv usually lives); `-i` sources interactive rc files
            // (.zshrc/.bashrc, where nvm usually lives).
            let mut command = std::process::Command::new(&shell);
            command.args(["-lic", "printf '__OCPATH__%s__OCEND__' \"$PATH\""]);
            sanitize_std_command(&mut command);
            let out = command.output().ok()?;
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
    sanitize_std_command(cmd);
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
    let url = proxy.url.trim();
    if url.is_empty() {
        return;
    }
    let full = proxy_url_with_auth(url, proxy.username.as_deref(), proxy.password.as_deref());

    for key in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
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
/// Returns an empty vector for every other agent: they all install onto `PATH`,
/// and guessing locations for them would only produce false positives.
pub fn off_path_candidates(bin: &str) -> Vec<PathBuf> {
    match bin {
        "openclaw" => openclaw_off_path_candidates(),
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
        _ => Vec::new(),
    }
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

/// First [`off_path_candidates`] entry that exists on disk.
pub fn resolve_off_path(bin: &str) -> Option<PathBuf> {
    off_path_candidates(bin).into_iter().find(|p| p.is_file())
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
    if let Some(found) = resolve_off_path(&bin) {
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
    let (program, mut args, prereq, docs) = agent_install_spec(&agent_id)?;

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

    // OpenClaw pins a narrow set of Node releases and ships its npm install
    // behind npm's script-approval flag. Both are checked here, after the npm
    // prerequisite (and any winget bootstrap) has settled, so we read the Node
    // that will actually run the agent.
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
        let allow_scripts = tokio::task::spawn_blocking(
            || matches!(tool_version("npm"), Some(v) if v >= NPM_ALLOW_SCRIPTS_MIN),
        )
        .await
        .unwrap_or(false);
        if allow_scripts {
            args.push("--allow-scripts=openclaw".to_string());
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
    let _ = context_length;
    let keyed = api_key.as_deref().is_some_and(|k| !k.is_empty());
    let profile = tauri::async_runtime::spawn_blocking({
        let (api_url, model) = (api_url.clone(), model.clone());
        move || super::codex_config::configure(&api_url, &model, keyed)
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
/// array of `~/.factory/settings.json` (strict JSON, other models preserved).
/// Droid speaks OpenAI Chat Completions via `generic-chat-completion-api`, so
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
    let _ = context_length;
    const DISPLAY_NAME: &str = "Atomic Chat";

    let home = agent_home_dir()?;
    let dir = PathBuf::from(&home).join(".factory");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create ~/.factory: {}", e))?;
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

/// Whether OpenClaw's desktop app is installed, and whether we brought it up.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenclawAppStatus {
    /// The desktop app is present on this machine.
    pub installed: bool,
    /// We were able to bring it to the front. False with `installed: true` means
    /// the user has to open it themselves.
    pub launched: bool,
}

/// Report (and on macOS, open) OpenClaw's desktop app.
///
/// The app and the CLI share `~/.openclaw/openclaw.json`, and the Gateway
/// watches that file and hot-reloads it, so `configure_openclaw` is the whole
/// integration for app users too — this only saves them from going to find the
/// app afterwards, the way `launch_zed` does for Zed.
///
/// macOS ships `OpenClaw.app`, which `open -a` addresses by path. Windows Hub
/// ("OpenClaw Companion") installs per-user with no documented install path or
/// AUMID to launch it by, so there we only *detect* it — via its state
/// directory, which is the one location the docs pin down — and let the UI point
/// the user at the tray icon. Guessing a Start-menu path would break silently on
/// every install that does not match the guess.
#[tauri::command]
pub fn launch_openclaw_app() -> OpenclawAppStatus {
    #[cfg(target_os = "macos")]
    {
        let mut candidates = vec![PathBuf::from("/Applications/OpenClaw.app")];
        if let Ok(home) = agent_home_dir() {
            candidates.push(PathBuf::from(home).join("Applications/OpenClaw.app"));
        }
        let Some(app) = candidates.into_iter().find(|p| p.exists()) else {
            return OpenclawAppStatus {
                installed: false,
                launched: false,
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
        };
    }

    #[cfg(windows)]
    {
        // `%LOCALAPPDATA%\OpenClawTray` is the Hub's own state directory (its
        // setup logs live under it), so its presence is a reliable marker even
        // though the install root is not.
        let installed = std::env::var("LOCALAPPDATA")
            .ok()
            .filter(|p| !p.is_empty())
            .map(|local| PathBuf::from(local).join("OpenClawTray"))
            .is_some_and(|dir| dir.is_dir());
        return OpenclawAppStatus {
            installed,
            launched: false,
        };
    }

    #[allow(unreachable_code)]
    OpenclawAppStatus {
        installed: false,
        launched: false,
    }
}

/// Provider id we own inside `openclaw.json`. Model refs are `<provider>/<id>`,
/// so this is also the prefix of every ref we write.
pub(crate) const OPENCLAW_PROVIDER_ID: &str = "atomic";

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

/// Apply Atomic Chat's provider, primary model and policy edits to a parsed
/// `openclaw.json`, returning the updated document.
///
/// Split out from [`configure_openclaw`] so the merge rules — which of the
/// user's keys we overwrite, which we only seed, and how an existing
/// `modelPolicy.allow` is widened — are testable without touching the disk.
fn openclaw_patch_config(
    mut root: serde_json::Value,
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
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
    providers_obj.insert(
        OPENCLAW_PROVIDER_ID.to_string(),
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
    // Point the agent at our model via `model.primary`. Preserve sibling
    // `model.*` keys and normalize a plain string (both forms are accepted, but
    // only the object form has room for the fallbacks OpenClaw writes itself).
    // Run is explicit "use this", so we overwrite primary to keep it synced with
    // the active model.
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

/// `openclaw.json` location: `$OPENCLAW_CONFIG_PATH` when set, else
/// `~/.openclaw/openclaw.json`.
pub(crate) fn openclaw_config_path(home: &str) -> PathBuf {
    std::env::var("OPENCLAW_CONFIG_PATH")
        .ok()
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(home).join(".openclaw").join("openclaw.json"))
}

/// Configure OpenClaw by upserting `models.providers.atomic`, the agent's
/// primary model, and its per-model settings entry in `~/.openclaw/openclaw.json`.
///
/// The desktop apps (macOS `OpenClaw.app`, Windows Hub) read the same file
/// through the same Gateway, and the Gateway watches it and hot-reloads, so
/// this one write covers both the CLI and the app with no restart.
#[tauri::command]
pub fn configure_openclaw(
    api_url: String,
    model: String,
    api_key: Option<String>,
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    let _ = context_length;
    let home = agent_home_dir()?;
    let config_path = openclaw_config_path(&home);

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }

    // OpenClaw reads this file as JSON5 (comments, unquoted keys, trailing
    // commas), so we must parse with the same leniency or we reject configs
    // OpenClaw happily accepts (ATO-87). json5 deserializes into the same
    // serde_json::Value, and we always re-serialize as strict JSON on write,
    // which normalizes (and silently drops comments from) the file.
    let root: serde_json::Value = if config_path.exists() {
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

    let root = openclaw_patch_config(root, &api_url, &model, api_key.as_deref())?;
    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, pretty + "\n")
        .map_err(|e| format!("Failed to write {}: {}", config_path.display(), e))?;
    log::info!("OpenClaw configured: baseUrl={}, model={}", api_url, model);
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

/// Environment variables Copilot CLI reads for BYOK.
///
/// Shared by `configure_copilot`, which persists them to the user's shell rc,
/// and by `atomic-chat-cli launch`, which must also set them directly on the
/// spawned child: a freshly written rc file is not live in a process that is
/// already running.
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
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    let _ = context_length;
    let env_vars = copilot_env_vars(&api_url, &model, api_key.as_deref());

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
/// A route the pi-ai catalog does not ship falls back to `defaultContextWindow`
/// 262144 / `defaultMaxTokens` 32768, a wild over-claim for a local model that
/// surfaces as a mid-turn provider rejection. Declare something sane instead.
const DSH_CONTEXT_WINDOW: u64 = 65536;
const DSH_MAX_TOKENS: u64 = 8192;

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
fn dsh_route_node(api_url: &str, model: &str, with_key: bool) -> serde_yaml::Value {
    use serde_yaml::{Mapping, Value};

    let mut model_entry = Mapping::new();
    model_entry.insert(ykey("id"), Value::String(model.to_string()));
    model_entry.insert(ykey("contextWindow"), Value::from(DSH_CONTEXT_WINDOW));
    model_entry.insert(ykey("maxTokens"), Value::from(DSH_MAX_TOKENS));

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
) -> Result<(), String> {
    use serde_yaml::{Mapping, Value};

    // An invalid route does not merely fail to help: dsh rejects the entire
    // `llm-pi-ai` section, taking the user's other providers down with it. So
    // refuse to write one, before touching the tree.
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
    providers.insert(ykey(DSH_ROUTE_ID), dsh_route_node(api_url, model, with_key));
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

/// Read `DSH_HOME` from the user's login shell.
///
/// An `export DSH_HOME=...` in `~/.zshrc` is invisible to a Finder/Dock-launched
/// app (which inherits launchd's environment) but very visible to the `dsh` we
/// spawn through a terminal. Without this probe we would cheerfully write
/// `~/.dsh/settings.yaml` while dsh reads somewhere else entirely. Same problem
/// and same fix as {@link login_shell_path}, including the cache — the probe
/// spawns an interactive login shell and is far too slow to repeat.
#[cfg(not(windows))]
fn login_shell_dsh_home() -> Option<String> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            let out = std::process::Command::new(shell)
                .args(["-lic", "printf '__DSHHOME__%s__DSHEND__' \"$DSH_HOME\""])
                .output()
                .ok()?;
            if !out.status.success() {
                return None;
            }
            let s = String::from_utf8_lossy(&out.stdout);
            let start = s.find("__DSHHOME__")? + "__DSHHOME__".len();
            let end = s[start..].find("__DSHEND__")? + start;
            let value = s[start..end].trim().to_string();
            if value.is_empty() {
                None
            } else {
                Some(value)
            }
        })
        .clone()
}

#[cfg(windows)]
fn login_shell_dsh_home() -> Option<String> {
    None
}

/// Resolve dsh's home directory: `$DSH_HOME` when set, else `~/.dsh`.
pub(crate) fn dsh_home_dir() -> Result<PathBuf, String> {
    let from_env = std::env::var("DSH_HOME")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(login_shell_dsh_home);
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
) -> Result<(), String> {
    let key = api_key.map(str::trim).filter(|k| !k.is_empty());

    // Validate the credential before writing settings.yaml, so an unusable key
    // cannot leave a route pointing at a reference we then failed to store.
    if let Some(k) = key {
        dsh_validate_env_value(DSH_KEY_ENV, k)?;
    }

    let settings_path = home.join("settings.yaml");

    // Parse before creating anything, so a malformed file leaves no debris.
    let text = match std::fs::read_to_string(&settings_path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
            return Err(format!(
                "{} is not valid UTF-8. Fix or remove the file and try again.",
                settings_path.display()
            ))
        }
        Err(e) => return Err(format!("Failed to read {}: {}", settings_path.display(), e)),
    };
    let mut root: serde_yaml::Value = serde_yaml::from_str(&text).map_err(|e| {
        format!(
            "Could not parse {}: {}. Fix or remove the file and try again.",
            settings_path.display(),
            e
        )
    })?;

    apply_dsh_provider(&mut root, api_url, model, key.is_some())?;

    let mut serialized = serde_yaml::to_string(&root)
        .map_err(|e| format!("Failed to serialize {}: {}", settings_path.display(), e))?;
    if !serialized.ends_with('\n') {
        serialized.push('\n');
    }

    std::fs::create_dir_all(home)
        .map_err(|e| format!("Failed to create {}: {}", home.display(), e))?;

    // The round trip below drops comments and expands anchors, so keep one copy
    // of whatever the user had before we first touched it. Only ever written
    // once, so a later run cannot overwrite the true pre-Atomic state.
    if !text.is_empty() {
        let backup = home.join("settings.yaml.atomic-backup");
        if !backup.exists() {
            let _ = std::fs::write(&backup, &text);
        }
    }

    write_atomically(&settings_path, serialized.as_bytes())?;

    // The secret itself never enters settings.yaml. dsh resolves the reference
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
        "DeepSeek Harness configured: baseURL={}, model={}, home={}, key={}",
        api_url,
        model,
        home.display(),
        if key.is_some() { "yes" } else { "no" }
    );
    Ok(())
}

/// Point DeepSeek Harness (`dsh`) at the local Atomic Chat server by upserting
/// the `llm-pi-ai.providers.atomic` route in `$DSH_HOME/settings.yaml`
/// (default `~/.dsh`). dsh re-reads that document live, so no restart is needed.
///
/// NOTE: the parse/re-serialize round trip drops YAML comments and expands
/// anchors and aliases — the same trade `configure_zed` makes for JSONC, which
/// is why the previous contents are backed up alongside on the first write.
#[tauri::command]
pub fn configure_dsh(
    api_url: String,
    model: String,
    api_key: Option<String>,
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    let _ = context_length;
    let home = dsh_home_dir()?;
    configure_dsh_at(&home, &api_url, &model, api_key.as_deref())
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

/// Environment variables OpenHands reads for BYOK. See `copilot_env_vars` for
/// why this is shared with the CLI.
pub fn openhands_env_vars(
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
) -> Vec<(String, String)> {
    let key_val = api_key.filter(|k| !k.is_empty()).unwrap_or("atomic");

    let mut env_vars: Vec<(String, String)> = Vec::with_capacity(3);
    // The litellm `openai/` prefix is required for a custom OpenAI-compatible
    // base_url.
    env_vars.push(("LLM_MODEL".to_string(), format!("openai/{}", model)));
    env_vars.push(("LLM_BASE_URL".to_string(), api_url.to_string()));
    env_vars.push(("LLM_API_KEY".to_string(), key_val.to_string()));
    env_vars
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
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    let _ = context_length;
    let env_vars = openhands_env_vars(&api_url, &model, api_key.as_deref());

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

/// Poolside standalone mode expects a base URL WITHOUT the `/v1` suffix.
fn poolside_standalone_base_url(api_url: &str) -> String {
    let trimmed = api_url.trim().trim_end_matches('/');
    trimmed
        .strip_suffix("/v1")
        .unwrap_or(trimmed)
        .trim_end_matches('/')
        .to_string()
}

/// Configure Poolside CLI via its standalone OpenAI-compatible environment
/// variables. Poolside has no provider config file for BYOK — it reads
/// `POOLSIDE_STANDALONE_*` from the environment at launch — so we persist them
/// to the user's shell rc (Windows: `setx`). The auto-opened terminal also
/// passes them inline so the session works without re-sourcing the rc file.
/// Environment variables Poolside reads in standalone mode. See
/// `copilot_env_vars` for why this is shared with the CLI.
pub fn poolside_env_vars(
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
) -> Vec<(String, String)> {
    let key_val = api_key.filter(|k| !k.is_empty()).unwrap_or("atomic");
    let standalone_base = poolside_standalone_base_url(api_url);

    let mut env_vars: Vec<(String, String)> = Vec::with_capacity(3);
    env_vars.push(("POOLSIDE_STANDALONE_BASE_URL".to_string(), standalone_base));
    env_vars.push(("POOLSIDE_API_KEY".to_string(), key_val.to_string()));
    env_vars.push(("POOLSIDE_STANDALONE_MODEL".to_string(), model.to_string()));
    env_vars
}

#[tauri::command]
pub fn configure_poolside(
    api_url: String,
    model: String,
    api_key: Option<String>,
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    let _ = context_length;
    let standalone_base = poolside_standalone_base_url(&api_url);
    let env_vars = poolside_env_vars(&api_url, &model, api_key.as_deref());

    const MARKER: &str = "# Atomic Chat - Poolside Config";

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
            "Poolside configured (Windows env): base_url={}, model={}",
            standalone_base,
            model
        );
        return Ok(());
    }

    let home = agent_home_dir()?;
    let is_macos = cfg!(target_os = "macos");
    let (_shell, env_file_path) = detect_shell_env_file(&home, is_macos);
    write_marked_env_to_shell(&env_file_path, MARKER, "POOLSIDE_", &env_vars)?;
    log::info!(
        "Poolside configured: base_url={}, model={}, rc={}",
        standalone_base,
        model,
        env_file_path
    );
    Ok(())
}

/// Environment Muse Code needs before it will talk to a non-Meta endpoint.
///
/// Muse Code is the one agent here with no writable endpoint configuration:
/// `~/.config/muse/settings.json` holds UI, tool and MCP preferences, while the
/// provider is chosen per invocation with `--provider meta --base-url <url>
/// --model <id>` (see `cli::integrations::dynamic_run_args`). The credential is
/// the only piece that persists, and Muse only checks that `META_API_KEY` is
/// present -- the upstream call goes to whatever `--base-url` points at -- so
/// the local server's own key satisfies both ends.
pub fn muse_env_vars(_api_url: &str, _model: &str, api_key: Option<&str>) -> Vec<(String, String)> {
    let key_val = api_key.filter(|k| !k.is_empty()).unwrap_or("atomic");
    vec![("META_API_KEY".to_string(), key_val.to_string())]
}

/// Configure Muse Code by persisting `META_API_KEY`.
///
/// `api_url` and `model` are accepted for symmetry with the other
/// `configure_*` commands the Launch page invokes, but Muse takes both as
/// launch flags rather than configuration, so only the key is written here.
#[tauri::command]
pub fn configure_muse(
    api_url: String,
    model: String,
    api_key: Option<String>,
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    let _ = context_length;
    let env_vars = muse_env_vars(&api_url, &model, api_key.as_deref());

    const MARKER: &str = "# Atomic Chat - Muse Code Config";

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
        log::info!("Muse Code configured (Windows env): base_url={}", api_url);
        return Ok(());
    }

    let home = agent_home_dir()?;
    let is_macos = cfg!(target_os = "macos");
    let (_shell, env_file_path) = detect_shell_env_file(&home, is_macos);
    write_marked_env_to_shell(&env_file_path, MARKER, "META_", &env_vars)?;
    log::info!(
        "Muse Code configured: base_url={}, model={}, rc={}",
        api_url,
        model,
        env_file_path
    );
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
    // The window the served model was loaded with, when the app knows it;
    // the agent is told so it compacts before the server refuses.
    context_length: Option<u32>,
) -> Result<(), String> {
    let _ = context_length;
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
/// which the agent would otherwise refuse to load). Unknown keys survive
/// because Atomic Agent's parser carries unknown top-level keys through
/// verbatim.
fn atomic_agent_patch_config(
    mut root: serde_json::Value,
    api_url: &str,
    model: &str,
    api_key: Option<&str>,
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

        let entry = serde_json::json!({
            "id": ATOMIC_AGENT_PROVIDER_ID,
            "kind": "openai-compatible",
            "baseUrl": api_url,
            "apiKey": key_val,
            "defaultChatModel": model.trim(),
            "supportsTools": true,
            "requestTimeoutMs": timeout,
        });
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

    Ok(root)
}

/// Whether `providers` already carries an entry with this id.
fn atomic_agent_lists(providers: &[serde_json::Value], id: &str) -> bool {
    providers
        .iter()
        .any(|p| p.get("id").and_then(|v| v.as_str()) == Some(id))
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
    let _ = context_length;
    let state_dir = resolve_atomic_agent_state_dir()?;
    let path = state_dir.join("config.json");

    let root: serde_json::Value = if path.exists() {
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
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

    let patched = atomic_agent_patch_config(root, &api_url, &model, api_key.as_deref())?;

    std::fs::create_dir_all(&state_dir)
        .map_err(|e| format!("Failed to create {}: {}", state_dir.display(), e))?;
    let pretty = serde_json::to_string_pretty(&patched).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty + "\n")
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;

    log::info!(
        "Atomic Agent configured: baseUrl={}, model={}",
        api_url,
        model
    );
    Ok(())
}

/// Open the OS terminal and run `command` interactively, so the user can start
/// using a just-configured agent in one click. The terminal stays open after
/// the command (it launches an interactive TUI agent like codex/claude).
#[tauri::command]
#[cfg_attr(feature = "e2e", allow(unreachable_code, unused_variables))]
pub fn open_agent_terminal(command: String, proxy: Option<ProxyEnv>) -> Result<(), String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("Empty terminal command".to_string());
    }

    // An end-to-end build must not open terminal windows on the desktop of
    // whoever runs the tests; it writes down what it would have run instead.
    #[cfg(feature = "e2e")]
    return crate::core::e2e::record_terminal(&crate::core::e2e::data_root(), &command);

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
        for agent_id in ["goose", "atomic-agent", "hermes", "poolside", "zed", "muse"] {
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
        apply_dsh_provider(&mut root, URL, "qwen3-4b", false).unwrap();

        let r = route(&root);
        assert_eq!(r.get("api").unwrap().as_str(), Some("openai-completions"));
        assert_eq!(r.get("baseURL").unwrap().as_str(), Some(URL));
        assert_eq!(r.get("displayName").unwrap().as_str(), Some("Atomic Chat"));

        // A hand-declared route is refused by dsh without a non-empty model list.
        let models = r.get("models").unwrap().as_sequence().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].get("id").unwrap().as_str(), Some("qwen3-4b"));
        assert_eq!(
            models[0].get("contextWindow").unwrap().as_u64(),
            Some(DSH_CONTEXT_WINDOW)
        );
        assert_eq!(
            models[0].get("maxTokens").unwrap().as_u64(),
            Some(DSH_MAX_TOKENS)
        );
    }

    #[test]
    fn preserves_other_plugin_sections() {
        let mut root =
            parse("web-app:\n  port: 3080\nsession-persistence-jsonl:\n  root: /tmp/x\n");
        apply_dsh_provider(&mut root, URL, "m", false).unwrap();

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
        apply_dsh_provider(&mut root, URL, "m", false).unwrap();

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
        apply_dsh_provider(&mut root, URL, "m", false).unwrap();

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
        apply_dsh_provider(&mut keyed, URL, "m", true).unwrap();
        assert_eq!(
            route(&keyed).get("apiKeyEnv").unwrap().as_str(),
            Some(DSH_KEY_ENV)
        );

        let mut keyless = parse("");
        apply_dsh_provider(&mut keyless, URL, "m", false).unwrap();
        assert!(route(&keyless).get("apiKeyEnv").is_none());
    }

    #[test]
    fn bare_section_and_providers_keys_are_healed() {
        // Both parse to Null, which is a hole to fill rather than data to protect.
        for fixture in ["llm-pi-ai:\n", "llm-pi-ai:\n  providers:\n"] {
            let mut root = parse(fixture);
            apply_dsh_provider(&mut root, URL, "m", false).unwrap();
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
            assert!(apply_dsh_provider(&mut root, URL, "m", false).is_err());
            assert_eq!(root, before, "a refused write must not mutate the tree");
        }
    }

    #[test]
    fn refuses_a_non_mapping_root() {
        let mut root = parse("- a\n- b\n");
        assert!(apply_dsh_provider(&mut root, URL, "m", false).is_err());
    }

    /// An invalid route makes dsh reject the whole `llm-pi-ai` section, so this
    /// must fail loudly instead of writing something the user's other providers
    /// would go down with.
    #[test]
    fn refuses_an_empty_model_or_url() {
        let mut root = parse("");
        let before = root.clone();
        assert!(apply_dsh_provider(&mut root, URL, "   ", false).is_err());
        assert!(apply_dsh_provider(&mut root, "", "m", false).is_err());
        assert_eq!(root, before);
    }

    /// Model ids are quoted by serde_yaml rather than concatenated in, so an id
    /// that looks like another YAML type still round-trips as a string.
    #[test]
    fn model_ids_that_look_like_other_types_round_trip() {
        for id in ["yes", "no", "7", "1.0", "null", "on"] {
            let mut root = parse("");
            apply_dsh_provider(&mut root, URL, id, false).unwrap();
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
        apply_dsh_provider(&mut once, URL, "m", true).unwrap();
        let mut twice = once.clone();
        apply_dsh_provider(&mut twice, URL, "m", true).unwrap();
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
}

#[cfg(test)]
mod atomic_agent_tests {
    use super::*;

    const URL: &str = "http://127.0.0.1:1337/v1";

    fn patch(input: serde_json::Value) -> serde_json::Value {
        atomic_agent_patch_config(input, URL, "qwen3-4b", Some("")).expect("merge must succeed")
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
        let out = atomic_agent_patch_config(serde_json::json!({}), URL, "  qwen3-4b\n", None)
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

        let out = atomic_agent_patch_config(tuned, URL, "gemma-4-12b", Some("sk-local"))
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
        assert!(atomic_agent_patch_config(serde_json::json!({}), URL, "  ", None).is_err());
    }

    #[test]
    fn rejects_a_config_file_that_is_not_an_object() {
        assert!(atomic_agent_patch_config(serde_json::json!([]), URL, "m", None).is_err());
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
        openclaw_patch_config(root, OC_URL, "gemma-4", Some("atomic")).expect("patch must succeed")
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

    /// Only OpenClaw's launcher, ZCode's desktop app and the editors live off
    /// PATH; guessing paths for the other agents would only produce false
    /// positives.
    #[test]
    fn off_path_candidates_cover_only_openclaw_and_zcode() {
        assert!(off_path_candidates("claude").is_empty());
        assert!(off_path_candidates("codex").is_empty());

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
    fn hermes_selects_its_keyed_provider_and_rotates_without_stale_credentials() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("config.yaml"), format!("{}custom_providers:\n- name: personal\n  base_url: https://example.com/v1\n  api_key: personal-key\n", HERMES_DEFAULT_CONFIG.replace("custom_providers: []\n", ""))).unwrap();
        for key in [Some("first'key#quoted"), Some("rotated"), None, Some("")] {
            configure_hermes_at(
                dir.path(),
                "http://localhost:1337/v1".into(),
                "test/model".into(),
                key.map(str::to_string),
                None,
            )
            .unwrap();
            let text = fs::read_to_string(dir.path().join("config.yaml")).unwrap();
            let doc: serde_yaml::Value = serde_yaml::from_str(&text).unwrap();
            assert_eq!(
                doc["model"]["provider"].as_str(),
                Some("custom:atomic-chat")
            );
            let providers = doc["custom_providers"].as_sequence().unwrap();
            assert_eq!(providers.len(), 2);
            assert_eq!(providers[0]["api_key"].as_str(), Some("personal-key"));
            assert_eq!(
                providers[1]["api_key"].as_str(),
                Some(key.filter(|k| !k.is_empty()).unwrap_or("atomic"))
            );
        }
    }

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
    const PROVIDER: &str = "custom:atomic-chat";

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
        patch_hermes_model_section(content, MODEL, PROVIDER, URL)
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
            upsert_atomic_provider(inline, "http://u", "m", 64, None),
            inline
        );
        assert_eq!(remove_atomic_provider(inline), inline);
    }

    #[test]
    fn hermes_provider_timeout_rewrites_an_empty_inline_map_into_a_block() {
        assert_eq!(
            upsert_provider_request_timeout("a: 1\nproviders: {}\nb: 2\n", "custom", 180),
            "a: 1\nproviders:\n  custom:\n    request_timeout_seconds: 180\nb: 2\n"
        );
    }

    #[test]
    fn hermes_provider_timeout_never_adds_a_second_providers_key() {
        assert_eq!(
            upsert_provider_request_timeout(
                "providers:  # named endpoints\n  x: {}\n",
                "custom",
                180
            ),
            "providers:  # named endpoints\n  custom:\n    request_timeout_seconds: 180\n  x: {}\n"
        );
        let inline = "providers: {openai: {request_timeout_seconds: 60}}\n";
        assert_eq!(
            upsert_provider_request_timeout(inline, "custom", 180),
            inline
        );
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
        ];
        for seed in shapes {
            let dir = tempfile::tempdir().unwrap();
            let config = dir.path().join("config.yaml");
            fs::write(&config, seed).unwrap();
            let connect = || {
                configure_hermes_at(
                    dir.path(),
                    URL.into(),
                    MODEL.into(),
                    Some("sk-test".into()),
                    None,
                )
                .unwrap();
                fs::read_to_string(&config).unwrap()
            };

            let first = connect();
            let view = hermes_view(&first);
            assert_eq!(view["model"]["default"].as_str(), Some(MODEL), "{first}");
            assert_eq!(
                view["model"]["provider"].as_str(),
                Some(PROVIDER),
                "{first}"
            );
            assert_eq!(view["model"]["base_url"].as_str(), Some(URL), "{first}");
            let entries = view["custom_providers"].as_sequence().unwrap();
            assert_eq!(entries.len(), 1, "{first}");
            assert_eq!(entries[0]["name"].as_str(), Some(ATOMIC_PROVIDER_NAME));
            assert_eq!(entries[0]["base_url"].as_str(), Some(URL));
            assert_eq!(entries[0]["api_key"].as_str(), Some("sk-test"));
            assert_eq!(entries[0]["model"].as_str(), Some(MODEL));
            assert_eq!(
                entries[0]["models"][MODEL]["context_length"].as_u64(),
                Some(65536)
            );
            assert_eq!(
                view["providers"]["custom"]["request_timeout_seconds"].as_u64(),
                Some(180),
                "{first}"
            );

            assert_eq!(connect(), first);
        }
    }

    #[test]
    fn hermes_disconnect_restores_only_the_model_block_and_our_entry() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config.yaml");
        let seed = "auxiliary:\n  vision:\n    provider: auto\n    base_url: \"\"\n\
                    model:\n  default: anthropic/claude-opus-4.6\n  provider: auto\n  \
                    base_url: https://openrouter.ai/api/v1\n\
                    custom_providers:\n- name: personal\n  base_url: https://example.com/v1\n\
                    delegation:\n  provider: openrouter\n";
        fs::write(&config, seed).unwrap();

        configure_hermes_at(dir.path(), URL.into(), MODEL.into(), None, None).unwrap();
        clear_hermes_at(dir.path()).unwrap();

        // The provider timeout Connect seeded stays, as it did before.
        assert_eq!(
            fs::read_to_string(&config).unwrap(),
            format!("{seed}providers:\n  custom:\n    request_timeout_seconds: 180\n")
        );
    }
}
