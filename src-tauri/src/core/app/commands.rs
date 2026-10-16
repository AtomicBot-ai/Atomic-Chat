use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, Runtime, State};

use super::{
    constants::CONFIGURATION_FILE_NAME, helpers::copy_dir_recursive, models::AppConfiguration,
};
use crate::core::state::AppState;

/// `identifier` in `tauri.conf.json`, for code that runs without an `AppHandle`.
const APP_IDENTIFIER: &str = "chat.atomic.app";

#[cfg(test)]
thread_local! {
    static TEST_DATA_DIR: std::cell::RefCell<Option<tempfile::TempDir>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn fallback_test_data_folder() -> PathBuf {
    TEST_DATA_DIR.with(|dir| {
        let mut dir = dir.borrow_mut();
        let temp_dir = dir.get_or_insert_with(|| {
            tempfile::Builder::new()
                .prefix("atomic-chat-test-data-")
                .tempdir()
                .expect("failed to create temporary Radium test data directory")
        });
        temp_dir.path().to_path_buf()
    })
}

fn select_configuration_file_path(current_dir: &Path, legacy_dir: &Path) -> PathBuf {
    let parent = if legacy_dir.exists() {
        legacy_dir
    } else {
        current_dir
    };
    parent.join(CONFIGURATION_FILE_NAME)
}

pub(crate) fn build_default_data_folder(data_dir: &Path, app_name: &str) -> PathBuf {
    data_dir.join(app_name).join("data")
}

fn resolve_data_folder_from_config(config_file: &Path, default_folder: &Path) -> PathBuf {
    fs::read_to_string(config_file)
        .ok()
        .and_then(|content| serde_json::from_str::<AppConfiguration>(&content).ok())
        .map(|config| PathBuf::from(config.data_folder))
        .unwrap_or_else(|| default_folder.to_path_buf())
}

/// Resolve the Jan config file path without an AppHandle (for CLI use).
/// Mirrors the logic in get_configuration_file_path() using the dirs crate.
pub fn resolve_config_file_path() -> PathBuf {
    let package_name = env!("CARGO_PKG_NAME");

    // On Linux, prefer the XDG config dir first (matches Tauri behaviour)
    #[cfg(target_os = "linux")]
    if let Some(config_dir) = dirs::config_dir() {
        let path = config_dir.join(package_name);
        if path.exists() {
            return path.join(CONFIGURATION_FILE_NAME);
        }
    }

    // The same choice the app makes in `get_configuration_file_path`: the
    // legacy `CARGO_PKG_NAME` folder while it exists, otherwise the identifier
    // folder. Read-only on purpose. Creating the legacy folder here used to
    // switch the app over to it silently on its next launch (ADR 2026-09-13).
    if let Some(data_dir) = dirs::data_dir() {
        return select_configuration_file_path(
            &data_dir.join(APP_IDENTIFIER),
            &data_dir.join(package_name),
        );
    }

    // Last resort: home directory
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(home).join(CONFIGURATION_FILE_NAME)
}

/// Resolve the Jan data folder path without an AppHandle (for CLI use).
/// Reads AppConfiguration from the config file; falls back to the default location.
pub fn resolve_jan_data_folder() -> PathBuf {
    let config_file = resolve_config_file_path();
    let app_name = std::env::var("APP_NAME").unwrap_or_else(|_| "Radium".to_string());
    let data_dir = dirs::data_dir().unwrap_or_else(|| {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        PathBuf::from(home)
    });
    let default_folder = build_default_data_folder(&data_dir, &app_name);
    resolve_data_folder_from_config(&config_file, &default_folder)
}

#[tauri::command]
pub fn get_app_configurations<R: Runtime>(app_handle: tauri::AppHandle<R>) -> AppConfiguration {
    let mut app_default_configuration = AppConfiguration::default();

    if std::env::var("CI").unwrap_or_default() == "e2e" {
        return app_default_configuration;
    }

    let configuration_file = get_configuration_file_path(app_handle.clone());

    let default_data_folder = default_data_folder_path(app_handle.clone());

    if !configuration_file.exists() {
        log::info!("App config not found, creating default config at {configuration_file:?}");

        app_default_configuration = AppConfiguration::new_install();
        app_default_configuration.data_folder = default_data_folder;

        // On a clean install the app-data directory (e.g. on Windows
        // `…\Roaming\chat.atomic.app`) does not exist yet, so `fs::write`
        // alone fails with os error 3 and the config is never persisted.
        if let Some(parent) = configuration_file.parent() {
            if let Err(err) = fs::create_dir_all(parent) {
                log::error!("Failed to create config dir {parent:?}: {err}");
            }
        }

        if let Err(err) = write_configuration_file(&configuration_file, &app_default_configuration)
        {
            log::error!("Failed to create default config: {err}");
        }

        return app_default_configuration;
    }

    load_configuration_file(&configuration_file, &default_data_folder)
}

/// Reads `settings.json`, and copes when it is unusable.
///
/// It used to fall back to `AppConfiguration::default()`, whose data folder is
/// the *relative* path `./data`: resolved against whatever directory the app
/// was started from. A blue screen seconds after the file was written left it
/// as zero bytes on the owner's machine (2026-10-14), and from then on every
/// launch silently used a second, empty data folder - inside the install
/// folder when started from the Start menu (where `decompress` then refused
/// every engine archive and the window hung), or `C:\Windows\system32\data`
/// when started from an elevated shell (where the log folder could not be
/// created and the process died before writing a line).
///
/// Now an unparsable file is moved aside to `settings.json.corrupt-<secs>` and
/// replaced with a valid one that points at the default data folder, which is
/// absolute. A file that cannot be read at all (locked, permissions) is left
/// alone, and the default data folder is used for this call.
fn load_configuration_file(
    configuration_file: &Path,
    default_data_folder: &str,
) -> AppConfiguration {
    let fallback = || AppConfiguration {
        data_folder: default_data_folder.to_string(),
        ..AppConfiguration::default()
    };

    let content = match fs::read_to_string(configuration_file) {
        Ok(content) => content,
        Err(err) => {
            log::error!(
                "Failed to read app config {configuration_file:?}; using the default data folder {default_data_folder} for now. Error: {err}"
            );
            return fallback();
        }
    };

    match serde_json::from_str::<AppConfiguration>(&content) {
        Ok(configuration) => configuration,
        Err(err) => {
            let repaired = fallback();
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_secs())
                .unwrap_or_default();
            let mut aside = configuration_file.as_os_str().to_owned();
            aside.push(format!(".corrupt-{stamp}"));
            let aside = PathBuf::from(aside);
            // Another caller may have repaired it a moment ago; that is fine.
            let moved = fs::rename(configuration_file, &aside);
            let rewritten = write_configuration_file(configuration_file, &repaired);
            log::error!(
                "App config {configuration_file:?} is unreadable ({err}); kept it as {aside:?} ({}), wrote a new one pointing at {default_data_folder} ({})",
                if moved.is_ok() { "moved" } else { "could not move it" },
                match &rewritten {
                    Ok(()) => "ok".to_string(),
                    Err(write_err) => format!("failed: {write_err}"),
                }
            );
            repaired
        }
    }
}

