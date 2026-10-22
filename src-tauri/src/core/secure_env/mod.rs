//! Secure environment projects: a project names the folders its chats'
//! commands may reach (each read-only or writable) and whether they may use
//! the network; everything else stays out of reach.
//!
//! Projects themselves live in the webview's storage, but the policy is kept
//! here, in `<data>/secure-environments.json`, and `chat_exec_run` looks it up
//! itself from the thread's own `thread.json` (`metadata.project.id`). A
//! frontend that forgets to pass it therefore cannot widen a run back to the
//! ordinary chat folders. Enforcement is the Windows MXC policy
//! (`chat_exec::mxc`); where MXC is not available a secure thread's commands
//! do not run at all.
//!
//! MCP servers are host processes MXC cannot wrap, so in a secure project
//! they are off unless the project lists them (`allowed_mcp_servers`);
//! `mcp::commands::call_tool` refuses the rest for that thread.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::core::agent::approval_allowlist::atomic_replace;
use crate::core::agent::session::validate_session_id;
use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::threads::utils::get_thread_metadata_path;

const FILE_NAME: &str = "secure-environments.json";
const FILE_VERSION: u32 = 1;
const MAX_FOLDERS: usize = 32;
const MAX_PROJECT_ID_LEN: usize = 128;
const MAX_MCP_SERVERS: usize = 64;
const MAX_MCP_SERVER_NAME_LEN: usize = 256;

/// Read-modify-write of the file is serialized; reads go straight to disk.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureFolder {
    /// Absolute, as the folder picker returned it.
    pub path: String,
    pub can_edit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureEnvironment {
    pub folders: Vec<SecureFolder>,
    /// Outgoing network for commands (and web search in the chat).
    #[serde(default)]
    pub network: bool,
    /// MCP servers (keys of `mcp_config.json`) the project's chats may call.
    /// They run outside the sandbox with the user's own access.
    #[serde(default)]
    pub allowed_mcp_servers: Vec<String>,
}

impl SecureEnvironment {
    pub fn allows_mcp_server(&self, server: &str) -> bool {
        self.allowed_mcp_servers.iter().any(|name| name == server)
    }

    /// Folders that still exist, split into (writable, read-only). A folder
    /// deleted since it was added is skipped rather than failing the run.
    pub fn existing_roots(&self) -> (Vec<PathBuf>, Vec<PathBuf>) {
        let mut writable = Vec::new();
        let mut readonly = Vec::new();
        for folder in &self.folders {
            let path = PathBuf::from(&folder.path);
            if !path.is_dir() {
                continue;
            }
            if folder.can_edit {
                writable.push(path);
            } else {
                readonly.push(path);
            }
        }
        (writable, readonly)
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SecureEnvironmentsFile {
    version: u32,
    projects: BTreeMap<String, SecureEnvironment>,
}

fn file_path(data_folder: &Path) -> PathBuf {
    data_folder.join(FILE_NAME)
}

/// All secure projects. A missing file is "none"; an unreadable one is an
/// error, so a damaged policy never reads as "no restrictions".
pub fn load_all(data_folder: &Path) -> Result<BTreeMap<String, SecureEnvironment>, String> {
    let path = file_path(data_folder);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(format!("Could not read the secure environments: {error}")),
    };
    let file: SecureEnvironmentsFile = serde_json::from_str(&content)
        .map_err(|error| format!("The secure environments file is damaged: {error}"))?;
    if file.version != FILE_VERSION {
        return Err(format!(
            "Unsupported secure environments version: {}",
            file.version
        ));
    }
    Ok(file.projects)
}

/// The policy of the project a thread belongs to, if that project is a
/// secure environment. A thread without `thread.json` belongs to no project.
pub fn for_thread(
    data_folder: &Path,
    thread_id: &str,
) -> Result<Option<SecureEnvironment>, String> {
    validate_session_id(thread_id)
        .map_err(|_| "threadId must be a safe single path component".to_owned())?;
    let metadata = get_thread_metadata_path(data_folder, thread_id);
    let content = match fs::read_to_string(&metadata) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read the thread: {error}")),
    };
    let thread: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| format!("Could not read the thread: {error}"))?;
    let Some(project_id) = thread
        .pointer("/metadata/project/id")
        .and_then(serde_json::Value::as_str)
    else {
        return Ok(None);
    };
    Ok(load_all(data_folder)?.remove(project_id))
}

