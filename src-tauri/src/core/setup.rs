use flate2::read::GzDecoder;
use std::{
    fs::{self, File},
    io::Read,
    path::PathBuf,
    sync::Arc,
};
use tar::Archive;
use tauri::{App, Emitter, Manager, Runtime, WindowEvent, Wry};

#[cfg(desktop)]
use tauri::{
    menu::{IconMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{TrayIcon, TrayIconBuilder},
};
use tauri_plugin_store::Store;

use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::mcp::constants::MCP_CONFIG_VERSION;
use crate::core::mcp::helpers::{
    add_server_config, drop_retired_serper_default_from_config, ensure_mcp_config_exists,
};

use super::{
    extensions::commands::get_jan_extensions_path, mcp::helpers::run_mcp_commands, state::AppState,
};

pub fn install_extensions<R: Runtime>(app: tauri::AppHandle<R>, force: bool) -> Result<(), String> {
    // Skip extension installation on mobile platforms
    // Mobile uses pre-bundled extensions loaded via MobileCoreService in the frontend
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        return Ok(());
    }

    let extensions_path = get_jan_extensions_path(app.clone());
    let pre_install_path = app
        .path()
        .resource_dir()
        .unwrap()
        .join("resources")
        .join("pre-install");

    let mut clean_up = force;

    // Check IS_CLEAN environment variable to optionally skip extension install
    if std::env::var("IS_CLEAN").is_ok() {
        clean_up = true;
    }
    log::info!("Installing extensions. Clean up: {clean_up}");
    if !clean_up && extensions_path.exists() {
        return Ok(());
    }

    // Attempt to remove extensions folder
    if extensions_path.exists() {
        fs::remove_dir_all(&extensions_path).unwrap_or_else(|_| {
            log::info!("Failed to remove existing extensions folder, it may not exist.");
        });
    }

    // Attempt to create it again
    if !extensions_path.exists() {
        fs::create_dir_all(&extensions_path).map_err(|e| e.to_string())?;
    }

    let extensions_json_path = extensions_path.join("extensions.json");
    let mut extensions_list = if extensions_json_path.exists() {
        let existing_data =
            fs::read_to_string(&extensions_json_path).unwrap_or_else(|_| "[]".to_string());
        serde_json::from_str::<Vec<serde_json::Value>>(&existing_data).unwrap_or_else(|_| vec![])
    } else {
        vec![]
    };

    for entry in fs::read_dir(&pre_install_path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.extension().is_some_and(|ext| ext == "tgz") {
            let tar_gz = File::open(&path).map_err(|e| e.to_string())?;
            let gz_decoder = GzDecoder::new(tar_gz);
            let mut archive = Archive::new(gz_decoder);

            let mut extension_name = None;
            let mut extension_manifest = None;
            extract_extension_manifest(&mut archive)
                .map_err(|e| e.to_string())
                .and_then(|manifest| match manifest {
                    Some(manifest) => {
                        extension_name = manifest["name"].as_str().map(|s| s.to_string());
                        extension_manifest = Some(manifest);
                        Ok(())
                    }
                    None => Err("Manifest is None".to_string()),
                })?;

            let extension_name = extension_name.ok_or("package.json not found in archive")?;
            let extension_dir = extensions_path.join(extension_name.clone());
            fs::create_dir_all(&extension_dir).map_err(|e| e.to_string())?;

            let tar_gz = File::open(&path).map_err(|e| e.to_string())?;
            let gz_decoder = GzDecoder::new(tar_gz);
            let mut archive = Archive::new(gz_decoder);
            for entry in archive.entries().map_err(|e| e.to_string())? {
                let mut entry = entry.map_err(|e| e.to_string())?;
                let file_path = entry.path().map_err(|e| e.to_string())?;
                let components: Vec<_> = file_path.components().collect();
                if components.len() > 1 {
                    let relative_path: PathBuf = components[1..].iter().collect();
                    let target_path = extension_dir.join(relative_path);
                    if let Some(parent) = target_path.parent() {
                        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                    let _result = entry.unpack(&target_path).map_err(|e| e.to_string())?;
                }
            }

            let main_entry = extension_manifest
                .as_ref()
                .and_then(|manifest| manifest["main"].as_str())
                .unwrap_or("index.js");
            let url = extension_dir.join(main_entry).to_string_lossy().to_string();

            let new_extension = serde_json::json!({
                "url": url,
                "name": extension_name.clone(),
                "origin": extension_dir.to_string_lossy(),
                "active": true,
                "description": extension_manifest
                    .as_ref()
                    .and_then(|manifest| manifest["description"].as_str())
                    .unwrap_or(""),
                "version": extension_manifest
                    .as_ref()
                    .and_then(|manifest| manifest["version"].as_str())
                    .unwrap_or(""),
                "productName": extension_manifest
                    .as_ref()
                    .and_then(|manifest| manifest["productName"].as_str())
                    .unwrap_or(""),
            });

            extensions_list.push(new_extension);

            log::info!("Installed extension to {extension_dir:?}");
        }
    }
    fs::write(
        &extensions_json_path,
        serde_json::to_string_pretty(&extensions_list).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

// Migrate MCP servers configuration
pub fn migrate_mcp_servers(
    app_handle: tauri::AppHandle,
    store: Arc<Store<Wry>>,
) -> Result<(), String> {
    let mcp_version = store
        .get("mcp_version")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    // On a clean install the config file does not exist yet — `setup_mcp` only
    // creates it later, asynchronously. Without this the migrations below fail
    // with "os error 2" on every first launch.
    ensure_mcp_config_exists(app_handle.clone())?;

    if mcp_version < 1 {
        log::info!("Migrating MCP schema version 1");
        let result = add_server_config(
            app_handle.clone(),
            "exa".to_string(),
            serde_json::json!({
                  "command": "npx",
                  "args": ["-y", "exa-mcp-server"],
                  "env": { "EXA_API_KEY": "YOUR_EXA_API_KEY_HERE" },
                  "active": false
            }),
        );
        if let Err(e) = result {
            log::error!("Failed to add server config: {e}");
        }
    }
    if mcp_version < 2 {
        log::info!("Migrating MCP schema version 2: Adding Jan Browser MCP");
        let result = add_server_config(
            app_handle.clone(),
            "Jan Browser MCP".to_string(),
            serde_json::json!({
                "command": "npx",
                "args": ["-y", "search-mcp-server@latest"],
                "env": {
                    "BRIDGE_HOST": "127.0.0.1",
                    "BRIDGE_PORT": "17389"
                },
                "active": false,
                "official": true
            }),
        );
        if let Err(e) = result {
            log::error!("Failed to add Jan Browser MCP server config: {e}");
        }
    }
    if mcp_version < 3 {
        log::info!("Migrating MCP schema version 3: Updating Exa to streamable HTTP");
        if let Err(e) = migrate_exa_to_http(app_handle.clone()) {
            log::error!("Failed to migrate Exa to HTTP: {e}");
        }
    }
    if mcp_version < 4 {
        log::info!("Migrating MCP schema version 4: Dropping the retired serper default");
        match drop_retired_serper_default_from_config(app_handle) {
            Ok(true) => log::info!("Dropped the untouched serper default from mcp_config.json"),
            Ok(false) => {}
            Err(e) => log::error!("Failed to drop the serper default: {e}"),
        }
    }
    store.set("mcp_version", MCP_CONFIG_VERSION);
    store.save().expect("Failed to save store");
    Ok(())
}

fn migrate_exa_to_http(app_handle: tauri::AppHandle) -> Result<(), String> {
    let config_path = get_jan_data_folder_path(app_handle).join("mcp_config.json");

    let config_str =
        fs::read_to_string(&config_path).map_err(|e| format!("Failed to read MCP config: {e}"))?;

    let mut config: serde_json::Value = serde_json::from_str(&config_str)
        .map_err(|e| format!("Failed to parse MCP config: {e}"))?;

    if let Some(servers) = config.get_mut("mcpServers").and_then(|s| s.as_object_mut()) {
        servers.insert(
            "exa".to_string(),
            serde_json::json!({
                "type": "http",
                "url": "https://mcp.exa.ai/mcp".to_string(),
                "command": "",
                "args": [],
                "env": {},
                "active": true
            }),
        );
    }

    fs::write(
        &config_path,
        serde_json::to_string_pretty(&config)
            .map_err(|e| format!("Failed to serialize MCP config: {e}"))?,
    )
    .map_err(|e| format!("Failed to write MCP config: {e}"))?;

    Ok(())
}

pub fn extract_extension_manifest<R: Read>(
    archive: &mut Archive<R>,
) -> Result<Option<serde_json::Value>, String> {
    let entry = archive
        .entries()
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok()) // Ignore errors in individual entries
        .find(|entry| {
            if let Ok(file_path) = entry.path() {
                let path_str = file_path.to_string_lossy();
                path_str == "package/package.json" || path_str == "package.json"
            } else {
                false
            }
        });

    if let Some(mut entry) = entry {
        let mut content = String::new();
        entry
            .read_to_string(&mut content)
            .map_err(|e| e.to_string())?;

        let package_json: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| e.to_string())?;
        return Ok(Some(package_json));
    }

    Ok(None)
}

/// Refresh an `atomic-chat-cli` that is already on PATH after an app update, so it
/// stays in sync with the bundled binary.
///
/// The CLI is hidden in the app, so a launch never installs it on its own: when the
/// version is unchanged, or the command is not on PATH, this does nothing.
///
/// Runs in a background task — never blocks startup.
/// Errors are logged as warnings and never prevent the app from starting.
pub fn setup_jan_cli<R: Runtime>(app_handle: tauri::AppHandle<R>, version_changed: bool) {
    if !version_changed {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if !crate::core::system::commands::check_jan_cli_installed()
            .await
            .installed
        {
            log::debug!("Atomic Chat CLI not on PATH — leaving it uninstalled");
            return;
        }

        match crate::core::system::commands::install_jan_cli_sync(&app_handle) {
            Ok(status) => {
                log::info!(
                    "Atomic Chat CLI updated at {}",
                    status.path.as_deref().unwrap_or("<unknown>")
                );
            }
            Err(e) => {
                log::warn!("Atomic Chat CLI update skipped: {e}");
            }
        }
    });
}

