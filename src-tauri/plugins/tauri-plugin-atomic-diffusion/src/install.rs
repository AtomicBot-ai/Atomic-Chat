//! Engine-binary installs under `<dataFolder>/diffusion/backends/<tag>/<backendId>/`
//! and the model-file store under `<dataFolder>/diffusion/models/`.
//!
//! The download and extraction happen in the web app through the ordinary
//! download pipeline; this module finalises a tree (permissions, ownership
//! marker, install record, sanity probe) and refuses to delete anything it
//! did not mark as its own.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{DiffusionError, DiffusionErrorCode, DiffusionResult};
use crate::process::{CLI_BINARY, SERVER_BINARY};
use crate::state::{now_ms, BackendInstallRecord, DiffusionBackend, EngineKind, ModelFile};
use jan_utils::{canonicalize_existing_prefix, is_within};

pub const OWNER_MARKER: &str = ".atomic-owned";
pub const INSTALL_RECORD: &str = "install.json";
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const PROBE_MARKERS: [&str; 2] = ["stable-diffusion.cpp", "--cfg-scale"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeBackendInstallArgs {
    pub dir: String,
    pub tag: String,
    pub backend_id: String,
    pub backend: DiffusionBackend,
    pub engine: EngineKind,
    #[serde(default)]
    pub sha256: Option<String>,
}

/// On-disk shape of `install.json`. Same fields as the record minus `dir`,
/// which is where the file lives.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallRecordFile {
    tag: String,
    backend_id: String,
    backend: DiffusionBackend,
    engine: EngineKind,
    #[serde(default)]
    sha256: Option<String>,
    installed_at_ms: u64,
}

pub fn write_install_record(dir: &Path, record: &BackendInstallRecord) -> DiffusionResult<()> {
    let file = InstallRecordFile {
        tag: record.tag.clone(),
        backend_id: record.backend_id.clone(),
        backend: record.backend,
        engine: record.engine,
        sha256: record.sha256.clone(),
        installed_at_ms: record.installed_at_ms,
    };
    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| DiffusionError::internal(format!("install record: {e}")))?;
    std::fs::write(dir.join(OWNER_MARKER), b"atomic-chat\n")
        .map_err(|e| DiffusionError::io("Could not write the ownership marker.", &e))?;
    std::fs::write(dir.join(INSTALL_RECORD), json)
        .map_err(|e| DiffusionError::io("Could not write the install record.", &e))
}

pub fn read_install_record(dir: &Path) -> Option<BackendInstallRecord> {
    let text = std::fs::read_to_string(dir.join(INSTALL_RECORD)).ok()?;
    let file: InstallRecordFile = serde_json::from_str(&text).ok()?;
    Some(BackendInstallRecord {
        tag: file.tag,
        backend_id: file.backend_id,
        backend: file.backend,
        engine: file.engine,
        sha256: file.sha256,
        installed_at_ms: file.installed_at_ms,
        dir: dir.to_string_lossy().to_string(),
    })
}

pub fn is_owned(dir: &Path) -> bool {
    dir.join(OWNER_MARKER).is_file()
}

