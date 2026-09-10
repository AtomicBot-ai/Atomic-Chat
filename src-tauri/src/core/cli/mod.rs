//! CLI adapter layer — thin wrappers that call core logic without an AppHandle.
//!
//! This module is only compiled when the `cli` feature is enabled.
//!
//! The CLI targets a single inference provider: `llamacpp-upstream`, the same
//! one the desktop app defaults to on every platform (see
//! `LOCAL_LLAMACPP_PROVIDER` in `web-app/src/lib/utils.ts`).
//!
//! Note the asymmetry in the on-disk layout: backends are per-provider
//! (`<data>/llamacpp-upstream/backends/`) but the GGUF tree is shared between
//! both llama.cpp providers (`<data>/llamacpp/models/`). Models the user
//! downloads in the app therefore show up here without any extra wiring.

pub mod integrations;

use std::path::{Path, PathBuf};

use crate::core::app::commands::resolve_jan_data_folder;
use tauri_plugin_llamacpp_upstream::state::LlamacppState as LlamacppUpstreamState;

// Re-export impl functions and config types so the binary can call them directly.
// `load_llama_model_impl` is explicitly documented as usable without an AppHandle.
pub use tauri_plugin_llamacpp_upstream::{load_llama_model_impl, LlamacppConfig};

/// The only inference provider the CLI runs: upstream `ggml-org/llama.cpp`.
/// Its backends live under `<data_folder>/<LOCAL_PROVIDER>/backends/`.
pub const LOCAL_PROVIDER: &str = "llamacpp-upstream";

/// On-disk subfolder holding the GGUF tree, at `<data_folder>/<MODELS_ROOT>/models/`.
///
/// Both llama.cpp providers deliberately share it — see `MODELS_PROVIDER_ROOT`
/// in `extensions/llamacpp-upstream-extension/src/index.ts` — so a model
/// downloaded once is runnable by either engine. Only backends and
/// provider-specific settings live per provider, which is why this is not the
/// same constant as [`LOCAL_PROVIDER`].
pub const MODELS_ROOT: &str = "llamacpp";

// ── State constructors ─────────────────────────────────────────────────────

pub fn init_llamacpp_upstream_state() -> LlamacppUpstreamState {
    LlamacppUpstreamState::new()
}

// ── Model discovery ───────────────────────────────────────────────────────

/// Parsed representation of a `model.yml` file.
#[derive(Debug, serde::Deserialize)]
pub struct ModelYml {
    pub model_path: String,
    pub name: Option<String>,
    #[serde(default)]
    pub size_bytes: u64,
    #[serde(default)]
    pub embedding: bool,
    pub mmproj_path: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

/// A discovered model entry: `(model_id, yml)`.
pub type ModelEntry = (String, ModelYml);

/// List the chat models installed for the local provider.
///
/// Embedding models are excluded: they cannot serve `/v1/chat/completions`, so
/// offering them anywhere the CLI leads is a dead end.
pub fn list_chat_models() -> Vec<ModelEntry> {
    list_chat_models_in(&resolve_jan_data_folder())
}

/// Same as [`list_chat_models`], against an explicit data folder.
pub fn list_chat_models_in(data_folder: &Path) -> Vec<ModelEntry> {
    use std::fs;

    let models_root = data_folder.join(MODELS_ROOT).join("models");

    if !models_root.exists() {
        return Vec::new();
    }

    let mut results = Vec::new();
    let mut stack = vec![models_root.clone()];

    while let Some(dir) = stack.pop() {
        let yml_path = dir.join("model.yml");
        if yml_path.exists() {
            if let Ok(content) = fs::read_to_string(&yml_path) {
                if let Ok(yml) = serde_yaml::from_str::<ModelYml>(&content) {
                    // model_id = path relative to models_root, always using
                    // forward slashes so Windows `\` separators never leak
                    // into config files (e.g. TOML) or API responses.
                    let model_id = dir
                        .strip_prefix(&models_root)
                        .unwrap_or(&dir)
                        .to_string_lossy()
                        .into_owned()
                        .replace('\\', "/");
                    if !yml.embedding {
                        results.push((model_id, yml));
                    }
                    continue; // don't recurse into a model directory
                }
            }
        }
        // Recurse into subdirectories
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    stack.push(entry.path());
                }
            }
        }
    }

    results.sort_by(|a, b| a.0.cmp(&b.0));
    results
}