/// Writes `settings.json` so that a crash can never leave it half-written:
/// the new content goes to a temporary file that is flushed to disk, then
/// renamed over the old one. A plain `fs::write` was what a blue screen turned
/// into a file of zero bytes.
fn write_configuration_file(
    configuration_file: &Path,
    configuration: &AppConfiguration,
) -> Result<(), String> {
    use std::io::Write;

    let json = serde_json::to_string(configuration).map_err(|e| e.to_string())?;
    let mut temporary = configuration_file.as_os_str().to_owned();
    temporary.push(".tmp");
    let temporary = PathBuf::from(temporary);
    {
        let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
        file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&temporary, configuration_file).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_app_configuration<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    configuration: AppConfiguration,
) -> Result<(), String> {
    let configuration_file = get_configuration_file_path(app_handle);
    log::info!("update_app_configuration, configuration_file: {configuration_file:?}");

    // Ensure the parent dir exists before writing — on a clean install it may
    // not (os error 3), which silently drops every config update.
    if let Some(parent) = configuration_file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    write_configuration_file(&configuration_file, &configuration)
}

#[tauri::command]
pub fn get_jan_data_folder_path<R: Runtime>(app_handle: tauri::AppHandle<R>) -> PathBuf {
    #[cfg(test)]
    if let Some(root) = app_handle.try_state::<crate::test_support::TestDataRoot>() {
        return root.0.clone();
    }

    #[cfg(test)]
    return fallback_test_data_folder();

    #[cfg(not(test))]
    let app_configurations = get_app_configurations(app_handle);
    #[cfg(not(test))]
    PathBuf::from(app_configurations.data_folder)
}

#[tauri::command]
pub fn get_configuration_file_path<R: Runtime>(app_handle: tauri::AppHandle<R>) -> PathBuf {
    let (current_dir, legacy_dir) = configuration_dirs(&app_handle);
    select_configuration_file_path(&current_dir, &legacy_dir)
}