fn set_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.is_file() {
            if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)) {
                log::warn!("[atomic-diffusion] chmod {} failed: {e}", path.display());
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// Run `<binary> --help` and check that the output is stable-diffusion.cpp's.
pub async fn probe_binary(binary: &Path) -> DiffusionResult<()> {
    let mut command = tokio::process::Command::new(binary);
    command.arg("--help");
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    command.kill_on_drop(true);
    jan_utils::setup_windows_process_flags(&mut command);
    jan_utils::setup_library_path(binary.parent(), &mut command);
    let output = tokio::time::timeout(PROBE_TIMEOUT, command.output())
        .await
        .map_err(|_| {
            DiffusionError::with_details(
                DiffusionErrorCode::EngineInstallFailed,
                "The image engine did not respond to --help.",
                format!(
                    "{} timed out after {}s",
                    binary.display(),
                    PROBE_TIMEOUT.as_secs()
                ),
            )
        })?
        .map_err(|e| {
            DiffusionError::with_details(
                DiffusionErrorCode::EngineInstallFailed,
                "The image engine could not be started.",
                format!("{}: {e}", binary.display()),
            )
        })?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    if probe_output_is_sdcpp(&text) {
        Ok(())
    } else {
        Err(DiffusionError::with_details(
            DiffusionErrorCode::EngineInstallFailed,
            "The downloaded binary is not stable-diffusion.cpp.",
            text.chars().take(800).collect::<String>(),
        ))
    }
}

pub fn probe_output_is_sdcpp(text: &str) -> bool {
    let lower = text.to_lowercase();
    PROBE_MARKERS.iter().any(|m| lower.contains(m))
}

/// Finalise a tree the web app extracted: permissions, marker, record, probe.
pub async fn finalize_backend_install(
    backends_root: &Path,
    args: FinalizeBackendInstallArgs,
) -> DiffusionResult<BackendInstallRecord> {
    let dir = PathBuf::from(&args.dir);
    if !dir.is_dir() {
        return Err(DiffusionError::with_details(
            DiffusionErrorCode::EngineInstallFailed,
            "The engine directory does not exist.",
            dir.display().to_string(),
        ));
    }
    if !is_within(
        &canonicalize_existing_prefix(&dir),
        &canonicalize_existing_prefix(backends_root),
    ) {
        return Err(DiffusionError::with_details(
            DiffusionErrorCode::InvalidRequest,
            "The engine directory is outside the diffusion backends folder.",
            dir.display().to_string(),
        ));
    }
    let server = dir.join(SERVER_BINARY);
    if !server.is_file() {
        return Err(DiffusionError::with_details(
            DiffusionErrorCode::EngineInstallFailed,
            "The archive did not contain sd-server.",
            server.display().to_string(),
        ));
    }
    let cli = dir.join(CLI_BINARY);
    set_executable(&server);
    set_executable(&cli);
    // Some release layouts ship a bare `sd` too.
    set_executable(&dir.join(if cfg!(windows) { "sd.exe" } else { "sd" }));

    let probe_target = if cli.is_file() { cli } else { server };
    probe_binary(&probe_target).await?;

    let record = BackendInstallRecord {
        tag: args.tag,
        backend_id: args.backend_id,
        backend: args.backend,
        engine: args.engine,
        sha256: args.sha256,
        installed_at_ms: now_ms(),
        dir: dir.to_string_lossy().to_string(),
    };
    write_install_record(&dir, &record)?;
    Ok(record)
}

/// Every `<root>/<tag>/<backendId>/install.json`, newest first.
pub fn list_installed_backends(backends_root: &Path) -> Vec<BackendInstallRecord> {
    let mut out = Vec::new();
    let Ok(tags) = std::fs::read_dir(backends_root) else {
        return out;
    };
    for tag in tags.flatten() {
        let tag_path = tag.path();
        if !tag_path.is_dir() {
            continue;
        }
        let Ok(backends) = std::fs::read_dir(&tag_path) else {
            continue;
        };
        for backend in backends.flatten() {
            let dir = backend.path();
            if !dir.is_dir() || !is_owned(&dir) {
                continue;
            }
            if let Some(record) = read_install_record(&dir) {
                if dir.join(SERVER_BINARY).is_file() {
                    out.push(record);
                }
            }
        }
    }
    out.sort_by(|a, b| b.installed_at_ms.cmp(&a.installed_at_ms));
    out
}

/// Delete an installed tree. Refuses trees without the ownership marker or
/// outside the backends root; the caller checks `BACKEND_IN_USE` first.
pub fn remove_backend(backends_root: &Path, dir: &Path) -> DiffusionResult<()> {
    let resolved = canonicalize_existing_prefix(dir);
    let root = canonicalize_existing_prefix(backends_root);
    if !is_within(&resolved, &root) || resolved == root {
        return Err(DiffusionError::with_details(
            DiffusionErrorCode::InvalidRequest,
            "That directory is not a diffusion backend install.",
            dir.display().to_string(),
        ));
    }
    if !dir.is_dir() {
        return Ok(());
    }
    if !is_owned(dir) {
        return Err(DiffusionError::with_details(
            DiffusionErrorCode::InvalidRequest,
            "Refusing to delete a directory Atomic Chat did not install.",
            format!("{} has no {OWNER_MARKER} marker", dir.display()),
        ));
    }
    std::fs::remove_dir_all(dir)
        .map_err(|e| DiffusionError::io("Could not remove the engine directory.", &e))?;
    // Drop the now-empty `<tag>` parent so the listing stays tidy.
    if let Some(parent) = dir.parent() {
        if parent != root
            && std::fs::read_dir(parent)
                .map(|mut d| d.next().is_none())
                .unwrap_or(false)
        {
            let _ = std::fs::remove_dir(parent);
        }
    }
    Ok(())
}

/// Same containment test the delete path uses, exposed for `BACKEND_IN_USE`.
pub fn same_dir(a: &Path, b: &Path) -> bool {
    canonicalize_existing_prefix(a) == canonicalize_existing_prefix(b)
}

/// Regular files under the models root, recursively, with `/`-separated
/// relative paths. Hidden files and in-flight downloads are skipped.
pub fn list_model_files(models_root: &Path) -> Vec<ModelFile> {
    let mut out = Vec::new();
    walk(models_root, models_root, &mut out);
    out.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    out
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<ModelFile>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            walk(root, &path, out);
            continue;
        }
        if name.ends_with(".tmp") || name.ends_with(".part") || name.ends_with(".download") {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map(|p| {
                p.components()
                    .map(|c| c.as_os_str().to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .unwrap_or_else(|_| name.clone());
        out.push(ModelFile {
            path: path.to_string_lossy().to_string(),
            relative_path: relative,
            bytes: meta.len(),
        });
    }
}

/// Delete one file under the models root. Anything outside is refused.
pub fn delete_model_file(models_root: &Path, path: &Path) -> DiffusionResult<()> {
    let resolved = canonicalize_existing_prefix(path);
    let root = canonicalize_existing_prefix(models_root);
    if !is_within(&resolved, &root) || resolved == root {
        return Err(DiffusionError::with_details(
            DiffusionErrorCode::InvalidRequest,
            "That file is not in the diffusion models folder.",
            path.display().to_string(),
        ));
    }
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        return Err(DiffusionError::with_details(
            DiffusionErrorCode::InvalidRequest,
            "That path is a directory, not a model file.",
            path.display().to_string(),
        ));
    }
    std::fs::remove_file(path)
        .map_err(|e| DiffusionError::io("Could not delete the model file.", &e))?;
    // Prune empty family directories on the way up, never the root itself.
    let mut cursor = path.parent();
    while let Some(dir) = cursor {
        if canonicalize_existing_prefix(dir) == root {
            break;
        }
        let empty = std::fs::read_dir(dir)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if !empty {
            break;
        }
        let _ = std::fs::remove_dir(dir);
        cursor = dir.parent();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(dir: &Path) -> BackendInstallRecord {
        BackendInstallRecord {
            tag: "master-849-d04e895".into(),
            backend_id: "macos-arm64".into(),
            backend: DiffusionBackend::Metal,
            engine: EngineKind::SdCpp,
            sha256: Some("abc".into()),
            installed_at_ms: 1234,
            dir: dir.to_string_lossy().to_string(),
        }
    }

    #[test]
    fn install_record_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let expected = record(dir.path());
        write_install_record(dir.path(), &expected).unwrap();
        assert!(is_owned(dir.path()));
        let read = read_install_record(dir.path()).unwrap();
        assert_eq!(read, expected);
        let text = std::fs::read_to_string(dir.path().join(INSTALL_RECORD)).unwrap();
        assert!(text.contains("\"backendId\""));
        assert!(text.contains("\"installedAtMs\""));
    }

    #[test]
    fn listing_walks_tag_and_backend_dirs_and_skips_unowned_trees() {
        let root = tempfile::tempdir().unwrap();
        let owned = root.path().join("tag-a").join("macos-arm64");
        std::fs::create_dir_all(&owned).unwrap();
        std::fs::write(owned.join(SERVER_BINARY), b"bin").unwrap();
        write_install_record(&owned, &record(&owned)).unwrap();

        let foreign = root.path().join("tag-a").join("foreign");
        std::fs::create_dir_all(&foreign).unwrap();
        std::fs::write(foreign.join(SERVER_BINARY), b"bin").unwrap();
        let mut foreign_record = record(&foreign);
        foreign_record.backend_id = "foreign".into();
        let json = serde_json::to_string(&serde_json::json!({
            "tag": "t", "backendId": "foreign", "backend": "cpu", "engine": "sd-cpp", "installedAtMs": 1
        }))
        .unwrap();
        std::fs::write(foreign.join(INSTALL_RECORD), json).unwrap();

        let newer = root.path().join("tag-b").join("win-cuda12-x64");
        std::fs::create_dir_all(&newer).unwrap();
        std::fs::write(newer.join(SERVER_BINARY), b"bin").unwrap();
        let mut newer_record = record(&newer);
        newer_record.installed_at_ms = 9999;
        newer_record.backend_id = "win-cuda12-x64".into();
        write_install_record(&newer, &newer_record).unwrap();

        let listed = list_installed_backends(root.path());
        let ids: Vec<&str> = listed.iter().map(|r| r.backend_id.as_str()).collect();
        assert_eq!(ids, vec!["win-cuda12-x64", "macos-arm64"]);
        assert_eq!(listed[0].dir, newer.to_string_lossy());
    }

    #[test]
    fn remove_refuses_unowned_and_outside_trees() {
        let root = tempfile::tempdir().unwrap();
        let unowned = root.path().join("tag").join("cpu");
        std::fs::create_dir_all(&unowned).unwrap();
        let err = remove_backend(root.path(), &unowned).unwrap_err();
        assert_eq!(err.code, DiffusionErrorCode::InvalidRequest);
        assert!(unowned.exists());

        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join(OWNER_MARKER), b"x").unwrap();
        let err = remove_backend(root.path(), outside.path()).unwrap_err();
        assert_eq!(err.code, DiffusionErrorCode::InvalidRequest);
        assert!(outside.path().exists());

        let err = remove_backend(root.path(), root.path()).unwrap_err();
        assert_eq!(err.code, DiffusionErrorCode::InvalidRequest);
        assert!(root.path().exists());
    }

    #[test]
    fn remove_deletes_an_owned_tree_and_its_empty_tag_dir() {
        let root = tempfile::tempdir().unwrap();
        let owned = root.path().join("tag").join("cpu");
        std::fs::create_dir_all(owned.join("lib")).unwrap();
        std::fs::write(owned.join("lib").join("x.so"), b"x").unwrap();
        write_install_record(&owned, &record(&owned)).unwrap();
        remove_backend(root.path(), &owned).unwrap();
        assert!(!owned.exists());
        assert!(!root.path().join("tag").exists());
        assert!(root.path().exists());
    }

    #[test]
    fn model_files_are_listed_relative_and_deleted_only_inside_the_root() {
        let root = tempfile::tempdir().unwrap();
        let family = root.path().join("z-image");
        std::fs::create_dir_all(&family).unwrap();
        std::fs::write(family.join("z.gguf"), b"12345").unwrap();
        std::fs::write(family.join("z.gguf.tmp"), b"1").unwrap();
        std::fs::write(family.join(".hidden"), b"1").unwrap();
        let shared = root.path().join("shared").join("Qwen3-4B");
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::write(shared.join("te.gguf"), b"12").unwrap();

        let files = list_model_files(root.path());
        let rel: Vec<&str> = files.iter().map(|f| f.relative_path.as_str()).collect();
        assert_eq!(rel, vec!["shared/Qwen3-4B/te.gguf", "z-image/z.gguf"]);
        assert_eq!(files[1].bytes, 5);

        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("keep.gguf");
        std::fs::write(&victim, b"x").unwrap();
        let err = delete_model_file(root.path(), &victim).unwrap_err();
        assert_eq!(err.code, DiffusionErrorCode::InvalidRequest);
        assert!(victim.exists());

        let traversal = family
            .join("..")
            .join("..")
            .join(outside.path().file_name().unwrap())
            .join("keep.gguf");
        let _ = delete_model_file(root.path(), &traversal);
        assert!(victim.exists(), "traversal must not escape the models root");

        delete_model_file(root.path(), &family.join("z.gguf")).unwrap();
        assert!(!family.join("z.gguf").exists());
        assert!(family.exists(), "dir still has the .tmp and hidden files");
        delete_model_file(root.path(), &shared.join("te.gguf")).unwrap();
        assert!(!shared.exists(), "empty family dirs are pruned");
        assert!(root.path().exists());
    }

    #[tokio::test]
    async fn finalize_requires_a_tree_inside_the_backends_root_with_sd_server() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("tag").join("cpu");
        std::fs::create_dir_all(&dir).unwrap();
        let args = || FinalizeBackendInstallArgs {
            dir: dir.to_string_lossy().to_string(),
            tag: "tag".into(),
            backend_id: "cpu".into(),
            backend: DiffusionBackend::Cpu,
            engine: EngineKind::SdCpp,
            sha256: None,
        };
        let err = finalize_backend_install(root.path(), args())
            .await
            .unwrap_err();
        assert_eq!(err.code, DiffusionErrorCode::EngineInstallFailed);
        assert!(err.message.contains("sd-server"));

        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join(SERVER_BINARY), b"x").unwrap();
        let mut outside_args = args();
        outside_args.dir = outside.path().to_string_lossy().to_string();
        let err = finalize_backend_install(root.path(), outside_args)
            .await
            .unwrap_err();
        assert_eq!(err.code, DiffusionErrorCode::InvalidRequest);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn finalize_probes_the_cli_and_writes_the_record() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("tag").join("cpu");
        std::fs::create_dir_all(&dir).unwrap();
        // Not executable on purpose: finalize must chmod before probing.
        std::fs::write(dir.join(SERVER_BINARY), b"#!/bin/sh\necho server\n").unwrap();
        std::fs::write(
            dir.join(CLI_BINARY),
            b"#!/bin/sh\necho 'usage: sd-cli [options]'\necho '  --cfg-scale SCALE'\n",
        )
        .unwrap();
        let record = finalize_backend_install(
            root.path(),
            FinalizeBackendInstallArgs {
                dir: dir.to_string_lossy().to_string(),
                tag: "tag".into(),
                backend_id: "cpu".into(),
                backend: DiffusionBackend::Cpu,
                engine: EngineKind::SdCpp,
                sha256: Some("ff".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(record.backend_id, "cpu");
        assert!(record.installed_at_ms > 0);
        assert_eq!(read_install_record(&dir).unwrap(), record);
        assert_eq!(list_installed_backends(root.path()).len(), 1);

        // A binary that is not sd.cpp fails the probe and leaves no record.
        let bad = root.path().join("tag").join("bad");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(
            bad.join(SERVER_BINARY),
            b"#!/bin/sh\necho 'llama-server usage'\n",
        )
        .unwrap();
        let err = finalize_backend_install(
            root.path(),
            FinalizeBackendInstallArgs {
                dir: bad.to_string_lossy().to_string(),
                tag: "tag".into(),
                backend_id: "bad".into(),
                backend: DiffusionBackend::Cpu,
                engine: EngineKind::SdCpp,
                sha256: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, DiffusionErrorCode::EngineInstallFailed);
        assert!(!is_owned(&bad));
    }

    #[test]
    fn probe_markers() {
        assert!(probe_output_is_sdcpp("stable-diffusion.cpp v1"));
        assert!(probe_output_is_sdcpp(
            "  --cfg-scale SCALE  unconditional guidance"
        ));
        assert!(!probe_output_is_sdcpp("usage: llama-server"));
    }
}
