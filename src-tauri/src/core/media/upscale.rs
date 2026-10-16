//! Upscaling a finished image to the chosen output size (up to 4K).
//!
//! The model renders at its own comfortable size; this enlarges the result
//! afterwards. With an ESRGAN model downloaded (Real-ESRGAN 4×, 4×-UltraSharp)
//! the engine's one-shot tool does the enlarging (`sd-cli -M upscale
//! --upscale-model …`, shipped in the pinned release next to `sd-server`), and
//! a Lanczos resize then lands it on the exact target. Without one, a Lanczos
//! resize does all of it. The result always says which happened, so the UI and
//! the library can label it as upscaled.

use std::{
    io::Cursor,
    path::{Path, PathBuf},
    process::Stdio,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{imageops::FilterType, ImageFormat};
use serde::Serialize;
use tauri::Runtime;

use super::{
    catalog::{find_upscaler, upscaler_install_plan, upscalers, UpscalerModel},
    engine::{engine_install_plan, EngineVariant},
    resolution::{esrgan_passes, find_output_size, output_target},
};
use crate::core::app::commands::get_jan_data_folder_path;

/// How a finished image was enlarged.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UpscaleInfo {
    /// `esrgan` (model upscaler, then Lanczos to the exact size) or `lanczos`.
    pub method: &'static str,
    /// The ESRGAN model used, when one was.
    pub upscaler: Option<&'static str>,
    pub source_width: u32,
    pub source_height: u32,
    pub width: u32,
    pub height: u32,
    /// Why ESRGAN was not used when it was asked for, in plain words.
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpscaledImage {
    pub image_base64: String,
    pub mime: &'static str,
    pub info: UpscaleInfo,
}

/// The engine's one-shot tool, if the installed build has it.
pub fn upscale_tool(data_dir: &Path, variant: EngineVariant) -> Option<PathBuf> {
    let plan = engine_install_plan(data_dir, variant);
    if !plan.installed {
        return None;
    }
    let server = plan
        .executable
        .split('/')
        .fold(data_dir.to_path_buf(), |path, part| path.join(part));
    let name = if cfg!(windows) {
        "sd-cli.exe"
    } else {
        "sd-cli"
    };
    let tool = server.parent()?.join(name);
    tool.is_file().then_some(tool)
}

/// Lanczos resize of `img` to exactly `target`.
pub fn lanczos_to(img: &image::DynamicImage, target: [u32; 2]) -> image::DynamicImage {
    if img.width() == target[0] && img.height() == target[1] {
        return img.clone();
    }
    img.resize_exact(target[0], target[1], FilterType::Lanczos3)
}

fn encode_png(img: &image::DynamicImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .map_err(|error| format!("Could not save the upscaled image: {error}"))?;
    Ok(out)
}

/// Enlarges a PNG to `long_edge` on its long side. `esrgan` runs the model
/// upscaler first and returns the enlarged image, or an error that makes this
/// fall back to Lanczos (recorded in `note`).
/// Runs an ESRGAN model on a PNG `passes` times.
pub type EsrganRunner<'a> = &'a dyn Fn(&[u8], u32) -> Result<Vec<u8>, String>;

pub fn upscale_png(
    png: &[u8],
    long_edge: u32,
    esrgan: Option<(&'static str, EsrganRunner<'_>)>,
) -> Result<(Vec<u8>, UpscaleInfo), String> {
    let source = image::load_from_memory(png)
        .map_err(|error| format!("The finished image could not be read: {error}"))?;
    let (sw, sh) = (source.width(), source.height());
    let target = output_target(sw, sh, long_edge);
    let mut note = None;
    let mut used = None;
    let mut working = source;
    let passes = esrgan_passes([sw, sh], target);
    if let (Some((label, run)), true) = (esrgan, passes > 0) {
        match run(png, passes).and_then(|bytes| {
            image::load_from_memory(&bytes)
                .map_err(|error| format!("the upscaler's output could not be read: {error}"))
        }) {
            Ok(enlarged) => {
                working = enlarged;
                used = Some(label);
            }
            Err(reason) => note = Some(format!("{label} failed ({reason}); used Lanczos instead.")),
        }
    }
    let finished = lanczos_to(&working, target);
    let info = UpscaleInfo {
        method: if used.is_some() { "esrgan" } else { "lanczos" },
        upscaler: used,
        source_width: sw,
        source_height: sh,
        width: finished.width(),
        height: finished.height(),
        note,
    };
    Ok((encode_png(&finished)?, info))
}

/// Runs `sd-cli -M upscale` on `png` with an ESRGAN model, `passes` times.
fn run_esrgan(tool: &Path, model: &Path, png: &[u8], passes: u32) -> Result<Vec<u8>, String> {
    let dir = tempfile_dir()?;
    let input = dir.join("in.png");
    let output = dir.join("out.png");
    std::fs::write(&input, png).map_err(|error| error.to_string())?;
    let tool_dir = tool.parent().unwrap_or(Path::new("."));
    let mut command = std::process::Command::new(tool);
    command
        .args(["-M", "upscale", "--upscale-model"])
        .arg(model)
        .arg("-i")
        .arg(&input)
        .arg("-o")
        .arg(&output)
        .args(["--upscale-repeats", &passes.to_string()])
        .current_dir(tool_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // The Linux build keeps its libraries beside the program.
    #[cfg(target_os = "linux")]
    command.env("LD_LIBRARY_PATH", tool_dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let result = command.output().map_err(|error| error.to_string());
    let bytes = result.and_then(|out| {
        if out.status.success() {
            std::fs::read(&output).map_err(|error| error.to_string())
        } else {
            let stderr = String::from_utf8_lossy(&out.stderr);
            Err(stderr.lines().last().unwrap_or("exit failure").to_string())
        }
    });
    let _ = std::fs::remove_dir_all(&dir);
    bytes
}

fn tempfile_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!(
        "radium-upscale-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

/// The ESRGAN model to use: the one named, or for `auto` the first installed.
fn pick_upscaler(data_dir: &Path, choice: &str) -> Option<&'static UpscalerModel> {
    let installed = |upscaler: &&UpscalerModel| upscaler_install_plan(data_dir, upscaler).installed;
    match choice {
        "lanczos" => None,
        "auto" | "" => upscalers().iter().find(installed),
        id => find_upscaler(id).filter(installed),
    }
}

/// Upscale a finished image (base64 PNG) to an output size from
/// `resolution::OUTPUT_SIZES`. `upscaler` is `auto`, `lanczos` or an upscaler
/// id from the catalog; an ESRGAN model must already be downloaded
/// (`media_upscaler_install`).
#[tauri::command]
pub async fn media_upscale_image<R: Runtime>(
    app: tauri::AppHandle<R>,
    image_base64: String,
    output_size: String,
    upscaler: Option<String>,
) -> Result<UpscaledImage, String> {
    let size = find_output_size(&output_size)
        .ok_or_else(|| format!("Radium has no output size called \"{output_size}\"."))?;
    let data_dir = get_jan_data_folder_path(app);
    let png = STANDARD
        .decode(image_base64.trim())
        .map_err(|error| format!("The finished image is not valid base64: {error}"))?;
    let choice = upscaler.unwrap_or_else(|| "auto".to_string());
    let variant = super::runtime::this_computers_variant().ok();
    let long_edge = size.long_edge;
    tauri::async_runtime::spawn_blocking(move || {
        let model = pick_upscaler(&data_dir, &choice);
        let tool = variant.and_then(|variant| upscale_tool(&data_dir, variant));
        let mut fallback_note = None;
        let runner = match (model, tool) {
            (Some(model), Some(tool)) => {
                let path = data_dir
                    .join("media")
                    .join("upscalers")
                    .join(model.file.file_name());
                Some((model.label, tool, path))
            }
            (Some(model), None) => {
                fallback_note = Some(format!(
                    "{} needs the media engine's upscale tool, which is not installed; used Lanczos.",
                    model.label
                ));
                None
            }
            (None, _) if choice != "lanczos" && choice != "auto" => {
                fallback_note = Some(format!(
                    "The upscaler \"{choice}\" is not downloaded; used Lanczos."
                ));
                None
            }
            _ => None,
        };
        let run = runner.as_ref().map(|(_, tool, path)| {
            move |png: &[u8], passes: u32| run_esrgan(tool, path, png, passes)
        });
        let esrgan = match (&runner, &run) {
            (Some((label, _, _)), Some(run)) => {
                Some((*label, run as EsrganRunner<'_>))
            }
            _ => None,
        };
        let (bytes, mut info) = upscale_png(&png, long_edge, esrgan)?;
        if info.note.is_none() {
            info.note = fallback_note;
        }
        Ok(UpscaledImage {
            image_base64: STANDARD.encode(bytes),
            mime: "image/png",
            info,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let img =
            image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(width, height, |x, y| {
                image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
            }));
        encode_png(&img).unwrap()
    }

    #[test]
    fn lanczos_alone_reaches_4k_and_says_so() {
        let (bytes, info) = upscale_png(&png(64, 36), 3840, None).unwrap();
        assert_eq!((info.width, info.height), (3840, 2160));
        assert_eq!((info.source_width, info.source_height), (64, 36));
        assert_eq!(info.method, "lanczos");
        assert!(info.upscaler.is_none());
        let out = image::load_from_memory(&bytes).unwrap();
        assert_eq!((out.width(), out.height()), (3840, 2160));
    }

    #[test]
    fn esrgan_output_is_resized_to_the_exact_target() {
        let fake = |input: &[u8], passes: u32| {
            assert_eq!(passes, 1);
            let img = image::load_from_memory(input).unwrap();
            encode_png(&img.resize_exact(img.width() * 4, img.height() * 4, FilterType::Nearest))
        };
        // Kept small so the debug-build test stays fast: 256×144 → ×4 → 960×540.
        let (_, info) = upscale_png(&png(256, 144), 960, Some(("Fake 4×", &fake))).unwrap();
        assert_eq!(info.method, "esrgan");
        assert_eq!(info.upscaler, Some("Fake 4×"));
        assert_eq!((info.width, info.height), (960, 540));
    }

    #[test]
    fn a_failing_esrgan_falls_back_to_lanczos_with_a_note() {
        let broken = |_: &[u8], _: u32| Err::<Vec<u8>, _>("boom".to_string());
        let (_, info) = upscale_png(&png(100, 100), 1920, Some(("Fake", &broken))).unwrap();
        assert_eq!(info.method, "lanczos");
        assert!(info.note.unwrap().contains("boom"));
        assert_eq!((info.width, info.height), (1920, 1920));
    }

    #[test]
    fn garbage_is_refused() {
        assert!(upscale_png(b"not a png", 3840, None).is_err());
    }
}
