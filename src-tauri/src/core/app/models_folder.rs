//! The folder local models are saved to and read from.
//!
//! Both llama.cpp engines keep their models in `<data folder>/llamacpp/models`,
//! and the extensions spell that location in dozens of places. When the user
//! picks a folder of their own (Models page, "Models folder"), that one
//! subfolder is redirected to it: every path under
//! `<data folder>/llamacpp/models` resolves to the same place under the chosen
//! folder. The file commands, the downloader and the model settings files all
//! go through [`redirect_into_models_folder`], so nothing else has to know.
//!
//! Relative `model_path` values in `model.yml` (`llamacpp/models/<id>/...`)
//! follow the redirect too, which is why moving the models needs no rewrite of
//! their settings files.

use std::fs;
use std::path::{Component, Path, PathBuf};

use jan_utils::{is_within, normalize_path};
use serde::Serialize;
use tauri::Runtime;

use super::commands::{get_app_configurations, get_jan_data_folder_path, update_app_configuration};
use super::helpers::copy_dir_recursive;
use crate::core::state::AppState;

/// Where models live inside the data folder when no folder has been chosen.
pub fn default_models_folder(data_folder: &Path) -> PathBuf {
    data_folder.join("llamacpp").join("models")
}

/// The models folder in use: the chosen one, or the default inside the data folder.
pub fn effective_models_folder(data_folder: &Path, chosen: Option<&Path>) -> PathBuf {
    chosen
        .map(normalize_path)
        .unwrap_or_else(|| default_models_folder(data_folder))
}

/// `path` with its `<data folder>/llamacpp/models` part swapped for the chosen
/// folder. Anything else, or any path while no folder is chosen, is returned
/// as it came.
pub fn redirect_into_models_folder(
    path: &Path,
    data_folder: &Path,
    chosen: Option<&Path>,
) -> PathBuf {
    let Some(chosen) = chosen else {
        return path.to_path_buf();
    };
    let default = default_models_folder(data_folder);
    if !is_within(path, &default) {
        return path.to_path_buf();
    }
    // `is_within` compared the leading components (case-insensitively on
    // Windows), so the rest of the path starts right after them.
    let skip = normalize_path(&default).components().count();
    let rest: PathBuf = normalize_path(path).components().skip(skip).collect();
    normalize_path(&chosen.join(rest))
}

/// Whether the app may write or delete at `path`: inside the data folder, or
/// inside the chosen models folder.
pub fn is_within_app_folders(path: &Path, data_folder: &Path, chosen: Option<&Path>) -> bool {
    is_within(path, data_folder) || chosen.is_some_and(|folder| is_within(path, folder))
}

/// Check a folder the user picked, and say plainly what is wrong with it.
///
/// `current` is the models folder in use now.
pub fn check_new_models_folder(new: &Path, current: &Path) -> Result<PathBuf, String> {
    if !new.is_absolute() {
        return Err("Choose a full folder path, such as D:\\Models.".to_string());
    }
    let new = normalize_path(new);
    if new.parent().is_none()
        || new
            .components()
            .all(|c| matches!(c, Component::Prefix(_) | Component::RootDir))
    {
        return Err("Choose a folder, not the top of a drive. For example D:\\Models.".to_string());
    }
    if is_within(&new, current) && !is_within(current, &new) {
        return Err("The new folder can't be inside the current models folder.".to_string());
    }
    if is_within(current, &new) && !is_within(&new, current) {
        return Err("The new folder can't contain the current models folder.".to_string());
    }
    Ok(new)
}

/// Create `folder` if needed and prove the app can write there.
pub fn prepare_models_folder(folder: &Path) -> Result<(), String> {
    fs::create_dir_all(folder)
        .map_err(|e| format!("Couldn't create the folder {}: {e}", folder.display()))?;
    let probe = folder.join(".radium-write-test");
    fs::write(&probe, b"ok").map_err(|e| {
        format!(
            "Radium can't save files in {}. Choose a folder you can write to. ({e})",
            folder.display()
        )
    })?;
    let _ = fs::remove_file(probe);
    Ok(())
}

