//! Review before use for MCP connectors (Task 28, decision D36).
//!
//! Every connector - built in, from the catalog, added by hand or imported -
//! is started only after the user allowed it with Allow / Preview / Cancel,
//! and again whenever what it runs or where it connects changes. The check
//! lives in `start_mcp_server`, the single place every connector starts (at
//! launch, from a switch, or on a sign-in retry), so no screen can skip it.

use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    path::Path,
    process::Stdio,
    time::Duration,
};

use rmcp::{model::Tool, transport::TokioChildProcess, ServiceExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Runtime};
use tokio::{io::AsyncReadExt, time::timeout};

use super::{
    constants::{DEFAULT_MCP_HANDSHAKE_TIMEOUT_SECS, DEFAULT_MCP_TOOL_LIST_TIMEOUT_SECS},
    helpers::{
        append_bounded_stderr, build_stdio_command, connect_remote_mcp, extract_command_args,
        format_mcp_start_error, kill_process_tree_by_pid,
    },
};
use crate::core::{agent::skills::atomic_replace, app::commands::get_jan_data_folder_path};

/// Connector reviews, stored next to `mcp_config.json`.
pub const REVIEWED_CONNECTORS_FILE: &str = "mcp_reviewed.json";

#[derive(Debug, Default, Serialize, Deserialize)]
struct ReviewedConnectorsState {
    #[serde(default)]
    reviewed: BTreeMap<String, String>,
}

/// What the user was shown when they allowed a connector: what it runs, where
/// it connects, and the names of the secrets and headers it is given. Secret
/// values, `active`, `timeout` and `official` are left out, so switching a
/// connector off and on or replacing an API key does not ask again.
pub fn connector_fingerprint(config: &Value) -> String {
    let text = |key: &str| {
        config
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let names = |key: &str| {
        let mut names: Vec<String> = config
            .get(key)
            .and_then(Value::as_object)
            .map(|object| object.keys().cloned().collect())
            .unwrap_or_default();
        names.sort();
        names
    };
    // A fixed-order array, so the hash never depends on JSON key order.
    let reviewed = serde_json::json!([
        ["type", text("type")],
        ["url", text("url")],
        ["command", text("command")],
        [
            "args",
            config
                .get("args")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new()))
        ],
        ["cwd", text("cwd")],
        ["env", names("env")],
        ["headers", names("headers")],
    ]);
    format!("{:x}", Sha256::digest(reviewed.to_string().as_bytes()))
}

/// Whether the user allowed this connector, under this name, as it is now.
pub fn is_connector_reviewed(data_dir: &Path, name: &str, config: &Value) -> bool {
    read_reviewed(data_dir).get(name) == Some(&connector_fingerprint(config))
}

/// Records that the user allowed this connector as it is now.
pub fn approve_connector(data_dir: &Path, name: &str, config: &Value) -> Result<(), String> {
    let mut reviewed = read_reviewed(data_dir);
    reviewed.insert(name.to_string(), connector_fingerprint(config));
    write_reviewed(data_dir, reviewed)
}

/// The error a connector that was not reviewed fails to start with.
pub fn needs_review_error(name: &str) -> String {
    format!(
        "Connector \"{name}\" needs review before Radium can connect to it. \
         Switch it on in Connectors to review it."
    )
}

fn read_reviewed(data_dir: &Path) -> BTreeMap<String, String> {
    let path = data_dir.join(REVIEWED_CONNECTORS_FILE);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return BTreeMap::new(),
        Err(error) => {
            log::warn!("Treating connector reviews as empty: could not read them: {error}");
            return BTreeMap::new();
        }
    };
    match serde_json::from_str::<ReviewedConnectorsState>(&content) {
        Ok(state) => state.reviewed,
        Err(error) => {
            log::warn!("Treating connector reviews as empty: they are damaged: {error}");
            BTreeMap::new()
        }
    }
}

