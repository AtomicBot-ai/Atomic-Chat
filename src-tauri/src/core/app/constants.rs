// App Configuration Constants
pub const CONFIGURATION_FILE_NAME: &str = "settings.json";

pub const JAN_DATA_SUBDIRS: &[&str] = &[
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

/// Files at the data folder's top level that a factory reset removes: the MCP configuration, the
/// ChatGPT subscription's tokens, and the Local API server's last address for the CLI.
pub const JAN_DATA_FILES: &[&str] = &[
    "mcp_config.json",
    "atomic-chatgpt-auth.json",
    "local-api-server.json",
];

/// Providers whose downloaded backends a factory reset keeps, so that hundreds of megabytes of
/// CUDA or Vulkan builds are not fetched again. `llamacpp-upstream` is the default provider; when
/// only `llamacpp` was kept, a reset threw the default provider's backend away and the next
/// launch downloaded it anew.
pub const BACKEND_PRESERVING_PROVIDERS: &[&str] = &["llamacpp", "llamacpp-upstream"];
