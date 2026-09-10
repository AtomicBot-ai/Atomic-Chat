use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, Runtime, State};

use super::{
    constants::CONFIGURATION_FILE_NAME, helpers::copy_dir_recursive, models::AppConfiguration,
};
use crate::core::state::AppState;

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
                .expect("failed to create temporary Atomic Chat test data directory")
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

fn build_default_data_folder(data_dir: &Path, app_name: &str) -> PathBuf {
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

    // Primary path: data_dir/Jan  (e.g. ~/Library/Application Support/Jan on macOS)
    if let Some(data_dir) = dirs::data_dir() {
        let path = data_dir.join(package_name);
        if !path.exists() {
            let _ = fs::create_dir_all(&path);
        }
        return path.join(CONFIGURATION_FILE_NAME);
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
    let app_name = std::env::var("APP_NAME").unwrap_or_else(|_| "Atomic Chat".to_string());
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

        if let Err(err) = fs::write(
            &configuration_file,
            serde_json::to_string(&app_default_configuration).unwrap(),
        ) {
            log::error!("Failed to create default config: {err}");
        }

        return app_default_configuration;
    }

    match fs::read_to_string(&configuration_file) {
        Ok(content) => {
            match serde_json::from_str::<AppConfiguration>(&content) {
                Ok(app_configurations) => app_configurations,
                Err(err) => {
                    log::error!("Failed to parse app config, returning default config instead. Error: {err}");
                    app_default_configuration
                }
            }
        }
        Err(err) => {
            log::error!(
                "Failed to read app config, returning default config instead. Error: {err}"
            );
            app_default_configuration
        }
    }
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

    fs::write(
        configuration_file,
        serde_json::to_string(&configuration).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
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

    select_configuration_file_path(&app_path, &old_data_dir)
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
            build_default_data_folder(root.path(), "Atomic Chat"),
            root.path().join("Atomic Chat").join("data")
        );
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
        let default = root.path().join("Atomic Chat").join("data");

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
