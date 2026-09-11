//! The on-disk gallery: `<outputDir>/<jobId>-<index:02>.png` with the recipe
//! spliced into the PNG as `tEXt` chunks, a small thumbnail beside it, and a
//! `.flags.json` for pin/archive.
//!
//! The recipe lives *in* the file, so an image copied anywhere still carries
//! its parameters (A1111 / ComfyUI read the `parameters` chunk). PNGs without
//! an `atomic` chunk are somebody else's: they are never listed and never
//! deleted, even when they sit in the output folder.

use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{DiffusionError, DiffusionErrorCode, DiffusionResult};
use crate::state::{GalleryFlags, GalleryImageItem, GalleryListOptions, GalleryPage, ImageRecipe};

pub const RECIPE_KEYWORD: &str = "atomic";
pub const PARAMETERS_KEYWORD: &str = "parameters";
pub const FLAGS_FILE: &str = ".flags.json";
pub const THUMB_EDGE: u32 = 256;
const THUMB_SUFFIX: &str = ".thumb.png";
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

// ---------------------------------------------------------------------------
// Ids and paths
// ---------------------------------------------------------------------------

/// `^[a-f0-9]{32}-\d{2}$`
pub fn is_valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() != 35 {
        return false;
    }
    bytes[..32]
        .iter()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        && bytes[32] == b'-'
        && bytes[33..].iter().all(|b| b.is_ascii_digit())
}

pub fn make_id(job_id: &str, index: u32) -> String {
    format!("{job_id}-{index:02}")
}

pub fn png_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.png"))
}

pub fn thumb_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}{THUMB_SUFFIX}"))
}

fn checked_png_path(dir: &Path, id: &str) -> DiffusionResult<PathBuf> {
    if !is_valid_id(id) {
        return Err(DiffusionError::with_details(
            DiffusionErrorCode::InvalidRequest,
            "That is not a gallery image id.",
            id.to_string(),
        ));
    }
    let path = png_path(dir, id);
    if !jan_utils::is_within(&path, dir) {
        return Err(DiffusionError::with_details(
            DiffusionErrorCode::InvalidRequest,
            "That image is outside the gallery folder.",
            id.to_string(),
        ));
    }
    Ok(path)
}

// ---------------------------------------------------------------------------
// PNG chunk handling
// ---------------------------------------------------------------------------

struct Chunk<'a> {
    kind: &'a [u8],
    data: &'a [u8],
    /// Byte range of the whole chunk (length + type + data + crc).
    end: usize,
}

fn read_chunk(png: &[u8], offset: usize) -> Option<Chunk<'_>> {
    if offset + 8 > png.len() {
        return None;
    }
    let len = u32::from_be_bytes([
        png[offset],
        png[offset + 1],
        png[offset + 2],
        png[offset + 3],
    ]) as usize;
    let kind = &png[offset + 4..offset + 8];
    let data_start = offset + 8;
    let data_end = data_start.checked_add(len)?;
    let end = data_end.checked_add(4)?;
    if end > png.len() {
        return None;
    }
    Some(Chunk {
        kind,
        data: &png[data_start..data_end],
        end,
    })
}

fn text_chunk(keyword: &str, text: &str) -> Vec<u8> {
    let mut data = Vec::with_capacity(keyword.len() + 1 + text.len());
    data.extend_from_slice(keyword.as_bytes());
    data.push(0);
    data.extend_from_slice(text.as_bytes());
    let mut chunk = Vec::with_capacity(data.len() + 12);
    chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut hasher = crc32fast::Hasher::new();
    hasher.update(b"tEXt");
    hasher.update(&data);
    chunk.extend_from_slice(b"tEXt");
    chunk.extend_from_slice(&data);
    chunk.extend_from_slice(&hasher.finalize().to_be_bytes());
    chunk
}

