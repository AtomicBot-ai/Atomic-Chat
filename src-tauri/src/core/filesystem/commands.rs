// WARNING: These APIs will be deprecated soon due to removing FS API access from frontend.
// It's added to ensure the legacy implementation from frontend still functions before removal.
use super::helpers::resolve_path;
use super::models::{DialogOpenOptions, FileStat};
use crate::core::app::models_folder::{
    chosen_models_folder, is_within_app_folders, redirect_for_app,
};
use rfd::AsyncFileDialog;
use std::collections::HashSet;
use std::fs;
use std::sync::Mutex;
use tauri::Runtime;

/// Paths the user granted via a native dialog this session. Managed as Tauri
/// state: `save_dialog` inserts the picked path and `write_file_sync` only
/// accepts paths in here (or inside the app's own folders), so a compromised
/// extension cannot use the legacy write primitive on arbitrary files.
#[derive(Default)]
pub struct DialogGrants {
    write: Mutex<HashSet<std::path::PathBuf>>,
}

/// Normalize `path` into a stable comparison key. Canonicalizing the parent
/// (which must exist for a save-dialog pick) plus the leaf name tolerates the
/// case/normalization differences between the dialog's raw path and the path
/// that comes back through `resolve_path`.
fn grant_key(path: &std::path::Path) -> std::path::PathBuf {
    let normalized = jan_utils::normalize_path(path);
    if let (Some(parent), Some(name)) = (normalized.parent(), normalized.file_name()) {
        if let Ok(canonical_parent) = parent.canonicalize() {
            return canonical_parent.join(name);
        }
    }
    normalized
}

