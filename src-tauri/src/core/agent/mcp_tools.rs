//! Dynamic MCP tools for the agent loop.
//!
//! The user's connected MCP servers are snapshotted **once per turn** into an
//! [`McpCatalog`]: each remote tool gets a namespaced agent-facing name
//! (`mcp.<server-slug>.<tool>`), a one-line catalog entry in the prompt, an
//! alternation branch in the GBNF grammar / JSON schema, and a dispatch path
//! through [`McpBridge`]. Freezing the set per turn keeps every prompt within
//! the turn byte-stable (KV-cache friendly); a changed server set costs one
//! prefix re-ingest at the next turn boundary.
//!
//! Names are namespaced but never *parsed*: the catalog owns the exact
//! `agent name → (server, tool)` mapping, so dots or dashes inside server and
//! tool names cannot cause ambiguity.

use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

use async_trait::async_trait;
use rmcp::model::{CallToolRequestParam, CallToolResult};
use rmcp::{service::Peer, RoleClient};
use serde_json::Value;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::core::mcp::constants::DEFAULT_MCP_TOOL_LIST_TIMEOUT_SECS;
use crate::core::state::{AppState, SharedMcpServers};

/// Reserved namespace for MCP-origin tools. No built-in tool may use it
/// (pinned by a test in `grammar.rs`).
pub const MCP_TOOL_PREFIX: &str = "mcp.";

/// Hard cap on catalog size. Grammar alternations and the `# mcp` prompt block
/// stay bounded no matter how many servers the user connects.
pub const MAX_MCP_TOOLS: usize = 64;

/// Longest agent-facing name. Longer names are truncated before the collision
/// suffix is applied.
const MAX_AGENT_NAME_CHARS: usize = 96;

/// The built-in `os.web.search` / `os.web.fetch` already call the hosted Exa
/// MCP endpoint directly, so the `exa` server from the default config would
/// only duplicate them in the catalog. It stays available to the legacy chat
/// pipeline untouched.
const EXCLUDED_SERVERS: &[&str] = &["exa"];

#[derive(Debug, Clone)]
pub struct McpToolDescriptor {
    /// Namespaced name the model calls: `mcp.<server-slug>.<tool>`.
    pub agent_name: String,
    /// Connected server name, exactly as keyed in the MCP config.
    pub server: String,
    /// Original tool name on that server.
    pub tool: String,
    pub description: String,
    pub input_schema: Value,
    /// MCP `readOnlyHint` annotation. A *hint* from a user-configured server:
    /// read-only tools skip the approval gate but still run serialized.
    pub read_only: bool,
}

#[derive(Debug, Default)]
pub struct McpCatalog {
    tools: Vec<McpToolDescriptor>,
    by_name: HashMap<String, usize>,
    /// Tools dropped by [`MAX_MCP_TOOLS`]; surfaced in the prompt block.
    pub omitted: usize,
}

impl McpCatalog {
    pub fn from_tools(mut tools: Vec<McpToolDescriptor>) -> Self {
        // Deterministic order → byte-stable prompt and grammar.
        tools.sort_by(|a, b| (&a.server, &a.tool).cmp(&(&b.server, &b.tool)));
        let omitted = tools.len().saturating_sub(MAX_MCP_TOOLS);
        tools.truncate(MAX_MCP_TOOLS);
        let mut by_name = HashMap::with_capacity(tools.len());
        for (index, descriptor) in tools.iter_mut().enumerate() {
            let mut candidate = descriptor.agent_name.clone();
            let mut suffix = 2;
            while by_name.contains_key(&candidate) {
                candidate = format!("{}-{suffix}", descriptor.agent_name);
                suffix += 1;
            }
            descriptor.agent_name = candidate.clone();
            by_name.insert(candidate, index);
        }
        Self {
            tools,
            by_name,
            omitted,
        }
    }

    pub fn resolve(&self, agent_name: &str) -> Option<&McpToolDescriptor> {
        self.by_name
            .get(agent_name)
            .and_then(|index| self.tools.get(*index))
    }

    pub fn descriptors(&self) -> &[McpToolDescriptor] {
        &self.tools
    }

