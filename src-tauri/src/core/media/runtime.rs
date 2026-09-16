//! Installs and runs the built-in engine for the Media page (tracker Task 30
//! S05, part 3).
//!
//! The Media page asks for three things, and this module is all of them:
//! what the engine and its models look like on this computer, to download the
//! engine and a model in one go with a progress bar, and to run the engine for
//! the model the user picked. Only one model is loaded at a time; picking
//! another stops the first. The engine is stopped when Radium quits.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Serialize;
use tauri::{Runtime, State};
use tokio::{process::Child, sync::Mutex};

use super::{
    catalog::{
        catalog, model_install_plan, resolve_model, CatalogModel, CatalogQuant, GenerationDefaults,
        ModelFileRole, ModelTask,
    },
    engine::{
        choose_engine_variant, engine_install_plan, host_platform, EngineInstallPlan,
        EngineVariant, GpuSummary, GpuVendor,
    },
    server::{pick_free_port, server_args, server_base_url},
    supervisor::{start_server, stop_server},
};
use crate::core::{
    app::commands::get_jan_data_folder_path,
    downloads::{commands::download_files, models::DownloadItem},
    state::AppState,
};

/// Answers as soon as the server has loaded its model (checked on this PC).
pub const READY_PATH: &str = "/v1/models";

/// Loading a large model from a slow disk can take a while.
const START_TIMEOUT: Duration = Duration::from_secs(300);

struct RunningEngine {
    model_id: String,
    port: u16,
    child: Child,
}

/// The engine Radium is running, if any. Managed by Tauri next to `AppState`.
#[derive(Default)]
pub struct MediaEngineState {
    running: Mutex<Option<RunningEngine>>,
}

/// One graphics device as the engine choice needs it.
pub fn gpu_summary(
    vendor: GpuVendor,
    name: &str,
    has_vulkan: bool,
    has_nvidia_driver: bool,
) -> GpuSummary {
    GpuSummary {
        vendor,
        name: name.to_string(),
        supports_vulkan: has_vulkan,
        has_cuda_driver: vendor == GpuVendor::Nvidia && has_nvidia_driver,
    }
}

#[cfg(feature = "hardware")]
fn detected_gpus() -> Vec<GpuSummary> {
    use tauri_plugin_hardware::Vendor;
    tauri_plugin_hardware::get_system_info()
        .gpus
        .iter()
        .map(|gpu| {
            let vendor = match gpu.vendor {
                Vendor::NVIDIA => GpuVendor::Nvidia,
                Vendor::AMD => GpuVendor::Amd,
                Vendor::Intel => GpuVendor::Intel,
                Vendor::Unknown(_) => GpuVendor::Other,
            };
            gpu_summary(
                vendor,
                &gpu.name,
                gpu.vulkan_info.is_some(),
                gpu.nvidia_info.is_some(),
            )
        })
        .collect()
}

/// Without the hardware plugin nothing is known about graphics, which picks the
/// CPU build: slow, but it runs.
#[cfg(not(feature = "hardware"))]
fn detected_gpus() -> Vec<GpuSummary> {
    Vec::new()
}

/// The engine build for this computer, or why there is none.
fn this_computers_variant() -> Result<EngineVariant, String> {
    let (os, arch) = host_platform(std::env::consts::OS, std::env::consts::ARCH);
    choose_engine_variant(os, arch, &detected_gpus())
        .ok_or_else(|| "The built-in media engine has no build for this computer.".to_string())
}