#[tauri::command]
pub fn rm<R: Runtime>(app_handle: tauri::AppHandle<R>, args: Vec<String>) -> Result<(), String> {
    if args.is_empty() || args[0].is_empty() {
        return Err("rm error: Invalid argument".to_string());
    }

    let jan_data_folder = crate::core::app::commands::get_jan_data_folder_path(app_handle.clone());
    let models_folder = chosen_models_folder(&app_handle);
    let path = resolve_path(app_handle, &args[0]);
    let canonical_data = jan_data_folder.canonicalize().unwrap_or(jan_data_folder);
    let canonical_models = models_folder.map(|f| f.canonicalize().unwrap_or(f));
    let canonical_path = path.canonicalize().unwrap_or_else(|_| path.clone());
    if !is_within_app_folders(
        &canonical_path,
        &canonical_data,
        canonical_models.as_deref(),
    ) {
        return Err(format!(
            "rm error: path {} is not under jan data folder {}",
            canonical_path.display(),
            canonical_data.display()
        ));
    }

    if path.is_file() {
        log::info!("rm: removing file {}", path.display());
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    } else if path.is_dir() {
        // Recursive, frontend-initiated, and irreversible — the one call that
        // can take a model directory with it. Recorded at warn so an "it
        // deleted my model" report can be traced to the caller that asked.
        log::warn!("rm: recursively removing directory {}", path.display());
        fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    } else {
        return Err("rm error: Path does not exist".to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn mkdir<R: Runtime>(app_handle: tauri::AppHandle<R>, args: Vec<String>) -> Result<(), String> {
    if args.is_empty() || args[0].is_empty() {
        return Err("mkdir error: Invalid argument".to_string());
    }

    let path = resolve_path(app_handle, &args[0]);
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mv<R: Runtime>(app_handle: tauri::AppHandle<R>, args: Vec<String>) -> Result<(), String> {
    if args.len() < 2 || args[0].is_empty() || args[1].is_empty() {
        return Err("mv error: Invalid argument - source and destination required".to_string());
    }

    let source = resolve_path(app_handle.clone(), &args[0]);
    let destination = resolve_path(app_handle, &args[1]);

    if !source.exists() {
        return Err("mv error: Source path does not exist".to_string());
    }

    fs::rename(&source, &destination).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn join_path<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    args: Vec<String>,
) -> Result<String, String> {
    if args.is_empty() {
        return Err("join_path error: Invalid argument".to_string());
    }

    let path = resolve_path(app_handle.clone(), &args[0]);
    let joined_path = args[1..].iter().fold(path, |acc, part| acc.join(part));
    // `[data folder, "llamacpp", "models"]` only becomes a models path once joined.
    let joined_path = redirect_for_app(&app_handle, &jan_utils::normalize_path(&joined_path));
    Ok(joined_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn exists_sync<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    args: Vec<String>,
) -> Result<bool, String> {
    if args.is_empty() || args[0].is_empty() {
        return Err("exist_sync error: Invalid argument".to_string());
    }

    let path = resolve_path(app_handle, &args[0]);
    Ok(path.exists())
}

#[tauri::command]
pub fn file_stat<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    args: String,
) -> Result<FileStat, String> {
    if args.is_empty() {
        return Err("file_stat error: Invalid argument".to_string());
    }

    let path = resolve_path(app_handle, &args);
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    let is_directory = metadata.is_dir();
    let size = if is_directory { 0 } else { metadata.len() };
    let file_stat = FileStat { is_directory, size };
    Ok(file_stat)
}

#[tauri::command]
pub fn read_file_sync<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    args: Vec<String>,
) -> Result<String, String> {
    if args.is_empty() || args[0].is_empty() {
        return Err("read_file_sync error: Invalid argument".to_string());
    }

    let path = resolve_path(app_handle, &args[0]);
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Upper bound on the bytes a single `read_file_chunk` call returns.
///
/// Every custom-protocol response — the asset protocol and the IPC channel
/// alike — is materialised by WebView2 as one in-memory stream, and bodies
/// past roughly 10 MB fail to arrive in the webview ("Failed to fetch" on a
/// 200 response, #261). Callers page through a file well below that.
const READ_FILE_CHUNK_MAX: u64 = 8 * 1024 * 1024;

/// Read `length` bytes of `path` starting at `offset` and return them as a raw
/// binary IPC response (an `ArrayBuffer` on the JS side, no base64 detour).
/// Returns fewer bytes at end of file; an empty body means `offset` is at or
/// past the end.
#[tauri::command]
pub fn read_file_chunk<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    path: String,
    offset: u64,
    length: u64,
) -> Result<tauri::ipc::Response, String> {
    use std::io::{Read, Seek, SeekFrom};

    if path.is_empty() || length == 0 {
        return Err("read_file_chunk error: Invalid argument".to_string());
    }

    let path = resolve_path(app_handle, &path);
    let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        return Err("read_file_chunk error: path is a directory".to_string());
    }

    let to_read = length
        .min(READ_FILE_CHUNK_MAX)
        .min(metadata.len().saturating_sub(offset));
    let mut buf = Vec::with_capacity(to_read as usize);
    if to_read > 0 {
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        file.take(to_read)
            .read_to_end(&mut buf)
            .map_err(|e| e.to_string())?;
    }
    Ok(tauri::ipc::Response::new(buf))
}

/// A path may be written only if the user granted it via the native save dialog
/// this session, or it lives inside the app's own folders. Anything else is
/// refused so a compromised extension cannot write arbitrary files.
fn is_allowed_write_path<R: Runtime>(
    app: &tauri::AppHandle<R>,
    grants: &DialogGrants,
    path: &std::path::Path,
) -> bool {
    let data_folder = crate::core::app::commands::get_jan_data_folder_path(app.clone());
    if is_within_app_folders(path, &data_folder, chosen_models_folder(app).as_deref()) {
        return true;
    }
    grants
        .write
        .lock()
        .map(|granted| granted.contains(&grant_key(path)))
        .unwrap_or(false)
}

#[tauri::command]
pub fn write_file_sync<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    grants: tauri::State<'_, DialogGrants>,
    args: Vec<String>,
) -> Result<(), String> {
    if args.len() < 2 || args[0].is_empty() || args[1].is_empty() {
        return Err("write_file_sync error: Invalid argument".to_string());
    }

    let path = resolve_path(app_handle.clone(), &args[0]);
    if !is_allowed_write_path(&app_handle, &grants, &path) {
        return Err(format!(
            "write_file_sync error: {} was not picked in a save dialog and is outside the app's folders",
            path.display()
        ));
    }
    let content = &args[1];
    fs::write(&path, content).map_err(|e| e.to_string())
}

/// Decode `data_base64` and write it to `path`, creating parent folders.
///
/// The media library saves generated images and video through this. There was
/// no binary write at all before: the frontend called a `writeBlob` that no
/// Rust command backed, so every generation failed to save and the Library
/// stayed empty. Base64 rather than a JSON number array keeps a multi-megabyte
/// image from ballooning on its way over IPC.
///
/// Absolute paths only, because the user can point media at any folder they
/// own, and a relative path would silently land in the process's cwd.
#[tauri::command]
pub fn write_binary_file<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    path: String,
    data_base64: String,
) -> Result<(), String> {
    use base64::Engine;

    if path.is_empty() {
        return Err("write_binary_file error: Invalid argument".to_string());
    }
    let target = resolve_path(app_handle, &path);
    if !target.is_absolute() {
        return Err("write_binary_file error: path must be absolute".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("write_binary_file error: bad base64: {e}"))?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&target, bytes).map_err(|e| e.to_string())
}

