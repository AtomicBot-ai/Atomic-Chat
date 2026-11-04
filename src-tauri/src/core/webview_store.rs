//! A webview storage of its own for an app that must not share the usual one.
//!
//! Much of the frontend's state lives in the webview, not in the data folder:
//! localStorage holds projects, onboarding progress, provider and interface
//! settings. Moving the data folder therefore leaves all of that behind in the
//! default webview storage of the bundle (or, for an unbundled dev binary, of
//! the executable name), which every launch shares and which redirecting HOME
//! does not move. Both an end-to-end run (`core::e2e`) and an isolated QA/dev
//! profile (`ATOMIC_CHAT_PROFILE_DIR`) build their windows here instead.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::utils::config::WindowConfig;

/// Where the webview's data lives, inside a root, on platforms that take a
/// directory for it.
pub const WEBVIEW_DATA_DIR: &str = "webview";

/// Where one app's webviews keep their storage.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebviewStorage {
    /// The WebKit data store of WKWebView (macOS 14 and later). WebView2 and
    /// WebKitGTK ignore it.
    pub data_store_identifier: [u8; 16],
    /// The data directory of WebView2 and WebKitGTK. WKWebView has none.
    pub data_directory: PathBuf,
}

impl WebviewStorage {
    /// Storage named after `root` alone: the same path is always the same storage.
    pub fn derived_from(root: &Path) -> Self {
        Self {
            data_store_identifier: webview_data_store(root),
            data_directory: root.join(WEBVIEW_DATA_DIR),
        }
    }
}

/// A WebKit data store named after a root: the first 16 bytes of SHA-256 over
/// its path. Each root gets a store of its own that survives a restart.
pub fn webview_data_store(root: &Path) -> [u8; 16] {
    let digest = Sha256::digest(root.as_os_str().as_encoded_bytes());
    let mut store = [0u8; 16];
    store.copy_from_slice(&digest[..16]);
    store
}

/// Stops Tauri from creating the configured windows itself.
///
/// `data_store_identifier` in a window config is not carried into the webview
/// (tauri-runtime 2.10 copies `incognito` but not the identifier), so only a
/// builder can set it; `create_windows` builds the same windows from the same
/// config in `setup`.
pub fn take_over_windows<R: tauri::Runtime>(context: &mut tauri::Context<R>) {
    for window in &mut context.config_mut().app.windows {
        window.create = false;
    }
}

/// A configured window, with its webview kept in `storage`.
///
/// Both ways of giving a webview its own storage are set, with no platform
/// branch: WKWebView takes the data store identifier and has no data directory,
/// while WebView2 and WebKitGTK take the data directory and ignore the
/// identifier. Only the macOS half is verified.
pub fn window_builder<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    manager: &'a M,
    config: &WindowConfig,
    storage: &WebviewStorage,
) -> tauri::Result<tauri::WebviewWindowBuilder<'a, R, M>> {
    Ok(tauri::WebviewWindowBuilder::from_config(manager, config)?
        .data_store_identifier(storage.data_store_identifier)
        .data_directory(storage.data_directory.clone()))
}

/// Builds every configured window the way Tauri would, with its webview kept
/// in `storage`. Pairs with `take_over_windows`.
pub fn create_windows<R: tauri::Runtime>(
    app: &tauri::App<R>,
    storage: &WebviewStorage,
) -> tauri::Result<()> {
    for window in app.config().app.windows.clone() {
        window_builder(app.handle(), &window, storage)?.build()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_root_gets_its_own_stable_webkit_store() {
        let one = webview_data_store(Path::new("/runs/one"));

        assert_eq!(one, webview_data_store(Path::new("/runs/one")));
        assert_ne!(one, webview_data_store(Path::new("/runs/two")));
    }

    #[test]
    fn storage_derived_from_a_root_stays_inside_it() {
        let storage = WebviewStorage::derived_from(Path::new("/runs/one"));

        assert_eq!(storage.data_directory, Path::new("/runs/one/webview"));
        assert_eq!(
            storage.data_store_identifier,
            webview_data_store(Path::new("/runs/one"))
        );
        assert_ne!(
            storage,
            WebviewStorage::derived_from(Path::new("/runs/two"))
        );
    }

    #[test]
    fn tauri_is_told_not_to_create_any_configured_window() {
        let mut context: tauri::Context<tauri::test::MockRuntime> =
            tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().app.windows = vec![
            WindowConfig::default(),
            WindowConfig {
                label: "second".into(),
                ..Default::default()
            },
        ];

        take_over_windows(&mut context);

        assert!(context
            .config()
            .app
            .windows
            .iter()
            .all(|window| !window.create));
    }

    #[test]
    fn the_configured_windows_are_built_with_the_storage() {
        use tauri::Manager;

        let root = tempfile::tempdir().unwrap();
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().app.windows = vec![
            WindowConfig::default(),
            WindowConfig {
                label: "second".into(),
                ..Default::default()
            },
        ];
        take_over_windows(&mut context);
        let app = tauri::test::mock_builder().build(context).unwrap();
        assert!(app.webview_windows().is_empty());

        let storage = WebviewStorage::derived_from(root.path());
        create_windows(&app, &storage).unwrap();

        assert!(app.get_webview_window("main").is_some());
        assert!(app.get_webview_window("second").is_some());
        // Tauri creates the data directory it was given before the webview starts.
        assert!(storage.data_directory.is_dir());
    }
}