/// Resolve the absolute model file path (and optional mmproj path) for a model ID.
///
/// `model_path` in the YAML can be:
///   - absolute (`/…` or `C:\…`) — used verbatim
///   - relative — joined with the Atomic Chat data folder
pub fn resolve_model_by_id(model_id: &str) -> Result<(PathBuf, Option<PathBuf>), String> {
    resolve_model_by_id_in(&resolve_jan_data_folder(), model_id)
}

/// Same as [`resolve_model_by_id`], against an explicit data folder.
pub fn resolve_model_by_id_in(
    data_folder: &Path,
    model_id: &str,
) -> Result<(PathBuf, Option<PathBuf>), String> {
    let yml_path = data_folder
        .join(MODELS_ROOT)
        .join("models")
        .join(model_id)
        .join("model.yml");

    if !yml_path.exists() {
        return Err(format!(
            "Model '{model_id}' is not installed. \
            Run `atomic-chat-cli models list` to see available models."
        ));
    }

    let content = std::fs::read_to_string(&yml_path).map_err(|e| e.to_string())?;
    let yml: ModelYml = serde_yaml::from_str(&content).map_err(|e| e.to_string())?;

    let resolve_path = |p: &str| -> PathBuf {
        let pb = PathBuf::from(p);
        if pb.is_absolute() {
            pb
        } else {
            data_folder.join(p)
        }
    };

    let model_path = resolve_path(&yml.model_path);
    let mmproj_path = yml.mmproj_path.as_deref().map(resolve_path);

    Ok((model_path, mmproj_path))
}

// ── Binary auto-discovery ──────────────────────────────────────────────────

/// A discovered `llama-server` and the backend it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackendBinary {
    pub path: PathBuf,
    /// `"<version>/<backend>"`, the form `ArgumentBuilder` parses to decide
    /// which llama.cpp features (flash attention, reasoning-preserve, cache
    /// quantization) the build supports. Getting this wrong silently disables
    /// them, so it is carried alongside the path rather than reconstructed.
    pub version_backend: String,
}

/// Parse the upstream llama.cpp build number out of a backend version directory
/// name. Mirrors `ArgumentBuilder::parse_build_number`: handles plain upstream
/// tags ("b6325") and the unified TurboQuant tag shape ("b10018-1.3.0").
/// Returns `None` for anything else, which sorts last.
fn parse_build_number(version: &str) -> Option<u32> {
    version.strip_prefix('b')?.split('-').next()?.parse().ok()
}

/// Find the llama-server binary inside the Atomic Chat data folder.
///
/// Walks `<data_folder>/llamacpp-upstream/backends/<version>/<backend>/` and
/// checks two locations per backend (same logic as the llamacpp extension):
///   1. `<backend_dir>/build/bin/llama-server[.exe]`
///   2. `<backend_dir>/llama-server[.exe]`
///
/// Returns the first binary found, preferring the newest version directory.
pub fn discover_llamacpp_binary() -> Option<BackendBinary> {
    discover_llamacpp_binary_in(&resolve_jan_data_folder())
}

/// Same as [`discover_llamacpp_binary`], against an explicit data folder.
pub fn discover_llamacpp_binary_in(data_folder: &Path) -> Option<BackendBinary> {
    use std::fs;

    let backends_dir = data_folder.join(LOCAL_PROVIDER).join("backends");

    if !backends_dir.exists() {
        return None;
    }

    let exe = if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    };

    // Collect version directories, newest first. Sorting the names as plain
    // strings would rank "b9000" above "b10018-1.3.0" ('9' > '1'), so the build
    // number is parsed out and compared numerically, with the raw name as the
    // tiebreaker for anything unparseable (e.g. the fork's `turboquant-<sha>`).
    let mut version_entries: Vec<_> = fs::read_dir(&backends_dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();
    version_entries.sort_by(|a, b| {
        let a_name = a.file_name().to_string_lossy().into_owned();
        let b_name = b.file_name().to_string_lossy().into_owned();
        parse_build_number(&b_name)
            .cmp(&parse_build_number(&a_name))
            .then_with(|| b_name.cmp(&a_name))
    });

    for version_entry in version_entries {
        let version_dir = version_entry.path();
        let version = version_entry.file_name().to_string_lossy().into_owned();

        let mut backend_entries: Vec<_> = match fs::read_dir(&version_dir) {
            Ok(entries) => entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .collect(),
            Err(_) => continue,
        };
        backend_entries.sort_by_key(|e| e.file_name());

        for backend_entry in backend_entries {
            let backend_dir = backend_entry.path();
            let backend = backend_entry.file_name().to_string_lossy().into_owned();

            // Primary location: <backend>/build/bin/llama-server
            let primary = backend_dir.join("build").join("bin").join(exe);
            // Fallback: <backend>/llama-server
            let fallback = backend_dir.join(exe);

            for candidate in [primary, fallback] {
                if candidate.exists() {
                    return Some(BackendBinary {
                        path: candidate,
                        version_backend: format!("{version}/{backend}"),
                    });
                }
            }
        }
    }

    None
}

