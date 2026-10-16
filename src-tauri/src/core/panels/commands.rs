//! IPC commands for the panel board.
//!
//! The frontend can list what is installed, install a folder, remove one,
//! open the panels directory, and relay a panel's request to the bridge.
//! Nothing here decides what a panel may do — `panels_request` hands straight
//! to `bridge::dispatch`, which is the single authorising choke point.

use super::bridge::{dispatch, PanelResponse};
use super::host::AppPanelHost;
use super::manifest::parse_manifest;
use super::registry::{BrokenPanel, InstalledPanel, PanelRegistry};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime};

#[derive(Debug, Serialize)]
pub struct PanelListing {
    pub installed: Vec<InstalledPanel>,
    /// Reported rather than hidden, so a panel that fails to load says why
    /// instead of silently not appearing.
    pub broken: Vec<BrokenPanel>,
}

#[tauri::command]
pub async fn panels_list<R: Runtime>(app: AppHandle<R>) -> Result<PanelListing, String> {
    let root = super::panels_root(&app);
    let registry = tokio::task::spawn_blocking(move || PanelRegistry::load(&root))
        .await
        .map_err(|error| format!("Listing panels failed: {error}"))??;
    Ok(PanelListing {
        installed: registry.installed().cloned().collect(),
        broken: registry.broken().to_vec(),
    })
}

/// Copy a panel folder into the panels directory.
///
/// The frontend picks the folder — same division as `agent_import_skill`,
/// which keeps the native dialog on the side that already owns it. The
/// manifest is validated *before* anything is copied, so a bad folder cannot
/// leave a half-installed panel behind.
#[tauri::command]
pub async fn panels_install<R: Runtime>(
    app: AppHandle<R>,
    source_path: String,
) -> Result<super::manifest::PanelManifest, String> {
    let root = super::panels_root(&app);
    tokio::task::spawn_blocking(move || install_from(&root, Path::new(&source_path)))
        .await
        .map_err(|error| format!("Panel install failed: {error}"))?
}

pub(super) fn install_from(
    root: &Path,
    source: &Path,
) -> Result<super::manifest::PanelManifest, String> {
    let manifest_path = source.join("panel.json");
    let source_text = fs::read_to_string(&manifest_path)
        .map_err(|_| "That folder has no readable panel.json.".to_string())?;

    // Validated against the folder's own name: `id` has to match, and the
    // copy below trusts `id` for the destination path.
    let folder = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Could not read the folder name.".to_string())?;
    let manifest = parse_manifest(&source_text, Some(folder))
        .map_err(|errors| format!("Invalid panel.json — {}", errors.join("; ")))?;

    let destination = root.join(&manifest.id);
    fs::create_dir_all(root)
        .map_err(|error| format!("Could not create the panels directory: {error}"))?;

    // Refuse to install a folder onto itself, or onto one of its own
    // ancestors. The replace step below removes the destination first, so
    // without this, picking an already-installed panel's folder — or anything
    // beneath it — would delete the source and then copy nothing, losing the
    // panel outright.
    if let (Ok(source_real), Ok(destination_real)) =
        (source.canonicalize(), destination.canonicalize())
    {
        if source_real == destination_real || source_real.starts_with(&destination_real) {
            return Err(
                "That folder is already installed as this panel; copy it somewhere else first."
                    .to_string(),
            );
        }
    }
    // Replacing rather than merging: a leftover file from an older version of
    // the same panel is exactly the kind of thing that makes an install
    // behave differently from a fresh one.
    if destination.exists() {
        fs::remove_dir_all(&destination)
            .map_err(|error| format!("Could not replace the existing panel: {error}"))?;
    }
    copy_tree(source, &destination).map_err(|error| {
        // Leave nothing half-written behind.
        let _ = fs::remove_dir_all(&destination);
        format!("Could not copy the panel: {error}")
    })?;
    Ok(manifest)
}

/// Copy a directory, refusing symlinks rather than following them — a link in
/// a downloaded panel folder could otherwise pull in anything the user can
/// read.
pub(super) fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(from).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let target = to.join(entry.file_name());
        if file_type.is_symlink() {
            return Err(format!(
                "`{}` is a symbolic link; panels must contain only regular files",
                entry.file_name().to_string_lossy()
            ));
        } else if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn panels_remove<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let root = super::panels_root(&app);
    tokio::task::spawn_blocking(move || {
        // Re-resolve through the registry rather than joining the id straight
        // onto the root: this only ever deletes something the registry says is
        // a panel directly under the panels directory.
        let registry = PanelRegistry::load(&root)?;
        let path = registry
            .get(&id)
            .map(|panel| panel.path.clone())
            .or_else(|| {
                registry
                    .broken()
                    .iter()
                    .find(|broken| broken.id == id)
                    .map(|broken| root.join(&broken.id))
            })
            .ok_or_else(|| format!("No panel called {id} is installed."))?;
        if path.parent() != Some(root.as_path()) {
            return Err("That panel is not inside the panels directory.".to_string());
        }
        fs::remove_dir_all(&path).map_err(|error| format!("Could not remove the panel: {error}"))
    })
    .await
    .map_err(|error| format!("Panel removal failed: {error}"))?
}

#[tauri::command]
pub async fn panels_open_folder<R: Runtime>(app: AppHandle<R>) -> Result<PathBuf, String> {
    let root = super::panels_root(&app);
    fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create the panels directory: {error}"))?;
    Ok(root)
}

/// Relay one request from a panel to the bridge.
///
/// `theme` comes from the renderer because the renderer owns it; a second copy
/// in the backend would be one more thing to keep in step. Everything else is
/// the bridge's decision, including whether this panel may ask at all.
#[tauri::command]
pub async fn panels_request<R: Runtime>(
    app: AppHandle<R>,
    panel_id: String,
    method: String,
    params: Option<Value>,
    theme: Option<String>,
) -> Result<PanelResponse, String> {
    let root = super::panels_root(&app);
    let lookup_id = panel_id.clone();
    let registry = tokio::task::spawn_blocking(move || PanelRegistry::load(&root))
        .await
        .map_err(|error| format!("Reading panels failed: {error}"))??;

    let Some(panel) = registry.get(&lookup_id) else {
        // Matches the contract's `unknown_panel`, and says nothing about
        // whether the panel exists but is broken.
        return Ok(PanelResponse::Err {
            ok: false,
            error: format!("No such panel: {lookup_id}"),
            code: "unknown_panel".to_string(),
        });
    };

    let host = AppPanelHost::new(app.clone(), theme);
    let params = params.unwrap_or(Value::Null);
    Ok(dispatch(&panel.manifest, &method, &params, &host).await)
}
