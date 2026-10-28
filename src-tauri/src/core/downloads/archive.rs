//! Unpacking an AI Hub bundle (openspec change `add-geniex-runtime`, spec `geniex-models`, "Файлы
//! модели качает клиент с проверкой"): the app downloads the bundle's zip with `download_files`,
//! which checks its size and sha256, then asks this to unpack it into the variant's folder under the
//! same task id — so the download panel's row shows the unpacking as one more stage of the same
//! download and its Cancel stops it — and to delete the archive afterwards.
//!
//! Every entry is written inside the output folder or not at all: an entry whose name climbs out
//! (`../`, an absolute path, a drive) fails the whole unpack (zip-slip). The core later checks the
//! folder (`POST /models/geniex/check` by path) before the app writes `model.yml`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{Emitter, Runtime, State};

use super::models::{DownloadEvent, DownloadTask};
use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::state::AppState;

/// The error an unpack stopped by Cancel answers; the app reads it as a cancel, not a failure.
pub const EXTRACT_CANCELLED: &str = "Extraction cancelled";

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct ExtractReport {
    /// Files written (directories not counted).
    pub files: u64,
    /// Bytes written, uncompressed.
    pub bytes: u64,
}

/// Unpack `archive` into `output_dir`, which is created when missing, reporting
/// `(bytes done, bytes total)` as entries land and stopping at the first entry once
/// `cancelled()` says so. Pure: no Tauri, no data-folder rule — the command adds those.
pub fn extract_zip_into(
    archive: &Path,
    output_dir: &Path,
    mut progress: impl FnMut(u64, u64),
    cancelled: impl Fn() -> bool,
) -> Result<ExtractReport, String> {
    let file = fs::File::open(archive).map_err(|e| format!("cannot open {}: {e}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("not a zip archive: {e}"))?;
    let root = jan_utils::normalize_path(output_dir);

    // Every target is decided before a byte is written: a bad entry anywhere fails the whole unpack
    // with nothing of it on disk.
    let mut targets: Vec<(usize, PathBuf, bool)> = Vec::with_capacity(zip.len());
    let mut total: u64 = 0;
    for index in 0..zip.len() {
        let entry = zip.by_index_raw(index).map_err(|e| e.to_string())?;
        let relative = entry
            .enclosed_name()
            .map(Path::to_path_buf)
            .ok_or_else(|| format!("zip entry \"{}\" would land outside the folder", entry.name()))?;
        let target = jan_utils::normalize_path(&root.join(&relative));
        if !jan_utils::is_within(&target, &root) || target == root {
            return Err(format!("zip entry \"{}\" would land outside the folder", entry.name()));
        }
        let is_dir = entry.is_dir();
        if !is_dir {
            total += entry.size();
        }
        targets.push((index, target, is_dir));
    }

    fs::create_dir_all(&root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;
    let mut done: u64 = 0;
    let mut files: u64 = 0;
    progress(0, total);
    for (index, target, is_dir) in targets {
        if cancelled() {
            return Err(EXTRACT_CANCELLED.to_string());
        }
        if is_dir {
            fs::create_dir_all(&target).map_err(|e| format!("cannot create {}: {e}", target.display()))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        let mut entry = zip.by_index(index).map_err(|e| e.to_string())?;
        let mut out = fs::File::create(&target).map_err(|e| format!("cannot write {}: {e}", target.display()))?;
        let written = io::copy(&mut entry, &mut out).map_err(|e| format!("cannot write {}: {e}", target.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                let _ = fs::set_permissions(&target, fs::Permissions::from_mode(mode));
            }
        }
        done += written;
        files += 1;
        progress(done, total);
    }
    Ok(ExtractReport { files, bytes: done })
}

/// Unpack a downloaded zip into a folder, both inside the data folder, under the download's task id
/// (progress on `download-<task_id>`, Cancel through `cancel_download_task`), and delete the archive
/// when asked. The output folder is left as it is on failure: the caller removes what it owns.
#[tauri::command]
pub async fn extract_zip<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    archive: &str,
    output_dir: &str,
    task_id: &str,
    remove_archive: bool,
) -> Result<ExtractReport, String> {
    let data_folder = get_jan_data_folder_path(app.clone());
    let archive_path = jan_utils::normalize_path(Path::new(archive));
    let output_path = jan_utils::normalize_path(Path::new(output_dir));
    for (what, path) in [("archive", &archive_path), ("output folder", &output_path)] {
        if !path.is_absolute() || !jan_utils::is_within(path, &data_folder) {
            return Err(format!(
                "the {what} {} is not inside the data folder {}",
                path.display(),
                data_folder.display()
            ));
        }
    }

    // The same task as the download that brought the archive: a Cancel in the panel stops this too.
    let task = DownloadTask::new();
    let cancel_token = task.cancel_token.clone();
    {
        let mut manager = state.download_manager.lock().await;
        if let Some(existing) = manager.cancel_tokens.remove(task_id) {
            existing.supersede();
        }
        manager.cancel_tokens.insert(task_id.to_string(), task.clone());
    }

    let event_name = format!("download-{task_id}");
    let emitter = app.clone();
    let token = cancel_token.clone();
    let (archive_for_task, output_for_task) = (archive_path.clone(), output_path.clone());
    let result = tokio::task::spawn_blocking(move || {
        let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
        extract_zip_into(
            &archive_for_task,
            &output_for_task,
            |transferred, total| {
                // At most a few events a second: the row only has to move.
                if transferred == total || last.elapsed() >= std::time::Duration::from_millis(250) {
                    last = std::time::Instant::now();
                    let _ = emitter.emit(
                        &event_name,
                        DownloadEvent {
                            transferred,
                            total,
                            stage: None,
                        },
                    );
                }
            },
            || token.is_cancelled(),
        )
    })
    .await
    .map_err(|e| format!("unpacking stopped: {e}"))?;

    {
        let mut manager = state.download_manager.lock().await;
        let is_ours = manager
            .cancel_tokens
            .get(task_id)
            .is_some_and(|current| current.is_same_task(&task));
        if is_ours {
            manager.cancel_tokens.remove(task_id);
        }
    }

    let report = result?;
    if remove_archive {
        fs::remove_file(&archive_path)
            .map_err(|e| format!("unpacked, but cannot delete {}: {e}", archive_path.display()))?;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::FileOptions;

    fn zip_with(entries: &[(&str, &[u8])]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bundle.zip");
        let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for (name, bytes) in entries {
            if name.ends_with('/') {
                writer.add_directory(name.trim_end_matches('/'), FileOptions::default()).unwrap();
            } else {
                writer.start_file(*name, FileOptions::default()).unwrap();
                writer.write_all(bytes).unwrap();
            }
        }
        writer.finish().unwrap();
        (dir, path)
    }

    #[test]
    fn unpacks_a_bundle_into_the_folder_and_reports_its_bytes() {
        // spec geniex-models "Бандл скачан и распакован": the files land in the variant's folder,
        // nested folders included, and the progress ends at the uncompressed total.
        let (dir, archive) = zip_with(&[
            ("geniex.json", br#"{"chip":"x-elite"}"#),
            ("weights/", b""),
            ("weights/shard-0.bin", b"0123456789"),
            ("tokenizer.json", b"{}"),
        ]);
        let out = dir.path().join("qwen3-4b-aihub-x-elite");
        let mut seen: Vec<(u64, u64)> = Vec::new();

        let report = extract_zip_into(&archive, &out, |done, total| seen.push((done, total)), || false).unwrap();

        assert_eq!(report, ExtractReport { files: 3, bytes: 18 + 10 + 2 });
        assert_eq!(fs::read(out.join("geniex.json")).unwrap(), br#"{"chip":"x-elite"}"#);
        assert_eq!(fs::read(out.join("weights/shard-0.bin")).unwrap(), b"0123456789");
        assert_eq!(seen.first(), Some(&(0, 30)));
        assert_eq!(seen.last(), Some(&(30, 30)));
    }

    #[test]
    fn refuses_an_entry_that_would_land_outside_the_folder_and_writes_nothing() {
        // spec geniex-models: "отвергая пути вне папки". Checked before any byte is written, so a
        // good entry ahead of the bad one does not land either.
        let (dir, archive) = zip_with(&[("geniex.json", b"{}"), ("../evil.txt", b"owned")]);
        let out = dir.path().join("bundle");

        let error = extract_zip_into(&archive, &out, |_, _| {}, || false).unwrap_err();

        assert!(error.contains("outside the folder"), "{error}");
        assert!(!dir.path().join("evil.txt").exists());
        assert!(!out.exists(), "a refused archive leaves no folder");
    }

    #[test]
    fn refuses_an_absolute_entry() {
        let (dir, archive) = zip_with(&[("/tmp/evil.txt", b"owned")]);
        let out = dir.path().join("bundle");

        let error = extract_zip_into(&archive, &out, |_, _| {}, || false).unwrap_err();

        assert!(error.contains("outside the folder"), "{error}");
    }

    #[test]
    fn stops_at_the_next_entry_once_cancelled() {
        let (dir, archive) = zip_with(&[("a.bin", b"aaaa"), ("b.bin", b"bbbb")]);
        let out = dir.path().join("bundle");
        let written = std::cell::Cell::new(0u32);

        let error = extract_zip_into(
            &archive,
            &out,
            |_, _| {},
            || {
                written.set(written.get() + 1);
                written.get() > 1
            },
        )
        .unwrap_err();

        assert_eq!(error, EXTRACT_CANCELLED);
        assert!(out.join("a.bin").exists());
        assert!(!out.join("b.bin").exists());
    }

    #[test]
    fn answers_what_is_wrong_with_something_that_is_not_a_zip() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("bundle.zip");
        fs::write(&archive, b"not a zip").unwrap();

        let error = extract_zip_into(&archive, &dir.path().join("out"), |_, _| {}, || false).unwrap_err();

        assert!(error.contains("not a zip archive"), "{error}");
    }
}