    pub fn names(&self) -> Vec<String> {
        self.tools
            .iter()
            .map(|descriptor| descriptor.agent_name.clone())
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }
}

/// Lowercased `[a-z0-9_-]` form of a server name for the agent-facing
/// namespace. Purely cosmetic — the reverse mapping lives in the catalog.
pub fn server_slug(name: &str) -> String {
    let mut slug = String::with_capacity(name.len());
    let mut last_dash = false;
    for ch in name.to_lowercase().chars() {
        let mapped = if ch.is_ascii_alphanumeric() || ch == '_' {
            Some(ch)
        } else {
            None
        };
        match mapped {
            Some(ch) => {
                slug.push(ch);
                last_dash = false;
            }
            None if !last_dash && !slug.is_empty() => {
                slug.push('-');
                last_dash = true;
            }
            None => {}
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "server".into()
    } else {
        slug
    }
}

pub fn agent_tool_name(server: &str, tool: &str) -> String {
    let name = format!("{MCP_TOOL_PREFIX}{}.{tool}", server_slug(server));
    if name.chars().count() <= MAX_AGENT_NAME_CHARS {
        return name;
    }
    name.chars().take(MAX_AGENT_NAME_CHARS).collect()
}

/// Whether the raw rmcp tool advertises `readOnlyHint: true`.
fn is_read_only(tool: &rmcp::model::Tool) -> bool {
    tool.annotations
        .as_ref()
        .and_then(|annotations| annotations.read_only_hint)
        == Some(true)
}

/// Snapshot every connected server's tool list into a catalog.
///
/// Follows the ATO-271 discipline: clone `(name, Peer)` handles under the map
/// lock, release it, then list concurrently with a short per-server timeout —
/// a dead server delays only itself and is skipped. `disabled_keys` uses the
/// frontend's `server::tool` composite format (`useToolAvailable`).
pub async fn snapshot_catalog(state: &AppState, disabled_keys: &BTreeSet<String>) -> McpCatalog {
    let list_timeout = Duration::from_secs(DEFAULT_MCP_TOOL_LIST_TIMEOUT_SECS);
    let handles: Vec<(String, Peer<RoleClient>)> = {
        let servers = state.mcp_servers.lock().await;
        servers
            .iter()
            .filter(|(name, _)| !EXCLUDED_SERVERS.contains(&name.as_str()))
            .map(|(name, service)| (name.clone(), service.peer()))
            .collect()
    };

    let per_server = handles.into_iter().map(|(server, peer)| async move {
        match timeout(list_timeout, peer.list_all_tools()).await {
            Ok(Ok(tools)) => Some((server, tools)),
            Ok(Err(error)) => {
                log::warn!("Agent MCP catalog: server {server} failed to list tools: {error}");
                None
            }
            Err(_) => {
                log::warn!(
                    "Agent MCP catalog: server {server} tool listing timed out after {}s",
                    list_timeout.as_secs()
                );
                None
            }
        }
    });

    let mut descriptors = Vec::new();
    for listed in futures_util::future::join_all(per_server).await {
        let Some((server, tools)) = listed else {
            continue;
        };
        for tool in tools {
            if disabled_keys.contains(&format!("{server}::{}", tool.name)) {
                continue;
            }
            descriptors.push(McpToolDescriptor {
                agent_name: agent_tool_name(&server, &tool.name),
                server: server.clone(),
                tool: tool.name.to_string(),
                description: tool
                    .description
                    .as_ref()
                    .map(|description| description.to_string())
                    .unwrap_or_default(),
                input_schema: Value::Object((*tool.input_schema).clone()),
                read_only: is_read_only(&tool),
            });
        }
    }
    McpCatalog::from_tools(descriptors)
}

/// What the loop needs from MCP: name resolution and one call. A trait so
/// `runner_tests` can script it without any live server.
#[async_trait]
pub trait McpBridge: Send + Sync {
    fn resolve(&self, agent_name: &str) -> Option<&McpToolDescriptor>;
    fn descriptors(&self) -> &[McpToolDescriptor];
    async fn call(
        &self,
        descriptor: &McpToolDescriptor,
        args: &Value,
        cancellation: &CancellationToken,
    ) -> Result<CallToolResult, String>;
}

pub struct LiveMcpBridge {
    catalog: McpCatalog,
    servers: SharedMcpServers,
    call_timeout: Duration,
}

impl LiveMcpBridge {
    pub fn new(catalog: McpCatalog, servers: SharedMcpServers, call_timeout: Duration) -> Self {
        Self {
            catalog,
            servers,
            call_timeout,
        }
    }

    /// Tools dropped by the catalog cap, for the prompt's omission marker.
    pub fn omitted(&self) -> usize {
        self.catalog.omitted
    }
}

#[async_trait]
impl McpBridge for LiveMcpBridge {
    fn resolve(&self, agent_name: &str) -> Option<&McpToolDescriptor> {
        self.catalog.resolve(agent_name)
    }

    fn descriptors(&self) -> &[McpToolDescriptor] {
        self.catalog.descriptors()
    }

    async fn call(
        &self,
        descriptor: &McpToolDescriptor,
        args: &Value,
        cancellation: &CancellationToken,
    ) -> Result<CallToolResult, String> {
        // Lock only long enough to clone the peer (ATO-271): a slow call must
        // not block the app-wide server map.
        let peer = {
            let servers = self.servers.lock().await;
            servers
                .get(&descriptor.server)
                .map(crate::core::state::RunningServiceEnum::peer)
        };
        let Some(peer) = peer else {
            return Err(format!(
                "MCP server '{}' is not connected — it may have stopped; do not retry this tool",
                descriptor.server
            ));
        };
        let arguments = args.as_object().cloned();
        let call = peer.call_tool(CallToolRequestParam {
            name: descriptor.tool.clone().into(),
            arguments,
        });
        tokio::select! {
            _ = cancellation.cancelled() => Err("Tool call cancelled".into()),
            result = timeout(self.call_timeout, call) => match result {
                Ok(result) => result.map_err(|error| error.to_string()),
                Err(_) => Err(format!(
                    "MCP tool '{}' timed out after {} seconds",
                    descriptor.tool,
                    self.call_timeout.as_secs()
                )),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(server: &str, tool: &str) -> McpToolDescriptor {
        McpToolDescriptor {
            agent_name: agent_tool_name(server, tool),
            server: server.into(),
            tool: tool.into(),
            description: String::new(),
            input_schema: Value::Null,
            read_only: false,
        }
    }

    #[test]
    fn slugs_normalize_arbitrary_server_names() {
        assert_eq!(server_slug("Jan Browser MCP"), "jan-browser-mcp");
        assert_eq!(server_slug("exa"), "exa");
        assert_eq!(server_slug("  ~~~ "), "server");
        assert_eq!(server_slug("a__b--c"), "a__b-c");
    }

    #[test]
    fn agent_names_are_namespaced_and_bounded() {
        assert_eq!(
            agent_tool_name("Jan Browser MCP", "open_url"),
            "mcp.jan-browser-mcp.open_url"
        );
        let long = agent_tool_name("server", &"x".repeat(200));
        assert!(long.chars().count() <= MAX_AGENT_NAME_CHARS);
    }

    #[test]
    fn catalog_resolves_by_exact_name_and_dedupes_collisions() {
        let catalog = McpCatalog::from_tools(vec![descriptor("a.b", "c"), descriptor("a", "b.c")]);
        // Both slug to `mcp.a-b.c` / `mcp.a.b.c` style names; whatever the
        // collision outcome, resolution goes through the catalog only.
        let names = catalog.names();
        assert_eq!(names.len(), 2);
        for name in &names {
            let resolved = catalog.resolve(name).expect("resolvable");
            assert_eq!(
                agent_tool_name(&resolved.server, &resolved.tool).len() > 0,
                true
            );
        }
        assert!(catalog.resolve("mcp.unknown.tool").is_none());
    }

    #[test]
    fn catalog_caps_size_and_counts_omissions() {
        let tools = (0..MAX_MCP_TOOLS + 5)
            .map(|index| descriptor("srv", &format!("tool{index:03}")))
            .collect();
        let catalog = McpCatalog::from_tools(tools);
        assert_eq!(catalog.descriptors().len(), MAX_MCP_TOOLS);
        assert_eq!(catalog.omitted, 5);
    }
}
