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

/// The app identifier of one run: the build's, plus a tag derived from the run's root.
///
/// Whatever is named after the identifier alone is shared by every e2e app on the machine. The
/// one that matters is the single-instance socket (`/tmp/<identifier>_si.sock`): a second app
/// finds it, hands over to the first and exits with code 0, so two runs could never be up
/// together. With the root in the identifier each run is an installation of its own, and the
/// single-instance behaviour stays in the build under test — two apps on the *same* root still
/// meet.
pub fn run_identifier(base: &str, root: &Path) -> String {
    let digest = Sha256::digest(root.as_os_str().as_encoded_bytes());
    let tag: String = digest[..4].iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{base}.r{tag}")
}

pub fn namespace_identifier<R: tauri::Runtime>(context: &mut tauri::Context<R>) {
    let identifier = run_identifier(&context.config().identifier, &data_root());
    context.config_mut().identifier = identifier;
}

/// Both ways of giving a webview its own storage are set, with no platform
/// branch: WKWebView takes the data store identifier and has no data directory,
/// while WebView2 and WebKitGTK take the data directory and ignore the
/// identifier. Only the macOS half is verified; the other keeps the webview's
/// data inside the root, where it is deleted with the run.
pub fn create_windows<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let root = data_root();
    let store = webview_data_store(&root);
    let (x, y) = window_position(std::env::var(WINDOW_SLOT_ENV).ok().as_deref());
    for window in app.config().app.windows.clone() {
        tauri::WebviewWindowBuilder::from_config(app.handle(), &window)?
            .position(x, y)
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

/// Which of several apps running side by side this one is, counted from 1.
pub const WINDOW_SLOT_ENV: &str = "ATOMIC_E2E_WINDOW_SLOT";

/// Where a run's window goes. Runs in parallel each keep their window on top, and windows that
/// open in the same place cover each other completely — which is exactly what keeping them on top
/// was for. A cascade leaves a strip of every window uncovered, and a window that is partly
/// visible keeps getting its animation frames.
pub fn window_position(slot: Option<&str>) -> (f64, f64) {
    let slot = slot.and_then(|value| value.parse::<u32>().ok()).unwrap_or(1).clamp(1, 16);
    let step = f64::from(slot - 1) * 48.0;
    (40.0 + step, 40.0 + step)
}

/// Servers the core starts from the app's bundled binaries folder — `mlx-server`,
/// `foundation-models-server` — taken from the run's own root instead, when it has the folder. A
/// scenario that stands a scripted server in for one of them then changes nothing outside its
/// profile, and runs beside scenarios that must not see it.
pub const SIDECAR_DIR: &str = "sidecars";

pub fn sidecar_dir(root: &Path) -> Option<PathBuf> {
    let dir = root.join(SIDECAR_DIR);
    dir.is_dir().then_some(dir)
}

/// Where the commands of terminals that were not opened are written, one JSON
/// string per line.
pub const OPENED_TERMINALS_FILE: &str = "opened-terminals.jsonl";

/// Stands in for opening a terminal with an agent in it. The Launch page still
/// goes through the real command; the desktop of whoever runs the tests is left
/// alone, and a test can read exactly what would have been run.
pub fn record_terminal(root: &Path, command: &str) -> Result<(), String> {
    use std::io::Write;
    let line = serde_json::to_string(command).map_err(|error| error.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join(OPENED_TERMINALS_FILE))
        .map_err(|error| error.to_string())?;
    writeln!(file, "{line}").map_err(|error| error.to_string())
}

/// Answers the runner queued for the file dialogs the app is about to open,
/// one JSON value per line: a path, an array of paths, or `null` for "cancelled".
pub const DIALOG_ANSWERS_FILE: &str = "dialog-answers.jsonl";

/// Takes the next queued answer; `None` — what a cancelled dialog returns —
/// when nothing is queued, so an unexpected dialog never blocks a run.
pub fn take_dialog_answer(root: &Path) -> Option<serde_json::Value> {
    let file = root.join(DIALOG_ANSWERS_FILE);
    let queued = std::fs::read_to_string(&file).ok()?;
    let mut lines = queued.lines().filter(|line| !line.trim().is_empty());
    let next = lines.next()?.to_string();
    let rest: Vec<&str> = lines.collect();
    let _ = std::fs::write(&file, rest.join("\n"));
    match serde_json::from_str::<serde_json::Value>(&next).ok()? {
        serde_json::Value::Null => None,
        answer => Some(answer),
    }
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
  // The page's own console, newest last, bounded. The app does not forward it
  // to its log, and it is where the frontend explains what it just did.
  var lines = (window.__atomic_e2e_console = []);
  ['info', 'warn', 'error'].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      try {
        var text = Array.prototype.map.call(arguments, function (a) {
          return a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a);
        }).join(' ');
        lines.push(level + ': ' + text.slice(0, 600));
        if (lines.length > 400) lines.shift();
      } catch (e) {}
      return original.apply(console, arguments);
    };
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
    #[test]
    fn each_root_is_an_installation_of_its_own_and_the_same_root_is_the_same_one() {
        let a = super::run_identifier("chat.atomic.app.e2e", std::path::Path::new("/tmp/atomic-e2e-a"));
        let b = super::run_identifier("chat.atomic.app.e2e", std::path::Path::new("/tmp/atomic-e2e-b"));
        assert_ne!(a, b);
        assert!(a.starts_with("chat.atomic.app.e2e.r"));
        assert_eq!(a, super::run_identifier("chat.atomic.app.e2e", std::path::Path::new("/tmp/atomic-e2e-a")));
        // What the single-instance plugin turns into a socket name stays a plain word.
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '.'));
    }

    #[test]
    fn windows_of_parallel_runs_do_not_open_in_one_place() {
        assert_eq!(super::window_position(None), (40.0, 40.0));
        assert_eq!(super::window_position(Some("1")), (40.0, 40.0));
        assert_eq!(super::window_position(Some("3")), (136.0, 136.0));
        assert_eq!(super::window_position(Some("not a number")), (40.0, 40.0));
        assert_eq!(super::window_position(Some("400")), super::window_position(Some("16")));
    }

    #[test]
    fn a_run_brings_its_own_sidecars_only_when_it_has_the_folder() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(super::sidecar_dir(root.path()), None);
        std::fs::create_dir(root.path().join(super::SIDECAR_DIR)).unwrap();
        assert_eq!(super::sidecar_dir(root.path()), Some(root.path().join(super::SIDECAR_DIR)));
    }

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
    fn a_terminal_that_is_not_opened_is_written_down_verbatim() {
        let root = tempfile::tempdir().unwrap();

        record_terminal(root.path(), "codex").unwrap();
        record_terminal(root.path(), "KEY='a \"b\"' agent --flag").unwrap();

        let written = std::fs::read_to_string(root.path().join(OPENED_TERMINALS_FILE)).unwrap();
        let commands: Vec<String> = written
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(commands, vec!["codex", "KEY='a \"b\"' agent --flag"]);
    }

    #[test]
    fn dialog_answers_are_taken_in_order_and_run_out_as_cancelled() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join(DIALOG_ANSWERS_FILE),
            "\"/picked/folder\"\nnull\n[\"/a\",\"/b\"]\n",
        )
        .unwrap();

        assert_eq!(take_dialog_answer(root.path()), Some(serde_json::json!("/picked/folder")));
        assert_eq!(take_dialog_answer(root.path()), None);
        assert_eq!(take_dialog_answer(root.path()), Some(serde_json::json!(["/a", "/b"])));
        assert_eq!(take_dialog_answer(root.path()), None);
        assert_eq!(take_dialog_answer(tempfile::tempdir().unwrap().path()), None);
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