/// Recover `"<version>/<backend>"` from a hand-supplied `--bin` path.
///
/// Only works for a binary that still sits inside the standard
/// `.../backends/<version>/<backend>/…` layout; returns `None` otherwise, in
/// which case the caller falls back to a neutral placeholder.
pub fn version_backend_from_bin_path(bin: &Path) -> Option<String> {
    let components: Vec<String> = bin
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    let idx = components.iter().rposition(|c| c == "backends")?;
    let version = components.get(idx + 1)?;
    let backend = components.get(idx + 2)?;
    Some(format!("{version}/{backend}"))
}

// ── HuggingFace download ───────────────────────────────────────────────────

/// A single file entry from a HuggingFace repository.
#[derive(Debug, Clone)]
pub struct HfFileInfo {
    /// Original filename in the repo (e.g. `qwen3-30b.Q4_K_M.gguf`)
    pub filename: String,
    /// Total size in bytes (from HF metadata or LFS pointer)
    pub size: u64,
    /// SHA-256 from the LFS pointer, used for integrity validation
    pub sha256: Option<String>,
    /// Direct download URL (`https://huggingface.co/{repo}/resolve/main/{file}`)
    pub download_url: String,
}

/// Return `true` if `s` looks like a HuggingFace repo ID (`owner/repo`).
///
/// A valid HF repo ID has exactly one `/`, both parts non-empty, no
/// filesystem path markers, and only alphanumeric / `-` / `_` / `.` chars.
pub fn looks_like_hf_repo(s: &str) -> bool {
    if s.starts_with('/') || s.starts_with('.') || s.starts_with('~') {
        return false;
    }
    let Some((owner, name)) = s.split_once('/') else {
        return false;
    };
    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return false;
    }
    let ok = |c: char| c.is_alphanumeric() || matches!(c, '-' | '_' | '.');
    owner.chars().all(ok) && name.chars().all(ok)
}

/// Fetch the list of GGUF files available in a HuggingFace repository.
///
/// Results are sorted by size ascending so smaller quantizations appear first.
/// Passes `hf_token` as a Bearer token when provided.
pub async fn fetch_hf_gguf_files(
    repo_id: &str,
    hf_token: Option<&str>,
) -> Result<Vec<HfFileInfo>, String> {
    let url = format!(
        "https://huggingface.co/api/models/{}?blobs=true&files_metadata=true",
        repo_id
    );

    let client = reqwest::Client::new();
    let mut req = client.get(&url);
    if let Some(tok) = hf_token {
        req = req.bearer_auth(tok);
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();

    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => format!(
                "HuggingFace returned {status} for '{repo_id}'. \
                The repo may be gated — set the HF_TOKEN environment variable."
            ),
            404 => format!(
                "HuggingFace repo '{repo_id}' not found. \
                Check the repo ID or run `atomic-chat-cli models list` to see local models."
            ),
            _ => format!("HuggingFace API error {status} for '{repo_id}'."),
        });
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let siblings = body["siblings"]
        .as_array()
        .ok_or_else(|| "Unexpected HuggingFace API response format".to_string())?;

    let mut files: Vec<HfFileInfo> = siblings
        .iter()
        .filter_map(|s| {
            let name = s["rfilename"].as_str()?;
            if !name.to_lowercase().ends_with(".gguf") {
                return None;
            }
            // Prefer LFS size, fall back to top-level size field
            let size = s["lfs"]["size"]
                .as_u64()
                .or_else(|| s["size"].as_u64())
                .unwrap_or(0);
            let sha256 = s["lfs"]["sha256"].as_str().map(str::to_owned);
            let download_url = format!("https://huggingface.co/{}/resolve/main/{}", repo_id, name);
            Some(HfFileInfo {
                filename: name.to_owned(),
                size,
                sha256,
                download_url,
            })
        })
        .collect();

    if files.is_empty() {
        return Err(format!(
            "No GGUF files found in HuggingFace repo '{repo_id}'."
        ));
    }

    // Smaller quantizations first
    files.sort_by_key(|f| f.size);
    Ok(files)
}