pub fn setup_mcp<R: Runtime>(app: &App<R>) {
    let state = app.state::<AppState>();
    let servers = state.mcp_servers.clone();
    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        use crate::core::mcp::lockfile::cleanup_all_stale_locks;

        if let Err(e) = ensure_mcp_config_exists(app_handle.clone()) {
            log::error!("Failed to create default MCP config: {e}");
        }

        if let Err(e) = cleanup_all_stale_locks(&app_handle).await {
            log::debug!("Lock file cleanup error: {}", e);
        }

        if let Err(e) = run_mcp_commands(&app_handle, servers).await {
            log::error!("Failed to run mcp commands: {e}");
        }
        app_handle
            .emit("mcp-update", "MCP servers updated")
            .unwrap();
    });
}

/// Bring the main window back from wherever close-to-tray or minimise left it.
/// Shared by the tray's "Open" item and the rows that open a page of the app.
#[cfg(desktop)]
fn show_main_window(app: &tauri::AppHandle) {
    // Close-to-tray hides the whole app (NSApplication) on macOS, so
    // un-hide it first before showing/focusing the window.
    #[cfg(target_os = "macos")]
    let _ = app.show();
    // A close may still be deciding between hide and exit.
    #[cfg(target_os = "linux")]
    cancel_pending_close();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
pub fn setup_tray(app: &App) -> tauri::Result<TrayIcon> {
    use crate::core::state::AppState;
    use crate::core::tray_status::{
        render_copy_icon, render_dot, render_segmented_bar, write_clipboard, TrayHandles,
    };

    //* Dynamic status rows: populated immediately with placeholders, then refreshed
    //  every ~5 s by the frontend hook `useTrayStatusSync` invoking `update_tray_status`.

    //* Server block — stacked Pico-style: status row ("Server Running") on top,
    //  copy-icon-prefixed URL row beneath, and an actionable "Stop Server"
    //  button (hidden while the server is stopped). Clicking the URL row
    //  copies the cached server URL.
    let status_server = IconMenuItem::with_id(
        app.handle(),
        "status_server",
        "Server Stopped",
        true,
        Some(render_dot(false)),
        None::<&str>,
    )?;
    let status_server_url = IconMenuItem::with_id(
        app.handle(),
        "status_server_url",
        "—",
        false,
        Some(render_copy_icon()),
        None::<&str>,
    )?;
    //* Server toggle row. Starts as "Start Server" assuming the proxy is not
    //  yet up; `update_tray_status` swaps the label to "Stop Server" the
    //  moment the frontend reports `server_running == true`. Click is routed
    //  to the frontend via `tray-stop-server` / `tray-start-server` events so
    //  React owns the actual start/stop flow (model loading, status pings).
    let status_stop = MenuItem::with_id(
        app.handle(),
        "status_stop",
        "Start Server",
        true,
        None::<&str>,
    )?;

    //* Model block — a disabled "Model" header above the live model name,
    //  then a "Runtime" header above the engine it runs on. The headers are
    //  kept static (and disabled, so they render muted) so the block reads as
    //  section labels, mirroring Pico AI Server's panel. Both values are
    //  clickable: they open the page where the engine and model are chosen.
    let status_model_label = MenuItem::with_id(
        app.handle(),
        "status_model_label",
        "Model",
        false,
        None::<&str>,
    )?;
    let status_model_value = MenuItem::with_id(
        app.handle(),
        "status_model_value",
        "— no model loaded —",
        true,
        None::<&str>,
    )?;
    let status_runtime_label = MenuItem::with_id(
        app.handle(),
        "status_runtime_label",
        "Runtime",
        false,
        None::<&str>,
    )?;
    let status_runtime_value = MenuItem::with_id(
        app.handle(),
        "status_runtime_value",
        "—",
        true,
        None::<&str>,
    )?;
    //* RAM split across two rows — text caption + stand-alone segmented bar —
    //  so only BAR_WIDTH drives the overall menu width (Pico-style narrow panel).
    let status_ram_text = MenuItem::with_id(
        app.handle(),
        "status_ram_text",
        "RAM  —",
        true,
        None::<&str>,
    )?;
    let status_ram_bar = IconMenuItem::with_id(
        app.handle(),
        "status_ram_bar",
        "",
        true,
        Some(render_segmented_bar(0)),
        None::<&str>,
    )?;

    let show_i = MenuItem::with_id(app.handle(), "open", "Open Atomic Chat", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app.handle(), "quit", "Quit", true, None::<&str>)?;

    //* Three separators carve the menu into Pico-style sections so the rows
    //  feel grouped instead of one long list.
    let sep_after_server = PredefinedMenuItem::separator(app.handle())?;
    let sep_after_model = PredefinedMenuItem::separator(app.handle())?;
    let sep_before_actions = PredefinedMenuItem::separator(app.handle())?;

    let menu = Menu::with_items(
        app.handle(),
        &[
            &status_server,
            &status_server_url,
            &status_stop,
            &sep_after_server,
            &status_model_label,
            &status_model_value,
            &status_runtime_label,
            &status_runtime_value,
            &sep_after_model,
            &status_ram_text,
            &status_ram_bar,
            &sep_before_actions,
            &show_i,
            &quit_i,
        ],
    )?;

    //* Stash mutable handles in AppState so `update_tray_status` can flip their text/icons.
    {
        let handles_arc = {
            let state = app.state::<AppState>();
            state.tray_handles.clone()
        };
        let new_handles = TrayHandles {
            server: status_server.clone(),
            server_url_row: status_server_url.clone(),
            stop_button: status_stop.clone(),
            model_label: status_model_label.clone(),
            model_value: status_model_value.clone(),
            runtime_label: status_runtime_label.clone(),
            runtime_value: status_runtime_value.clone(),
            ram_text: status_ram_text.clone(),
            ram_bar: status_ram_bar.clone(),
            server_url: std::sync::Mutex::new(String::new()),
            is_running: std::sync::Mutex::new(false),
        };
        match handles_arc.lock() {
            Ok(mut guard) => *guard = Some(new_handles),
            Err(e) => log::warn!("tray_handles mutex poisoned: {e}"),
        };
    }

    //* macOS menu bar icon: separate asset; icon_as_template(false) — show the PNG as is
    //  Single-click opens the status menu (Pico-style). The right-click menu is the same.
    let mut tray_builder = TrayIconBuilder::with_id("tray")
        .menu(&menu)
        .show_menu_on_left_click(true);

    #[cfg(target_os = "macos")]
    {
        //* Template: the system tints the black outline like the battery icon; PNG with rounded corners and a "hollow" star
        let menu_bar_icon = tauri::image::Image::from_bytes(include_bytes!(
            "../../../web-app/public/images/tray-macos-template.png"
        ))?;
        tray_builder = tray_builder.icon(menu_bar_icon).icon_as_template(true);
    }

    #[cfg(not(target_os = "macos"))]
    {
        tray_builder = tray_builder.icon(app.default_window_icon().unwrap().clone());
    }

    tray_builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => {
                app.exit(0);
            }
            "status_server_url" => {
                //* Clicking the URL row copies the cached server URL — the row's
                //  display text may be truncated, so we always copy the full URL
                //  stashed in `TrayHandles::server_url`.
                let state = app.state::<AppState>();
                let url = state
                    .tray_handles
                    .lock()
                    .ok()
                    .and_then(|g| {
                        g.as_ref()
                            .and_then(|h| h.server_url.lock().ok().map(|u| u.clone()))
                    })
                    .unwrap_or_default();
                if url.is_empty() {
                    log::debug!("Copy URL: no URL recorded yet");
                } else if let Err(e) = write_clipboard(&url) {
                    log::warn!("Copy URL failed: {e}");
                }
            }
            "status_stop" => {
                //* Defer to the frontend instead of calling `proxy::stop_server`
                //  / `proxy::start_server` directly: the React store owns
                //  `serverStatus` and the start path needs the full Local API
                //  Server config (host/port/prefix/api_key/...) plus model
                //  loading. Routing through events keeps the UI, status hook
                //  and tray in sync without duplicating that logic in Rust.
                let state = app.state::<AppState>();
                let running = state
                    .tray_handles
                    .lock()
                    .ok()
                    .and_then(|g| {
                        g.as_ref()
                            .and_then(|h| h.is_running.lock().ok().map(|v| *v))
                    })
                    .unwrap_or(false);
                let event = if running {
                    "tray-stop-server"
                } else {
                    "tray-start-server"
                };
                if let Err(e) = app.emit(event, ()) {
                    log::warn!("Failed to emit {event}: {e}");
                }
            }
            id @ ("status_model_value" | "status_runtime_value") => {
                //* Open the app on Server → Engine & model with the matching
                //  picker already open. The frontend owns the routing (and
                //  knows when the first-run flow is on screen and should be
                //  left alone), so Rust only shows the window and says which
                //  row was clicked.
                show_main_window(app);
                let target = if id == "status_model_value" {
                    "model"
                } else {
                    "runtime"
                };
                if let Err(e) = app.emit("tray-open-model-config", target) {
                    log::warn!("Failed to emit tray-open-model-config: {e}");
                }
            }
            // Live status rows are non-interactive — clicking them is a no-op.
            "status_server"
            | "status_model_label"
            | "status_runtime_label"
            | "status_ram_text"
            | "status_ram_bar" => {}
            other => {
                log::debug!("tray menu item {other} not handled");
            }
        })
        .build(app)
}