fn write_reviewed(data_dir: &Path, reviewed: BTreeMap<String, String>) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(&ReviewedConnectorsState { reviewed })
        .map_err(|error| format!("Failed to serialize connector reviews: {error}"))?;
    fs::create_dir_all(data_dir)
        .map_err(|error| format!("Failed to create the data folder: {error}"))?;
    let path = data_dir.join(REVIEWED_CONNECTORS_FILE);
    let temporary = data_dir.join(format!(
        "{REVIEWED_CONNECTORS_FILE}.{}.tmp",
        uuid::Uuid::new_v4()
    ));
    let result = fs::write(&temporary, &content)
        .map_err(|error| format!("Failed to write connector reviews: {error}"))
        .and_then(|()| {
            atomic_replace(&temporary, &path)
                .map_err(|error| format!("Failed to save connector reviews: {error}"))
        });
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// One of a connector's tools, as Preview shows it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTool {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// What the connector says about the tool; it labels its own tools.
    pub read_only: bool,
    /// Whether the tool says it may delete or overwrite things.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destructive: Option<bool>,
    /// Whether the tool says it reaches services outside this computer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_world: Option<bool>,
    /// The inputs the tool asks for, as the connector describes them.
    pub input_schema: Value,
}

/// Lists a connector's tools for Preview without connecting it: nothing is
/// added to the running connectors the AI can use, no sign-in is used, and a
/// local program is stopped as soon as it has answered.
pub async fn preview_connector_tools<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    config: &Value,
) -> Result<Vec<PreviewTool>, String> {
    let params = extract_command_args(config)
        .ok_or_else(|| format!("The settings for {name} could not be read"))?;
    let list_timeout = Duration::from_secs(DEFAULT_MCP_TOOL_LIST_TIMEOUT_SECS);

    match params.transport_type.as_deref() {
        Some(transport @ ("http" | "sse")) => {
            let client = connect_remote_mcp(app, name, &params, transport, false).await?;
            let listed = timeout(list_timeout, client.peer().list_all_tools()).await;
            let _ = client.cancel().await;
            preview_from_listing(listed, list_timeout)
        }
        Some(other) if other != "stdio" => Err(format!(
            "Unsupported MCP transport type '{other}' for server {name}"
        )),
        _ => {
            if params.command.trim().is_empty() {
                return Err(format!("MCP stdio server {name} has no command"));
            }
            let app_path = get_jan_data_folder_path(app.clone());
            let command = build_stdio_command(&app_path, name, &params);
            let (process, stderr) = TokioChildProcess::builder(command)
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|error| format!("{name} could not start: {error}"))?;
            let pid = process.id();
            let handshake_timeout = params
                .timeout
                .unwrap_or_else(|| Duration::from_secs(DEFAULT_MCP_HANDSHAKE_TIMEOUT_SECS));

            let result = match timeout(handshake_timeout, ().serve(process)).await {
                Ok(Ok(service)) => {
                    let listed = timeout(list_timeout, service.peer().list_all_tools()).await;
                    let _ = service.cancel().await;
                    preview_from_listing(listed, list_timeout)
                }
                Ok(Err(error)) => Err(format!("{name} could not start: {error}")),
                Err(_) => Err(format!(
                    "{name} could not start: no answer within {}s",
                    handshake_timeout.as_secs()
                )),
            };

            // Stop the program whatever happened; Preview never leaves it running.
            if let Some(pid) = pid {
                let _ = kill_process_tree_by_pid(pid).await;
            }
            match (result, stderr) {
                (Err(error), Some(mut stderr)) => {
                    let mut captured = VecDeque::new();
                    let mut chunk = [0_u8; 4096];
                    let _ = timeout(Duration::from_secs(1), async {
                        while let Ok(size) = stderr.read(&mut chunk).await {
                            if size == 0 {
                                break;
                            }
                            append_bounded_stderr(&mut captured, &chunk[..size]);
                        }
                    })
                    .await;
                    let captured = captured.into_iter().collect::<Vec<_>>();
                    Err(format_mcp_start_error(
                        &error,
                        &String::from_utf8_lossy(&captured),
                    ))
                }
                (result, _) => result,
            }
        }
    }
}