/// Download one GGUF file from HuggingFace and write a `model.yml` for it.
///
/// The model is stored at `<data_folder>/llamacpp/models/<repo_id>/<filename>`
/// — the shared GGUF tree the desktop app downloads into, so the two stay
/// interchangeable.
///
/// The file is streamed to `<filename>.part` and renamed only once the download
/// completes, so an interrupted run never leaves a truncated `.gguf` behind a
/// `model.yml` that claims it is ready.
///
/// `on_progress(downloaded, total)` is called after each chunk.
/// Returns the local model ID (same as `repo_id`).
pub async fn download_hf_model(
    repo_id: &str,
    file: &HfFileInfo,
    hf_token: Option<&str>,
    on_progress: impl Fn(u64, u64) + Send,
) -> Result<String, String> {
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;

    let data_folder = resolve_jan_data_folder();
    let model_dir = data_folder.join(MODELS_ROOT).join("models").join(repo_id);
    tokio::fs::create_dir_all(&model_dir)
        .await
        .map_err(|e| e.to_string())?;

    let dest_path = model_dir.join(&file.filename);
    let part_path = model_dir.join(format!("{}.part", file.filename));

    // ── Download ──────────────────────────────────────────────────────────
    let client = reqwest::Client::new();
    let mut req = client.get(&file.download_url);
    if let Some(tok) = hf_token {
        req = req.bearer_auth(tok);
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Download request failed: {}", resp.status()));
    }

    // Use the server-reported content-length, fall back to metadata size
    let total = resp.content_length().unwrap_or(file.size);
    let mut downloaded: u64 = 0;

    let mut dest = tokio::fs::File::create(&part_path)
        .await
        .map_err(|e| e.to_string())?;

    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                drop(dest);
                let _ = tokio::fs::remove_file(&part_path).await;
                return Err(e.to_string());
            }
        };
        if let Err(e) = dest.write_all(&chunk).await {
            drop(dest);
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(e.to_string());
        }
        downloaded += chunk.len() as u64;
        on_progress(downloaded, total);
    }
    dest.flush().await.map_err(|e| e.to_string())?;
    drop(dest);

    tokio::fs::rename(&part_path, &dest_path)
        .await
        .map_err(|e| e.to_string())?;

    // ── Write model.yml ───────────────────────────────────────────────────
    // model_path is relative to the Atomic Chat data folder
    let rel_path = format!("{MODELS_ROOT}/models/{repo_id}/{}", file.filename);
    let display_name = repo_id.rsplit('/').next().unwrap_or(repo_id);

    let mut yml = format!(
        "model_path: {rel_path}\nname: {display_name}\nsize_bytes: {}\nembedding: false\n",
        file.size
    );
    if let Some(sha) = &file.sha256 {
        yml.push_str(&format!("model_sha256: {sha}\n"));
    }

    tokio::fs::write(model_dir.join("model.yml"), yml)
        .await
        .map_err(|e| e.to_string())?;

    Ok(repo_id.to_string())
}

// ── App config ────────────────────────────────────────────────────────────