/// Copy a file to a path the user picked in a save dialog ("Save as…").
///
/// Refuses to overwrite a directory and creates missing parent folders. The
/// source must be an existing regular file.
#[tauri::command]
pub fn copy_file<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    src: String,
    dest: String,
) -> Result<(), String> {
    if src.is_empty() || dest.is_empty() {
        return Err("copy_file error: source and destination required".to_string());
    }
    let source = resolve_path(app_handle.clone(), &src);
    let destination = resolve_path(app_handle, &dest);
    if !source.is_file() {
        return Err("copy_file error: source is not a file".to_string());
    }
    if !destination.is_absolute() || destination.is_dir() {
        return Err("copy_file error: destination must be an absolute file path".to_string());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(&source, &destination)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Delete one file. Unlike `rm` it is not limited to the app's own folders,
/// because a generation can live in a media folder the user chose - but it only
/// ever removes a single regular file, never a directory.
#[tauri::command]
pub fn remove_file<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    path: String,
) -> Result<(), String> {
    if path.is_empty() {
        return Err("remove_file error: Invalid argument".to_string());
    }
    let target = resolve_path(app_handle, &path);
    if !target.is_absolute() || !target.is_file() {
        return Err("remove_file error: not an existing file".to_string());
    }
    fs::remove_file(&target).map_err(|e| e.to_string())
}

/// Returns the current OS user's real home directory (e.g. `/Users/<name>` or
/// `C:\Users\<name>`), NOT the Jan data folder. Used by the local-model scanner
/// to locate other apps' model stores (Ollama / LM Studio / HF cache / Unsloth).
#[tauri::command]
pub fn get_os_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not resolve OS home directory".to_string())
}

/// Environment variables that name where other apps keep their models.
///
/// The renderer cannot read the process environment, and the local-model
/// scanner used to hardcode every store's default location — a user whose
/// `OLLAMA_MODELS` or `HF_HOME` points at a second disk was invisible to it.
/// Only this list is readable: it is the full set of keys the scanner uses,
/// and nothing else about the environment has any business in the webview.
const SCAN_ENV_KEYS: &[&str] = &[
    "OLLAMA_MODELS",
    "HF_HOME",
    "HF_HUB_CACHE",
    "TRANSFORMERS_CACHE",
    "UNSLOTH_STUDIO_HOME",
    "STUDIO_HOME",
    "LLAMA_CACHE",
    "LOCALAPPDATA",
    "APPDATA",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
];

/// Returns the subset of `keys` that are both on the scanner's allow-list and
/// set to a non-empty value. Unknown keys are silently dropped rather than
/// rejected, so an older renderer asking for a key a newer build no longer
/// exposes degrades to "not set".
#[tauri::command]
pub fn get_env_vars(keys: Vec<String>) -> std::collections::HashMap<String, String> {
    keys.into_iter()
        .filter(|key| SCAN_ENV_KEYS.contains(&key.as_str()))
        .filter_map(|key| {
            std::env::var(&key)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(|value| (key, value))
        })
        .collect()
}

