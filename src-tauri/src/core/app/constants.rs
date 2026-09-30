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
];

pub const JAN_DATA_FILES: &[&str] = &[
    "agent-approval-allowlist.json",
    "atomic-chatgpt-auth.json",
    "atomic-mcp-oauth.json",
    "local-api-server.json",
    "mcp_config.json",
    "store.json",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn factory_reset_owns_assistants_connections_and_agent_state() {
        for dir in [
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