/// The two folders `settings.json` can live in, as `(current, legacy)`: the
/// identifier folder from `app_data_dir()`, and the older `CARGO_PKG_NAME`
/// folder, which wins while it exists. Shared with the data-folder migration so
/// both agree on which settings the app reads.
pub fn configuration_dirs<R: Runtime>(app_handle: &tauri::AppHandle<R>) -> (PathBuf, PathBuf) {
    let app_path = app_handle.path().app_data_dir().unwrap_or_else(|err| {
        log::error!("Failed to get app data directory: {err}. Using home directory instead.");

        let home_dir = std::env::var(if cfg!(target_os = "windows") {
            "USERPROFILE"
        } else {
            "HOME"
        })
        .expect("Failed to determine the home directory");

        PathBuf::from(home_dir)
    });

    let package_name = env!("CARGO_PKG_NAME");
    #[cfg(target_os = "linux")]
    let old_data_dir = {
        if let Some(config_path) = dirs::config_dir() {
            config_path.join(package_name)
        } else {
            log::debug!("Could not determine config directory");
            app_path
                .parent()
                .unwrap_or(&app_path.join("../"))
                .join(package_name)
        }
    };

    #[cfg(not(target_os = "linux"))]
    let old_data_dir = app_path
        .parent()
        .unwrap_or(&app_path.join("../"))
        .join(package_name);

    (app_path, old_data_dir)
}

#[tauri::command]
pub fn default_data_folder_path<R: Runtime>(app_handle: tauri::AppHandle<R>) -> String {
    let mut path = app_handle.path().data_dir().unwrap_or_else(|err| {
        log::error!("Failed to get data directory: {err}. Falling back to home directory.");
        let home = std::env::var(if cfg!(target_os = "windows") {
            "USERPROFILE"
        } else {
            "HOME"
        })
        .unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home)
    });

    let app_name = std::env::var("APP_NAME")
        .unwrap_or_else(|_| app_handle.config().product_name.clone().unwrap());
    path = build_default_data_folder(&path, &app_name);

    let mut path_str = path.to_string_lossy().into_owned();

    if let Some(stripped) = path_str.strip_suffix(".ai.app") {
        path_str = stripped.to_string();
    }

    path_str
}

#[tauri::command]
pub fn get_user_home_path<R: Runtime>(app: AppHandle<R>) -> String {
    get_app_configurations(app.clone()).data_folder
}

#[tauri::command]
pub fn change_app_data_folder<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    new_data_folder: String,
) -> Result<(), String> {
    // Get current data folder path
    let current_data_folder = get_jan_data_folder_path(app_handle.clone());
    let new_data_folder_path = PathBuf::from(&new_data_folder);

    // Create the new data folder if it doesn't exist
    if !new_data_folder_path.exists() {
        fs::create_dir_all(&new_data_folder_path)
            .map_err(|e| format!("Failed to create new data folder: {e}"))?;
    }

    // Copy all files from the old folder to the new one
    if current_data_folder.exists() {
        log::info!("Copying data from {current_data_folder:?} to {new_data_folder_path:?}");

        // Check if this is a parent directory to avoid infinite recursion
        if new_data_folder_path.starts_with(&current_data_folder) {
            return Err(
                "New data folder cannot be a subdirectory of the current data folder".to_string(),
            );
        }
        copy_dir_recursive(
            &current_data_folder,
            &new_data_folder_path,
            &[".uvx", ".npx", "openclaw"],
        )
        .map_err(|e| format!("Failed to copy data to new folder: {e}"))?;
    } else {
        log::info!("Current data folder does not exist, nothing to copy");
    }

    // Update the configuration to point to the new folder
    let mut configuration = get_app_configurations(app_handle.clone());
    configuration.data_folder = new_data_folder;

    // Save the updated configuration
    update_app_configuration(app_handle, configuration)
}