/// Creates a filesystem link from `link` to an existing `target`, WITHOUT
/// copying data. Used to expose Ollama's content-addressed blobs as runnable
/// `*.gguf` files under `<ollama>/.studio_links/`. Prefers a symlink; falls back
/// to a hard link when symlinks aren't permitted (e.g. Windows without
/// developer mode). Returns "symlink" or "hardlink" to indicate which was used.
/// Parent directories of `link` are created as needed. Never copies blobs —
/// callers should skip the model if this fails.
#[tauri::command]
pub fn create_symlink(target: String, link: String) -> Result<String, String> {
    use std::path::Path;
    let target_path = Path::new(&target);
    if !target_path.exists() {
        return Err(format!("create_symlink: target does not exist: {target}"));
    }
    let link_path = Path::new(&link);
    if let Some(parent) = link_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Idempotent: drop any stale link before recreating it.
    if fs::symlink_metadata(link_path).is_ok() {
        let _ = fs::remove_file(link_path);
    }

    #[cfg(unix)]
    let symlink_result = std::os::unix::fs::symlink(target_path, link_path);
    #[cfg(windows)]
    let symlink_result = std::os::windows::fs::symlink_file(target_path, link_path);

    match symlink_result {
        Ok(()) => Ok("symlink".to_string()),
        Err(symlink_err) => match fs::hard_link(target_path, link_path) {
            Ok(()) => Ok("hardlink".to_string()),
            Err(hardlink_err) => Err(format!(
                "create_symlink failed (symlink: {symlink_err}; hardlink: {hardlink_err})"
            )),
        },
    }
}

#[tauri::command]
pub fn readdir_sync<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    args: Vec<String>,
) -> Result<Vec<String>, String> {
    if args.is_empty() || args[0].is_empty() {
        return Err("read_dir_sync error: Invalid argument".to_string());
    }

    let path = resolve_path(app_handle, &args[0]);
    let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;
    let paths: Vec<String> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path().to_string_lossy().to_string())
        .collect();
    Ok(paths)
}

/// Resolves `path` against the data folder and refuses anything outside the
/// app's folders. `label` names the path in the error ("path", "save path").
fn get_scoped_path<R: Runtime>(
    app: &tauri::AppHandle<R>,
    path: &str,
    label: &str,
) -> Result<std::path::PathBuf, String> {
    let jan_data_folder = crate::core::app::commands::get_jan_data_folder_path(app.clone());
    let resolved_path =
        redirect_for_app(app, &jan_utils::normalize_path(&jan_data_folder.join(path)));
    if !is_within_app_folders(
        &resolved_path,
        &jan_data_folder,
        chosen_models_folder(app).as_deref(),
    ) {
        return Err(format!(
            "Error: {} {} is not under jan_data_folder {}",
            label,
            resolved_path.to_string_lossy(),
            jan_data_folder.to_string_lossy(),
        ));
    }
    Ok(resolved_path)
}

#[tauri::command]
pub fn write_yaml<R: Runtime>(
    app: tauri::AppHandle<R>,
    data: serde_json::Value,
    save_path: &str,
) -> Result<(), String> {
    let save_path = get_scoped_path(&app, save_path, "save path")?;
    let file = fs::File::create(&save_path).map_err(|e| e.to_string())?;
    let mut writer = std::io::BufWriter::new(file);
    serde_yaml::to_writer(&mut writer, &data).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn read_yaml<R: Runtime>(
    app: tauri::AppHandle<R>,
    path: &str,
) -> Result<serde_json::Value, String> {
    let path = get_scoped_path(&app, path, "path")?;
    let file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = std::io::BufReader::new(file);
    let data: serde_json::Value = serde_yaml::from_reader(reader).map_err(|e| e.to_string())?;
    Ok(data)
}

/// Unpacks a backend archive. Async on purpose: a synchronous Tauri command
/// runs on the main thread, so the window stopped repainting and answering for
/// as long as an archive took to unpack - a fraction of a second for a CPU
/// build, much longer for a CUDA one. The work itself runs on a blocking
/// thread.
#[tauri::command]
pub async fn decompress<R: Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
    output_dir: String,
) -> Result<(), String> {
    let jan_data_folder = crate::core::app::commands::get_jan_data_folder_path(app.clone());
    tauri::async_runtime::spawn_blocking(move || {
        decompress_in(&jan_data_folder, &path, &output_dir)
    })
    .await
    .map_err(|e| format!("decompress task failed: {e}"))?
}

