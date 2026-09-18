//! Isolation for desktop UI end-to-end builds (`--features e2e`).
//!
//! An e2e build is the shipped app plus a WebDriver server. A test runner starts
//! it on a developer's machine, next to that developer's own Atomic Chat, so
//! everything it would share with a real install is separated here, and the
//! build refuses to start when the runner did not say where its profile lives.
//! Nothing in this module exists in a build without the feature.

use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The directory a test run owns. The app config, the default data folder and
/// the WebKit data store are all derived from it.
pub const DATA_ROOT_ENV: &str = "ATOMIC_E2E_DATA_ROOT";

static DATA_ROOT: OnceLock<PathBuf> = OnceLock::new();

fn validate_root(value: Option<OsString>) -> Result<PathBuf, String> {
    let value = value.ok_or_else(|| format!("{DATA_ROOT_ENV} is not set"))?;
    let root = PathBuf::from(value);
    if !root.is_absolute() {
        return Err(format!(
            "{DATA_ROOT_ENV} must be an absolute path, got {}",
            root.display()
        ));
    }
    if !root.is_dir() {
        return Err(format!(
            "{DATA_ROOT_ENV} is not an existing directory: {}",
            root.display()
        ));
    }
    Ok(root)
}

/// Exits before anything is read or written when the run has no root of its
/// own. Without one the app would resolve the developer's real profile: the
/// default data folder is named after the product, not the bundle identifier.
pub fn require_root() {
    match validate_root(std::env::var_os(DATA_ROOT_ENV)) {
        Ok(root) => {
            let _ = DATA_ROOT.set(root);
        }
        Err(reason) => {
            eprintln!("refusing to start an end-to-end build: {reason}");
            std::process::exit(2);
        }
    }
}

/// The validated root. `require_root` runs first in `run()`, so this only
/// falls back to the environment in unit tests and AppHandle-free callers.
pub fn data_root() -> PathBuf {
    DATA_ROOT
        .get()
        .cloned()
        .or_else(|| validate_root(std::env::var_os(DATA_ROOT_ENV)).ok())
        .unwrap_or_else(|| {
            eprintln!("refusing to resolve a path in an end-to-end build without {DATA_ROOT_ENV}");
            std::process::exit(2);
        })
}

/// Where the app configuration lives instead of the identifier-named app-data dir.
pub fn config_file(root: &Path, file_name: &str) -> PathBuf {
    root.join(file_name)
}

/// The default data folder instead of `<data dir>/<product name>/data`.
pub fn default_data_folder(root: &Path) -> PathBuf {
    root.join("data")
}

fn is_inside(root: &Path, path: &Path) -> bool {
    path.is_absolute() && path.starts_with(root)
}

/// The last line of defence, checked once the data folder is actually
/// resolved: a stale `settings.json`, the legacy `CI=e2e` switch (which answers
/// `./data`) or a future resolver change must not move a test run outside its root.
pub fn require_inside_root(data_folder: &Path) {
    let root = data_root();
    if !is_inside(&root, data_folder) {
        eprintln!(
            "refusing to run an end-to-end build: the data folder {} is outside {}",
            data_folder.display(),
            root.display()
        );
        std::process::exit(2);
    }
}

/// Where the webview's data lives on platforms that take a directory for it.
pub const WEBVIEW_DATA_DIR: &str = "webview";

/// A WebKit data store of this run's own, named after its root.
///
/// The tests run an unbundled binary. WebKit keys the default store of such a
/// process by executable name (`~/Library/WebKit/Atomic-Chat`), which every dev
/// build shares, and redirecting HOME does not move it — so without this a test
/// run reads and rewrites the developer's own webview state (localStorage holds
/// onboarding, provider and backend settings). Deriving the store from the root
/// gives each profile a clean webview that still survives a restart.
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

/// Both ways of giving a webview its own storage are set, with no platform
/// branch: WKWebView takes the data store identifier and has no data directory,
/// while WebView2 and WebKitGTK take the data directory and ignore the
/// identifier. Only the macOS half is verified; the other keeps the webview's
/// data inside the root, where it is deleted with the run.
pub fn create_windows<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let root = data_root();
    let store = webview_data_store(&root);
    for window in app.config().app.windows.clone() {
        tauri::WebviewWindowBuilder::from_config(app.handle(), &window)?
            .data_store_identifier(store)
            .data_directory(root.join(WEBVIEW_DATA_DIR))
            // A window fully covered by others gets no animation frames from
            // WebKit. The app hides its splash overlay from one, so on a machine
            // somebody is working on the overlay stays over the whole UI and
            // swallows every click. Nothing can cover a window kept on top.
            .always_on_top(true)
            .build()?;
    }
    Ok(())
}

/// The file a runner may put in the root to start the webview with chosen
/// localStorage entries: a JSON object of key to stored string.
pub const WEBVIEW_SEED_FILE: &str = "webview-seed.json";

/// The key that records a profile's webview as seeded, so a relaunch on the
/// same profile keeps whatever the app has written since.
const SEEDED_MARKER: &str = "__atomic_e2e_seeded";

