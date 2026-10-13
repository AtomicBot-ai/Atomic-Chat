//! Where Radium gets an `ollama` program from: its own pinned copy under the
//! data folder, or one the user already installed.
//!
//! Radium's copy is the official Windows standalone build
//! (`ollama-windows-amd64.zip`, which carries the CLI and its GPU libraries),
//! pinned to one release and checked against the SHA-256 Ollama publishes
//! with it. Other systems use an Ollama the user installed; Radium still runs
//! and configures it.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// The release Radium installs.
pub const VERSION: &str = "0.34.4";

pub struct PinnedAsset {
    pub file_name: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    /// Download size as the release page lists it, for display before install.
    pub approx_bytes: u64,
}

/// The Windows x64 standalone build of [`VERSION`]. SHA-256 from the
/// release's published asset digests.
pub const WINDOWS_X64: PinnedAsset = PinnedAsset {
    file_name: "ollama-windows-amd64.zip",
    url: "https://github.com/ollama/ollama/releases/download/v0.34.4/ollama-windows-amd64.zip",
    sha256: "535193f38f3344e5b08f5d1c171c31ce11aa17f0124ff69ae26d8ec7fe06fa62",
    approx_bytes: 1_460_000_000,
};

/// The asset for this computer, if Radium installs Ollama here.
pub fn pinned_asset() -> Option<&'static PinnedAsset> {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Some(&WINDOWS_X64)
    } else {
        None
    }
}

/// `runtimes/ollama` under the data folder: settings, Radium's copy, logs.
pub fn home(data_dir: &Path) -> PathBuf {
    data_dir.join("runtimes").join("ollama")
}

pub fn install_dir(data_dir: &Path) -> PathBuf {
    home(data_dir).join(format!("v{VERSION}"))
}

/// Relative to the data folder, as the download manager expects.
pub fn archive_save_path(asset: &PinnedAsset) -> String {
    format!("runtimes/ollama/{}", asset.file_name)
}

pub fn settings_path(data_dir: &Path) -> PathBuf {
    home(data_dir).join("settings.json")
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "ollama.exe"
    } else {
        "ollama"
    }
}

/// Finds the `ollama` executable in `dir` or one level below (the archive
/// layout is not something to depend on).
pub fn find_exe_in(dir: &Path) -> Option<PathBuf> {
    let direct = dir.join(exe_name());
    if direct.is_file() {
        return Some(direct);
    }
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path().join(exe_name()))
        .find(|candidate| candidate.is_file())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BinarySource {
    /// Radium's pinned copy under the data folder.
    Radium,
    /// An Ollama the user installed.
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binary {
    pub path: PathBuf,
    pub source: BinarySource,
}

/// Where a user-installed Ollama usually lives, in the order checked.
fn system_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local).join("Programs").join("Ollama").join("ollama.exe"));
        }
    } else {
        candidates.push(PathBuf::from("/usr/local/bin/ollama"));
        candidates.push(PathBuf::from("/usr/bin/ollama"));
        candidates.push(PathBuf::from("/opt/homebrew/bin/ollama"));
        candidates.push(PathBuf::from("/Applications/Ollama.app/Contents/Resources/ollama"));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join(exe_name()));
        }
    }
    candidates
}

/// The `ollama` to run: Radium's copy if installed, else the user's.
pub fn resolve(data_dir: &Path) -> Option<Binary> {
    resolve_with(data_dir, system_candidates())
}

pub fn resolve_with(data_dir: &Path, system: Vec<PathBuf>) -> Option<Binary> {
    if let Some(path) = find_exe_in(&install_dir(data_dir)) {
        return Some(Binary {
            path,
            source: BinarySource::Radium,
        });
    }
    system
        .into_iter()
        .find(|candidate| candidate.is_file())
        .map(|path| Binary {
            path,
            source: BinarySource::System,
        })
}