/// A path relative to the data folder, written with `/`, on this system.
fn under(data_dir: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(data_dir.to_path_buf(), |path, part| path.join(part))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ModelStatus {
    pub id: &'static str,
    pub label: &'static str,
    pub family: &'static str,
    pub tasks: &'static [ModelTask],
    pub license: &'static str,
    pub license_url: &'static str,
    pub min_memory_mb: u64,
    pub defaults: GenerationDefaults,
    /// The default size's download, and whether it is complete.
    pub size_bytes: u64,
    pub installed: bool,
    /// The size used when none is chosen.
    pub default_quant: &'static str,
    /// Every size offered, smallest first.
    pub quants: Vec<QuantStatus>,
}

/// One size of a model, and what downloading it saves.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct QuantStatus {
    pub id: &'static str,
    pub label: &'static str,
    pub note: &'static str,
    /// Every file this size needs, shared parts included.
    pub size_bytes: u64,
    pub installed: bool,
    pub files: Vec<FileStatus>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FileStatus {
    pub role: ModelFileRole,
    pub name: &'static str,
    pub repo: &'static str,
    pub size: u64,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EngineStatus {
    pub variant: EngineVariant,
    pub engine_installed: bool,
    pub engine_size_bytes: u64,
    pub models: Vec<ModelStatus>,
    /// The model the engine is running, and where to send jobs for it.
    pub running_model: Option<String>,
    pub base_url: Option<String>,
}

/// Every catalog model, each of its sizes, and what is downloaded under
/// `data_dir`.
pub fn model_statuses(data_dir: &Path) -> Vec<ModelStatus> {
    catalog()
        .iter()
        .map(|model| {
            let standard = quant_status(data_dir, model, model.standard_quant());
            ModelStatus {
                id: model.id,
                label: model.label,
                family: model.family,
                tasks: model.tasks,
                license: model.license,
                license_url: model.license_url,
                min_memory_mb: model.min_memory_mb,
                defaults: model.defaults,
                size_bytes: standard.size_bytes,
                installed: standard.installed,
                default_quant: standard.id,
                quants: model
                    .quants
                    .iter()
                    .map(|quant| quant_status(data_dir, model, quant))
                    .collect(),
            }
        })
        .collect()
}

fn quant_status(data_dir: &Path, model: &CatalogModel, quant: &CatalogQuant) -> QuantStatus {
    let plan = model_install_plan(data_dir, model, quant);
    let files = model
        .files_for(quant)
        .into_iter()
        .zip(&plan.downloads)
        .map(|(file, download)| FileStatus {
            role: file.role,
            name: file.file_name(),
            repo: file.repo,
            size: file.size,
            installed: fs::metadata(under(data_dir, &download.save_path))
                .is_ok_and(|meta| meta.is_file() && meta.len() == download.size),
        })
        .collect();
    QuantStatus {
        id: quant.id,
        label: quant.label,
        note: quant.note,
        size_bytes: plan.total_size,
        installed: plan.installed,
        files,
    }
}

/// What still has to be downloaded to make images with `model_id`: the engine
/// (when it is not installed yet) and the model's missing files.
pub fn downloads_needed(
    data_dir: &Path,
    variant: EngineVariant,
    model_id: &str,
) -> Result<Vec<DownloadItem>, String> {
    let (model, quant) = resolve_model(model_id)
        .ok_or_else(|| format!("The built-in engine has no model called \"{model_id}\"."))?;
    let mut items = Vec::new();
    let engine = engine_install_plan(data_dir, variant);
    if !engine.installed {
        items.extend(engine.downloads.iter().map(|download| DownloadItem {
            url: download.url.clone(),
            save_path: download.save_path.clone(),
            proxy: None,
            sha256: Some(download.sha256.to_string()),
            size: Some(download.size),
            model_id: Some("media-engine".to_string()),
        }));
    }
    let plan = model_install_plan(data_dir, model, quant);
    items.extend(
        plan.downloads
            .iter()
            // A part already there at its full size is not fetched again.
            .filter(|download| {
                fs::metadata(under(data_dir, &download.save_path))
                    .map(|meta| meta.len() != download.size)
                    .unwrap_or(true)
            })
            .map(|download| DownloadItem {
                url: download.url.clone(),
                save_path: download.save_path.clone(),
                proxy: None,
                sha256: Some(download.sha256.to_string()),
                size: Some(download.size),
                model_id: Some(format!("media:{model_id}")),
            }),
    );
    Ok(items)
}

/// Unpack a downloaded engine archive into its install folder. Entries that
/// would land outside the folder are refused.
pub fn unpack_archive(archive: &Path, into: &Path) -> Result<(), String> {
    let file = fs::File::open(archive)
        .map_err(|error| format!("Could not open {}: {error}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|error| format!("{} is not a readable archive: {error}", archive.display()))?;
    fs::create_dir_all(into).map_err(|error| error.to_string())?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|error| error.to_string())?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| format!("{} holds an unsafe path", archive.display()))?;
        let target = into.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut out = fs::File::create(&target).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&target, fs::Permissions::from_mode(mode));
        }
    }
    Ok(())
}