#[tauri::command]
pub fn app_token(state: State<'_, AppState>) -> Option<String> {
    state.app_token.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn removes_fallback_test_data_when_its_thread_exits() {
        let path = std::thread::spawn(fallback_test_data_folder)
            .join()
            .unwrap();

        assert!(path.starts_with(std::env::temp_dir()));
        assert!(!path.exists());
    }

    #[test]
    fn selects_current_config_for_a_clean_install() {
        let root = tempdir().unwrap();
        let current = root.path().join("chat.atomic.app");
        let legacy = root.path().join("Atomic-Chat");

        assert_eq!(
            select_configuration_file_path(&current, &legacy),
            current.join(CONFIGURATION_FILE_NAME)
        );
    }

    #[test]
    fn selects_legacy_config_when_only_legacy_directory_exists() {
        let root = tempdir().unwrap();
        let current = root.path().join("chat.atomic.app");
        let legacy = root.path().join("Atomic-Chat");
        fs::create_dir_all(&legacy).unwrap();

        assert_eq!(
            select_configuration_file_path(&current, &legacy),
            legacy.join(CONFIGURATION_FILE_NAME)
        );
    }

    #[test]
    fn keeps_legacy_precedence_when_both_config_directories_exist() {
        let root = tempdir().unwrap();
        let current = root.path().join("chat.atomic.app");
        let legacy = root.path().join("Atomic-Chat");
        fs::create_dir_all(&current).unwrap();
        fs::create_dir_all(&legacy).unwrap();

        assert_eq!(
            select_configuration_file_path(&current, &legacy),
            legacy.join(CONFIGURATION_FILE_NAME)
        );
    }

    #[test]
    fn builds_the_active_default_data_folder() {
        let root = tempdir().unwrap();

        assert_eq!(
            build_default_data_folder(root.path(), "Radium"),
            root.path().join("Radium").join("data")
        );
    }

    /// A blue screen seconds after `settings.json` was written left it as 102
    /// zero bytes (2026-10-14). The app then used the relative `./data` and
    /// built a second, broken data folder wherever it was started from.
    #[test]
    fn a_zeroed_settings_file_is_set_aside_and_replaced_with_the_default_folder() {
        let root = tempdir().unwrap();
        let config_file = root.path().join(CONFIGURATION_FILE_NAME);
        fs::write(&config_file, [0u8; 102]).unwrap();
        let default = root.path().join("Radium").join("data");
        let default = default.to_string_lossy().into_owned();

        let loaded = load_configuration_file(&config_file, &default);

        assert_eq!(loaded.data_folder, default);
        let rewritten: AppConfiguration =
            serde_json::from_str(&fs::read_to_string(&config_file).unwrap()).unwrap();
        assert_eq!(rewritten.data_folder, default);
        let kept: Vec<_> = fs::read_dir(root.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("settings.json.corrupt-"))
            .collect();
        assert_eq!(kept.len(), 1, "the damaged file is kept beside the new one");
        assert_eq!(
            fs::read(root.path().join(&kept[0])).unwrap(),
            vec![0u8; 102]
        );
        // The next launch reads the repaired file as it is.
        assert_eq!(
            load_configuration_file(&config_file, "unused").data_folder,
            default
        );
    }

    #[test]
    fn an_unreadable_settings_file_is_left_alone_and_the_default_folder_used() {
        let root = tempdir().unwrap();
        // A directory where the file should be cannot be read as one.
        let config_file = root.path().join(CONFIGURATION_FILE_NAME);
        fs::create_dir_all(&config_file).unwrap();
        let default = root.path().join("Radium").join("data");
        let default = default.to_string_lossy().into_owned();

        assert_eq!(
            load_configuration_file(&config_file, &default).data_folder,
            default
        );
        assert!(config_file.is_dir());
    }

    #[test]
    fn settings_are_written_through_a_flushed_temporary_file() {
        let root = tempdir().unwrap();
        let config_file = root.path().join(CONFIGURATION_FILE_NAME);
        fs::write(&config_file, "{\"data_folder\":\"old\"}").unwrap();
        let configuration = AppConfiguration {
            data_folder: "new".to_string(),
            ..AppConfiguration::default()
        };

        write_configuration_file(&config_file, &configuration).unwrap();

        let written: AppConfiguration =
            serde_json::from_str(&fs::read_to_string(&config_file).unwrap()).unwrap();
        assert_eq!(written.data_folder, "new");
        assert!(!root
            .path()
            .join(format!("{CONFIGURATION_FILE_NAME}.tmp"))
            .exists());
    }

    #[test]
    fn resolves_custom_data_folder_from_settings() {
        let root = tempdir().unwrap();
        let config_file = root.path().join(CONFIGURATION_FILE_NAME);
        let custom = root.path().join("custom-model-data");
        let configuration = AppConfiguration {
            data_folder: custom.to_string_lossy().into_owned(),
            ..AppConfiguration::default()
        };
        fs::write(&config_file, serde_json::to_vec(&configuration).unwrap()).unwrap();

        assert_eq!(
            resolve_data_folder_from_config(&config_file, &root.path().join("default")),
            custom
        );
    }

    #[test]
    fn falls_back_to_default_data_folder_without_valid_settings() {
        let root = tempdir().unwrap();
        let config_file = root.path().join(CONFIGURATION_FILE_NAME);
        let default = root.path().join("Radium").join("data");

        assert_eq!(
            resolve_data_folder_from_config(&config_file, &default),
            default
        );

        fs::write(&config_file, "{not-json").unwrap();
        assert_eq!(
            resolve_data_folder_from_config(&config_file, &default),
            default
        );
    }
}
