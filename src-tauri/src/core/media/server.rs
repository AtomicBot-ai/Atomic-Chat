//! Runs the built-in engine for one model at a time (tracker Task 30 S05).
//!
//! The engine ships `sd-server`, which keeps a model loaded between images and
//! takes jobs over a local HTTP API (`/sdcpp/v1/img_gen`, `/vid_gen`,
//! `/jobs/{id}`, `/jobs/{id}/cancel`). Radium starts it privately on this
//! computer for the model the user picked; the Media page sends jobs to it.
//! This module builds how the server is started; the process itself is
//! supervised separately.

use std::path::Path;

use super::catalog::{model_install_plan, CatalogModel, CatalogQuant, ModelFileRole, ModelTask};

/// The server only ever listens on this computer.
pub const LISTEN_IP: &str = "127.0.0.1";

/// Folders the server scans when it makes an image, relative to the data
/// folder. They must exist: without them every job failed with "The system
/// cannot find the path specified" (checked on this PC, 2026-09-15).
pub const SCAN_DIRS: [(&str, &str); 3] = [
    ("--lora-model-dir", "media/loras"),
    ("--embd-dir", "media/embeddings"),
    ("--hires-upscalers-dir", "media/upscalers"),
];

/// The engine option each kind of model file is passed with.
pub fn role_flag(role: ModelFileRole) -> &'static str {
    match role {
        ModelFileRole::Model => "--model",
        ModelFileRole::DiffusionModel => "--diffusion-model",
        ModelFileRole::Vae => "--vae",
        ModelFileRole::ClipL => "--clip_l",
        ModelFileRole::T5xxl => "--t5xxl",
    }
}

/// The options that start the engine's server for `model` on `port`, or why
/// it cannot start.
pub fn server_args(
    data_dir: &Path,
    model: &CatalogModel,
    quant: &CatalogQuant,
    port: u16,
) -> Result<Vec<String>, String> {
    let plan = model_install_plan(data_dir, model, quant);
    if !plan.installed {
        return Err(format!(
            "{} ({}) is not fully downloaded yet. Download it before making images with it.",
            model.label, quant.label
        ));
    }
    let mut args = Vec::new();
    for (file, download) in model.files_for(quant).into_iter().zip(&plan.downloads) {
        // Built part by part so the path uses this system's separators.
        let path = download
            .save_path
            .split('/')
            .fold(data_dir.to_path_buf(), |path, part| path.join(part));
        args.push(role_flag(file.role).to_string());
        args.push(path.to_string_lossy().into_owned());
    }
    if model.tasks.contains(&ModelTask::TextToVideo) {
        // The engine's Wan guide runs video with these so it fits in memory.
        args.push("--diffusion-fa".to_string());
        args.push("--offload-to-cpu".to_string());
    }
    for (flag, relative) in SCAN_DIRS {
        let folder = relative
            .split('/')
            .fold(data_dir.to_path_buf(), |path, part| path.join(part));
        args.push(flag.to_string());
        args.push(folder.to_string_lossy().into_owned());
    }
    args.extend([
        "--listen-ip".to_string(),
        LISTEN_IP.to_string(),
        "--listen-port".to_string(),
        port.to_string(),
    ]);
    Ok(args)
}

/// The address the Media page sends jobs to.
pub fn server_base_url(port: u16) -> String {
    format!("http://{LISTEN_IP}:{port}")
}