/// Unpack every downloaded archive of `plan`, then remove the archives.
pub fn finish_engine_install(data_dir: &Path, plan: &EngineInstallPlan) -> Result<(), String> {
    let install_dir = under(data_dir, &plan.install_dir);
    for download in &plan.downloads {
        let archive = under(data_dir, &download.save_path);
        unpack_archive(&archive, &install_dir)?;
    }
    if !under(data_dir, &plan.executable).is_file() {
        return Err(format!(
            "The media engine was unpacked, but {} is missing from it.",
            plan.executable
        ));
    }
    for download in &plan.downloads {
        let _ = fs::remove_file(under(data_dir, &download.save_path));
    }
    Ok(())
}

/// The program and options that start the engine for `model_id`, or why it
/// cannot start yet.
pub fn start_command(
    data_dir: &Path,
    variant: EngineVariant,
    model_id: &str,
    port: u16,
) -> Result<(PathBuf, Vec<String>), String> {
    let engine = engine_install_plan(data_dir, variant);
    if !engine.installed {
        return Err(
            "The built-in media engine is not installed yet. Download a model to install it."
                .to_string(),
        );
    }
    let (model, quant) = resolve_model(model_id)
        .ok_or_else(|| format!("The built-in engine has no model called \"{model_id}\"."))?;
    let args = server_args(data_dir, model, quant, port)?;
    for (_, relative) in super::server::SCAN_DIRS {
        fs::create_dir_all(under(data_dir, relative))
            .map_err(|error| format!("Could not create the media folder {relative}: {error}"))?;
    }
    Ok((under(data_dir, &engine.executable), args))
}

#[tauri::command]
pub async fn media_engine_status<R: Runtime>(
    app: tauri::AppHandle<R>,
    engine: State<'_, MediaEngineState>,
) -> Result<EngineStatus, String> {
    let data_dir = get_jan_data_folder_path(app);
    let variant = this_computers_variant()?;
    let plan = engine_install_plan(&data_dir, variant);
    let mut running = engine.running.lock().await;
    // A server that has exited on its own is no longer running.
    if let Some(current) = running.as_mut() {
        if !matches!(current.child.try_wait(), Ok(None)) {
            *running = None;
        }
    }
    Ok(EngineStatus {
        variant,
        engine_installed: plan.installed,
        engine_size_bytes: plan.downloads.iter().map(|download| download.size).sum(),
        models: model_statuses(&data_dir),
        running_model: running.as_ref().map(|current| current.model_id.clone()),
        base_url: running
            .as_ref()
            .map(|current| server_base_url(current.port)),
    })
}

