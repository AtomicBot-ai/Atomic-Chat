//! The panel bridge: the only way a panel reaches anything.
//!
//! Every request a panel makes arrives here, is authorised against the
//! permissions its own manifest declares, and is refused if it was not asked
//! for. Unknown methods are rejected rather than forwarded, so a capability
//! exists only once someone adds it deliberately — adding a method to the
//! table is the act of granting it.
//!
//! The host surface is kept small on purpose. Four methods need no permission,
//! `storage` adds two, and everything else a panel might want goes through
//! MCP, gated by `mcp.read` / `mcp.call` and confined to the servers the
//! manifest names. That is the decision recorded in the ADR: panel authors
//! write against a protocol they already know instead of a hand-written
//! method list that only ever grows, and the list of things this host has to
//! keep safe stays short enough to reason about.
//!
//! Everything here is expressed against the `PanelHost` trait so the
//! authorisation rules can be tested without an app handle — the tests below
//! drive a stub that records what it was asked for.

use super::manifest::{PanelManifest, ALWAYS_ALLOWED};
use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Value};

/// A tool a panel may see, flattened to what a panel actually needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PanelTool {
    pub name: String,
    pub server: String,
    pub description: Option<String>,
}

/// What the bridge needs from the app. Implemented for real over the MCP
/// client and per-panel storage; stubbed in tests.
#[async_trait]
pub trait PanelHost: Send + Sync {
    fn app_version(&self) -> String;
    fn platform(&self) -> String;
    async fn theme(&self) -> String;
    /// Tools from `servers` only. The bridge never calls this with a server
    /// the manifest did not name.
    async fn list_tools(&self, servers: &[String]) -> Result<Vec<PanelTool>, String>;
    async fn call_tool(&self, server: &str, tool: &str, args: Value) -> Result<Value, String>;
    async fn storage_get(&self, panel_id: &str, key: Option<&str>) -> Result<Value, String>;
    async fn storage_set(&self, panel_id: &str, key: &str, value: Value) -> Result<(), String>;
}

/// The answer sent back to a panel, matching contract v1's `host:response`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum PanelResponse {
    Ok {
        ok: bool,
        result: Value,
    },
    Err {
        ok: bool,
        error: String,
        code: String,
    },
}

impl PanelResponse {
    fn ok(result: Value) -> Self {
        Self::Ok { ok: true, result }
    }

    fn err(code: &str, error: impl Into<String>) -> Self {
        Self::Err {
            ok: false,
            error: error.into(),
            code: code.to_string(),
        }
    }

    pub fn is_ok(&self) -> bool {
        matches!(self, Self::Ok { .. })
    }

    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Err { code, .. } => Some(code),
            Self::Ok { .. } => None,
        }
    }

    pub fn error(&self) -> Option<&str> {
        match self {
            Self::Err { error, .. } => Some(error),
            Self::Ok { .. } => None,
        }
    }

    pub fn result(&self) -> Option<&Value> {
        match self {
            Self::Ok { result, .. } => Some(result),
            Self::Err { .. } => None,
        }
    }
}

/// Which permission a method needs, or `None` when it needs none.
fn required_permission(method: &str) -> Option<&'static str> {
    match method {
        "storage.get" | "storage.set" => Some("storage"),
        "mcp.listTools" => Some("mcp.read"),
        "mcp.callTool" => Some("mcp.call"),
        _ => None,
    }
}

fn is_known(method: &str) -> bool {
    ALWAYS_ALLOWED.contains(&method)
        || matches!(
            method,
            "storage.get" | "storage.set" | "mcp.listTools" | "mcp.callTool"
        )
}