/// A port on this computer that nothing is listening on right now. The port is
/// released as soon as it is found, for the server to take.
pub fn pick_free_port() -> Result<u16, String> {
    let describe = |error: std::io::Error| format!("No free port on this computer: {error}");
    let listener = std::net::TcpListener::bind((LISTEN_IP, 0)).map_err(describe)?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(describe)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::media::catalog::{CatalogFile, CatalogQuant, GenerationDefaults, ModelTask};

    const TINY_QUANTS: [CatalogQuant; 1] = [CatalogQuant {
        id: "q4_0",
        label: "Q4_0",
        note: "Small.",
        file: CatalogFile {
            role: ModelFileRole::DiffusionModel,
            repo: "example/tiny-model",
            revision: "0123456789abcdef0123456789abcdef01234567",
            file: "tiny-Q4_0.gguf",
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            size: 5,
        },
    }];

    const SHARED_FILES: [CatalogFile; 1] = [CatalogFile {
        role: ModelFileRole::Vae,
        repo: "example/tiny-parts",
        revision: "89abcdef0123456789abcdef0123456789abcdef",
        file: "split_files/vae/tiny_vae.safetensors",
        sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        size: 3,
    }];

    const DEFAULTS: GenerationDefaults = GenerationDefaults {
        width: 64,
        height: 64,
        steps: 1,
        cfg_scale: 1.0,
        sampler: "euler",
    };

    const TINY_IMAGE: CatalogModel = CatalogModel {
        id: "tiny",
        label: "Tiny image model",
        family: "test",
        license: "apache-2.0",
        license_url: "https://www.apache.org/licenses/LICENSE-2.0",
        tasks: &[ModelTask::TextToImage],
        min_memory_mb: 1,
        defaults: DEFAULTS,
        quants: &TINY_QUANTS,
        default_quant: "q4_0",
        files: &SHARED_FILES,
    };

    const TINY_VIDEO: CatalogModel = CatalogModel {
        id: "tiny",
        label: "Tiny video model",
        family: "test-video",
        license: "apache-2.0",
        license_url: "https://www.apache.org/licenses/LICENSE-2.0",
        tasks: &[ModelTask::TextToVideo],
        min_memory_mb: 1,
        defaults: DEFAULTS,
        quants: &TINY_QUANTS,
        default_quant: "q4_0",
        files: &SHARED_FILES,
    };

    /// Puts the tiny model's files in place at their full size.
    fn install_tiny(data: &Path) {
        let folder = data.join("media").join("models").join("tiny");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("tiny-Q4_0.gguf"), b"12345").unwrap();
        std::fs::write(folder.join("tiny_vae.safetensors"), b"123").unwrap();
    }

    fn scan_dir(data: &Path, name: &str) -> String {
        data.join("media").join(name).to_string_lossy().into_owned()
    }

    fn model_file(data: &Path, name: &str) -> String {
        data.join("media")
            .join("models")
            .join("tiny")
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn each_kind_of_model_file_uses_the_engines_own_option() {
        assert_eq!(role_flag(ModelFileRole::Model), "--model");
        assert_eq!(
            role_flag(ModelFileRole::DiffusionModel),
            "--diffusion-model"
        );
        assert_eq!(role_flag(ModelFileRole::Vae), "--vae");
        assert_eq!(role_flag(ModelFileRole::ClipL), "--clip_l");
        assert_eq!(role_flag(ModelFileRole::T5xxl), "--t5xxl");
    }

    #[test]
    fn the_server_starts_with_every_model_file_and_listens_only_on_this_computer() {
        let data = tempfile::TempDir::new().unwrap();
        install_tiny(data.path());

        let args = server_args(data.path(), &TINY_IMAGE, &TINY_QUANTS[0], 41_234).unwrap();

        assert_eq!(
            args,
            [
                "--diffusion-model".to_string(),
                model_file(data.path(), "tiny-Q4_0.gguf"),
                "--vae".to_string(),
                model_file(data.path(), "tiny_vae.safetensors"),
                "--lora-model-dir".to_string(),
                scan_dir(data.path(), "loras"),
                "--embd-dir".to_string(),
                scan_dir(data.path(), "embeddings"),
                "--hires-upscalers-dir".to_string(),
                scan_dir(data.path(), "upscalers"),
                "--listen-ip".to_string(),
                "127.0.0.1".to_string(),
                "--listen-port".to_string(),
                "41234".to_string(),
            ]
        );
        assert_eq!(server_base_url(41_234), "http://127.0.0.1:41234");
    }

    #[test]
    fn video_models_get_the_memory_saving_options_from_the_engines_guide() {
        let data = tempfile::TempDir::new().unwrap();
        install_tiny(data.path());

        let video = server_args(data.path(), &TINY_VIDEO, &TINY_QUANTS[0], 41_234).unwrap();
        let image = server_args(data.path(), &TINY_IMAGE, &TINY_QUANTS[0], 41_234).unwrap();

        for option in ["--diffusion-fa", "--offload-to-cpu"] {
            assert!(
                video.iter().any(|arg| arg == option),
                "video is missing {option}"
            );
            assert!(
                !image.iter().any(|arg| arg == option),
                "images do not need {option}"
            );
        }
    }

    #[test]
    fn a_model_that_is_not_fully_downloaded_is_not_started() {
        let data = tempfile::TempDir::new().unwrap();

        let error = server_args(data.path(), &TINY_IMAGE, &TINY_QUANTS[0], 41_234).unwrap_err();

        assert!(error.contains("Tiny image model"), "{error}");
        assert!(error.contains("not fully downloaded"), "{error}");
        assert!(!model_install_plan(data.path(), &TINY_IMAGE, &TINY_QUANTS[0]).installed);
    }

    #[test]
    fn a_free_port_is_found_on_this_computer() {
        let port = pick_free_port().unwrap();

        assert!(port > 0);
        // Nothing is using it, so it can be taken straight away.
        std::net::TcpListener::bind((LISTEN_IP, port)).unwrap();
    }
}