/// What happened when models were moved to a new folder.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
pub struct MoveReport {
    /// Names moved into the new folder.
    pub moved: Vec<String>,
    /// Names left where they were because the new folder already has one.
    pub skipped: Vec<String>,
    /// Names that could not be moved, with the reason.
    pub failed: Vec<(String, String)>,
}

/// Move everything in `from` into `to`, one entry at a time.
///
/// A rename when both folders are on the same drive; otherwise copy, then
/// remove the original only once the copy is complete. An entry that already
/// exists in `to` is never overwritten.
pub fn move_models(from: &Path, to: &Path) -> Result<MoveReport, String> {
    let mut report = MoveReport::default();
    if !from.exists() {
        return Ok(report);
    }
    fs::create_dir_all(to).map_err(|e| e.to_string())?;

    let mut entries: Vec<_> = fs::read_dir(from)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let source = entry.path();
        let target = to.join(entry.file_name());
        if target.exists() {
            report.skipped.push(name);
            continue;
        }
        match move_entry(&source, &target) {
            Ok(()) => report.moved.push(name),
            Err(e) => report.failed.push((name, e)),
        }
    }
    Ok(report)
}

fn move_entry(source: &Path, target: &Path) -> Result<(), String> {
    if fs::rename(source, target).is_ok() {
        return Ok(());
    }
    // Different drive (or a rename the filesystem refused): copy, then remove.
    let copied = if source.is_dir() {
        copy_dir_recursive(&source.to_path_buf(), &target.to_path_buf(), &[])
            .and_then(|()| same_size(source, target))
    } else {
        fs::copy(source, target).and_then(|_| same_size(source, target))
    };
    if let Err(e) = copied {
        // Leave the original untouched and drop the partial copy.
        if target.is_dir() {
            let _ = fs::remove_dir_all(target);
        } else {
            let _ = fs::remove_file(target);
        }
        return Err(e.to_string());
    }
    if source.is_dir() {
        fs::remove_dir_all(source)
    } else {
        fs::remove_file(source)
    }
    .map_err(|e| format!("copied, but the original couldn't be removed: {e}"))
}

fn same_size(source: &Path, target: &Path) -> std::io::Result<()> {
    let (a, b) = (total_size(source)?, total_size(target)?);
    if a == b {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "the copy is incomplete ({b} of {a} bytes)"
        )))
    }
}

fn total_size(path: &Path) -> std::io::Result<u64> {
    let meta = fs::metadata(path)?;
    if !meta.is_dir() {
        return Ok(meta.len());
    }
    let mut sum = 0;
    for entry in fs::read_dir(path)? {
        sum += total_size(&entry?.path())?;
    }
    Ok(sum)
}

#[cfg(test)]
pub(crate) struct TestModelsFolder(pub(crate) PathBuf);

/// The folder the user chose, if any.
pub fn chosen_models_folder<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    #[cfg(test)]
    {
        use tauri::Manager;
        app.try_state::<TestModelsFolder>().map(|f| f.0.clone())
    }
    #[cfg(not(test))]
    get_app_configurations(app.clone())
        .models_folder
        .filter(|folder| !folder.trim().is_empty())
        .map(PathBuf::from)
}

/// [`redirect_into_models_folder`] for the running app.
pub fn redirect_for_app<R: Runtime>(app: &tauri::AppHandle<R>, path: &Path) -> PathBuf {
    let chosen = chosen_models_folder(app);
    if chosen.is_none() {
        return path.to_path_buf();
    }
    let data_folder = get_jan_data_folder_path(app.clone());
    redirect_into_models_folder(path, &data_folder, chosen.as_deref())
}

#[derive(Debug, Serialize)]
pub struct ModelsFolderInfo {
    pub path: String,
    pub default_path: String,
    pub is_default: bool,
}

#[tauri::command]
pub fn get_models_folder<R: Runtime>(app: tauri::AppHandle<R>) -> ModelsFolderInfo {
    let data_folder = get_jan_data_folder_path(app.clone());
    let chosen = chosen_models_folder(&app);
    let default = default_models_folder(&data_folder);
    ModelsFolderInfo {
        path: effective_models_folder(&data_folder, chosen.as_deref())
            .to_string_lossy()
            .into_owned(),
        default_path: default.to_string_lossy().into_owned(),
        is_default: chosen.is_none(),
    }
}