fn string_param(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Handle one request from a panel.
///
/// The order matters: a method this host does not implement is reported as
/// `unknown_method` before any permission check, so a panel written against a
/// newer contract learns that the host is old rather than that it is
/// unauthorised.
pub async fn dispatch(
    manifest: &PanelManifest,
    method: &str,
    params: &Value,
    host: &dyn PanelHost,
) -> PanelResponse {
    if !is_known(method) {
        return PanelResponse::err("unknown_method", format!("Unknown method: {method}"));
    }

    if let Some(permission) = required_permission(method) {
        if !manifest.allows(permission) {
            // Name the permission: the author can act on that, where a bare
            // "denied" only tells them to go reading.
            return PanelResponse::err(
                "permission_denied",
                format!(
                    "Panel \"{}\" has not requested permission to call {method}. Add \"{permission}\" to its manifest permissions.",
                    manifest.id
                ),
            );
        }
    }

    match method {
        "host.info" => PanelResponse::ok(json!({
            "version": host.app_version(),
            "platform": host.platform(),
            "theme": host.theme().await,
            "contract": manifest.contract,
        })),

        // Acknowledged here so a panel's call resolves; the visible effect is
        // the host's, driven by the same postMessage the panel already sent.
        "panel.ready" | "panel.resize" => PanelResponse::ok(json!(true)),

        "panel.theme" => PanelResponse::ok(json!({ "theme": host.theme().await })),

        "storage.get" => {
            let key = string_param(params, "key");
            match host.storage_get(&manifest.id, key.as_deref()).await {
                Ok(value) => PanelResponse::ok(value),
                Err(error) => PanelResponse::err("handler_error", error),
            }
        }

        "storage.set" => {
            let Some(key) = string_param(params, "key") else {
                return PanelResponse::err("handler_error", "`key` is required");
            };
            let value = params.get("value").cloned().unwrap_or(Value::Null);
            match host.storage_set(&manifest.id, &key, value).await {
                Ok(()) => PanelResponse::ok(json!(true)),
                Err(error) => PanelResponse::err("handler_error", error),
            }
        }

        "mcp.listTools" => match host.list_tools(&manifest.mcp_servers).await {
            Ok(tools) => match serde_json::to_value(tools) {
                Ok(value) => PanelResponse::ok(value),
                Err(error) => PanelResponse::err("handler_error", error.to_string()),
            },
            Err(error) => PanelResponse::err("handler_error", error),
        },

        "mcp.callTool" => {
            let Some(tool) = string_param(params, "name") else {
                return PanelResponse::err("handler_error", "`name` is required");
            };
            let args = params.get("args").cloned().unwrap_or_else(|| json!({}));

            // A panel may name the server explicitly, but it must be one its
            // manifest allows. Checked before anything is listed or called.
            if let Some(server) = string_param(params, "server") {
                if !manifest.allows_server(&server) {
                    return PanelResponse::err(
                        "permission_denied",
                        format!(
                            "Panel \"{}\" may not reach MCP server \"{server}\". Add it to `mcpServers` in the manifest.",
                            manifest.id
                        ),
                    );
                }
                return match host.call_tool(&server, &tool, args).await {
                    Ok(value) => PanelResponse::ok(value),
                    Err(error) => PanelResponse::err("handler_error", error),
                };
            }

            // Otherwise resolve the tool *within the allowlist*, never outside
            // it. Listing is scoped to the allowed servers, so an unqualified
            // name can only ever reach something the manifest permits.
            let tools = match host.list_tools(&manifest.mcp_servers).await {
                Ok(tools) => tools,
                Err(error) => return PanelResponse::err("handler_error", error),
            };
            let matches: Vec<&PanelTool> = tools.iter().filter(|t| t.name == tool).collect();
            match matches.as_slice() {
                [one] => match host.call_tool(&one.server, &tool, args).await {
                    Ok(value) => PanelResponse::ok(value),
                    Err(error) => PanelResponse::err("handler_error", error),
                },
                [] => PanelResponse::err("handler_error", format!("Unknown tool: {tool}")),
                // Ambiguity is the panel's to resolve: guessing a server for it
                // would silently pick which one of two it talked to.
                many => PanelResponse::err(
                    "handler_error",
                    format!(
                        "Tool \"{tool}\" is offered by {} of this panel's servers ({}). Pass `server` to say which.",
                        many.len(),
                        many.iter().map(|t| t.server.as_str()).collect::<Vec<_>>().join(", ")
                    ),
                ),
            }
        }

        // `is_known` is the gate; this arm exists so adding a method there
        // without handling it here fails loudly rather than silently allowing.
        other => PanelResponse::err("unknown_method", format!("Unhandled method: {other}")),
    }
}
