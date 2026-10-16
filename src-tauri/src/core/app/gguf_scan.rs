//! Find GGUF models that live in the models folder without a `model.yml`.
//!
//! Users point the models folder at a drive that already holds weights from
//! LM Studio, the Hugging Face hub cache, Ollama and loose downloads. None of
//! those carry a `model.yml`, so the llama.cpp extensions used to ignore them.
//! [`scan_models_folder`] walks the folder, reads only the GGUF header of each
//! file (never the tensors), and says which files are chat models, which are
//! companions (mmproj projectors) and which are skipped and why — diffusion
//! transformers, text encoders, VAEs and the like that llama-server cannot chat
//! with.
//!
//! Nothing is copied or moved: the extension registers each chat model in place
//! by writing a small `model.yml` whose `model_path` is the file found here.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Runtime;

/// How deep below the models folder the scan descends. LM Studio uses
/// `publisher/repo/file.gguf`, the HF hub cache
/// `hub/models--org--repo/snapshots/<sha>/file.gguf`; 8 leaves headroom.
pub const DEFAULT_MAX_DEPTH: usize = 8;
/// A safety valve so a mis-chosen folder (a whole home directory) cannot keep
/// the scan running for minutes.
const MAX_ENTRIES_VISITED: usize = 200_000;
/// Folders that never hold models worth scanning.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "__pycache__",
    "$RECYCLE.BIN",
    "System Volume Information",
    "discovered", // our own registrations: model.yml only
];

// ---------------------------------------------------------------------------
// GGUF header
// ---------------------------------------------------------------------------

/// The header fields the scan needs. Arrays (the tokenizer vocabulary) are
/// skipped, never materialised.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct GgufHeader {
    pub version: u32,
    pub tensor_count: u64,
    pub architecture: Option<String>,
    pub name: Option<String>,
    pub context_length: Option<u64>,
    pub file_type: Option<u32>,
    /// `split.count` for multi-part files, when present.
    pub split_count: Option<u32>,
}

const MAX_STRING_LEN: u64 = 16 * 1024 * 1024;
const MAX_KV_COUNT: u64 = 1_000_000;

fn bad(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.into())
}

fn read_u32<R: Read>(r: &mut R) -> io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn read_u64<R: Read>(r: &mut R) -> io::Result<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}

