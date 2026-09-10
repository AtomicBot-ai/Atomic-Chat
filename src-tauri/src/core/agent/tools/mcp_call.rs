//! Dispatch for dynamic `mcp.*` tools: resolve through the turn's
//! [`McpBridge`], call the remote server, and compress the `CallToolResult`
//! into the agent's `ToolOutcome` shape.

use serde_json::{json, Value};

use super::{ToolContext, MAX_TOOL_OUTPUT_CHARS};
use crate::core::agent::types::{ToolCallPayload, ToolOutcome};

/// Raw content carried into `details` for the UI renderers, bounded.
const MAX_DETAILS_CONTENT_CHARS: usize = 8_000;

pub(super) async fn execute(call: &ToolCallPayload, context: &ToolContext<'_>) -> ToolOutcome {
    let Some(bridge) = context.mcp else {
        return ToolOutcome::error("MCP tools are not available this turn");
    };
    let Some(descriptor) = bridge.resolve(&call.tool) else {
        return ToolOutcome::error(format!("Unknown MCP tool: {}", call.tool));
    };
    let result = match bridge
        .call(descriptor, &call.args, context.cancellation)
        .await
    {
        Ok(result) => result,
        Err(error) => {
            return ToolOutcome {
                status: if context.cancellation.is_cancelled() {
                    crate::core::agent::types::ToolStatus::Cancelled
                } else {
                    crate::core::agent::types::ToolStatus::Error
                },
                summary: error,
                details: Some(json!({
                    "mcp": true,
                    "server": descriptor.server,
                    "tool": descriptor.tool,
                })),
            }
        }
    };

    let content_json = serde_json::to_value(&result.content).unwrap_or(Value::Null);
    let mut text_blocks: Vec<String> = Vec::new();
    if let Some(items) = content_json.as_array() {
        for item in items {
            match item.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        text_blocks.push(text.to_owned());
                    }
                }
                Some("image") => text_blocks.push(format!(
                    "[image {}]",
                    item.get("mimeType").and_then(Value::as_str).unwrap_or("?")
                )),
                Some("resource") | Some("resource_link") => text_blocks.push(format!(
                    "[resource {}]",
                    item.pointer("/resource/uri")
                        .or_else(|| item.get("uri"))
                        .and_then(Value::as_str)
                        .unwrap_or("?")
                )),
                Some(other) => text_blocks.push(format!("[{other}]")),
                None => {}
            }
        }
    }
    let mut summary = text_blocks.join("\n");
    if summary.is_empty() {
        // Spec-current servers may return only `structuredContent` (the text
        // mirror is a SHOULD); surface it instead of reporting emptiness.
        summary = result
            .structured_content
            .as_ref()
            .map(|value| value.to_string())
            .unwrap_or_else(|| "(empty MCP tool result)".into());
    }
    if summary.chars().count() > MAX_TOOL_OUTPUT_CHARS {
        summary = summary.chars().take(MAX_TOOL_OUTPUT_CHARS).collect();
        summary.push('…');
    }

    let mut bounded_content = content_json.to_string();
    if bounded_content.chars().count() > MAX_DETAILS_CONTENT_CHARS {
        bounded_content = bounded_content
            .chars()
            .take(MAX_DETAILS_CONTENT_CHARS)
            .collect();
        bounded_content.push('…');
    }
    let is_error = result.is_error == Some(true);
    let mut structured = result
        .structured_content
        .as_ref()
        .map(|value| value.to_string())
        .unwrap_or_default();
    if structured.chars().count() > MAX_DETAILS_CONTENT_CHARS {
        structured = structured.chars().take(MAX_DETAILS_CONTENT_CHARS).collect();
        structured.push('…');
    }
    let details = json!({
        "mcp": true,
        "server": descriptor.server,
        "tool": descriptor.tool,
        "isError": is_error,
        "content": bounded_content,
        "structuredContent": structured,
    });

    if is_error {
        ToolOutcome {
            status: crate::core::agent::types::ToolStatus::Error,
            summary,
            details: Some(details),
        }
    } else {
        ToolOutcome {
            status: crate::core::agent::types::ToolStatus::Ok,
            summary,
            details: Some(details),
        }
    }
}