/// Set (or, with `None`, clear) one project's policy.
pub fn save(
    data_folder: &Path,
    project_id: &str,
    environment: Option<SecureEnvironment>,
) -> Result<(), String> {
    validate_project_id(project_id)?;
    if let Some(environment) = &environment {
        validate(environment, data_folder)?;
    }
    let _guard = WRITE_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let mut projects = load_all(data_folder)?;
    match environment {
        Some(environment) => {
            projects.insert(project_id.to_owned(), environment);
        }
        None => {
            if projects.remove(project_id).is_none() {
                return Ok(());
            }
        }
    }
    write(data_folder, projects)
}

fn validate_project_id(project_id: &str) -> Result<(), String> {
    if project_id.is_empty() || project_id.len() > MAX_PROJECT_ID_LEN {
        return Err("Invalid project id".into());
    }
    Ok(())
}

/// Every folder must be an existing, absolute directory that is not a
/// volume root and neither holds nor sits inside the app's own data (other
/// chats, keys, settings). Paths are compared canonically.
fn validate(environment: &SecureEnvironment, data_folder: &Path) -> Result<(), String> {
    if environment.folders.len() > MAX_FOLDERS {
        return Err(format!("A project can have at most {MAX_FOLDERS} folders"));
    }
    if environment.allowed_mcp_servers.len() > MAX_MCP_SERVERS
        || environment
            .allowed_mcp_servers
            .iter()
            .any(|name| name.trim().is_empty() || name.len() > MAX_MCP_SERVER_NAME_LEN)
    {
        return Err("Invalid list of allowed MCP servers".into());
    }
    let data = fs::canonicalize(data_folder).unwrap_or_else(|_| data_folder.to_path_buf());
    let mut seen = Vec::new();
    for folder in &environment.folders {
        let path = Path::new(&folder.path);
        if !path.is_absolute() {
            return Err(format!("Not an absolute folder path: {}", folder.path));
        }
        let canonical =
            fs::canonicalize(path).map_err(|_| format!("Folder not found: {}", folder.path))?;
        if !canonical.is_dir() {
            return Err(format!("Not a folder: {}", folder.path));
        }
        if canonical.parent().is_none() {
            return Err(format!(
                "A whole drive cannot be a project folder: {}",
                folder.path
            ));
        }
        if canonical.starts_with(&data) || data.starts_with(&canonical) {
            return Err(format!(
                "The app's own data folder cannot be part of a project: {}",
                folder.path
            ));
        }
        if seen.contains(&canonical) {
            return Err(format!("Folder added twice: {}", folder.path));
        }
        seen.push(canonical);
    }
    Ok(())
}

