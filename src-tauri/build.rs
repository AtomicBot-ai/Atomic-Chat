#[cfg(all(windows, feature = "test-tauri"))]
use std::path::Path;

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
    #[cfg(all(windows, feature = "test-tauri"))]
    embed_windows_test_manifest();

    #[cfg(not(feature = "cli"))]
    build_tauri()
}