fn preview_from_listing<E: std::fmt::Display>(
    listed: Result<Result<Vec<Tool>, E>, tokio::time::error::Elapsed>,
    list_timeout: Duration,
) -> Result<Vec<PreviewTool>, String> {
    match listed {
        Ok(Ok(tools)) => Ok(tools
            .into_iter()
            .map(|tool| PreviewTool {
                name: tool.name.to_string(),
                description: tool.description.as_ref().map(|text| text.to_string()),
                read_only: tool
                    .annotations
                    .as_ref()
                    .and_then(|annotations| annotations.read_only_hint)
                    == Some(true),
                destructive: tool
                    .annotations
                    .as_ref()
                    .and_then(|annotations| annotations.destructive_hint),
                open_world: tool
                    .annotations
                    .as_ref()
                    .and_then(|annotations| annotations.open_world_hint),
                input_schema: Value::Object((*tool.input_schema).clone()),
            })
            .collect()),
        Ok(Err(error)) => Err(format!("Failed to list tools: {error}")),
        Err(_) => Err(format!(
            "Tool listing timed out after {}s",
            list_timeout.as_secs()
        )),
    }
}

/// Whether a connector has to be reviewed before it can be switched on.
#[tauri::command]
pub async fn mcp_connector_needs_review<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    config: Value,
) -> Result<bool, String> {
    let data_dir = get_jan_data_folder_path(app);
    Ok(!is_connector_reviewed(&data_dir, &name, &config))
}

/// Records the user's Allow for a connector as it is now. It does not start it.
#[tauri::command]
pub async fn approve_mcp_connector<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    config: Value,
) -> Result<(), String> {
    let data_dir = get_jan_data_folder_path(app);
    log::info!("Connector {name} was reviewed and allowed");
    approve_connector(&data_dir, &name, &config)
}