pub fn setup_theme_listener<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    // Setup GTK window theme listener for main window
    if let Some(window) = app.get_webview_window("main") {
        setup_window_theme_listener(app.handle().clone(), window);
    }

    // On Linux, also listen to XDG Desktop Portal color-scheme changes via D-Bus.
    // This is needed because KDE Plasma and some other desktop environments
    // don't always update GTK settings when the system theme changes,
    // which means the GTK WindowEvent::ThemeChanged may never fire.
    #[cfg(target_os = "linux")]
    {
        let app_handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = setup_xdg_portal_theme_listener(app_handle).await {
                log::warn!("Failed to setup XDG Desktop Portal theme listener: {e}");
                log::warn!("System theme changes from KDE/non-GNOME DEs may not be detected");
            }
        });
    }

    Ok(())
}

/// Listen to the XDG Desktop Portal `org.freedesktop.appearance` `color-scheme`
/// setting via D-Bus. This fires reliably on KDE Plasma, GNOME, and other
/// freedesktop-compliant desktop environments.
#[cfg(target_os = "linux")]
async fn setup_xdg_portal_theme_listener<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<(), Box<dyn std::error::Error>> {
    use futures_util::StreamExt;
    use zbus::Connection;

    let connection = Connection::session().await?;

    // Build a proxy for the XDG Desktop Portal Settings interface
    let proxy: zbus::Proxy<'_> = zbus::proxy::Builder::new(&connection)
        .destination("org.freedesktop.portal.Desktop")?
        .path("/org/freedesktop/portal/desktop")?
        .interface("org.freedesktop.portal.Settings")?
        .build()
        .await?;

    // Listen for all SettingChanged signals and filter for color-scheme
    let mut signal_stream = proxy.receive_signal("SettingChanged").await?;

    log::info!("XDG Desktop Portal theme listener active");

    while let Some(signal) = signal_stream.next().await {
        let body = signal.body();
        if let Ok((namespace, key, value)) =
            body.deserialize::<(String, String, zbus::zvariant::OwnedValue)>()
        {
            if namespace == "org.freedesktop.appearance" && key == "color-scheme" {
                // color-scheme values: 0 = no preference, 1 = prefer dark, 2 = prefer light
                let color_scheme = u32::try_from(value).unwrap_or(0);
                let theme_str = match color_scheme {
                    1 => "dark",
                    2 => "light",
                    _ => "light", // default to light for "no preference"
                };
                log::info!(
                    "XDG Portal: system color-scheme changed to: {theme_str} (raw value: {color_scheme})"
                );
                let _ = app_handle.emit("theme-changed", theme_str);
            }
        }
    }

    Ok(())
}