/// Ollama's own default models folder, or the user's `OLLAMA_MODELS`, which
/// Radium keeps using so nothing is downloaded twice.
pub fn default_models_dir() -> Option<PathBuf> {
    if let Some(custom) = std::env::var_os("OLLAMA_MODELS") {
        return Some(PathBuf::from(custom));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    Some(PathBuf::from(home).join(".ollama").join("models"))
}

/// Unpacks a downloaded archive into [`install_dir`], then removes it.
pub fn finish_install(data_dir: &Path, asset: &PinnedAsset) -> Result<PathBuf, String> {
    let archive = data_dir.join(archive_save_path(asset));
    let target = install_dir(data_dir);
    // Unpack beside the target first, so a failed unpack never leaves a
    // half-installed copy that `resolve` would pick up.
    let staging = home(data_dir).join(format!(".v{VERSION}.partial"));
    let _ = std::fs::remove_dir_all(&staging);
    crate::core::media::runtime::unpack_archive(&archive, &staging)?;
    if find_exe_in(&staging).is_none() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("{} does not contain {}", asset.file_name, exe_name()));
    }
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&staging, &target).map_err(|error| error.to_string())?;
    let _ = std::fs::remove_file(&archive);
    find_exe_in(&target).ok_or_else(|| "Ollama was unpacked but not found".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"").unwrap();
    }

    #[test]
    fn the_pin_is_a_real_sha256_on_the_official_release() {
        assert_eq!(WINDOWS_X64.sha256.len(), 64);
        assert!(WINDOWS_X64.sha256.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(WINDOWS_X64
            .url
            .starts_with("https://github.com/ollama/ollama/releases/download/"));
        assert!(WINDOWS_X64.url.contains(&format!("v{VERSION}/")));
        assert!(WINDOWS_X64.url.ends_with(WINDOWS_X64.file_name));
    }

    #[test]
    fn radiums_copy_wins_over_a_system_install() {
        let data = tempfile::tempdir().unwrap();
        let system = tempfile::tempdir().unwrap();
        let system_exe = system.path().join(exe_name());
        touch(&system_exe);

        let found = resolve_with(data.path(), vec![system_exe.clone()]).unwrap();
        assert_eq!(found.source, BinarySource::System);

        touch(&install_dir(data.path()).join("nested").join(exe_name()));
        let found = resolve_with(data.path(), vec![system_exe]).unwrap();
        assert_eq!(found.source, BinarySource::Radium);
    }

    #[test]
    fn nothing_installed_resolves_to_none() {
        let data = tempfile::tempdir().unwrap();
        assert!(resolve_with(data.path(), vec![data.path().join("nope")]).is_none());
    }

    fn zip_with(path: &Path, entries: &[&str]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        for name in entries {
            zip.start_file(*name, zip::write::FileOptions::default()).unwrap();
            zip.write_all(b"x").unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn install_unpacks_moves_into_place_and_removes_the_archive() {
        let data = tempfile::tempdir().unwrap();
        let archive = data.path().join(archive_save_path(&WINDOWS_X64));
        zip_with(&archive, &[exe_name(), "lib/ollama/cuda_v12/ggml-cuda.dll"]);
        let exe = finish_install(data.path(), &WINDOWS_X64).unwrap();
        assert_eq!(exe, install_dir(data.path()).join(exe_name()));
        assert!(!archive.exists());
        assert!(install_dir(data.path()).join("lib/ollama/cuda_v12/ggml-cuda.dll").exists());
    }

    #[test]
    fn an_archive_without_ollama_is_refused_and_leaves_nothing_behind() {
        let data = tempfile::tempdir().unwrap();
        let archive = data.path().join(archive_save_path(&WINDOWS_X64));
        zip_with(&archive, &["readme.txt"]);
        let error = finish_install(data.path(), &WINDOWS_X64).unwrap_err();
        assert!(error.contains("does not contain"), "{error}");
        assert!(!install_dir(data.path()).exists());
        assert!(resolve_with(data.path(), vec![]).is_none());
    }
}