/// Lists a connector's tools for Preview without connecting it.
#[tauri::command]
pub async fn preview_mcp_connector_tools<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    config: Value,
) -> Result<Vec<PreviewTool>, String> {
    preview_connector_tools(&app, &name, &config).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn web_service() -> Value {
        json!({
            "type": "http",
            "url": "https://mcp.linear.app/mcp",
            "command": "",
            "args": [],
            "env": {},
            "headers": { "Authorization": "Bearer first-key" },
            "active": true
        })
    }

    fn local_program() -> Value {
        json!({
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem@2026.1.14", "C:/Users/me/Documents"],
            "env": { "API_TOKEN": "first-value" },
            "cwd": "C:/Users/me/Documents",
            "active": false
        })
    }

    #[test]
    fn a_connector_nobody_has_reviewed_is_not_reviewed() {
        let data = TempDir::new().unwrap();

        assert!(!is_connector_reviewed(
            data.path(),
            "linear",
            &web_service()
        ));
        assert!(!is_connector_reviewed(
            data.path(),
            "files",
            &local_program()
        ));
    }

    #[test]
    fn approving_a_connector_is_remembered_across_restarts() {
        let data = TempDir::new().unwrap();

        approve_connector(data.path(), "linear", &web_service()).unwrap();

        // Read straight from disk, as the next launch would.
        assert!(data.path().join(REVIEWED_CONNECTORS_FILE).is_file());
        assert!(is_connector_reviewed(data.path(), "linear", &web_service()));
        assert!(!is_connector_reviewed(
            data.path(),
            "files",
            &local_program()
        ));
    }

    #[test]
    fn changing_what_a_connector_runs_or_where_it_connects_needs_a_new_review() {
        let data = TempDir::new().unwrap();
        approve_connector(data.path(), "files", &local_program()).unwrap();
        approve_connector(data.path(), "linear", &web_service()).unwrap();

        let mut changed_command = local_program();
        changed_command["command"] = json!("uvx");
        let mut changed_args = local_program();
        changed_args["args"][1] = json!("evil-package");
        let mut changed_cwd = local_program();
        changed_cwd["cwd"] = json!("C:/");
        let mut new_secret_name = local_program();
        new_secret_name["env"]["NODE_OPTIONS"] = json!("--require payload.js");
        let mut changed_url = web_service();
        changed_url["url"] = json!("https://attacker.example/mcp");
        let mut changed_type = web_service();
        changed_type["type"] = json!("sse");
        let mut new_header = web_service();
        new_header["headers"]["X-Forward-To"] = json!("somewhere");

        for changed in [changed_command, changed_args, changed_cwd, new_secret_name] {
            assert!(
                !is_connector_reviewed(data.path(), "files", &changed),
                "still counted as reviewed after a change: {changed}"
            );
        }
        for changed in [changed_url, changed_type, new_header] {
            assert!(
                !is_connector_reviewed(data.path(), "linear", &changed),
                "still counted as reviewed after a change: {changed}"
            );
        }
    }

    #[test]
    fn switching_off_and_on_or_replacing_a_key_does_not_ask_again() {
        let data = TempDir::new().unwrap();
        approve_connector(data.path(), "linear", &web_service()).unwrap();
        approve_connector(data.path(), "files", &local_program()).unwrap();

        let mut new_key = web_service();
        new_key["headers"]["Authorization"] = json!("Bearer second-key");
        new_key["active"] = json!(false);
        new_key["timeout"] = json!(60);
        let mut new_value = local_program();
        new_value["env"]["API_TOKEN"] = json!("second-value");
        new_value["active"] = json!(true);
        new_value["official"] = json!(true);

        assert!(is_connector_reviewed(data.path(), "linear", &new_key));
        assert!(is_connector_reviewed(data.path(), "files", &new_value));
    }

    #[test]
    fn a_review_belongs_to_one_name() {
        let data = TempDir::new().unwrap();
        approve_connector(data.path(), "linear", &web_service()).unwrap();

        assert!(!is_connector_reviewed(
            data.path(),
            "renamed",
            &web_service()
        ));
    }

    #[test]
    fn a_damaged_review_file_counts_as_nothing_reviewed() {
        let data = TempDir::new().unwrap();
        approve_connector(data.path(), "linear", &web_service()).unwrap();
        fs::write(data.path().join(REVIEWED_CONNECTORS_FILE), "{ not json").unwrap();

        assert!(!is_connector_reviewed(
            data.path(),
            "linear",
            &web_service()
        ));
        // Approving again repairs it.
        approve_connector(data.path(), "linear", &web_service()).unwrap();
        assert!(is_connector_reviewed(data.path(), "linear", &web_service()));
    }

    #[test]
    fn preview_keeps_each_tools_inputs_and_what_it_says_about_itself() {
        let schema = json!({
            "type": "object",
            "properties": { "id": { "type": "string", "description": "Issue id" } },
            "required": ["id"]
        });
        let mut delete = Tool::new(
            "delete_issue",
            "Delete an issue",
            std::sync::Arc::new(schema.as_object().unwrap().clone()),
        );
        delete.annotations = Some(rmcp::model::ToolAnnotations {
            read_only_hint: Some(false),
            destructive_hint: Some(true),
            open_world_hint: Some(true),
            ..Default::default()
        });
        let list = Tool::new(
            "list_issues",
            "List issues",
            std::sync::Arc::new(serde_json::Map::new()),
        );

        let listed =
            preview_from_listing::<String>(Ok(Ok(vec![delete, list])), Duration::from_secs(1))
                .unwrap();

        assert_eq!(
            listed,
            vec![
                PreviewTool {
                    name: "delete_issue".into(),
                    description: Some("Delete an issue".into()),
                    read_only: false,
                    destructive: Some(true),
                    open_world: Some(true),
                    input_schema: schema,
                },
                PreviewTool {
                    name: "list_issues".into(),
                    description: Some("List issues".into()),
                    read_only: false,
                    destructive: None,
                    open_world: None,
                    input_schema: json!({}),
                },
            ]
        );
        // Sent to the review screen with the names it reads.
        let sent = serde_json::to_value(&listed[0]).unwrap();
        assert_eq!(sent["openWorld"], json!(true));
        assert_eq!(sent["inputSchema"]["required"], json!(["id"]));
    }

    #[test]
    fn the_refusal_names_the_connector_and_says_why() {
        let error = needs_review_error("linear");

        assert!(error.contains("linear"), "{error}");
        assert!(error.contains("needs review"), "{error}");
    }
}
