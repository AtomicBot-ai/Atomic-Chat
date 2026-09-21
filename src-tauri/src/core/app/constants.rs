// App Configuration Constants
pub const CONFIGURATION_FILE_NAME: &str = "settings.json";

pub const JAN_DATA_SUBDIRS: &[&str] = &[
    "agent-skills",
    "agent-workspace",
    "assistants",
    "diffusion",
    "images",
    "threads",
    "extensions",
    "logs",
    "llamacpp",
    "llamacpp-upstream",
    "mlx",
    "openclaw",
    "models",
    "db",
    ".npx",
    ".uvx",
    // The inference core's own folder: its copy of every provider's settings and, in
    // `credentials.json`, the cloud providers' API keys. A reset that clears the webview's
    // providers but leaves their keys on disk has not reset them.
    "atomic-core",
];

/// Files at the data folder's top level that a factory reset removes: the MCP configuration and
/// OAuth tokens, the agent's approval allowlist, the ChatGPT subscription's tokens, the Local API
/// server's last address for the CLI, and `store.json`, where the app records its migrations.
pub const JAN_DATA_FILES: &[&str] = &[
    "agent-approval-allowlist.json",
    "atomic-chatgpt-auth.json",
    "atomic-mcp-oauth.json",
    "local-api-server.json",
    "mcp_config.json",
    "store.json",
];

/// Providers whose downloaded backends a factory reset keeps, so that hundreds of megabytes of
/// CUDA or Vulkan builds are not fetched again. `llamacpp-upstream` is the default provider; when
/// only `llamacpp` was kept, a reset threw the default provider's backend away and the next
/// launch downloaded it anew.
pub const BACKEND_PRESERVING_PROVIDERS: &[&str] = &["llamacpp", "llamacpp-upstream"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn factory_reset_owns_assistants_connections_agent_and_core_state() {
        for dir in [
            "atomic-core",
            "assistants",
            "agent-skills",
            "agent-workspace",
            "diffusion",
            "images",
        ] {
            assert!(
                JAN_DATA_SUBDIRS.contains(&dir),
                "missing reset directory: {dir}"
            );
        }
        for file in [
            "atomic-chatgpt-auth.json",
            "atomic-mcp-oauth.json",
            "mcp_config.json",
            "agent-approval-allowlist.json",
        ] {
            assert!(JAN_DATA_FILES.contains(&file), "missing reset file: {file}");
        }
    }
}
