//! Windows-only notification helpers: AppUserModelID registration for Toast
//! notifications, and the one-time close-to-tray notice.
//!
//! Windows ToastNotificationManager silently drops notifications whose AUMID
//! is not registered in the system. In packaged NSIS builds the installer
//! creates a Start Menu shortcut that registers the AUMID; in `tauri dev`
//! no such shortcut exists, so we register a minimal HKCU entry ourselves.

use tauri::{AppHandle, Runtime};

#[cfg(target_os = "windows")]
pub fn ensure_aumid_registered(aumid: &str, display_name: &str) -> std::io::Result<()> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = format!("Software\\Classes\\AppUserModelId\\{aumid}");
    let (key, _) = hkcu.create_subkey(&path)?;
    key.set_value("DisplayName", &display_name.to_string())?;
    Ok(())
}

/// The `store.json` key that remembers the close-to-tray notice was shown.
const CLOSE_TO_TRAY_NOTICE_KEY: &str = "close_to_tray_notice_shown";

/// Tell the person, once per install, that closing the window kept the app running in the tray
/// (`setup::windows_close_action`). Recorded in the app's `store.json` only after the notice was
/// handed to the system. Runs on the blocking pool: the store is a file.
pub fn show_close_to_tray_notice_once<R: Runtime>(app: &AppHandle<R>, body: &'static str) {
    use tauri_plugin_notification::NotificationExt;
    use tauri_plugin_store::StoreExt;

    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path =
            crate::core::app::commands::get_jan_data_folder_path(app.clone()).join("store.json");
        let store = match app.store(path) {
            Ok(store) => store,
            Err(e) => {
                log::warn!("Close-to-tray notice skipped: store unavailable: {e}");
                return;
            }
        };
        if store
            .get(CLOSE_TO_TRAY_NOTICE_KEY)
            .and_then(|shown| shown.as_bool())
            .unwrap_or(false)
        {
            return;
        }
        match app
            .notification()
            .builder()
            .title("Atomic Chat is still running")
            .body(body)
            .show()
        {
            Ok(()) => {
                store.set(CLOSE_TO_TRAY_NOTICE_KEY, true);
                if let Err(e) = store.save() {
                    log::warn!("Could not record the close-to-tray notice: {e}");
                }
            }
            Err(e) => log::warn!("Could not show the close-to-tray notice: {e}"),
        }
    });
}