fn write(data_folder: &Path, projects: BTreeMap<String, SecureEnvironment>) -> Result<(), String> {
    fs::create_dir_all(data_folder).map_err(|error| error.to_string())?;
    let path = file_path(data_folder);
    let temporary = data_folder.join(format!("{FILE_NAME}.{}.tmp", uuid::Uuid::new_v4()));
    let content = serde_json::to_vec_pretty(&SecureEnvironmentsFile {
        version: FILE_VERSION,
        projects,
    })
    .map_err(|error| error.to_string())?;
    let result = (|| {
        let mut file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
        file.write_all(&content)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        atomic_replace(&temporary, &path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("Could not save the secure environment: {error}"))
}

/// Every secure project's policy, by project id.
#[tauri::command]
pub async fn secure_env_list<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<BTreeMap<String, SecureEnvironment>, String> {
    let data_folder = get_jan_data_folder_path(app_handle);
    tokio::task::spawn_blocking(move || load_all(&data_folder))
        .await
        .map_err(|error| error.to_string())?
}

/// Make a project a secure environment, change it, or (`null`) turn it off.
#[tauri::command]
pub async fn secure_env_set<R: Runtime>(
    app_handle: AppHandle<R>,
    project_id: String,
    environment: Option<SecureEnvironment>,
) -> Result<(), String> {
    let data_folder = get_jan_data_folder_path(app_handle);
    tokio::task::spawn_blocking(move || save(&data_folder, &project_id, environment))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn environment(folders: &[(&Path, bool)], network: bool) -> SecureEnvironment {
        SecureEnvironment {
            folders: folders
                .iter()
                .map(|(path, can_edit)| SecureFolder {
                    path: path.display().to_string(),
                    can_edit: *can_edit,
                })
                .collect(),
            network,
            allowed_mcp_servers: Vec::new(),
        }
    }

    fn write_thread(data: &Path, thread_id: &str, project_id: Option<&str>) {
        let path = get_thread_metadata_path(data, thread_id);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let metadata = match project_id {
            Some(id) => serde_json::json!({ "project": { "id": id, "name": "P" } }),
            None => serde_json::json!({}),
        };
        fs::write(
            path,
            serde_json::json!({ "id": thread_id, "metadata": metadata }).to_string(),
        )
        .unwrap();
    }

    #[test]
    fn a_thread_gets_its_projects_policy_and_nothing_else() {
        let data = TempDir::new().unwrap();
        let work = TempDir::new().unwrap();
        let policy = environment(&[(work.path(), false)], false);
        save(data.path(), "p1", Some(policy.clone())).unwrap();
        write_thread(data.path(), "in-secure", Some("p1"));
        write_thread(data.path(), "in-other", Some("p2"));
        write_thread(data.path(), "no-project", None);

        assert_eq!(for_thread(data.path(), "in-secure").unwrap(), Some(policy));
        assert_eq!(for_thread(data.path(), "in-other").unwrap(), None);
        assert_eq!(for_thread(data.path(), "no-project").unwrap(), None);
        assert_eq!(for_thread(data.path(), "missing").unwrap(), None);
        assert!(for_thread(data.path(), "../in-secure").is_err());
    }

    #[test]
    fn a_damaged_file_fails_closed() {
        let data = TempDir::new().unwrap();
        write_thread(data.path(), "t", Some("p1"));
        fs::write(file_path(data.path()), "{ not json").unwrap();
        assert!(for_thread(data.path(), "t").is_err());
    }

    #[test]
    fn clearing_removes_only_that_project() {
        let data = TempDir::new().unwrap();
        let work = TempDir::new().unwrap();
        save(
            data.path(),
            "a",
            Some(environment(&[(work.path(), true)], true)),
        )
        .unwrap();
        save(data.path(), "b", Some(environment(&[], false))).unwrap();
        save(data.path(), "a", None).unwrap();
        let all = load_all(data.path()).unwrap();
        assert_eq!(all.keys().collect::<Vec<_>>(), vec!["b"]);
    }

    #[test]
    fn rejects_folders_that_would_open_too_much() {
        let data = TempDir::new().unwrap();
        let inside_data = data.path().join("threads");
        fs::create_dir_all(&inside_data).unwrap();
        let root = data.path().ancestors().last().unwrap().to_path_buf();
        let work = TempDir::new().unwrap();

        for (folders, what) in [
            (
                vec![(inside_data.as_path(), false)],
                "inside the data folder",
            ),
            (vec![(data.path(), false)], "the data folder"),
            (vec![(root.as_path(), false)], "a volume root"),
            (vec![(Path::new("relative/dir"), false)], "a relative path"),
            (
                vec![(work.path(), false), (work.path(), true)],
                "the same folder twice",
            ),
        ] {
            assert!(
                save(data.path(), "p", Some(environment(&folders, false))).is_err(),
                "{what} must be refused"
            );
        }
        assert!(load_all(data.path()).unwrap().is_empty());
    }

    #[test]
    fn missing_folders_are_skipped_at_run_time() {
        let data = TempDir::new().unwrap();
        let kept = TempDir::new().unwrap();
        let gone = TempDir::new().unwrap();
        let policy = environment(&[(kept.path(), true), (gone.path(), false)], false);
        save(data.path(), "p", Some(policy.clone())).unwrap();
        let gone_path = gone.path().to_path_buf();
        drop(gone);
        let (writable, readonly) = policy.existing_roots();
        assert_eq!(writable, vec![kept.path().to_path_buf()]);
        assert!(readonly.is_empty(), "{gone_path:?} no longer exists");
    }
}
