use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::workspace::default_agent_workspace;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Runtime};

const DEFAULT_WORKSPACE_TEXT_BYTES: usize = 512 * 1024;
const MAX_WORKSPACE_TEXT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceRequest {
    #[serde(default)]
    pub working_dir: Option<String>,
    #[serde(default)]
    pub root_id: Option<String>,
    #[serde(default)]
    pub root_path: Option<String>,
    #[serde(default, alias = "path")]
    pub relative_path: Option<String>,
    #[serde(default)]
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceRootRequest {
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceRoot {
    pub root_id: String,
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: Option<u64>,
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceFile {
    pub path: String,
    pub absolute_path: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
    pub extension: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorkspaceText {
    pub path: String,
    pub content: String,
    pub truncated: bool,
}

#[tauri::command]
pub async fn agent_workspace_root<R: Runtime>(
    app_handle: AppHandle<R>,
    request: AgentWorkspaceRootRequest,
) -> Result<AgentWorkspaceRoot, String> {
    let data_folder = get_jan_data_folder_path(app_handle);
    let root = resolve_working_dir(request.path.as_deref(), &data_folder).await?;
    Ok(AgentWorkspaceRoot {
        root_id: root_id_for_path(&root),
        path: root.to_string_lossy().into_owned(),
        name: root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
pub async fn agent_workspace_list<R: Runtime>(
    app_handle: AppHandle<R>,
    request: AgentWorkspaceRequest,
) -> Result<Vec<AgentWorkspaceEntry>, String> {
    let (root, path) = resolve_workspace_path(
        app_handle,
        &request,
        request.relative_path.as_deref().unwrap_or(""),
    )
    .await?;
    list_workspace_directory(&root, &path).await
}

async fn list_workspace_directory(
    root: &Path,
    path: &Path,
) -> Result<Vec<AgentWorkspaceEntry>, String> {
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("Could not inspect '{}': {error}", path.display()))?;
    if !metadata.is_dir() {
        return Err(format!(
            "Workspace path is not a directory: {}",
            path.display()
        ));
    }

    let mut directory = tokio::fs::read_dir(&path)
        .await
        .map_err(|error| format!("Could not list '{}': {error}", path.display()))?;
    let mut entries = Vec::new();
    while let Some(entry) = directory
        .next_entry()
        .await
        .map_err(|error| format!("Could not read '{}': {error}", path.display()))?
    {
        let entry_path = entry.path();
        let metadata = tokio::fs::metadata(&entry_path).await.ok();
        let kind = metadata
            .as_ref()
            .map(|value| if value.is_dir() { "directory" } else { "file" })
            .unwrap_or("unknown")
            .to_string();
        entries.push(AgentWorkspaceEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: workspace_relative_path(&root, &entry_path)?,
            kind,
            size: metadata
                .as_ref()
                .and_then(|value| value.is_file().then_some(value.len())),
            modified_ms: metadata.as_ref().and_then(modified_ms),
        });
    }
    entries.sort_by(|left, right| {
        let left_rank = if left.kind == "directory" { 0 } else { 1 };
        let right_rank = if right.kind == "directory" { 0 } else { 1 };
        left_rank
            .cmp(&right_rank)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub async fn agent_workspace_stat<R: Runtime>(
    app_handle: AppHandle<R>,
    request: AgentWorkspaceRequest,
) -> Result<AgentWorkspaceFile, String> {
    let relative = request
        .relative_path
        .as_deref()
        .ok_or_else(|| "Workspace file path is required".to_string())?;
    let (root, path) = resolve_workspace_path(app_handle, &request, relative).await?;
    let metadata = workspace_file_metadata(&path).await?;
    Ok(AgentWorkspaceFile {
        path: workspace_relative_path(&root, &path)?,
        absolute_path: path.to_string_lossy().into_owned(),
        size: metadata.len(),
        modified_ms: modified_ms(&metadata),
        extension: path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase(),
    })
}

#[tauri::command]
pub async fn agent_workspace_resolve_path<R: Runtime>(
    app_handle: AppHandle<R>,
    request: AgentWorkspaceRequest,
) -> Result<String, String> {
    let relative = request
        .relative_path
        .as_deref()
        .ok_or_else(|| "Workspace path is required".to_string())?;
    let (_, path) = resolve_workspace_path(app_handle, &request, relative).await?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn agent_workspace_read_text<R: Runtime>(
    app_handle: AppHandle<R>,
    request: AgentWorkspaceRequest,
) -> Result<AgentWorkspaceText, String> {
    let relative = request
        .relative_path
        .as_deref()
        .ok_or_else(|| "Workspace file path is required".to_string())?;
    let (root, path) = resolve_workspace_path(app_handle, &request, relative).await?;
    workspace_file_metadata(&path).await?;
    let limit = request
        .max_bytes
        .unwrap_or(DEFAULT_WORKSPACE_TEXT_BYTES)
        .clamp(1, MAX_WORKSPACE_TEXT_BYTES);
    let (content, truncated) = read_workspace_text(&path, limit).await?;
    Ok(AgentWorkspaceText {
        path: workspace_relative_path(&root, &path)?,
        content,
        truncated,
    })
}

async fn workspace_file_metadata(path: &Path) -> Result<std::fs::Metadata, String> {
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("Could not inspect '{}': {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("Workspace path is not a file: {}", path.display()));
    }
    Ok(metadata)
}

async fn read_workspace_text(path: &Path, limit: usize) -> Result<(String, bool), String> {
    use tokio::io::AsyncReadExt;

    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|error| format!("Could not open '{}': {error}", path.display()))?;
    let mut bytes = Vec::with_capacity(limit.saturating_add(1));
    file.take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| format!("Could not read '{}': {error}", path.display()))?;
    let truncated = bytes.len() > limit;
    bytes.truncate(limit);
    let content = match String::from_utf8(bytes) {
        Ok(content) => content,
        Err(error) if truncated && error.utf8_error().error_len().is_none() => {
            let valid_up_to = error.utf8_error().valid_up_to();
            String::from_utf8(error.into_bytes()[..valid_up_to].to_vec())
                .expect("valid UTF-8 prefix")
        }
        Err(_) => {
            return Err(format!(
                "Workspace file is not valid UTF-8 text: {}",
                path.display()
            ))
        }
    };
    Ok((content, truncated))
}

pub(crate) async fn resolve_working_dir(
    value: Option<&str>,
    data_folder: &Path,
) -> Result<PathBuf, String> {
    let path = match value {
        Some(value) if !value.trim().is_empty() => expand_home(value)?,
        _ => {
            let workspace = default_agent_workspace(data_folder);
            tokio::fs::create_dir_all(&workspace)
                .await
                .map_err(|error| {
                    format!(
                        "Failed to create default Agent workspace '{}': {error}",
                        workspace.display()
                    )
                })?;
            workspace
        }
    };
    let path = if path.is_absolute() {
        lexical_normalize(&path)
    } else {
        lexical_normalize(
            &std::env::current_dir()
                .map_err(|error| error.to_string())?
                .join(path),
        )
    };
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("Invalid working directory '{}': {error}", path.display()))?;
    if !metadata.is_dir() {
        return Err(format!(
            "Working directory is not a directory: {}",
            path.display()
        ));
    }
    tokio::fs::canonicalize(&path)
        .await
        .map_err(|error| format!("Could not resolve working directory: {error}"))
}

async fn resolve_workspace_path<R: Runtime>(
    app_handle: AppHandle<R>,
    request: &AgentWorkspaceRequest,
    relative: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let data_folder = get_jan_data_folder_path(app_handle);
    let requested_root = request
        .root_path
        .as_deref()
        .or(request.working_dir.as_deref());
    let root = resolve_working_dir(requested_root, &data_folder).await?;
    if let Some(root_id) = request.root_id.as_deref() {
        if root_id != root_id_for_path(&root) {
            return Err("Workspace root identifier does not match its canonical path".into());
        }
    }
    let candidate = resolve_workspace_candidate(&root, relative).await?;
    Ok((root, candidate))
}

async fn resolve_workspace_candidate(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative.components().any(|component| {
            !matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
    {
        return Err("Workspace path must be relative and stay inside the workspace".into());
    }
    let candidate = tokio::fs::canonicalize(root.join(relative))
        .await
        .map_err(|error| format!("Could not resolve workspace path: {error}"))?;
    if !candidate.starts_with(&root) {
        return Err("Workspace path escapes the selected Agent workspace".into());
    }
    Ok(candidate)
}

fn workspace_relative_path(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Workspace path escapes the selected Agent workspace".to_string())?;
    Ok(relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn modified_ms(metadata: &std::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
}

pub fn root_id_for_path(path: &Path) -> String {
    let mut digest = Sha256::new();
    digest.update(path.to_string_lossy().as_bytes());
    format!("root-{:x}", digest.finalize())
}

#[cfg(windows)]
fn path_buf_from_input(raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix(r"\?\") {
        return PathBuf::from(format!(r"\\?\{rest}"));
    }
    // Models sometimes write a drive path in URL form, `/C:\Users\...`. Windows
    // reads that as rooted but drive-less and joins it onto the workspace's
    // drive, so the tool hit a folder that does not exist (#271).
    PathBuf::from(jan_utils::path::strip_windows_drive_slash(raw))
}

#[cfg(not(windows))]
fn path_buf_from_input(raw: &str) -> PathBuf {
    PathBuf::from(raw)
}

pub(crate) fn expand_home(raw: &str) -> Result<PathBuf, String> {
    if raw == "~" {
        return dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string());
    }
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        return dirs::home_dir()
            .map(|home| home.join(rest))
            .ok_or_else(|| "Could not resolve home directory".to_string());
    }
    Ok(path_buf_from_input(raw))
}

pub(crate) fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::test_support::TestWorkspace;
    use std::fs;

    #[cfg(windows)]
    fn create_junction(link: &Path, target: &Path) {
        let output = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("run mklink /J");
        assert!(
            output.status.success(),
            "mklink /J failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(windows)]
    fn create_directory_symlink_if_allowed(link: &Path, target: &Path) -> bool {
        match std::os::windows::fs::symlink_dir(target, link) {
            Ok(()) => true,
            Err(error)
                if error.kind() == std::io::ErrorKind::PermissionDenied
                    || error.raw_os_error() == Some(1314) =>
            {
                false
            }
            Err(error) => panic!("create directory symlink: {error}"),
        }
    }

    #[tokio::test]
    async fn missing_working_dir_uses_default_agent_workspace() {
        let data_folder = TestWorkspace::new();

        let resolved = resolve_working_dir(None, data_folder.path())
            .await
            .expect("resolve default Agent workspace");
        let expected = tokio::fs::canonicalize(
            data_folder
                .path()
                .join(super::super::workspace::DEFAULT_AGENT_WORKSPACE_DIR),
        )
        .await
        .expect("canonicalize default Agent workspace");

        assert_eq!(resolved, expected);
        assert!(resolved.is_dir());
    }

    #[tokio::test]
    async fn workspace_candidate_stays_inside_root() {
        let workspace = TestWorkspace::new();
        fs::create_dir_all(workspace.path().join("src")).expect("create src");
        fs::write(workspace.path().join("src/main.rs"), "fn main() {}").expect("write file");
        let root = tokio::fs::canonicalize(workspace.path())
            .await
            .expect("canonical root");

        let resolved = resolve_workspace_candidate(&root, "src/main.rs")
            .await
            .expect("resolve file");

        assert_eq!(
            workspace_relative_path(&root, &resolved).unwrap(),
            "src/main.rs"
        );
    }

    #[tokio::test]
    async fn workspace_candidate_rejects_parent_traversal() {
        let workspace = TestWorkspace::new();
        let root = tokio::fs::canonicalize(workspace.path())
            .await
            .expect("canonical root");

        let error = resolve_workspace_candidate(&root, "../outside.txt")
            .await
            .unwrap_err();

        assert!(error.contains("must be relative"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_candidate_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let workspace = TestWorkspace::new();
        let outside = TestWorkspace::new();
        fs::write(outside.path().join("secret.txt"), "secret").expect("write outside file");
        symlink(outside.path(), workspace.path().join("outside")).expect("create symlink");
        let root = tokio::fs::canonicalize(workspace.path())
            .await
            .expect("canonical root");

        let error = resolve_workspace_candidate(&root, "outside/secret.txt")
            .await
            .unwrap_err();

        assert!(error.contains("escapes"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn workspace_candidate_rejects_windows_reparse_point_escapes() {
        let workspace = TestWorkspace::new();
        let outside = TestWorkspace::new();
        fs::write(outside.path().join("secret.txt"), "secret").expect("write outside file");
        let root = tokio::fs::canonicalize(workspace.path())
            .await
            .expect("canonical root");

        let junction = workspace.path().join("junction");
        create_junction(&junction, outside.path());
        let junction_error = resolve_workspace_candidate(&root, "junction/secret.txt")
            .await
            .unwrap_err();
        assert!(junction_error.contains("escapes"));
        fs::remove_dir(&junction).expect("remove junction");

        let symlink = workspace.path().join("symlink");
        if create_directory_symlink_if_allowed(&symlink, outside.path()) {
            let symlink_error = resolve_workspace_candidate(&root, "symlink/secret.txt")
                .await
                .unwrap_err();
            assert!(symlink_error.contains("escapes"));
            fs::remove_dir(&symlink).expect("remove symlink");
        }
    }

    #[tokio::test]
    async fn workspace_list_returns_directories_before_files() {
        let workspace = TestWorkspace::new();
        fs::create_dir_all(workspace.path().join("src")).expect("create directory");
        fs::write(workspace.path().join("README.md"), "read me").expect("write file");
        let root = tokio::fs::canonicalize(workspace.path())
            .await
            .expect("canonical root");

        let entries = list_workspace_directory(&root, &root)
            .await
            .expect("list workspace");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "src");
        assert_eq!(entries[0].kind, "directory");
        assert_eq!(entries[1].name, "README.md");
        assert_eq!(entries[1].kind, "file");
    }

    #[tokio::test]
    async fn workspace_file_metadata_rejects_directory() {
        let workspace = TestWorkspace::new();

        let error = workspace_file_metadata(workspace.path()).await.unwrap_err();

        assert!(error.contains("not a file"));
    }

    #[tokio::test]
    async fn workspace_text_read_reports_truncation() {
        let workspace = TestWorkspace::new();
        let file = workspace.path().join("notes.txt");
        fs::write(&file, "abcdef").expect("write text");

        let (content, truncated) = read_workspace_text(&file, 4).await.unwrap();

        assert_eq!(content, "abcd");
        assert!(truncated);
    }

    #[tokio::test]
    async fn workspace_text_read_rejects_invalid_utf8() {
        let workspace = TestWorkspace::new();
        let file = workspace.path().join("binary.bin");
        fs::write(&file, [0xff, 0xfe, 0xfd]).expect("write bytes");

        let error = read_workspace_text(&file, 16).await.unwrap_err();

        assert!(error.contains("not valid UTF-8"));
    }
}