/// The Automatic1111 `parameters` string, so other tools show the settings.
pub fn a1111_parameters(recipe: &ImageRecipe) -> String {
    let mut out = recipe.prompt.clone();
    out.push('\n');
    if let Some(neg) = recipe.negative_prompt.as_deref().filter(|n| !n.is_empty()) {
        out.push_str("Negative prompt: ");
        out.push_str(neg);
        out.push('\n');
    }
    let mut fields = vec![
        format!("Steps: {}", recipe.steps),
        format!(
            "Sampler: {}",
            recipe.sampling_method.as_deref().unwrap_or("default")
        ),
        format!("CFG scale: {}", fmt_float(recipe.cfg_scale)),
    ];
    if let Some(guidance) = recipe.guidance {
        fields.push(format!("Distilled Guidance: {}", fmt_float(guidance)));
    }
    fields.push(format!("Seed: {}", recipe.seed));
    fields.push(format!("Size: {}x{}", recipe.width, recipe.height));
    fields.push(format!("Model: {}", recipe.model.filename));
    if let Some(shift) = recipe.flow_shift {
        fields.push(format!("Flow shift: {}", fmt_float(shift)));
    }
    if let Some(strength) = recipe.strength {
        fields.push(format!("Denoising strength: {}", fmt_float(strength)));
    }
    out.push_str(&fields.join(", "));
    out
}