/// Download whatever is missing to make images with `model_id`, reporting
/// progress on the download manager's `download-{task_id}` event, and unpack
/// the engine if it was part of it. Cancel with `cancel_download_task`.
#[tauri::command]
pub async fn media_engine_install<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    model_id: String,
    task_id: String,
) -> Result<(), String> {
    let data_dir = get_jan_data_folder_path(app.clone());
    let variant = this_computers_variant()?;
    let items = downloads_needed(&data_dir, variant, &model_id)?;
    if !items.is_empty() {
        download_files(app, state, items, &task_id, HashMap::new(), false).await?;
    }
    let plan = engine_install_plan(&data_dir, variant);
    if !plan.installed {
        let unpack_dir = data_dir.clone();
        tauri::async_runtime::spawn_blocking(move || finish_engine_install(&unpack_dir, &plan))
            .await
            .map_err(|error| error.to_string())??;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct StartedEngine {
    pub model_id: String,
    pub base_url: String,
}

/// Run the engine for `model_id`, stopping any other model first. Returns once
/// the model is loaded and the engine takes jobs.
#[tauri::command]
pub async fn media_engine_start<R: Runtime>(
    app: tauri::AppHandle<R>,
    engine: State<'_, MediaEngineState>,
    model_id: String,
) -> Result<StartedEngine, String> {
    let mut running = engine.running.lock().await;
    if let Some(current) = running.as_mut() {
        if current.model_id == model_id && matches!(current.child.try_wait(), Ok(None)) {
            return Ok(StartedEngine {
                model_id,
                base_url: server_base_url(current.port),
            });
        }
    }
    if let Some(mut previous) = running.take() {
        let _ = stop_server(&mut previous.child).await;
    }

    let data_dir = get_jan_data_folder_path(app);
    let variant = this_computers_variant()?;
    let port = pick_free_port()?;
    let (program, args) = start_command(&data_dir, variant, &model_id, port)?;
    let base_url = server_base_url(port);
    log::info!("Starting the media engine for {model_id} on {base_url}");
    let child = start_server(
        &program,
        &args,
        &format!("{base_url}{READY_PATH}"),
        START_TIMEOUT,
    )
    .await?;
    *running = Some(RunningEngine {
        model_id: model_id.clone(),
        port,
        child,
    });
    Ok(StartedEngine { model_id, base_url })
}

#[tauri::command]
pub async fn media_engine_stop(engine: State<'_, MediaEngineState>) -> Result<(), String> {
    if let Some(mut current) = engine.running.lock().await.take() {
        stop_server(&mut current.child).await?;
    }
    Ok(())
}

/// Stops the engine when Radium quits.
pub async fn stop_engine_on_exit(engine: &MediaEngineState) {
    if let Some(mut current) = engine.running.lock().await.take() {
        log::info!("Stopping the media engine ({})", current.model_id);
        let _ = stop_server(&mut current.child).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::media::catalog::find_model;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn only_nvidia_with_its_driver_counts_as_cuda() {
        assert!(gpu_summary(GpuVendor::Nvidia, "RTX 3090", true, true).has_cuda_driver);
        assert!(!gpu_summary(GpuVendor::Nvidia, "RTX 3090", true, false).has_cuda_driver);
        assert!(!gpu_summary(GpuVendor::Amd, "Radeon", true, true).has_cuda_driver);
        assert!(gpu_summary(GpuVendor::Amd, "Radeon", true, false).supports_vulkan);
    }

    #[test]
    fn a_fresh_data_folder_lists_every_model_as_not_downloaded() {
        let tmp = tempdir().unwrap();
        let statuses = model_statuses(tmp.path());
        assert_eq!(statuses.len(), catalog().len());
        assert!(statuses
            .iter()
            .all(|model| !model.installed && model.size_bytes > 0));
        assert!(statuses.iter().any(|model| model.id == "sd-1.5"));
    }

    #[test]
    fn a_first_install_downloads_the_engine_and_the_model_together() {
        let tmp = tempdir().unwrap();
        let items = downloads_needed(tmp.path(), EngineVariant::WindowsVulkan, "sd-1.5").unwrap();
        assert!(items
            .iter()
            .any(|item| item.save_path.starts_with("media/engine/")));
        assert!(items
            .iter()
            .any(|item| item.save_path.starts_with("media/models/sd-1.5/")));
        // Every file is checked by size and checksum before it is kept.
        assert!(items
            .iter()
            .all(|item| item.sha256.is_some() && item.size.is_some()));
    }

    #[test]
    fn nothing_already_downloaded_is_fetched_again() {
        let tmp = tempdir().unwrap();
        let variant = EngineVariant::WindowsCpu;
        let plan = engine_install_plan(tmp.path(), variant);
        let program = under(tmp.path(), &plan.executable);
        fs::create_dir_all(program.parent().unwrap()).unwrap();
        fs::write(&program, b"engine").unwrap();

        let items = downloads_needed(tmp.path(), variant, "sd-1.5").unwrap();

        assert!(items
            .iter()
            .all(|item| !item.save_path.starts_with("media/engine/")));
        let model = find_model("sd-1.5").unwrap();
        assert_eq!(items.len(), model.files_for(model.standard_quant()).len());
    }

    #[test]
    fn every_model_lists_its_sizes_with_the_files_each_downloads() {
        let tmp = tempdir().unwrap();
        let statuses = model_statuses(tmp.path());
        for status in &statuses {
            assert!(!status.quants.is_empty(), "{}", status.id);
            let standard = status
                .quants
                .iter()
                .find(|quant| quant.id == status.default_quant)
                .expect("the default size is listed");
            assert_eq!(standard.size_bytes, status.size_bytes, "{}", status.id);
            for quant in &status.quants {
                let files: u64 = quant.files.iter().map(|file| file.size).sum();
                assert_eq!(files, quant.size_bytes, "{} {}", status.id, quant.id);
                assert!(!quant.installed && quant.files.iter().all(|file| !file.installed));
            }
        }
        let flux = statuses
            .iter()
            .find(|status| status.id == "flux.1-schnell")
            .unwrap();
        let q8 = flux.quants.iter().find(|quant| quant.id == "q8_0").unwrap();
        assert_eq!(q8.files[0].name, "flux1-schnell-Q8_0.gguf");
        assert_eq!(q8.files[0].role, ModelFileRole::DiffusionModel);
        assert_eq!(q8.files.len(), 4, "the VAE and both text encoders come too");
    }

    #[test]
    fn a_chosen_size_downloads_its_own_main_file_and_the_shared_parts() {
        let tmp = tempdir().unwrap();
        let items =
            downloads_needed(tmp.path(), EngineVariant::WindowsCpu, "flux.1-schnell@q8_0").unwrap();
        let paths: Vec<&str> = items.iter().map(|item| item.save_path.as_str()).collect();

        assert!(paths.contains(&"media/models/flux.1-schnell/flux1-schnell-Q8_0.gguf"));
        assert!(paths.contains(&"media/models/flux.1-schnell/ae.safetensors"));
        assert!(!paths
            .iter()
            .any(|path| path.ends_with("flux1-schnell-Q4_0.gguf")));
        let error = downloads_needed(tmp.path(), EngineVariant::WindowsCpu, "flux.1-schnell@q9")
            .unwrap_err();
        assert!(error.contains("flux.1-schnell@q9"), "{error}");
    }

    #[test]
    fn an_unknown_model_is_refused_by_name() {
        let tmp = tempdir().unwrap();
        let error = downloads_needed(tmp.path(), EngineVariant::WindowsCpu, "nope").unwrap_err();
        assert!(error.contains("nope"));
    }

    fn zip_with(path: &Path, entries: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::default();
        for (name, bytes) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn the_engine_archive_is_unpacked_and_then_removed() {
        let tmp = tempdir().unwrap();
        let variant = EngineVariant::WindowsCpu;
        let plan = engine_install_plan(tmp.path(), variant);
        let program_name = plan.executable.rsplit('/').next().unwrap().to_string();
        for download in &plan.downloads {
            let archive = under(tmp.path(), &download.save_path);
            fs::create_dir_all(archive.parent().unwrap()).unwrap();
            zip_with(
                &archive,
                &[(&program_name, b"engine"), ("lib/helper.dll", b"dll")],
            );
        }

        finish_engine_install(tmp.path(), &plan).unwrap();

        assert!(under(tmp.path(), &plan.executable).is_file());
        assert!(under(tmp.path(), &plan.install_dir)
            .join("lib")
            .join("helper.dll")
            .is_file());
        assert!(plan
            .downloads
            .iter()
            .all(|download| !under(tmp.path(), &download.save_path).exists()));
        assert!(engine_install_plan(tmp.path(), variant).installed);
    }

    #[test]
    fn an_archive_without_the_engine_program_is_an_error() {
        let tmp = tempdir().unwrap();
        let plan = engine_install_plan(tmp.path(), EngineVariant::WindowsCpu);
        for download in &plan.downloads {
            let archive = under(tmp.path(), &download.save_path);
            fs::create_dir_all(archive.parent().unwrap()).unwrap();
            zip_with(&archive, &[("readme.txt", b"no engine here")]);
        }
        assert!(finish_engine_install(tmp.path(), &plan).is_err());
    }

    #[test]
    fn an_archive_entry_escaping_its_folder_is_refused() {
        let tmp = tempdir().unwrap();
        let archive = tmp.path().join("bad.zip");
        zip_with(&archive, &[("../escaped.txt", b"x")]);
        assert!(unpack_archive(&archive, &tmp.path().join("into")).is_err());
        assert!(!tmp.path().join("escaped.txt").exists());
    }

    #[test]
    fn the_engine_does_not_start_before_it_is_installed() {
        let tmp = tempdir().unwrap();
        let error =
            start_command(tmp.path(), EngineVariant::WindowsCpu, "sd-1.5", 5000).unwrap_err();
        assert!(error.contains("not installed"));
    }

    #[test]
    fn a_model_not_fully_downloaded_does_not_start() {
        let tmp = tempdir().unwrap();
        let variant = EngineVariant::WindowsCpu;
        let plan = engine_install_plan(tmp.path(), variant);
        let program = under(tmp.path(), &plan.executable);
        fs::create_dir_all(program.parent().unwrap()).unwrap();
        fs::write(&program, b"engine").unwrap();

        let error = start_command(tmp.path(), variant, "sd-1.5", 5000).unwrap_err();

        assert!(error.contains("not fully downloaded"));
    }

    #[test]
    fn the_engine_runs_its_server_program() {
        let tmp = tempdir().unwrap();
        let plan = engine_install_plan(tmp.path(), EngineVariant::WindowsVulkan);
        assert!(plan.executable.ends_with("sd-server.exe"));
    }

    /// The real engine makes one image through Radium's own start path: the
    /// install layout, `start_command` (model files and scan folders),
    /// `start_server` and its ready check, then a job on the server's API.
    ///
    /// Needs an unpacked engine build and the SD 1.5 file on this computer:
    /// `RADIUM_SD_ENGINE_DIR=<folder with sd-server> RADIUM_SD_MODEL=<gguf>
    /// cargo test ... -- --ignored the_real_engine`.
    #[tokio::test]
    #[ignore = "needs the real engine and a 1.7 GB model on this computer"]
    async fn the_real_engine_makes_an_image_through_radiums_start_path() {
        use tauri_plugin_http::reqwest;

        let engine_dir = std::env::var("RADIUM_SD_ENGINE_DIR").expect("set RADIUM_SD_ENGINE_DIR");
        let model_file = std::env::var("RADIUM_SD_MODEL").expect("set RADIUM_SD_MODEL");
        let tmp = tempdir().unwrap();
        let data = tmp.path();
        let variant = if cfg!(windows) {
            EngineVariant::WindowsVulkan
        } else {
            EngineVariant::LinuxVulkan
        };

        // Lay the engine and the model out exactly where an install puts them.
        let plan = engine_install_plan(data, variant);
        let install_dir = under(data, &plan.install_dir);
        fs::create_dir_all(&install_dir).unwrap();
        for entry in fs::read_dir(&engine_dir).unwrap() {
            let entry = entry.unwrap();
            if entry.path().is_file() {
                fs::copy(entry.path(), install_dir.join(entry.file_name())).unwrap();
            }
        }
        let model = find_model("sd-1.5").unwrap();
        let target = under(
            data,
            &model_install_plan(data, model, model.standard_quant()).downloads[0].save_path,
        );
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        if fs::hard_link(&model_file, &target).is_err() {
            fs::copy(&model_file, &target).unwrap();
        }

        let port = pick_free_port().unwrap();
        let (program, args) = start_command(data, variant, "sd-1.5", port).unwrap();
        let base = server_base_url(port);
        let mut child = start_server(
            &program,
            &args,
            &format!("{base}{READY_PATH}"),
            START_TIMEOUT,
        )
        .await
        .unwrap();

        let client = reqwest::Client::new();
        let body = serde_json::json!({
            "prompt": "a red apple on a wooden table",
            "width": 256,
            "height": 256,
            "sample_params": { "sample_steps": 6, "guidance": { "txt_cfg": 7.0 } },
            "seed": 42,
            "batch_count": 1
        });
        let submitted: serde_json::Value = client
            .post(format!("{base}/sdcpp/v1/img_gen"))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let id = submitted["id"].as_str().expect("a job id").to_string();

        let mut job = serde_json::Value::Null;
        for _ in 0..600 {
            job = client
                .get(format!("{base}/sdcpp/v1/jobs/{id}"))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if matches!(
                job["status"].as_str(),
                Some("completed" | "failed" | "cancelled")
            ) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        stop_server(&mut child).await.unwrap();

        assert_eq!(job["status"], "completed", "the job ended as: {job}");
        let image = job["result"]["images"][0]["b64_json"]
            .as_str()
            .unwrap_or("");
        assert!(image.len() > 1000, "no image came back");
    }
}