/// Use `path` as the models folder (`None` goes back to the default), and
/// move the models already downloaded there when `move_existing` is set.
///
/// Refused while a download is running: its file would land in the old folder.
#[tauri::command]
pub async fn set_models_folder<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    path: Option<String>,
    move_existing: bool,
) -> Result<MoveReport, String> {
    if !state.download_manager.lock().await.cancel_tokens.is_empty() {
        return Err(
            "A download is still running. Wait for it to finish, or cancel it, then change the models folder."
                .to_string(),
        );
    }

    let data_folder = get_jan_data_folder_path(app.clone());
    let default = default_models_folder(&data_folder);
    let current = effective_models_folder(&data_folder, chosen_models_folder(&app).as_deref());
    let new = match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => check_new_models_folder(Path::new(p), &current)?,
        None => default.clone(),
    };
    if is_within(&new, &current) && is_within(&current, &new) {
        return Ok(MoveReport::default());
    }

    let (from, to) = (current.clone(), new.clone());
    let report = tauri::async_runtime::spawn_blocking(move || {
        prepare_models_folder(&to)?;
        if move_existing {
            move_models(&from, &to)
        } else {
            Ok(MoveReport::default())
        }
    })
    .await
    .map_err(|e| e.to_string())??;

    let mut configuration = get_app_configurations(app.clone());
    configuration.models_folder = if is_within(&new, &default) && is_within(&default, &new) {
        None
    } else {
        Some(new.to_string_lossy().into_owned())
    };
    update_app_configuration(app, configuration)?;
    log::info!(
        "Models folder changed from {} to {} (moved {}, skipped {}, failed {})",
        current.display(),
        new.display(),
        report.moved.len(),
        report.skipped.len(),
        report.failed.len()
    );
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn nothing_moves_while_no_folder_is_chosen() {
        let data = Path::new("/data");
        let path = data.join("llamacpp/models/qwen/model.gguf");
        assert_eq!(redirect_into_models_folder(&path, data, None), path);
    }

    #[test]
    fn model_paths_follow_the_chosen_folder() {
        let tmp = tempdir().unwrap();
        let data = tmp.path().join("data");
        let chosen = tmp.path().join("My Models");
        let path = data
            .join("llamacpp")
            .join("models")
            .join("qwen")
            .join("model.gguf");

        assert_eq!(
            redirect_into_models_folder(&path, &data, Some(&chosen)),
            normalize_path(&chosen.join("qwen").join("model.gguf"))
        );
        // The models folder itself maps to the chosen folder.
        assert_eq!(
            redirect_into_models_folder(&default_models_folder(&data), &data, Some(&chosen)),
            normalize_path(&chosen)
        );
    }

    #[test]
    fn everything_else_in_the_data_folder_stays_put() {
        let tmp = tempdir().unwrap();
        let data = tmp.path().join("data");
        let chosen = tmp.path().join("models-elsewhere");
        for rest in [
            "llamacpp/backends/b1",
            "threads/t1.json",
            "llamacpp/models-old/x",
        ] {
            let path = data.join(rest);
            assert_eq!(
                redirect_into_models_folder(&path, &data, Some(&chosen)),
                path
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_differently_cased_path_still_follows_on_windows() {
        let data = Path::new(r"C:\Users\Bob\AppData\Roaming\Radium\data");
        let chosen = Path::new(r"D:\Models");
        let path =
            Path::new(r"c:\users\bob\appdata\roaming\radium\data\LlamaCpp\Models\qwen\model.gguf");
        assert_eq!(
            redirect_into_models_folder(path, data, Some(chosen)),
            PathBuf::from(r"D:\Models\qwen\model.gguf")
        );
    }

    #[test]
    fn the_chosen_folder_counts_as_an_app_folder() {
        let tmp = tempdir().unwrap();
        let data = tmp.path().join("data");
        let chosen = tmp.path().join("models");
        assert!(is_within_app_folders(
            &chosen.join("m/model.gguf"),
            &data,
            Some(&chosen)
        ));
        assert!(is_within_app_folders(&data.join("x"), &data, Some(&chosen)));
        assert!(!is_within_app_folders(&chosen.join("m"), &data, None));
        assert!(!is_within_app_folders(
            &tmp.path().join("other"),
            &data,
            Some(&chosen)
        ));
    }

    #[test]
    fn a_relative_path_or_a_whole_drive_is_refused() {
        let tmp = tempdir().unwrap();
        let current = tmp.path().join("data/llamacpp/models");
        assert!(check_new_models_folder(Path::new("models"), &current).is_err());
        let root = tmp.path().ancestors().last().unwrap();
        assert!(check_new_models_folder(root, &current).is_err());
    }

    #[test]
    fn a_folder_inside_or_around_the_current_one_is_refused() {
        let tmp = tempdir().unwrap();
        let current = tmp.path().join("models");
        assert!(check_new_models_folder(&current.join("sub"), &current).is_err());
        assert!(check_new_models_folder(tmp.path(), &current).is_err());
        assert!(check_new_models_folder(&tmp.path().join("elsewhere"), &current).is_ok());
    }

    #[test]
    fn a_new_folder_is_created_and_checked_for_writing() {
        let tmp = tempdir().unwrap();
        let folder = tmp.path().join("new").join("models");
        prepare_models_folder(&folder).unwrap();
        assert!(folder.is_dir());
        assert_eq!(
            fs::read_dir(&folder).unwrap().count(),
            0,
            "the write test is removed"
        );
    }

    #[test]
    fn models_move_and_keep_their_files() {
        let tmp = tempdir().unwrap();
        let from = tmp.path().join("old");
        let to = tmp.path().join("new");
        fs::create_dir_all(from.join("qwen")).unwrap();
        fs::write(from.join("qwen/model.gguf"), b"weights").unwrap();
        fs::write(from.join("qwen/model.yml"), b"model_path: x").unwrap();
        fs::create_dir_all(from.join("org/gemma")).unwrap();
        fs::write(from.join("org/gemma/model.gguf"), b"more").unwrap();

        let report = move_models(&from, &to).unwrap();

        assert_eq!(report.moved, vec!["org".to_string(), "qwen".to_string()]);
        assert!(report.failed.is_empty() && report.skipped.is_empty());
        assert_eq!(fs::read(to.join("qwen/model.gguf")).unwrap(), b"weights");
        assert_eq!(fs::read(to.join("org/gemma/model.gguf")).unwrap(), b"more");
        assert!(!from.join("qwen").exists());
    }

    #[test]
    fn a_model_already_in_the_new_folder_is_never_overwritten() {
        let tmp = tempdir().unwrap();
        let from = tmp.path().join("old");
        let to = tmp.path().join("new");
        fs::create_dir_all(from.join("qwen")).unwrap();
        fs::write(from.join("qwen/model.gguf"), b"old copy").unwrap();
        fs::create_dir_all(to.join("qwen")).unwrap();
        fs::write(to.join("qwen/model.gguf"), b"kept").unwrap();

        let report = move_models(&from, &to).unwrap();

        assert_eq!(report.skipped, vec!["qwen".to_string()]);
        assert_eq!(fs::read(to.join("qwen/model.gguf")).unwrap(), b"kept");
        assert_eq!(fs::read(from.join("qwen/model.gguf")).unwrap(), b"old copy");
    }

    #[test]
    fn moving_from_a_folder_that_does_not_exist_moves_nothing() {
        let tmp = tempdir().unwrap();
        let report = move_models(&tmp.path().join("missing"), &tmp.path().join("new")).unwrap();
        assert_eq!(report, MoveReport::default());
    }

    #[test]
    fn the_default_folder_is_inside_the_data_folder() {
        let data = Path::new("/data");
        assert_eq!(
            effective_models_folder(data, None),
            data.join("llamacpp").join("models")
        );
        assert_eq!(
            effective_models_folder(data, Some(Path::new("/m"))),
            normalize_path(Path::new("/m"))
        );
    }
}
