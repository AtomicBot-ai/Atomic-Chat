//! Bundled keyless web tools survive an Exa MCP handshake failure.
//! Keep Exa's two public tool identities so chat mutes and saved calls continue
//! to work while the hosted endpoint is blocked or rate-limited.
use std::path::Path;

use rmcp::model::{CallToolResult, Content};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, Runtime};

use super::models::ToolWithServer;
use crate::core::{
    agent::tools::web::{fetch_keyless, search_keyless},
    state::AppState,
};

pub(crate) const SEARCH_TOOL_NAME: &str = "web_search_exa";
pub(crate) const FETCH_TOOL_NAME: &str = "web_fetch_exa";
const SEARCH_UNAVAILABLE: &str = "Web search is temporarily unavailable. Try again.";
const FETCH_UNAVAILABLE: &str = "Web page fetch is temporarily unavailable. Try again.";

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

fn search_tool() -> ToolWithServer {
    ToolWithServer {
        name: SEARCH_TOOL_NAME.into(),
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

fn fetch_tool() -> ToolWithServer {
    ToolWithServer {
        name: FETCH_TOOL_NAME.into(),
        server: "exa".into(),
        description: Some("Read webpages".into()),
        input_schema: json!({
            "type": "object",
            "properties": {
                "urls": {
                    "type": "array",
                    "items": { "type": "string" },
                    "minItems": 1,
                    "description": "Webpage URLs to read"
                },
                "maxCharacters": { "type": "integer", "minimum": 1, "maximum": 50000 }
            },
            "required": ["urls"]
        }),
        annotations: Some(json!({"readOnlyHint": true})),
    }
}

pub(crate) fn tools() -> [ToolWithServer; 2] {
    [search_tool(), fetch_tool()]
}

pub(crate) fn is_bundled_tool(name: &str) -> bool {
    matches!(name, SEARCH_TOOL_NAME | FETCH_TOOL_NAME)
}

pub(crate) async fn call(
    tool_name: &str,
    arguments: Option<Map<String, Value>>,
    working_dir: &Path,
) -> Result<CallToolResult, String> {
    let args = Value::Object(arguments.unwrap_or_default());
    match tool_name {
        SEARCH_TOOL_NAME => call_search(&args).await,
        FETCH_TOOL_NAME => call_fetch(&args, working_dir).await,
        _ => Err(format!("Unknown bundled web tool: {tool_name}")),
    }
}

async fn call_search(args: &Value) -> Result<CallToolResult, String> {
    let query = args["query"]
        .as_str()
        .filter(|query| !query.trim().is_empty())
        .ok_or_else(|| SEARCH_UNAVAILABLE.to_owned())?;
    let count = args["numResults"].as_u64().unwrap_or(8).clamp(1, 20) as usize;
    let outcome = search_keyless(query, count)
        .await
        .map_err(|_| SEARCH_UNAVAILABLE.to_owned())?;
    Ok(CallToolResult::success(vec![Content::text(
        serde_json::to_string(&outcome).map_err(|_| SEARCH_UNAVAILABLE.to_owned())?,
    )]))
}

async fn call_fetch(args: &Value, working_dir: &Path) -> Result<CallToolResult, String> {
    let urls = args["urls"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .take(10)
        .collect::<Vec<_>>();
    if urls.is_empty() {
        return Err(FETCH_UNAVAILABLE.to_owned());
    }
    let max_chars = args["maxCharacters"]
        .as_u64()
        .unwrap_or(50_000)
        .clamp(1, 50_000) as usize;
    let mut content = Vec::with_capacity(urls.len());
    for url in urls {
        let outcome = fetch_keyless(url, max_chars, working_dir)
            .await
            .map_err(|_| FETCH_UNAVAILABLE.to_owned())?;
        content.push(Content::text(
            serde_json::to_string(&outcome).map_err(|_| FETCH_UNAVAILABLE.to_owned())?,
        ));
    }
    Ok(CallToolResult::success(content))
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

    #[test]
    fn bundled_exa_surface_keeps_search_and_fetch() {
        let tools = tools();
        assert_eq!(tools[0].name, SEARCH_TOOL_NAME);
        assert_eq!(tools[1].name, FETCH_TOOL_NAME);
        assert_eq!(tools[1].input_schema["required"], json!(["urls"]));
    }
}