pub fn cli_get_data_folder() -> PathBuf {
    resolve_jan_data_folder()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_data_folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("atomic-cli-tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp data folder");
        dir
    }

    fn write_model(data_folder: &Path, model_id: &str, yml: &str) {
        let dir = data_folder.join(MODELS_ROOT).join("models").join(model_id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("model.yml"), yml).unwrap();
    }

    #[test]
    fn lists_upstream_models_and_skips_embeddings() {
        let data = temp_data_folder("list-models");

        write_model(
            &data,
            "AtomicChat/Qwen3.5-9B-GGUF",
            "model_path: llamacpp/models/AtomicChat/Qwen3.5-9B-GGUF/model.gguf\n\
             name: Qwen3.5-9B\nsize_bytes: 123\nembedding: false\n",
        );
        // Embedding models cannot serve /v1/chat/completions.
        write_model(
            &data,
            "some/embedder",
            "model_path: llamacpp/models/some/embedder/model.gguf\n\
             name: Embedder\nembedding: true\n",
        );
        // A directory with no model.yml is not a model.
        std::fs::create_dir_all(data.join(MODELS_ROOT).join("models").join("junk")).unwrap();

        let models = list_chat_models_in(&data);
        let ids: Vec<&str> = models.iter().map(|(id, _)| id.as_str()).collect();

        assert_eq!(ids, vec!["AtomicChat/Qwen3.5-9B-GGUF"]);
        assert_eq!(models[0].1.name.as_deref(), Some("Qwen3.5-9B"));

        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn missing_provider_folder_lists_nothing() {
        let data = temp_data_folder("no-provider");
        assert!(list_chat_models_in(&data).is_empty());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn resolves_relative_and_absolute_model_paths() {
        let data = temp_data_folder("resolve-paths");

        write_model(
            &data,
            "rel/model",
            "model_path: llamacpp/models/rel/model/model.gguf\n\
             mmproj_path: llamacpp/models/rel/model/mmproj.gguf\n",
        );
        let (model_path, mmproj) = resolve_model_by_id_in(&data, "rel/model").unwrap();
        assert_eq!(
            model_path,
            data.join("llamacpp/models/rel/model/model.gguf")
        );
        assert_eq!(
            mmproj.unwrap(),
            data.join("llamacpp/models/rel/model/mmproj.gguf")
        );

        let absolute = if cfg!(windows) {
            "C:\\models\\abs.gguf"
        } else {
            "/models/abs.gguf"
        };
        write_model(&data, "abs/model", &format!("model_path: {absolute}\n"));
        let (model_path, mmproj) = resolve_model_by_id_in(&data, "abs/model").unwrap();
        assert_eq!(model_path, PathBuf::from(absolute));
        assert!(mmproj.is_none());

        let err = resolve_model_by_id_in(&data, "nope").unwrap_err();
        assert!(err.contains("not installed"), "unexpected error: {err}");

        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn discovers_newest_backend_and_reports_version_backend() {
        let data = temp_data_folder("discover-backend");
        let exe = if cfg!(windows) {
            "llama-server.exe"
        } else {
            "llama-server"
        };

        // b9000 sorts ABOVE b10018 as a plain string, so this pair is exactly
        // the case a lexicographic sort gets wrong.
        for (version, backend, nested) in [
            ("b9000", "linux-cpu-x64", true),
            ("b10018-1.3.0", "linux-vulkan-x64", false),
        ] {
            let mut dir = data
                .join(LOCAL_PROVIDER)
                .join("backends")
                .join(version)
                .join(backend);
            if nested {
                dir = dir.join("build").join("bin");
            }
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(exe), b"stub").unwrap();
        }

        // The TurboQuant fork keeps its own backends next door; they must not
        // be picked up.
        let fork_dir = data
            .join("llamacpp")
            .join("backends")
            .join("turboquant-x")
            .join("linux-cpu-x64");
        std::fs::create_dir_all(&fork_dir).unwrap();
        std::fs::write(fork_dir.join(exe), b"stub").unwrap();

        let found = discover_llamacpp_binary_in(&data).expect("binary discovered");
        // Versions sort descending, so the newer build wins.
        assert_eq!(found.version_backend, "b10018-1.3.0/linux-vulkan-x64");
        assert!(found.path.ends_with(exe));
        assert!(found.path.starts_with(data.join(LOCAL_PROVIDER)));

        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn no_backends_folder_discovers_nothing() {
        let data = temp_data_folder("no-backends");
        assert!(discover_llamacpp_binary_in(&data).is_none());
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn recovers_version_backend_from_an_explicit_bin_path() {
        assert_eq!(
            version_backend_from_bin_path(Path::new(
                "/data/llamacpp-upstream/backends/b9691/linux-vulkan-x64/build/bin/llama-server"
            )),
            Some("b9691/linux-vulkan-x64".to_string())
        );
        assert_eq!(
            version_backend_from_bin_path(Path::new("/usr/local/bin/llama-server")),
            None
        );
    }

    #[test]
    fn recognises_huggingface_repo_ids() {
        assert!(looks_like_hf_repo("AtomicChat/Qwen3.5-9B-GGUF"));
        assert!(!looks_like_hf_repo("./local/path"));
        assert!(!looks_like_hf_repo("/abs/path"));
        assert!(!looks_like_hf_repo("~/home"));
        assert!(!looks_like_hf_repo("nolash"));
        assert!(!looks_like_hf_repo("too/many/parts"));
    }
}