/// Whether a StatusNotifier host (a bar with a tray module) is on the session
/// bus. The tray icon object exists either way — `libappindicator` does not
/// check — so this is what decides whether a hidden window has a visible way
/// back and a "Quit" entry. Asked at close time, not at startup: the bar may
/// start after the app does (autostart).
#[cfg(target_os = "linux")]
async fn status_notifier_host_registered() -> Result<bool, Box<dyn std::error::Error>> {
    use zbus::Connection;

    let connection = Connection::session().await?;
    let proxy: zbus::Proxy<'_> = zbus::proxy::Builder::new(&connection)
        .destination("org.kde.StatusNotifierWatcher")?
        .path("/StatusNotifierWatcher")?
        .interface("org.kde.StatusNotifierWatcher")?
        .cache_properties(zbus::proxy::CacheProperties::No)
        .build()
        .await?;
    let registered: bool = proxy.get_property("IsStatusNotifierHostRegistered").await?;
    Ok(registered)
}

/// Generation of the latest close decision. A close bumps it and acts on the
/// host lookup only while its generation is still current; the tray's "Open"
/// and a relaunch bump it too, so a decision still in flight cannot hide or
/// exit a window the user has just brought back, and two overlapping closes
/// cannot end in opposite outcomes.
#[cfg(target_os = "linux")]
static CLOSE_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Supersede any close decision still waiting on the StatusNotifier lookup.
#[cfg(target_os = "linux")]
pub fn cancel_pending_close() {
    CLOSE_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

fn setup_window_theme_listener<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    window: tauri::WebviewWindow<R>,
) {
    let window_label = window.label().to_string();
    let app_handle_clone = app_handle.clone();

    // The close handler hides the window instead of destroying it, so keep a
    // clone to call `hide()` from inside the event closure.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let window_for_close = window.clone();

    window.on_window_event(move |event| match event {
        WindowEvent::ThemeChanged(theme) => {
            let theme_str = match theme {
                tauri::Theme::Light => "light",
                tauri::Theme::Dark => "dark",
                _ => "auto",
            };
            log::info!("System theme changed to: {theme_str} for window: {window_label}");
            let _ = app_handle_clone.emit("theme-changed", theme_str);
        }
        // On macOS the red traffic-light button should send the app to the
        // background (keeping the llama.cpp server running) instead of quitting,
        // matching typical menu-bar app behavior. We hide both the window and the
        // application (NSApplication): `window.hide()` alone leaves the window in
        // Mission Control / the app switcher, while `app.hide()` alone leaves the
        // transparent vibrancy window painted on screen. Hide order matters —
        // hide the window first, then the app, then veto the close. The app is
        // restored via the dock icon (RunEvent::Reopen) or the tray "Open" item.
        // Real quit still goes through Cmd+Q / the tray "Quit" item, which trigger
        // RunEvent::Exit and the process cleanup.
        #[cfg(target_os = "macos")]
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if window_for_close.is_fullscreen().unwrap_or(false) {
                // macOS can't hide a window while it's in a native-fullscreen Space.
                // Leave fullscreen first (a brief, unavoidable exit animation), then
                // hide once the transition has settled — hiding mid-animation
                // black-screens the window. The next show is a normal window.
                let _ = window_for_close.set_fullscreen(false);
                let win = window_for_close.clone();
                let app = app_handle_clone.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
                    let _ = win.hide();
                    let _ = app.hide();
                });
            } else {
                let _ = window_for_close.hide();
                let _ = app_handle_clone.hide();
            }
        }
        // On Linux closing the only window used to exit the app, which stops
        // the local API server on :1337 that agents and editors are talking
        // to. While a tray icon is up *and something shows it*, closing hides
        // the window instead and the tray's "Open Atomic Chat" (or launching
        // the app again) brings it back; "Quit" still exits through
        // RunEvent::Exit. Without a tray, or without a StatusNotifier host to
        // display it (GNOME without an indicator extension, a bar with no tray
        // module), there would be no visible way back and no "Quit", so the
        // close exits as before. The host check is a D-Bus round trip, so the
        // close is vetoed first and the decision is made asynchronously.
        #[cfg(target_os = "linux")]
        WindowEvent::CloseRequested { api, .. } => {
            if app_handle_clone.tray_by_id("tray").is_some() {
                use std::sync::atomic::Ordering;

                api.prevent_close();
                let generation = CLOSE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
                let win = window_for_close.clone();
                let app = app_handle_clone.clone();
                tauri::async_runtime::spawn(async move {
                    let host = tokio::time::timeout(
                        std::time::Duration::from_secs(2),
                        status_notifier_host_registered(),
                    )
                    .await;
                    if CLOSE_GENERATION.load(Ordering::SeqCst) != generation {
                        log::debug!(
                            "Close decision superseded while the StatusNotifier lookup ran"
                        );
                        return;
                    }
                    match host {
                        Ok(Ok(true)) => {
                            let _ = win.hide();
                        }
                        Ok(Ok(false)) => {
                            log::info!("No StatusNotifier host on the session bus: close exits");
                            app.exit(0);
                        }
                        Ok(Err(e)) => {
                            log::info!("StatusNotifier host lookup failed ({e}): close exits");
                            app.exit(0);
                        }
                        Err(_) => {
                            log::info!("StatusNotifier host lookup timed out: close exits");
                            app.exit(0);
                        }
                    }
                });
            }
        }
        _ => {}
    });
}
