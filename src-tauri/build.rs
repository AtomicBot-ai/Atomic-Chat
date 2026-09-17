use std::fs;
use std::path::Path;

/// Compile-time vars read via `option_env!` in `core::telemetry` that we allow a
/// local `src-tauri/.env` to populate for dev builds. CI sets these in the real
/// environment, which always takes precedence over the file (see `load_dotenv`).
const DOTENV_KEYS: &[&str] = &["SENTRY_DSN_DESKTOP", "SENTRY_RELEASE", "SENTRY_ENVIRONMENT"];

/// ATO-113 (dev convenience): let a gitignored `src-tauri/.env` feed the Sentry
/// compile-time vars so devs don't have to `export` them in every shell. Cargo
/// does not read `.env` itself, so we parse it here and emit `cargo:rustc-env`
/// — but only for keys NOT already present in the ambient environment, so a CI
/// `export` (the production path) is never overridden.
fn load_dotenv() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string());
    let env_path = Path::new(&manifest_dir).join(".env");

    println!("cargo:rerun-if-changed={}", env_path.display());
    for key in DOTENV_KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }

    let Ok(contents) = fs::read_to_string(&env_path) else {
        return;
    };

    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((raw_key, raw_val)) = line.split_once('=') else {
            continue;
        };
        let key = raw_key.trim();
        if !DOTENV_KEYS.contains(&key) {
            continue;
        }
        // Ambient env (CI export) wins; the file only fills the gap.
        if std::env::var(key).is_ok() {
            continue;
        }
        let val = raw_val.trim().trim_matches(|c| c == '"' || c == '\'');
        println!("cargo:rustc-env={key}={val}");
    }
}

/// Stamp the pinned `atomic-chat-core` version into the binary as
/// `ATOMIC_CORE_VERSION`.
///
/// The supervisor refuses to attach to a core whose version does not match this
/// string (PLAN.md §3.4: "With an incompatible version of the live owner — a clear
/// refusal"). The pin lives in one place, `package.json` → `atomicCore.version`,
/// because that is what `scripts/download-core.mjs` downloads and verifies; a
/// second copy here would let the bundled binary and the expectation drift.
///
/// A missing or unreadable `package.json` is not a build failure: the var is
/// read with `option_env!`, and a build without it simply cannot handshake —
/// which is the right outcome for a tree that has no pin.
fn stamp_core_version() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string());
    let pkg_path = Path::new(&manifest_dir).join("../package.json");
    println!("cargo:rerun-if-changed={}", pkg_path.display());

    let Ok(contents) = fs::read_to_string(&pkg_path) else {
        return;
    };
    if let Some(version) = core_version_from_package_json(&contents) {
        println!("cargo:rustc-env=ATOMIC_CORE_VERSION={version}");
    }
}

/// Pull `atomicCore.version` out of `package.json` without a JSON dependency:
/// `build.rs` runs before the crate's own dependency graph is useful, and the
/// shape we need is one string at a known key.
fn core_version_from_package_json(contents: &str) -> Option<String> {
    let after_key = contents.split_once("\"atomicCore\"")?.1;
    // Stop at the end of the `atomicCore` object, so an absent pin cannot pick
    // up the `"version"` of whatever block follows it.
    let block = after_key
        .split_once('}')
        .map_or(after_key, |(head, _)| head);
    let after_version = block.split_once("\"version\"")?.1;
    let after_colon = after_version.split_once(':')?.1;
    let rest = after_colon.trim_start();
    let quoted = rest.strip_prefix('"')?;
    let (value, _) = quoted.split_once('"')?;
    if value.is_empty() {
        return None;
    }
    Some(value.to_string())
}

/// Embed Common Controls v6 so Windows libtest harnesses can start.
///
/// Libtest binaries import `TaskDialogIndirect` / window-subclass APIs from
/// `comctl32.dll`. Without a v6 activation context they load the system v5
/// DLL and die at process start with `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139).
/// Keep this manifest test-only: Tauri embeds the application manifest in
/// `resource.lib`, and adding another manifest to the app binary creates a
/// duplicate resource with id 1.
#[cfg(all(windows, feature = "test-tauri"))]
fn embed_windows_test_manifest() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-test.manifest");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}

#[cfg(all(windows, feature = "test-tauri"))]
fn build_tauri() {
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    tauri_build::try_build(attributes).expect("failed to run Tauri build helpers");
}

#[cfg(not(all(windows, feature = "test-tauri")))]
fn build_tauri() {
    tauri_build::build();
}

fn main() {
    load_dotenv();
    stamp_core_version();

    #[cfg(all(windows, feature = "test-tauri"))]
    embed_windows_test_manifest();

    build_tauri()
}