/// The script that seeds localStorage, or `None` when there is nothing to seed.
///
/// Frontend settings live in localStorage, and some defaults reach outside the
/// run: the local API server binds port 1337 on launch. A test cannot click
/// that off in time — the webview reads it while booting — and the run's WebKit
/// store is new, so the entries are written before any page script runs. JSON
/// is a subset of JavaScript, which makes the serialized map a valid literal.
fn seed_script(seed_json: &str) -> Result<Option<String>, String> {
    let entries: std::collections::BTreeMap<String, String> = serde_json::from_str(seed_json)
        .map_err(|error| format!("{WEBVIEW_SEED_FILE} must map keys to strings: {error}"))?;
    if entries.is_empty() {
        return Ok(None);
    }
    let literal = serde_json::to_string(&entries).map_err(|error| error.to_string())?;
    let marker = serde_json::to_string(SEEDED_MARKER).map_err(|error| error.to_string())?;
    Ok(Some(format!(
        "(function () {{
  try {{
    if (window.localStorage.getItem({marker}) !== null) return;
    var entries = {literal};
    for (var key in entries) window.localStorage.setItem(key, entries[key]);
    window.localStorage.setItem({marker}, '1');
  }} catch (error) {{
    // A document without storage access, such as about:blank.
  }}
}})();"
    )))
}

/// Collects what the page throws, for a failed test to save. A page that dies
/// while booting renders nothing and logs nothing on the Rust side, and
/// WebKit's WebDriver surface has no console log to ask for afterwards.
const ERROR_COLLECTOR_SCRIPT: &str = "(function () {
  var errors = (window.__atomic_e2e_errors = []);
  window.addEventListener('error', function (event) {
    errors.push(String(event.message) + ' @ ' + event.filename + ':' + event.lineno + ':' + event.colno +
      (event.error && event.error.stack ? '\\n' + event.error.stack : ''));
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    errors.push('unhandled rejection: ' + (reason && reason.stack ? reason.stack : String(reason)));
  });
})();";

/// Prepares every webview of the run: always the error collector, and the
/// entries of `<root>/webview-seed.json` when the runner wrote one. A malformed
/// file stops the run: a silently unseeded profile would bind the developer's
/// ports and fail somewhere far from the cause.
pub fn seed_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let seed_file = data_root().join(WEBVIEW_SEED_FILE);
    let seed = match std::fs::read_to_string(&seed_file) {
        Ok(seed_json) => seed_script(&seed_json).unwrap_or_else(|reason| {
            eprintln!("refusing to start an end-to-end build: {reason}");
            std::process::exit(2);
        }),
        Err(_) => None,
    };
    let script = format!("{ERROR_COLLECTOR_SCRIPT}\n{}", seed.unwrap_or_default());
    tauri::plugin::Builder::new("e2e-seed")
        .js_init_script(script)
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::utils::config::WindowConfig;

    #[test]
    fn a_run_without_an_absolute_existing_root_is_refused() {
        let existing = tempfile::tempdir().unwrap();

        assert!(validate_root(None).unwrap_err().contains("is not set"));
        assert!(validate_root(Some("relative/root".into()))
            .unwrap_err()
            .contains("absolute"));
        assert!(validate_root(Some(existing.path().join("missing").into()))
            .unwrap_err()
            .contains("not an existing directory"));
        assert_eq!(
            validate_root(Some(existing.path().into())).unwrap(),
            existing.path()
        );
    }

    #[test]
    fn the_config_and_the_default_data_folder_stay_inside_the_root() {
        let root = Path::new("/runs/one");

        assert_eq!(config_file(root, "settings.json"), Path::new("/runs/one/settings.json"));
        assert_eq!(default_data_folder(root), Path::new("/runs/one/data"));
    }

    #[test]
    fn only_absolute_paths_under_the_root_count_as_inside_it() {
        let root = Path::new("/runs/one");

        assert!(is_inside(root, Path::new("/runs/one/data")));
        assert!(is_inside(root, Path::new("/runs/one/moved/data")));
        assert!(!is_inside(root, Path::new("./data")));
        assert!(!is_inside(root, Path::new("/runs/one-other/data")));
        assert!(!is_inside(root, Path::new("/Users/dev/Library/Application Support/Atomic Chat/data")));
    }

    #[test]
    fn the_seed_script_writes_each_entry_once_per_profile() {
        let script = seed_script(r#"{"setting": "{\"state\":{\"on\":false}}", "quote": "it's \"q\""}"#)
            .unwrap()
            .unwrap();

        // The values arrive as JavaScript string literals, quotes escaped.
        assert!(script.contains(r#""setting":"{\"state\":{\"on\":false}}""#));
        assert!(script.contains(r#""quote":"it's \"q\"""#));
        // A relaunch must not overwrite what the app stored since the first one.
        assert!(script.contains(r#"getItem("__atomic_e2e_seeded") !== null) return;"#));
        assert!(script.contains(r#"setItem("__atomic_e2e_seeded", '1')"#));
    }

    #[test]
    fn an_empty_seed_injects_nothing_and_a_malformed_one_is_an_error() {
        assert_eq!(seed_script("{}").unwrap(), None);
        assert!(seed_script(r#"{"key": 1}"#).unwrap_err().contains("must map keys to strings"));
        assert!(seed_script("not json").unwrap_err().contains("webview-seed.json"));
    }

    #[test]
    fn each_root_gets_its_own_stable_webkit_store() {
        let one = webview_data_store(Path::new("/runs/one"));

        assert_eq!(one, webview_data_store(Path::new("/runs/one")));
        assert_ne!(one, webview_data_store(Path::new("/runs/two")));
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

        assert!(context.config().app.windows.iter().all(|window| !window.create));
    }
}