fn decompress_in(
    jan_data_folder: &std::path::Path,
    path: &str,
    output_dir: &str,
) -> Result<(), String> {
    let path_buf = jan_utils::normalize_path(&jan_data_folder.join(path));

    let output_dir_buf = jan_utils::normalize_path(&jan_data_folder.join(output_dir));
    if !jan_utils::is_within(&output_dir_buf, jan_data_folder) {
        return Err(format!(
            "Error: output directory {} is not under jan_data_folder {}",
            output_dir_buf.to_string_lossy(),
            jan_data_folder.to_string_lossy(),
        ));
    }

    // Ensure output directory exists
    fs::create_dir_all(&output_dir_buf).map_err(|e| {
        format!(
            "Failed to create output directory {}: {}",
            output_dir_buf.to_string_lossy(),
            e
        )
    })?;

    // Use short path on Windows to handle paths with spaces
    #[cfg(windows)]
    let file = {
        if let Some(short_path) = jan_utils::path::get_short_path(&path_buf) {
            fs::File::open(&short_path).map_err(|e| e.to_string())?
        } else {
            fs::File::open(&path_buf).map_err(|e| e.to_string())?
        }
    };

    #[cfg(not(windows))]
    let file = fs::File::open(&path_buf).map_err(|e| e.to_string())?;
    if path.ends_with(".tar.gz") {
        let tar = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(tar);
        archive.unpack(&output_dir_buf).map_err(|e| e.to_string())?;
    } else if path.ends_with(".zip") {
        let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
            let outpath = output_dir_buf.join(
                entry
                    .enclosed_name()
                    .ok_or_else(|| "Invalid zip entry path".to_string())?,
            );

            if entry.name().ends_with('/') {
                std::fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
            } else {
                if let Some(parent) = outpath.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let mut outfile = std::fs::File::create(&outpath).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Some(mode) = entry.unix_mode() {
                        let _ = std::fs::set_permissions(
                            &outpath,
                            std::fs::Permissions::from_mode(mode),
                        );
                    }
                }
            }
        }
    } else {
        return Err("Unsupported file format. Only .tar.gz and .zip are supported.".to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn normalize_backend_layout<R: Runtime>(
    app: tauri::AppHandle<R>,
    output_dir: &str,
    exe_name: &str,
) -> Result<(), String> {
    if output_dir.is_empty() || exe_name.is_empty() {
        return Err("normalize_backend_layout error: Invalid argument".to_string());
    }

    let jan_data_folder = crate::core::app::commands::get_jan_data_folder_path(app.clone());
    let output_dir_buf = jan_utils::normalize_path(&jan_data_folder.join(output_dir));
    if !jan_utils::is_within(&output_dir_buf, &jan_data_folder) {
        return Err(format!(
            "Error: output directory {} is not under jan_data_folder {}",
            output_dir_buf.to_string_lossy(),
            jan_data_folder.to_string_lossy(),
        ));
    }

    let build_bin_dir = output_dir_buf.join("build").join("bin");
    let expected_bin = build_bin_dir.join(exe_name);
    if expected_bin.exists() {
        return Ok(());
    }

    let move_entry = |src: &std::path::Path, dst_dir: &std::path::Path| -> Result<(), String> {
        let file_name = src
            .file_name()
            .ok_or_else(|| format!("Invalid backend entry path: {}", src.display()))?;
        let dst = dst_dir.join(file_name);
        if dst.exists() {
            if dst.is_dir() {
                fs::remove_dir_all(&dst).map_err(|e| e.to_string())?;
            } else {
                fs::remove_file(&dst).map_err(|e| e.to_string())?;
            }
        }
        fs::rename(src, &dst).map_err(|e| {
            format!(
                "Failed to move backend entry {} -> {}: {}",
                src.display(),
                dst.display(),
                e
            )
        })
    };

    let flat_bin = output_dir_buf.join(exe_name);
    if flat_bin.exists() {
        fs::create_dir_all(&build_bin_dir).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(&output_dir_buf).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let file_name = path.file_name().and_then(|name| name.to_str());
            if matches!(file_name, Some("build" | "version.txt" | "backend.txt")) {
                continue;
            }
            move_entry(&path, &build_bin_dir)?;
        }
        return Ok(());
    }

    let nested_dir = fs::read_dir(&output_dir_buf)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .find(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("llama-"))
                && path.join(exe_name).exists()
        });

    if let Some(nested_dir) = nested_dir {
        log::info!(
            "Relocating nested backend layout {}/ into build/bin/",
            nested_dir
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("nested")
        );
        fs::create_dir_all(&build_bin_dir).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(&nested_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            move_entry(&entry.path(), &build_bin_dir)?;
        }
        fs::remove_dir_all(&nested_dir).map_err(|e| e.to_string())?;
    }

    if expected_bin.exists() {
        Ok(())
    } else {
        Err(format!(
            "Backend extracted but {} was not found at expected path {}",
            exe_name,
            expected_bin.display()
        ))
    }
}

