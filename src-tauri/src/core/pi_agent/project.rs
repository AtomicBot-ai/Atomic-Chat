//! Tools scoped to the project recorded in the task's persisted metadata.
use std::path::Path;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_vector_db::{api, VectorDBState};
use tokio_util::sync::CancellationToken;

use super::bridge::Connector;
use crate::core::{
    app::commands::get_jan_data_folder_path,
    chat_exec::{commands, ChatExecRequest, ChatExecState, ExecKind},
    secure_env,
    threads::validate_session_id,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProjectTool {
    ListFiles,
    ReadFile,
    RunCommand,
}

impl ProjectTool {
    pub fn name(self) -> &'static str {
        match self {
            Self::ListFiles => "atomic_project_list_files",
            Self::ReadFile => "atomic_project_read_file",
            Self::RunCommand => "atomic_project_run_command",
        }
    }

    fn connector(self) -> Connector {
        let (name, description, parameters) = match self {
            Self::ListFiles => ("list_files", "List indexed documents attached to this project.", json!({})),
            Self::ReadFile => ("read_file", "Read up to eight consecutive text chunks of a project document using the ID returned by list_files. Chunk numbering starts at zero.", json!({
                "properties":{"file_id":{"type":"string"},"start_order":{"type":"integer","minimum":0}},
                "required":["file_id"]
            })),
            Self::RunCommand => ("run_command", "Run a command inside this project's configured secure environment.", json!({
                "properties":{"command":{"type":"string"}},"required":["command"]
            })),
        };
        let mut input_schema =
            json!({"type":"object","properties":{},"additionalProperties":false});
        input_schema
            .as_object_mut()
            .unwrap()
            .extend(parameters.as_object().unwrap().clone());
        Connector {
            server: "Project".into(),
            name: name.into(),
            description: description.into(),
            input_schema,
            project_tool: Some(self),
        }
    }
}

pub fn tools(secure: bool) -> Vec<Connector> {
    let mut tools = vec![
        ProjectTool::ListFiles.connector(),
        ProjectTool::ReadFile.connector(),
    ];
    if secure {
        tools.push(ProjectTool::RunCommand.connector());
    }
    tools
}

fn collection_for_task(
    data: &Path,
    thread: &str,
    expected: Option<&str>,
) -> Result<String, String> {
    let current = secure_env::thread_project(data, thread)?.ok_or("This task has no project")?;
    if expected != Some(current.as_str())
        || current.contains(['/', '\\'])
        || validate_session_id(&current).is_err()
    {
        return Err(
            "The task's project changed. Reopen the task to use its current project.".into(),
        );
    }
    Ok(format!("project_{current}"))
}

fn documents(
    base: &Path,
    collection: &str,
    tool: ProjectTool,
    args: &Map<String, Value>,
) -> Result<Value, String> {
    match tool {
        ProjectTool::ListFiles => {
            let files = api::list_attachments(base, collection, None).map_err(|e| e.to_string())?;
            Ok(Value::Array(
                files
                    .into_iter()
                    .map(|f| json!({"id":f.id, "name":f.name,"chunk_count":f.chunk_count}))
                    .collect(),
            ))
        }
        ProjectTool::ReadFile => {
            let id = args
                .get("file_id")
                .and_then(Value::as_str)
                .ok_or("A project file ID is required")?;
            let start = match args.get("start_order") {
                Some(value) => value
                    .as_i64()
                    .filter(|v| *v >= 0)
                    .ok_or("Invalid chunk offset")?,
                None => 0,
            };
            let chunks = api::get_chunks(base, collection, id, start, start.saturating_add(7))
                .map_err(|e| e.to_string())?;
            Ok(Value::Array(
                chunks
                    .into_iter()
                    .map(|c| json!({"order":c.chunk_file_order, "text":c.text}))
                    .collect(),
            ))
        }
        ProjectTool::RunCommand => Err("Expected a project document tool".into()),
    }
}

pub async fn call<R: Runtime>(
    app: AppHandle<R>,
    thread: String,
    project: Option<&str>,
    tool: ProjectTool,
    args: Map<String, Value>,
    cancelled: CancellationToken,
) -> Result<Value, String> {
    let data = get_jan_data_folder_path(app.clone());
    let collection = collection_for_task(&data, &thread, project)?;
    let result = if tool == ProjectTool::RunCommand {
        let command = args
            .get("command")
            .and_then(Value::as_str)
            .ok_or("A command is required")?;
        let id = uuid::Uuid::new_v4().to_string();
        let state = app.state::<ChatExecState>();
        let request = ChatExecRequest {
            call_id: id.clone(),
            thread_id: thread,
            kind: ExecKind::Command,
            language: None,
            source: command.to_owned(),
            timeout_seconds: None,
        };
        let run = commands::run_request(&app, &state, request, true);
        tokio::pin!(run);
        tokio::select! {
            biased;
            _ = cancelled.cancelled() => { commands::chat_exec_cancel(state.clone(),id); return Err("Project command cancelled".into()); }
            result = &mut run => serde_json::to_value(result?).map_err(|e| e.to_string())?,
        }
    } else {
        let base = app.state::<VectorDBState>().base_dir.clone();
        tokio::select! {
            biased;
            _ = cancelled.cancelled() => return Err("Project document request cancelled".into()),
            result = tokio::task::spawn_blocking(move || documents(&base,&collection,tool,&args)) => result.map_err(|e| e.to_string())??,
        }
    };
    Ok(json!({"content":[{"type":"text","text":result.to_string()}]}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::threads::utils::get_thread_metadata_path;
    #[test]
    fn tools_follow_persisted_membership_and_reject_a_stale_session() {
        let root = tempfile::tempdir().unwrap();
        let path = get_thread_metadata_path(root.path(), "task");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, r#"{"metadata":{"project":{"id":"second"}}}"#).unwrap();
        assert!(collection_for_task(root.path(), "task", Some("first")).is_err());
        let collection = collection_for_task(root.path(), "task", Some("second")).unwrap();
        assert_eq!(collection, "project_second");
        assert_eq!(
            documents(
                root.path(),
                &collection,
                ProjectTool::ListFiles,
                &Map::new()
            )
            .unwrap(),
            json!([])
        );
        assert!(!root.path().join("project_second.db").exists());
    }
}
