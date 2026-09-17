//! The bundled keyless search capability survives an Exa MCP handshake failure.
//! Keep its existing tool identity so chat mutes and saved tool calls still work.
use rmcp::model::{CallToolResult, Content};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, Runtime};

use super::models::ToolWithServer;
use crate::core::{agent::tools::web::search_keyless, state::AppState};

pub(crate) const TOOL_NAME: &str = "web_search_exa";
pub(crate) const UNAVAILABLE: &str = "Web search is temporarily unavailable. Try again.";

pub(crate) fn is_bundled_config(name: &str, config: &Value) -> bool {
    name == "exa"
        && config["type"] == "http"
        && config["url"] == "https://mcp.exa.ai/mcp"
        && config.get("active").and_then(Value::as_bool) != Some(false)
        && config
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty()
        && ["args", "env", "envs", "headers"].iter().all(|key| {
            config.get(*key).is_none_or(|value| match value {
                Value::Null => true,
                Value::Array(items) => items.is_empty(),
                Value::Object(items) => items.is_empty(),
                _ => false,
            })
        })
}

pub(crate) async fn enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    let state = app.state::<AppState>();
    let config = state.mcp_active_servers.lock().await.get("exa").cloned();
    let Some(config) = config else { return false };
    is_bundled_config("exa", &config)
        && !state
            .mcp_oauth
            .has_entry(
                &crate::core::app::commands::get_jan_data_folder_path(app.clone()),
                "exa",
            )
            .await
}

pub(crate) fn tool() -> ToolWithServer {
    ToolWithServer {
        name: TOOL_NAME.into(),
        server: "exa".into(),
        description: Some("Web search".into()),
        input_schema: json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Search query" },
                "numResults": { "type": "integer", "minimum": 1, "maximum": 20 }
            },
            "required": ["query"]
        }),
        annotations: Some(json!({"readOnlyHint": true})),
    }
}

pub(crate) async fn call(arguments: Option<Map<String, Value>>) -> Result<CallToolResult, String> {
    let args = Value::Object(arguments.unwrap_or_default());
    let query = args["query"]
        .as_str()
        .filter(|query| !query.trim().is_empty())
        .ok_or_else(|| UNAVAILABLE.to_owned())?;
    let count = args["numResults"].as_u64().unwrap_or(8).clamp(1, 20) as usize;
    let outcome = search_keyless(query, count)
        .await
        .map_err(|_| UNAVAILABLE.to_owned())?;
    Ok(CallToolResult::success(vec![Content::text(
        serde_json::to_string(&outcome).map_err(|_| UNAVAILABLE.to_owned())?,
    )]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_unmodified_keyless_exa_gets_the_bundled_search_path() {
        let config = json!({"type": "http", "url": "https://mcp.exa.ai/mcp", "active": true});
        assert!(is_bundled_config("exa", &config));
        assert!(!is_bundled_config("my-exa", &config));
        for (key, value) in [
            ("url", json!("https://mcp.exa.ai/mcp?key=custom")),
            ("headers", json!({"Authorization": "Bearer custom"})),
            ("env", json!({"EXA_API_KEY": "custom"})),
            ("active", json!(false)),
            ("command", json!("my-search")),
        ] {
            let mut customized = config.clone();
            customized[key] = value;
            assert!(!is_bundled_config("exa", &customized), "{key}");
        }
    }
}