fn read_string<R: Read>(r: &mut R) -> io::Result<String> {
    let len = read_u64(r)?;
    if len > MAX_STRING_LEN {
        return Err(bad(format!("string length {len} is unreasonably large")));
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Byte width of a fixed-size GGUF scalar type, `None` for string/array.
fn scalar_width(t: u32) -> Option<u64> {
    match t {
        0 | 1 | 7 => Some(1), // u8, i8, bool
        2 | 3 => Some(2),     // u16, i16
        4..=6 => Some(4),     // u32, i32, f32
        10..=12 => Some(8),   // u64, i64, f64
        _ => None,
    }
}

#[derive(Debug)]
enum Value {
    Int(u64),
    Str(String),
    Other,
}

fn read_value<R: Read + Seek>(r: &mut R, t: u32) -> io::Result<Value> {
    match t {
        0 | 7 => {
            let mut b = [0u8; 1];
            r.read_exact(&mut b)?;
            Ok(Value::Int(b[0] as u64))
        }
        1 => {
            let mut b = [0u8; 1];
            r.read_exact(&mut b)?;
            Ok(Value::Int((b[0] as i8).max(0) as u64))
        }
        2 | 3 => {
            let mut b = [0u8; 2];
            r.read_exact(&mut b)?;
            Ok(Value::Int(u16::from_le_bytes(b) as u64))
        }
        4 => Ok(Value::Int(read_u32(r)? as u64)),
        5 => Ok(Value::Int((read_u32(r)? as i32).max(0) as u64)),
        10 => Ok(Value::Int(read_u64(r)?)),
        11 => Ok(Value::Int((read_u64(r)? as i64).max(0) as u64)),
        6 | 12 => {
            r.seek(SeekFrom::Current(scalar_width(t).unwrap_or(0) as i64))?;
            Ok(Value::Other)
        }
        8 => Ok(Value::Str(read_string(r)?)),
        9 => {
            let elem = read_u32(r)?;
            let len = read_u64(r)?;
            skip_array(r, elem, len)?;
            Ok(Value::Other)
        }
        other => Err(bad(format!("unknown GGUF value type {other}"))),
    }
}

fn skip_array<R: Read + Seek>(r: &mut R, elem: u32, len: u64) -> io::Result<()> {
    if let Some(w) = scalar_width(elem) {
        let bytes = w.checked_mul(len).ok_or_else(|| bad("array too large"))?;
        r.seek(SeekFrom::Current(bytes as i64))?;
        return Ok(());
    }
    match elem {
        8 => {
            for _ in 0..len {
                let l = read_u64(r)?;
                if l > MAX_STRING_LEN {
                    return Err(bad("array string too large"));
                }
                r.seek(SeekFrom::Current(l as i64))?;
            }
            Ok(())
        }
        9 => {
            for _ in 0..len {
                let inner = read_u32(r)?;
                let inner_len = read_u64(r)?;
                skip_array(r, inner, inner_len)?;
            }
            Ok(())
        }
        other => Err(bad(format!("unknown GGUF array element type {other}"))),
    }
}

/// Parse the GGUF header (magic, counts, metadata key/values).
pub fn parse_gguf_header<R: Read + Seek>(reader: R) -> io::Result<GgufHeader> {
    let mut r = BufReader::new(reader);
    let mut magic = [0u8; 4];
    r.read_exact(&mut magic)?;
    if &magic != b"GGUF" {
        return Err(bad("not a GGUF file"));
    }
    let version = read_u32(&mut r)?;
    if !(2..=3).contains(&version) {
        return Err(bad(format!("unsupported GGUF version {version}")));
    }
    let tensor_count = read_u64(&mut r)?;
    let kv_count = read_u64(&mut r)?;
    if kv_count > MAX_KV_COUNT {
        return Err(bad("too many metadata entries"));
    }

    let mut header = GgufHeader {
        version,
        tensor_count,
        ..Default::default()
    };
    let mut ints: HashMap<String, u64> = HashMap::new();
    for _ in 0..kv_count {
        let key = read_string(&mut r)?;
        let t = read_u32(&mut r)?;
        match read_value(&mut r, t)? {
            Value::Str(s) => match key.as_str() {
                "general.architecture" => header.architecture = Some(s),
                "general.name" => header.name = Some(s),
                _ => {}
            },
            Value::Int(v) => {
                if key == "general.file_type" {
                    header.file_type = Some(v as u32);
                } else if key == "split.count" {
                    header.split_count = Some(v as u32);
                } else if key.ends_with(".context_length") {
                    ints.insert(key, v);
                }
            }
            Value::Other => {}
        }
    }
    if let Some(arch) = &header.architecture {
        header.context_length = ints.get(&format!("{arch}.context_length")).copied();
    }
    Ok(header)
}

pub fn read_gguf_header(path: &Path) -> io::Result<GgufHeader> {
    parse_gguf_header(File::open(path)?)
}

/// llama.cpp `LLAMA_FTYPE_*` names for `general.file_type`.
pub fn file_type_name(ft: u32) -> Option<&'static str> {
    Some(match ft {
        0 => "F32",
        1 => "F16",
        2 => "Q4_0",
        3 => "Q4_1",
        7 => "Q8_0",
        8 => "Q5_0",
        9 => "Q5_1",
        10 => "Q2_K",
        11 => "Q3_K_S",
        12 => "Q3_K_M",
        13 => "Q3_K_L",
        14 => "Q4_K_S",
        15 => "Q4_K_M",
        16 => "Q5_K_S",
        17 => "Q5_K_M",
        18 => "Q6_K",
        19 => "IQ2_XXS",
        20 => "IQ2_XS",
        21 => "Q2_K_S",
        22 => "IQ3_XS",
        23 => "IQ3_XXS",
        24 => "IQ1_S",
        25 => "IQ4_NL",
        26 => "IQ3_S",
        27 => "IQ3_M",
        28 => "IQ2_S",
        29 => "IQ2_M",
        30 => "IQ4_XS",
        31 => "IQ1_M",
        32 => "BF16",
        36 => "TQ1_0",
        37 => "TQ2_0",
        38 => "MXFP4",
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "reason", rename_all = "snake_case")]
pub enum GgufKind {
    /// A text model llama-server can chat with.
    Llm,
    /// A multimodal projector, paired with a chat model where obvious.
    Mmproj,
    /// Not a chat model; the reason says what it is.
    NotChat(String),
}

/// Architectures that are not language models llama-server can serve for
/// chat: diffusion transformers, image/video VAEs, text encoders for diffusion
/// pipelines, vision/audio encoders.
fn non_chat_reason(arch: &str) -> Option<&'static str> {
    let a = arch.to_ascii_lowercase();
    let diffusion = [
        "wan",
        "flux",
        "qwen_image",
        "sd1",
        "sd2",
        "sd3",
        "sdxl",
        "hidream",
        "hunyuan_video",
        "hyvid",
        "ltxv",
        "lumina2",
        "aura",
        "chroma",
        "cosmos",
        "mochi",
        "pixart",
        "kontext",
    ];
    if diffusion
        .iter()
        .any(|d| a == *d || a.starts_with(&format!("{d}_")))
        || a.contains("diffusion")
        || a.contains("unet")
    {
        return Some("diffusion/image-video model (not a chat model)");
    }
    if a == "clip" || a == "clip_vision" || a == "siglip" || a.starts_with("clip") {
        return Some("vision encoder / projector (CLIP)");
    }
    if a == "t5" || a == "umt5" || a == "t5encoder" || a == "t5_encoder" || a == "mt5" {
        return Some("text encoder for diffusion pipelines (T5)");
    }
    if a == "vae" || a.ends_with("_vae") || a.starts_with("vae") {
        return Some("VAE (image/video decoder)");
    }
    if a == "whisper" || a == "encodec" || a == "wavtokenizer-dec" || a == "snac" {
        return Some("audio codec / encoder");
    }
    None
}

fn is_mmproj_name(file_name: &str) -> bool {
    let l = file_name.to_ascii_lowercase();
    l.contains("mmproj") || l.contains("projector")
}

/// Decide what a GGUF is from its header and file name.
pub fn classify(header: &GgufHeader, file_name: &str) -> GgufKind {
    let arch = header.architecture.as_deref().unwrap_or("");
    // Any projector named as such (clip-tagged or not) pairs with a model.
    if is_mmproj_name(file_name) {
        return GgufKind::Mmproj;
    }
    if arch.is_empty() {
        return GgufKind::NotChat("no general.architecture in header".into());
    }
    if let Some(reason) = non_chat_reason(arch) {
        return GgufKind::NotChat(format!("{reason}: architecture '{arch}'"));
    }
    // Diffusion GGUFs converted with city96's tools carry no tokenizer and
    // tiny metadata; a chat model always has a context length.
    if header.context_length.is_none() {
        return GgufKind::NotChat(format!(
            "architecture '{arch}' has no context length (not a language model)"
        ));
    }
    GgufKind::Llm
}

/// `name-00001-of-00003.gguf` → `Some((1, 3))`.
pub fn split_part(file_name: &str) -> Option<(u32, u32)> {
    let stem = file_name
        .strip_suffix(".gguf")
        .or_else(|| file_name.strip_suffix(".GGUF"))
        .unwrap_or(file_name);
    let idx = stem.rfind("-of-")?;
    let total = &stem[idx + 4..];
    let before = &stem[..idx];
    let dash = before.rfind('-')?;
    let part = &before[dash + 1..];
    if part.len() < 3 || total.len() < 3 {
        return None;
    }
    let p: u32 = part.parse().ok()?;
    let t: u32 = total.parse().ok()?;
    if p == 0 || t == 0 || p > t {
        return None;
    }
    Some((p, t))
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DiscoveredModel {
    /// Stable id derived from the path relative to the models folder.
    pub id: String,
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub architecture: String,
    pub context_length: Option<u64>,
    pub quant: Option<String>,
    pub mmproj_path: Option<String>,
    /// `lmstudio`, `huggingface`, `ollama` or `folder`.
    pub origin: String,
    pub split_parts: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SkippedFile {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScanReport {
    pub root: String,
    pub models: Vec<DiscoveredModel>,
    pub skipped: Vec<SkippedFile>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GgufClassification {
    pub path: String,
    pub is_chat: bool,
    pub reason: Option<String>,
    pub architecture: Option<String>,
}

fn origin_for(rel: &str) -> &'static str {
    let l = rel.to_ascii_lowercase();
    if l.contains("models--") || l.contains("/snapshots/") || l.starts_with("hub/") {
        "huggingface"
    } else if l.contains("lmstudio") {
        "lmstudio"
    } else {
        "folder"
    }
}

/// Id for a discovered file: `discovered/<relative path without .gguf>`,
/// with characters the model-id machinery dislikes replaced.
pub fn discovered_id(rel: &str) -> String {
    let rel = rel.replace('\\', "/");
    let rel = rel
        .strip_suffix(".gguf")
        .or_else(|| rel.strip_suffix(".GGUF"))
        .unwrap_or(&rel);
    let cleaned: String = rel
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/') {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("discovered/{}", cleaned.trim_matches('/'))
}

fn display_name(header: &GgufHeader, file_name: &str) -> String {
    let stem = file_name
        .strip_suffix(".gguf")
        .or_else(|| file_name.strip_suffix(".GGUF"))
        .unwrap_or(file_name);
    // The file name carries the quant, which general.name lacks; it is what
    // users recognise from LM Studio.
    if stem.len() >= 3 {
        return stem.to_string();
    }
    header.name.clone().unwrap_or_else(|| stem.to_string())
}

fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

struct Walk {
    ggufs: Vec<PathBuf>,
    ollama_roots: Vec<PathBuf>,
    truncated: bool,
}

fn walk(root: &Path, max_depth: usize) -> Walk {
    let mut out = Walk {
        ggufs: vec![],
        ollama_roots: vec![],
        truncated: false,
    };
    let mut visited = 0usize;
    let mut seen_dirs: HashSet<PathBuf> = HashSet::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if let Ok(canon) = fs::canonicalize(&dir) {
            if !seen_dirs.insert(canon) {
                continue; // symlink loop
            }
        }
        // A folder with a model.yml is already registered; its weights are
        // listed through it.
        if depth > 0 && dir.join("model.yml").is_file() {
            continue;
        }
        // Ollama store: `<x>/manifests` + `<x>/blobs`.
        if dir.join("manifests").is_dir() && dir.join("blobs").is_dir() {
            out.ollama_roots.push(dir.clone());
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > MAX_ENTRIES_VISITED {
                out.truncated = true;
                return out;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(ft) = entry.file_type() else { continue };
            let path = entry.path();
            let is_dir = ft.is_dir() || (ft.is_symlink() && path.is_dir());
            if is_dir {
                if name.starts_with('.')
                    || SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(&name))
                    || (depth == 0 && name == "discovered")
                {
                    continue;
                }
                // Ollama blobs are handled through the manifests.
                if name == "blobs" && dir.join("manifests").is_dir() {
                    continue;
                }
                if depth < max_depth {
                    stack.push((path, depth + 1));
                }
            } else if name.to_ascii_lowercase().ends_with(".gguf") && !name.starts_with('.') {
                out.ggufs.push(path);
            }
        }
    }
    out
}

#[derive(Deserialize)]
struct OllamaManifest {
    #[serde(default)]
    layers: Vec<OllamaLayer>,
}

#[derive(Deserialize)]
struct OllamaLayer {
    #[serde(rename = "mediaType")]
    media_type: String,
    digest: String,
}

/// An Ollama model found through its manifest.
#[derive(Debug, Clone, PartialEq)]
pub struct OllamaEntry {
    /// `library/llama3.2:3b` style name (registry host dropped).
    pub name: String,
    pub model_blob: PathBuf,
    pub projector_blob: Option<PathBuf>,
}

fn blob_path(store: &Path, digest: &str) -> PathBuf {
    store.join("blobs").join(digest.replace(':', "-"))
}

/// Read every manifest under `<store>/manifests` (host/namespace/model/tag).
pub fn read_ollama_store(store: &Path) -> Vec<OllamaEntry> {
    let manifests = store.join("manifests");
    let mut out = vec![];
    let mut stack = vec![(manifests.clone(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                if depth < 5 {
                    stack.push((p, depth + 1));
                }
                continue;
            }
            let Ok(text) = fs::read_to_string(&p) else {
                continue;
            };
            let Ok(m) = serde_json::from_str::<OllamaManifest>(&text) else {
                continue;
            };
            let Some(model) = m
                .layers
                .iter()
                .find(|l| l.media_type == "application/vnd.ollama.image.model")
            else {
                continue;
            };
            let projector = m
                .layers
                .iter()
                .find(|l| l.media_type == "application/vnd.ollama.image.projector")
                .map(|l| blob_path(store, &l.digest));
            let rel: Vec<String> = p
                .strip_prefix(&manifests)
                .unwrap_or(&p)
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            // host / namespace / model / tag
            let name = match rel.len() {
                n if n >= 2 => {
                    let tag = &rel[n - 1];
                    let model = &rel[n - 2];
                    let ns = if n >= 3 { rel[n - 3].as_str() } else { "" };
                    if ns.is_empty() || ns == "library" {
                        format!("{model}:{tag}")
                    } else {
                        format!("{ns}/{model}:{tag}")
                    }
                }
                _ => rel.join("/"),
            };
            out.push(OllamaEntry {
                name,
                model_blob: blob_path(store, &model.digest),
                projector_blob: projector,
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Walk `root` and report chat models, companions and skipped files.
/// `known_paths` are weights already registered through a model.yml; they are
/// not reported again.
pub fn scan_models_folder(root: &Path, max_depth: usize, known_paths: &[String]) -> ScanReport {
    let known: HashSet<String> = known_paths.iter().map(|p| norm_key(Path::new(p))).collect();
    let mut report = ScanReport {
        root: root.to_string_lossy().into_owned(),
        ..Default::default()
    };
    let w = walk(root, max_depth);
    report.truncated = w.truncated;

    // dir -> mmproj files in it
    let mut mmprojs: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    let mut llms: Vec<(PathBuf, GgufHeader, Option<u32>)> = vec![];

    for path in &w.ggufs {
        let file_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let display = path.to_string_lossy().into_owned();
        let split = split_part(&file_name);
        if let Some((p, t)) = split {
            if p != 1 {
                report.skipped.push(SkippedFile {
                    path: display,
                    reason: format!("split part {p} of {t} (registered through part 1)"),
                });
                continue;
            }
        }
        if known.contains(&norm_key(path)) {
            continue;
        }
        let header = match read_gguf_header(path) {
            Ok(h) => h,
            Err(e) => {
                report.skipped.push(SkippedFile {
                    path: display,
                    reason: format!("unreadable GGUF header: {e}"),
                });
                continue;
            }
        };
        match classify(&header, &file_name) {
            GgufKind::Llm => llms.push((path.clone(), header, split.map(|s| s.1))),
            GgufKind::Mmproj => mmprojs
                .entry(path.parent().map(Path::to_path_buf).unwrap_or_default())
                .or_default()
                .push(path.clone()),
            GgufKind::NotChat(reason) => report.skipped.push(SkippedFile {
                path: display,
                reason,
            }),
        }
    }

    let mut paired: HashSet<PathBuf> = HashSet::new();
    for (path, header, split) in llms {
        let file_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let rel = rel_of(root, &path);
        let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
        // Pair an mmproj in the same folder; prefer F16, then the first.
        let mmproj = mmprojs.get(&dir).and_then(|list| {
            list.iter()
                .find(|p| p.to_string_lossy().to_ascii_lowercase().contains("f16"))
                .or_else(|| list.first())
                .cloned()
        });
        if let Some(m) = &mmproj {
            paired.insert(m.clone());
        }
        let size_bytes = total_size(&path, split);
        report.models.push(DiscoveredModel {
            id: discovered_id(&rel),
            name: display_name(&header, &file_name),
            path: path.to_string_lossy().into_owned(),
            size_bytes,
            architecture: header.architecture.clone().unwrap_or_default(),
            context_length: header.context_length,
            quant: header
                .file_type
                .and_then(file_type_name)
                .map(str::to_string),
            mmproj_path: mmproj.map(|m| m.to_string_lossy().into_owned()),
            origin: origin_for(&rel).to_string(),
            split_parts: split,
        });
    }
    for (_, list) in mmprojs {
        for m in list {
            if !paired.contains(&m) {
                report.skipped.push(SkippedFile {
                    path: m.to_string_lossy().into_owned(),
                    reason: "mmproj projector with no chat model in the same folder".into(),
                });
            }
        }
    }

    for store in &w.ollama_roots {
        for entry in read_ollama_store(store) {
            let display = entry.model_blob.to_string_lossy().into_owned();
            if known.contains(&norm_key(&entry.model_blob)) {
                continue;
            }
            if !entry.model_blob.is_file() {
                report.skipped.push(SkippedFile {
                    path: display,
                    reason: format!("Ollama model '{}': blob missing", entry.name),
                });
                continue;
            }
            let header = match read_gguf_header(&entry.model_blob) {
                Ok(h) => h,
                Err(e) => {
                    report.skipped.push(SkippedFile {
                        path: display,
                        reason: format!("Ollama model '{}': {e}", entry.name),
                    });
                    continue;
                }
            };
            match classify(&header, "") {
                GgufKind::Llm => {
                    let safe = entry.name.replace(':', "-");
                    report.models.push(DiscoveredModel {
                        id: discovered_id(&format!("ollama/{safe}")),
                        name: entry.name.clone(),
                        path: display,
                        size_bytes: fs::metadata(&entry.model_blob)
                            .map(|m| m.len())
                            .unwrap_or(0),
                        architecture: header.architecture.clone().unwrap_or_default(),
                        context_length: header.context_length,
                        quant: header
                            .file_type
                            .and_then(file_type_name)
                            .map(str::to_string),
                        mmproj_path: entry
                            .projector_blob
                            .filter(|p| p.is_file())
                            .map(|p| p.to_string_lossy().into_owned()),
                        origin: "ollama".into(),
                        split_parts: None,
                    });
                }
                GgufKind::Mmproj => {}
                GgufKind::NotChat(reason) => report.skipped.push(SkippedFile {
                    path: display,
                    reason: format!("Ollama model '{}': {reason}", entry.name),
                }),
            }
        }
    }

    report.models.sort_by(|a, b| a.id.cmp(&b.id));
    // Ids must be unique; suffix the rare collision.
    let mut seen: HashMap<String, u32> = HashMap::new();
    for m in &mut report.models {
        let n = seen.entry(m.id.clone()).or_insert(0);
        if *n > 0 {
            m.id = format!("{}-{}", m.id, n);
        }
        *n += 1;
    }
    report
}

fn total_size(first: &Path, split: Option<u32>) -> u64 {
    let own = fs::metadata(first).map(|m| m.len()).unwrap_or(0);
    let Some(total) = split else { return own };
    let Some(name) = first.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return own;
    };
    let dir = first.parent().unwrap_or(Path::new("."));
    let mut sum = 0;
    for i in 1..=total {
        let width = name
            .rfind("-of-")
            .map(|idx| name[idx + 4..].trim_end_matches(".gguf").len())
            .unwrap_or(5);
        let part = format!("{:0width$}", i, width = width);
        let candidate = name.replacen(
            &format!("{:0width$}-of-", 1, width = width),
            &format!("{part}-of-"),
            1,
        );
        sum += fs::metadata(dir.join(candidate))
            .map(|m| m.len())
            .unwrap_or(0);
    }
    sum.max(own)
}

fn norm_key(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        s.to_ascii_lowercase()
    } else {
        s
    }
}

/// Classify individual files (used to flag existing chat entries that point
/// at non-chat GGUFs).
pub fn classify_paths(paths: &[String]) -> Vec<GgufClassification> {
    paths
        .iter()
        .map(|p| {
            let path = Path::new(p);
            let file_name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            match read_gguf_header(path) {
                Ok(h) => {
                    let kind = classify(&h, &file_name);
                    GgufClassification {
                        path: p.clone(),
                        is_chat: kind == GgufKind::Llm,
                        reason: match kind {
                            GgufKind::Llm => None,
                            GgufKind::Mmproj => Some("mmproj projector, not a chat model".into()),
                            GgufKind::NotChat(r) => Some(r),
                        },
                        architecture: h.architecture,
                    }
                }
                // Unreadable is not evidence of a non-chat model; leave it.
                Err(_) => GgufClassification {
                    path: p.clone(),
                    is_chat: true,
                    reason: None,
                    architecture: None,
                },
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Scan the models folder (`path` follows the models-folder redirect like the
/// file commands) for GGUF models without a model.yml.
#[tauri::command]
pub async fn scan_gguf_models<R: Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
    max_depth: Option<usize>,
    known_paths: Option<Vec<String>>,
) -> Result<ScanReport, String> {
    let root = super::models_folder::redirect_for_app(&app, Path::new(&path));
    let known: Vec<String> = known_paths
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            super::models_folder::redirect_for_app(&app, Path::new(&p))
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    tokio::task::spawn_blocking(move || {
        if !root.is_dir() {
            return Err(format!("Models folder not found: {}", root.display()));
        }
        Ok(scan_models_folder(
            &root,
            max_depth.unwrap_or(DEFAULT_MAX_DEPTH).min(16),
            &known,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Classify GGUF files by header: chat model or not, and why.
#[tauri::command]
pub async fn classify_gguf_files<R: Runtime>(
    app: tauri::AppHandle<R>,
    paths: Vec<String>,
) -> Result<Vec<GgufClassification>, String> {
    let paths: Vec<String> = paths
        .into_iter()
        .map(|p| {
            super::models_folder::redirect_for_app(&app, Path::new(&p))
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    tokio::task::spawn_blocking(move || classify_paths(&paths))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// Build a GGUF v3 header in memory.
    pub(super) struct Gguf {
        kvs: Vec<u8>,
        count: u64,
    }

    impl Gguf {
        pub fn new() -> Self {
            Gguf {
                kvs: vec![],
                count: 0,
            }
        }
        fn key(&mut self, k: &str, t: u32) {
            self.kvs.extend((k.len() as u64).to_le_bytes());
            self.kvs.extend(k.as_bytes());
            self.kvs.extend(t.to_le_bytes());
            self.count += 1;
        }
        pub fn str(mut self, k: &str, v: &str) -> Self {
            self.key(k, 8);
            self.kvs.extend((v.len() as u64).to_le_bytes());
            self.kvs.extend(v.as_bytes());
            self
        }
        pub fn u32(mut self, k: &str, v: u32) -> Self {
            self.key(k, 4);
            self.kvs.extend(v.to_le_bytes());
            self
        }
        pub fn u64(mut self, k: &str, v: u64) -> Self {
            self.key(k, 10);
            self.kvs.extend(v.to_le_bytes());
            self
        }
        pub fn f32(mut self, k: &str, v: f32) -> Self {
            self.key(k, 6);
            self.kvs.extend(v.to_le_bytes());
            self
        }
        pub fn str_array(mut self, k: &str, items: &[&str]) -> Self {
            self.key(k, 9);
            self.kvs.extend(8u32.to_le_bytes());
            self.kvs.extend((items.len() as u64).to_le_bytes());
            for s in items {
                self.kvs.extend((s.len() as u64).to_le_bytes());
                self.kvs.extend(s.as_bytes());
            }
            self
        }
        pub fn i32_array(mut self, k: &str, items: &[i32]) -> Self {
            self.key(k, 9);
            self.kvs.extend(5u32.to_le_bytes());
            self.kvs.extend((items.len() as u64).to_le_bytes());
            for v in items {
                self.kvs.extend(v.to_le_bytes());
            }
            self
        }
        pub fn bytes(&self) -> Vec<u8> {
            let mut b = b"GGUF".to_vec();
            b.extend(3u32.to_le_bytes());
            b.extend(7u64.to_le_bytes());
            b.extend(self.count.to_le_bytes());
            b.extend(&self.kvs);
            b.extend([0u8; 64]); // stand-in for tensor info
            b
        }
    }

    fn llm(arch: &str) -> Gguf {
        Gguf::new()
            .str("general.architecture", arch)
            .str("general.name", "Test Model")
            .u32("general.file_type", 15)
            .u32(&format!("{arch}.context_length"), 32768)
            .f32("general.rope_scale", 1.0)
            .str_array("tokenizer.ggml.tokens", &["<s>", "</s>", "hello"])
            .i32_array("tokenizer.ggml.token_type", &[1, 1, 1])
    }

    #[test]
    fn parses_header_fixture() {
        let h = parse_gguf_header(Cursor::new(llm("qwen3").bytes())).unwrap();
        assert_eq!(h.version, 3);
        assert_eq!(h.tensor_count, 7);
        assert_eq!(h.architecture.as_deref(), Some("qwen3"));
        assert_eq!(h.name.as_deref(), Some("Test Model"));
        assert_eq!(h.context_length, Some(32768));
        assert_eq!(h.file_type.and_then(file_type_name), Some("Q4_K_M"));
    }

    #[test]
    fn context_length_follows_the_architecture_key() {
        let bytes = Gguf::new()
            .u64("llama.context_length", 4096)
            .str("general.architecture", "llama")
            .u64("clip.context_length", 77)
            .bytes();
        let h = parse_gguf_header(Cursor::new(bytes)).unwrap();
        assert_eq!(h.context_length, Some(4096));
    }

    #[test]
    fn rejects_non_gguf_and_truncated() {
        assert!(parse_gguf_header(Cursor::new(b"PK\x03\x04garbage".to_vec())).is_err());
        let mut b = llm("llama").bytes();
        b.truncate(40);
        assert!(parse_gguf_header(Cursor::new(b)).is_err());
    }

    #[test]
    fn classifies_llms() {
        for arch in [
            "llama",
            "qwen2",
            "qwen3",
            "qwen3moe",
            "mistral",
            "gemma3",
            "phi3",
            "gpt-oss",
            "deepseek2",
        ] {
            let h = parse_gguf_header(Cursor::new(llm(arch).bytes())).unwrap();
            assert_eq!(classify(&h, "model-Q4_K_M.gguf"), GgufKind::Llm, "{arch}");
        }
    }

    #[test]
    fn classifies_non_chat() {
        for arch in [
            "wan",
            "flux",
            "qwen_image",
            "clip",
            "t5",
            "umt5",
            "sd3",
            "hidream",
            "vae",
        ] {
            let h = GgufHeader {
                architecture: Some(arch.into()),
                context_length: Some(512),
                ..Default::default()
            };
            assert!(
                matches!(classify(&h, "x.gguf"), GgufKind::NotChat(_)),
                "{arch}"
            );
        }
        // Unknown arch without context length (city96-style diffusion GGUF).
        let h = GgufHeader {
            architecture: Some("krea".into()),
            ..Default::default()
        };
        assert!(matches!(
            classify(&h, "flux1-krea-dev-Q8_0.gguf"),
            GgufKind::NotChat(_)
        ));
        let h = GgufHeader::default();
        assert!(matches!(classify(&h, "x.gguf"), GgufKind::NotChat(_)));
    }

    #[test]
    fn classifies_mmproj() {
        let h = GgufHeader {
            architecture: Some("clip".into()),
            ..Default::default()
        };
        assert_eq!(classify(&h, "mmproj-model-f16.gguf"), GgufKind::Mmproj);
        // clip without an mmproj name stays a non-chat file
        assert!(matches!(classify(&h, "clip_l.gguf"), GgufKind::NotChat(_)));
    }

    #[test]
    fn split_names() {
        assert_eq!(
            split_part("Qwen3-235B-Q4_K_M-00001-of-00003.gguf"),
            Some((1, 3))
        );
        assert_eq!(split_part("x-00003-of-00003.gguf"), Some((3, 3)));
        assert_eq!(split_part("model-Q4_K_M.gguf"), None);
        assert_eq!(split_part("x-00004-of-00003.gguf"), None);
        assert_eq!(split_part("x-1-of-2.gguf"), None);
    }

    #[test]
    fn discovered_ids_are_clean() {
        assert_eq!(
            discovered_id("lmstudio-community\\Qwen3 8B\\Qwen3-8B-Q4_K_M.gguf"),
            "discovered/lmstudio-community/Qwen3_8B/Qwen3-8B-Q4_K_M"
        );
    }

    fn write(p: &Path, bytes: &[u8]) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
    }

    #[test]
    fn scans_a_mixed_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let qwen = llm("qwen3").bytes();
        write(
            &root.join("lmstudio-community/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf"),
            &qwen,
        );
        let mm = Gguf::new().str("general.architecture", "clip").bytes();
        write(
            &root.join("lmstudio-community/Qwen3-8B-GGUF/mmproj-Qwen3-8B-F16.gguf"),
            &mm,
        );
        // split model
        write(
            &root.join("big/Big-Q4-00001-of-00002.gguf"),
            &llm("llama").bytes(),
        );
        write(
            &root.join("big/Big-Q4-00002-of-00002.gguf"),
            b"tensors only",
        );
        // diffusion
        let wan = Gguf::new().str("general.architecture", "wan").bytes();
        write(&root.join("video/wan2.1-t2v-14b-Q8_0.gguf"), &wan);
        // hidden folder and an already-registered folder
        write(&root.join(".cache/hidden.gguf"), &qwen);
        write(&root.join("registered/model.gguf"), &qwen);
        write(&root.join("registered/model.yml"), b"model_path: x");
        // garbage
        write(&root.join("junk/broken.gguf"), b"not gguf");
        // Ollama store
        let digest = "sha256:abc123";
        write(
            &root.join("ollama/models/blobs/sha256-abc123"),
            &llm("llama").bytes(),
        );
        write(
            &root.join("ollama/models/manifests/registry.ollama.ai/library/llama3.2/3b"),
            format!(
                r#"{{"layers":[{{"mediaType":"application/vnd.ollama.image.model","digest":"{digest}"}}]}}"#
            )
            .as_bytes(),
        );

        let r = scan_models_folder(root, DEFAULT_MAX_DEPTH, &[]);
        let ids: Vec<&str> = r.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "discovered/big/Big-Q4-00001-of-00002",
                "discovered/lmstudio-community/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M",
                "discovered/ollama/llama3.2-3b",
            ]
        );
        let q = &r.models[1];
        assert!(q.mmproj_path.as_deref().unwrap().contains("mmproj"));
        assert_eq!(q.quant.as_deref(), Some("Q4_K_M"));
        assert_eq!(q.origin, "lmstudio");
        assert_eq!(r.models[0].split_parts, Some(2));
        assert_eq!(r.models[2].name, "llama3.2:3b");
        assert_eq!(r.models[2].origin, "ollama");

        let reasons: Vec<String> = r.skipped.iter().map(|s| s.reason.clone()).collect();
        assert!(reasons.iter().any(|s| s.contains("split part 2")));
        assert!(reasons.iter().any(|s| s.contains("'wan'")));
        assert!(reasons.iter().any(|s| s.contains("unreadable")));
        assert!(!r.skipped.iter().any(|s| s.path.contains("hidden")));
        assert!(!r.models.iter().any(|m| m.path.contains("registered")));
    }

    #[test]
    fn known_paths_are_not_reported_again() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("a/m.gguf");
        write(&p, &llm("llama").bytes());
        let r = scan_models_folder(tmp.path(), 4, &[p.to_string_lossy().into_owned()]);
        assert!(r.models.is_empty());
    }

    #[test]
    fn depth_limit_is_respected() {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("a/b/c/d/m.gguf"), &llm("llama").bytes());
        assert!(scan_models_folder(tmp.path(), 2, &[]).models.is_empty());
        assert_eq!(scan_models_folder(tmp.path(), 4, &[]).models.len(), 1);
    }

    #[test]
    fn classify_paths_flags_diffusion() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("qwen-image-Q4.gguf");
        write(
            &p,
            &Gguf::new()
                .str("general.architecture", "qwen_image")
                .bytes(),
        );
        let c = classify_paths(&[p.to_string_lossy().into_owned()]);
        assert!(!c[0].is_chat);
        assert!(c[0].reason.as_deref().unwrap().contains("diffusion"));
    }
}