// rfd native file dialog
#[tauri::command]
pub async fn open_dialog(
    options: Option<DialogOpenOptions>,
) -> Result<Option<serde_json::Value>, String> {
    let mut dialog = AsyncFileDialog::new();

    if let Some(opts) = options {
        // Set default path
        if let Some(path) = opts.default_path {
            dialog = dialog.set_directory(&path);
        }

        // Set filters
        if let Some(filters) = opts.filters {
            for filter in filters {
                let extensions: Vec<&str> = filter.extensions.iter().map(|s| s.as_str()).collect();
                dialog = dialog.add_filter(&filter.name, &extensions);
            }
        }

        // Handle directory vs file selection
        if opts.directory == Some(true) {
            let result = dialog.pick_folder().await;
            return Ok(result.map(|folder| {
                serde_json::Value::String(folder.path().to_string_lossy().to_string())
            }));
        }

        // Handle multiple file selection
        if opts.multiple == Some(true) {
            let result = dialog.pick_files().await;
            return Ok(result.map(|files| {
                let paths: Vec<String> = files
                    .iter()
                    .map(|f| f.path().to_string_lossy().to_string())
                    .collect();
                serde_json::to_value(paths).unwrap()
            }));
        }
    }

    // Default: single file selection
    let result = dialog.pick_file().await;
    Ok(result.map(|file| serde_json::Value::String(file.path().to_string_lossy().to_string())))
}

#[tauri::command]
pub async fn save_dialog(
    grants: tauri::State<'_, DialogGrants>,
    options: Option<DialogOpenOptions>,
) -> Result<Option<String>, String> {
    let mut dialog = AsyncFileDialog::new();

    if let Some(opts) = options {
        // `default_path` may be a bare filename ("file.py") or a full path.
        // For a save dialog the filename portion must go through
        // `set_file_name` — passing it to `set_directory` (as before) made the
        // OS treat "file.py" as a folder and fall back to an "Untitled" name.
        if let Some(path) = opts.default_path {
            let p = std::path::Path::new(&path);
            if let Some(parent) = p.parent() {
                if !parent.as_os_str().is_empty() {
                    dialog = dialog.set_directory(parent);
                }
            }
            if let Some(name) = p.file_name() {
                dialog = dialog.set_file_name(name.to_string_lossy().into_owned());
            }
        }

        // Set filters
        if let Some(filters) = opts.filters {
            for filter in filters {
                let extensions: Vec<&str> = filter.extensions.iter().map(|s| s.as_str()).collect();
                dialog = dialog.add_filter(&filter.name, &extensions);
            }
        }
    }

    let result = dialog.save_file().await;
    if let Some(file) = result.as_ref() {
        grants
            .write
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(grant_key(file.path()));
    }
    Ok(result.map(|file| file.path().to_string_lossy().to_string()))
}