fn fmt_float(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

/// Insert the `atomic` (recipe JSON) and `parameters` (A1111) `tEXt` chunks
/// right after `IHDR`, without touching the image data.
pub fn splice_recipe(png: &[u8], recipe: &ImageRecipe) -> DiffusionResult<Vec<u8>> {
    if png.len() < 8 || png[..8] != PNG_SIGNATURE {
        return Err(DiffusionError::new(
            DiffusionErrorCode::Internal,
            "The engine returned something that is not a PNG.",
        ));
    }
    let ihdr = read_chunk(png, 8)
        .filter(|c| c.kind == b"IHDR")
        .ok_or_else(|| {
            DiffusionError::new(
                DiffusionErrorCode::Internal,
                "The engine returned a PNG without an IHDR chunk.",
            )
        })?;
    let recipe_json = serde_json::to_string(recipe)
        .map_err(|e| DiffusionError::internal(format!("recipe serialisation: {e}")))?;
    let split = ihdr.end;
    let mut out = Vec::with_capacity(png.len() + recipe_json.len() + 256);
    out.extend_from_slice(&png[..split]);
    out.extend_from_slice(&text_chunk(RECIPE_KEYWORD, &recipe_json));
    out.extend_from_slice(&text_chunk(PARAMETERS_KEYWORD, &a1111_parameters(recipe)));
    out.extend_from_slice(&png[split..]);
    Ok(out)
}

pub struct PngHeader {
    pub width: u32,
    pub height: u32,
    pub recipe: Option<ImageRecipe>,
}

/// Read `IHDR` and the text chunks before the first `IDAT`, and no further:
/// listing a gallery must not decode every image.
pub fn read_png_header(path: &Path) -> Option<PngHeader> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    // Recipes are a few hundred bytes; 256 KiB covers any sane header.
    let mut buf = Vec::with_capacity(64 * 1024);
    let mut chunk = [0u8; 8192];
    let mut header: Option<PngHeader> = None;
    let mut offset = 8usize;
    let mut signature_checked = false;
    loop {
        let n = file.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if !signature_checked {
            if buf.len() < 8 {
                continue;
            }
            if buf[..8] != PNG_SIGNATURE {
                return None;
            }
            signature_checked = true;
        }
        while let Some(c) = read_chunk(&buf, offset) {
            match c.kind {
                b"IHDR" => {
                    if c.data.len() < 8 {
                        return None;
                    }
                    header = Some(PngHeader {
                        width: u32::from_be_bytes([c.data[0], c.data[1], c.data[2], c.data[3]]),
                        height: u32::from_be_bytes([c.data[4], c.data[5], c.data[6], c.data[7]]),
                        recipe: None,
                    });
                }
                b"tEXt" => {
                    if let Some(h) = header.as_mut() {
                        if let Some(nul) = c.data.iter().position(|b| *b == 0) {
                            if &c.data[..nul] == RECIPE_KEYWORD.as_bytes() {
                                let text = String::from_utf8_lossy(&c.data[nul + 1..]);
                                h.recipe = serde_json::from_str(&text).ok();
                            }
                        }
                    }
                }
                b"IDAT" | b"IEND" => return header,
                _ => {}
            }
            offset = c.end;
        }
        if buf.len() > 256 * 1024 {
            break;
        }
    }
    header
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FlagEntry {
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub archived: bool,
}

pub type FlagMap = HashMap<String, FlagEntry>;

pub fn read_flags(dir: &Path) -> FlagMap {
    std::fs::read_to_string(dir.join(FLAGS_FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Write the flags file atomically. Callers hold `DiffusionState::flags_lock`.
pub fn write_flags(dir: &Path, flags: &FlagMap) -> DiffusionResult<()> {
    let json = serde_json::to_string_pretty(flags)
        .map_err(|e| DiffusionError::internal(format!("flags serialisation: {e}")))?;
    write_atomic(&dir.join(FLAGS_FILE), json.as_bytes())
}

fn write_atomic(target: &Path, bytes: &[u8]) -> DiffusionResult<()> {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let tmp = target.with_file_name(format!(".{name}.tmp"));
    if let Err(e) = std::fs::write(&tmp, bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(DiffusionError::io(
            "Could not write to the images folder.",
            &e,
        ));
    }
    if let Err(e) = std::fs::rename(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(DiffusionError::io(
            "Could not finish writing the image.",
            &e,
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Save / read / list / delete
// ---------------------------------------------------------------------------

/// Downscale to `THUMB_EDGE` on the longest side. PNG, because the workspace
/// lockfile carries no WebP codec.
pub fn write_thumbnail(png: &[u8], path: &Path) -> Result<(), String> {
    let image = image::load_from_memory(png).map_err(|e| e.to_string())?;
    let thumb = image.thumbnail(THUMB_EDGE, THUMB_EDGE);
    let mut buf = Cursor::new(Vec::new());
    thumb
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    write_atomic(path, buf.get_ref()).map_err(|e| e.message)
}

/// Splice the recipe, write `<id>.png` atomically, write the thumbnail, and
/// return the item plus the final PNG bytes (for the OpenAI facade).
pub fn save(
    dir: &Path,
    recipe: &ImageRecipe,
    png: &[u8],
    flags: &FlagMap,
) -> DiffusionResult<(GalleryImageItem, Vec<u8>)> {
    std::fs::create_dir_all(dir)
        .map_err(|e| DiffusionError::io("Could not create the images folder.", &e))?;
    let id = make_id(&recipe.job_id, recipe.index);
    let path = checked_png_path(dir, &id)?;
    let bytes = splice_recipe(png, recipe)?;
    write_atomic(&path, &bytes)?;

    let thumb = thumb_path(dir, &id);
    let thumbnail_path = match write_thumbnail(&bytes, &thumb) {
        Ok(()) => Some(thumb.to_string_lossy().to_string()),
        Err(err) => {
            log::warn!("[atomic-diffusion] thumbnail for {id} failed: {err}");
            None
        }
    };
    let header = read_png_header(&path).ok_or_else(|| {
        DiffusionError::new(
            DiffusionErrorCode::Internal,
            "The saved PNG could not be read back.",
        )
    })?;
    let flag = flags.get(&id).copied().unwrap_or_default();
    let item = GalleryImageItem {
        id,
        path: path.to_string_lossy().to_string(),
        thumbnail_path,
        width: header.width,
        height: header.height,
        size_bytes: bytes.len() as u64,
        created_at_ms: recipe.created_at_ms,
        pinned: flag.pinned,
        archived: flag.archived,
        recipe: recipe.clone(),
    };
    Ok((item, bytes))
}

fn item_from_path(dir: &Path, id: &str, path: &Path, flags: &FlagMap) -> Option<GalleryImageItem> {
    let header = read_png_header(path)?;
    let recipe = header.recipe?;
    let meta = std::fs::metadata(path).ok()?;
    let thumb = thumb_path(dir, id);
    let flag = flags.get(id).copied().unwrap_or_default();
    Some(GalleryImageItem {
        id: id.to_string(),
        path: path.to_string_lossy().to_string(),
        thumbnail_path: thumb.is_file().then(|| thumb.to_string_lossy().to_string()),
        width: header.width,
        height: header.height,
        size_bytes: meta.len(),
        created_at_ms: recipe.created_at_ms,
        pinned: flag.pinned,
        archived: flag.archived,
        recipe,
    })
}

pub fn get_item(
    dir: &Path,
    id: &str,
    flags: &FlagMap,
) -> DiffusionResult<Option<GalleryImageItem>> {
    let path = checked_png_path(dir, id)?;
    if !path.is_file() {
        return Ok(None);
    }
    Ok(item_from_path(dir, id, &path, flags))
}

/// Every owned image, newest first.
fn scan(dir: &Path, flags: &FlagMap) -> Vec<GalleryImageItem> {
    let mut items = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return items;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".png") else {
            continue;
        };
        if !is_valid_id(id) {
            continue;
        }
        if let Some(item) = item_from_path(dir, id, &entry.path(), flags) {
            items.push(item);
        }
    }
    items.sort_by(|a, b| {
        b.created_at_ms
            .cmp(&a.created_at_ms)
            .then_with(|| b.id.cmp(&a.id))
    });
    items
}

pub fn list(dir: &Path, options: &GalleryListOptions, flags: &FlagMap) -> GalleryPage {
    let all: Vec<GalleryImageItem> = scan(dir, flags)
        .into_iter()
        .filter(|item| options.include_archived || !item.archived)
        .collect();
    let total = all.len();
    let limit = options.limit.max(1);
    let items: Vec<GalleryImageItem> = all.into_iter().skip(options.offset).take(limit).collect();
    let has_more = options.offset.saturating_add(items.len()) < total;
    GalleryPage {
        items,
        has_more,
        total,
    }
}

/// Remove the PNG, its thumbnail and its flags entry. Foreign PNGs (no
/// `atomic` chunk) are left alone.
pub fn delete(dir: &Path, ids: &[String], flags: &mut FlagMap) -> DiffusionResult<()> {
    let mut changed = false;
    for id in ids {
        let path = checked_png_path(dir, id)?;
        if path.is_file() {
            let owned = read_png_header(&path)
                .map(|h| h.recipe.is_some())
                .unwrap_or(false);
            if !owned {
                log::warn!("[atomic-diffusion] refusing to delete foreign image {id}");
                continue;
            }
            std::fs::remove_file(&path)
                .map_err(|e| DiffusionError::io("Could not delete the image.", &e))?;
        }
        let thumb = thumb_path(dir, id);
        if thumb.is_file() {
            let _ = std::fs::remove_file(&thumb);
        }
        if flags.remove(id).is_some() {
            changed = true;
        }
    }
    if changed {
        write_flags(dir, flags)?;
    }
    Ok(())
}

pub fn set_flags(
    dir: &Path,
    id: &str,
    update: &GalleryFlags,
    flags: &mut FlagMap,
) -> DiffusionResult<GalleryImageItem> {
    let path = checked_png_path(dir, id)?;
    if !path.is_file() {
        return Err(DiffusionError::new(
            DiffusionErrorCode::JobNotFound,
            "That image is no longer in the gallery.",
        ));
    }
    let entry = flags.entry(id.to_string()).or_default();
    if let Some(pinned) = update.pinned {
        entry.pinned = pinned;
    }
    if let Some(archived) = update.archived {
        entry.archived = archived;
    }
    if *entry == FlagEntry::default() {
        flags.remove(id);
    }
    write_flags(dir, flags)?;
    item_from_path(dir, id, &path, flags).ok_or_else(|| {
        DiffusionError::new(
            DiffusionErrorCode::JobNotFound,
            "That image is not an Atomic Chat gallery image.",
        )
    })
}

/// Byte-for-byte copy, keeping the embedded recipe.
pub fn export(dir: &Path, id: &str, target: &Path) -> DiffusionResult<()> {
    let path = checked_png_path(dir, id)?;
    if !path.is_file() {
        return Err(DiffusionError::new(
            DiffusionErrorCode::JobNotFound,
            "That image is no longer in the gallery.",
        ));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| DiffusionError::io("Could not create the destination folder.", &e))?;
    }
    std::fs::copy(&path, target)
        .map(|_| ())
        .map_err(|e| DiffusionError::io("Could not export the image.", &e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{
        DiffusionBackend, EngineKind, ImageWorkflow, OffloadPolicy, RecipeEngine, RecipeModel,
    };

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let img = image::RgbaImage::from_fn(width, height, |x, y| {
            image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255])
        });
        let mut buf = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        buf.into_inner()
    }

    fn job_id(n: u8) -> String {
        format!("{:032x}", n as u128)
    }

    fn recipe(job: &str, index: u32, created: u64) -> ImageRecipe {
        ImageRecipe {
            job_id: job.to_string(),
            index,
            prompt: "a cat, photo".into(),
            negative_prompt: Some("blurry".into()),
            width: 64,
            height: 48,
            steps: 8,
            cfg_scale: 1.0,
            guidance: Some(3.5),
            seed: 100 + index as i64,
            batch_seed: 100,
            batch_size: 2,
            sampling_method: Some("euler".into()),
            flow_shift: None,
            workflow: ImageWorkflow::Create,
            strength: None,
            model: RecipeModel {
                model_id: "z-image:q4_k_m".into(),
                family: "z-image".into(),
                display_name: "Z-Image Turbo".into(),
                filename: "z-image-turbo-Q4_K_M.gguf".into(),
            },
            engine: RecipeEngine {
                kind: EngineKind::SdCpp,
                backend: DiffusionBackend::Metal,
                tag: "master-849".into(),
                offload: OffloadPolicy::None,
                cpu_fallback: false,
            },
            created_at_ms: created,
            duration_ms: 1234,
        }
    }

    #[test]
    fn ids_are_validated_strictly() {
        assert!(is_valid_id(&make_id(&job_id(1), 0)));
        assert!(is_valid_id("0123456789abcdef0123456789abcdef-03"));
        assert!(!is_valid_id("0123456789ABCDEF0123456789abcdef-03"));
        assert!(!is_valid_id("0123456789abcdef0123456789abcdef-3"));
        assert!(!is_valid_id("../0123456789abcdef0123456789abcd-03"));
        assert!(!is_valid_id(""));
    }

    #[test]
    fn spliced_png_decodes_with_both_text_chunks_intact() {
        let dir = tempfile::tempdir().unwrap();
        let job = job_id(7);
        let r = recipe(&job, 0, 1_700_000_000_000);
        let (item, bytes) = save(dir.path(), &r, &png_bytes(64, 48), &FlagMap::new()).unwrap();
        assert_eq!(item.width, 64);
        assert_eq!(item.height, 48);
        assert_eq!(item.recipe, r);
        assert!(Path::new(&item.path).is_file());
        assert!(Path::new(item.thumbnail_path.as_ref().unwrap()).is_file());
        assert!(std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .all(|e| !e.file_name().to_string_lossy().ends_with(".tmp")));

        // A third-party decoder reads both chunks and the image itself.
        let decoder = png::Decoder::new(Cursor::new(bytes.clone()));
        let mut reader = decoder.read_info().unwrap();
        let texts: Vec<(String, String)> = reader
            .info()
            .uncompressed_latin1_text
            .iter()
            .map(|t| (t.keyword.clone(), t.text.clone()))
            .collect();
        let atomic = texts.iter().find(|(k, _)| k == RECIPE_KEYWORD).unwrap();
        let parsed: ImageRecipe = serde_json::from_str(&atomic.1).unwrap();
        assert_eq!(parsed, r);
        let params = texts.iter().find(|(k, _)| k == PARAMETERS_KEYWORD).unwrap();
        assert!(params
            .1
            .starts_with("a cat, photo\nNegative prompt: blurry\n"));
        assert!(params.1.contains("Steps: 8, Sampler: euler, CFG scale: 1, Distilled Guidance: 3.5, Seed: 100, Size: 64x48, Model: z-image-turbo-Q4_K_M.gguf"));
        let mut pixels = vec![0u8; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut pixels).unwrap();
        assert_eq!((info.width, info.height), (64, 48));

        // The recipe JSON is camelCase, exactly the TS shape.
        assert!(atomic.1.contains("\"batchSeed\":100"));
        assert!(atomic.1.contains("\"cpuFallback\":false"));

        // Our own header reader sees the same recipe without decoding pixels.
        let header = read_png_header(Path::new(&item.path)).unwrap();
        assert_eq!(header.recipe.unwrap(), r);

        // Thumbnail fits within 256px and keeps the aspect ratio.
        let thumb = image::open(item.thumbnail_path.unwrap()).unwrap();
        assert!(thumb.width() <= THUMB_EDGE && thumb.height() <= THUMB_EDGE);
        let big = png_bytes(512, 256);
        let thumb_path = dir.path().join("t.png");
        write_thumbnail(&big, &thumb_path).unwrap();
        let thumb = image::open(&thumb_path).unwrap();
        assert_eq!((thumb.width(), thumb.height()), (256, 128));
    }

    #[test]
    fn splice_rejects_non_png_input() {
        let err = splice_recipe(b"not a png", &recipe(&job_id(1), 0, 1)).unwrap_err();
        assert_eq!(err.code, DiffusionErrorCode::Internal);
    }

    #[test]
    fn a_failed_rename_leaves_no_tmp_file_behind() {
        let dir = tempfile::tempdir().unwrap();
        let job = job_id(9);
        let id = make_id(&job, 0);
        // A directory squatting on the target name makes the rename fail.
        std::fs::create_dir_all(png_path(dir.path(), &id)).unwrap();
        let err = save(
            dir.path(),
            &recipe(&job, 0, 1),
            &png_bytes(8, 8),
            &FlagMap::new(),
        )
        .unwrap_err();
        assert_ne!(err.code, DiffusionErrorCode::DiskFull);
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(names.iter().all(|n| !n.ends_with(".tmp")), "{names:?}");
    }

    #[test]
    fn foreign_pngs_are_neither_listed_nor_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let foreign_id = make_id(&job_id(3), 0);
        let foreign = png_path(dir.path(), &foreign_id);
        std::fs::write(&foreign, png_bytes(8, 8)).unwrap();
        std::fs::write(dir.path().join("holiday.png"), png_bytes(8, 8)).unwrap();
        let (own, _) = save(
            dir.path(),
            &recipe(&job_id(4), 0, 5),
            &png_bytes(8, 8),
            &FlagMap::new(),
        )
        .unwrap();

        let page = list(
            dir.path(),
            &GalleryListOptions {
                offset: 0,
                limit: 10,
                include_archived: true,
            },
            &FlagMap::new(),
        );
        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].id, own.id);

        let mut flags = FlagMap::new();
        delete(
            dir.path(),
            &[foreign_id.clone(), own.id.clone()],
            &mut flags,
        )
        .unwrap();
        assert!(foreign.is_file(), "foreign PNG must survive delete");
        assert!(!Path::new(&own.path).is_file());
        assert!(!thumb_path(dir.path(), &own.id).is_file());

        assert!(get_item(dir.path(), &foreign_id, &flags).unwrap().is_none());
        let err = delete(dir.path(), &["../etc/passwd".into()], &mut flags).unwrap_err();
        assert_eq!(err.code, DiffusionErrorCode::InvalidRequest);
    }

    #[test]
    fn listing_orders_paginates_and_honours_flags() {
        let dir = tempfile::tempdir().unwrap();
        let mut flags = FlagMap::new();
        let mut ids = Vec::new();
        for (n, created) in [(1u8, 10u64), (2, 30), (3, 20), (4, 40)] {
            let (item, _) = save(
                dir.path(),
                &recipe(&job_id(n), 0, created),
                &png_bytes(8, 8),
                &flags,
            )
            .unwrap();
            ids.push(item.id);
        }
        let opts = |offset, limit, include_archived| GalleryListOptions {
            offset,
            limit,
            include_archived,
        };
        let page = list(dir.path(), &opts(0, 2, false), &flags);
        assert_eq!(page.total, 4);
        assert!(page.has_more);
        let listed: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(listed, vec![ids[3].as_str(), ids[1].as_str()]);
        let page = list(dir.path(), &opts(2, 2, false), &flags);
        assert!(!page.has_more);
        let listed: Vec<&str> = page.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(listed, vec![ids[2].as_str(), ids[0].as_str()]);

        // Archive one: hidden by default, visible with includeArchived; pin persists.
        let item = set_flags(
            dir.path(),
            &ids[1],
            &GalleryFlags {
                pinned: Some(true),
                archived: Some(true),
            },
            &mut flags,
        )
        .unwrap();
        assert!(item.pinned && item.archived);
        let on_disk = read_flags(dir.path());
        assert_eq!(
            on_disk.get(&ids[1]).copied(),
            Some(FlagEntry {
                pinned: true,
                archived: true
            })
        );
        let page = list(dir.path(), &opts(0, 10, false), &on_disk);
        assert_eq!(page.total, 3);
        assert!(page.items.iter().all(|i| i.id != ids[1]));
        let page = list(dir.path(), &opts(0, 10, true), &on_disk);
        assert_eq!(page.total, 4);
        assert!(page.items.iter().find(|i| i.id == ids[1]).unwrap().pinned);

        // Clearing both flags drops the entry.
        set_flags(
            dir.path(),
            &ids[1],
            &GalleryFlags {
                pinned: Some(false),
                archived: Some(false),
            },
            &mut flags,
        )
        .unwrap();
        assert!(read_flags(dir.path()).is_empty());

        // Export is byte-for-byte.
        let target = dir.path().join("out").join("export.png");
        export(dir.path(), &ids[0], &target).unwrap();
        assert_eq!(
            std::fs::read(&target).unwrap(),
            std::fs::read(png_path(dir.path(), &ids[0])).unwrap()
        );
        let err = export(dir.path(), "nope", &target).unwrap_err();
        assert_eq!(err.code, DiffusionErrorCode::InvalidRequest);
    }
}
