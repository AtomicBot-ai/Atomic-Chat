use std::path::PathBuf;

// Default MCP runtime settings
pub const DEFAULT_MCP_TOOL_CALL_TIMEOUT_SECS: u64 = 30;
pub const DEFAULT_MCP_HANDSHAKE_TIMEOUT_SECS: u64 = 30;

/// Short, dedicated ceiling for *listing* tools (`get_tools`), distinct from the
/// 30s tool-*call* timeout. Listing is a metadata round-trip that a healthy
/// server answers in milliseconds, so a stuck/unreachable server (e.g. a dead
/// remote MCP) should be given up on quickly instead of stalling every consumer
/// that needs the tool list — chat send, model switch re-init, the tools UI.
/// Applied per-server while all servers are listed concurrently, so total
/// `get_tools` latency is bounded by this value rather than N × 30s (ATO-271).
pub const DEFAULT_MCP_TOOL_LIST_TIMEOUT_SECS: u64 = 5;

/// Sentinel inside `DEFAULT_MCP_CONFIG_TEMPLATE` that is replaced at runtime
/// with the per-user sandbox directory exposed to the filesystem MCP server.
const FILESYSTEM_DIR_PLACEHOLDER: &str = "__JAN_DEFAULT_FS_DIR__";

/// Sentinel inside `DEFAULT_MCP_CONFIG_TEMPLATE` replaced at runtime with the
/// version-pinned filesystem MCP package spec (single source of truth =
/// `FILESYSTEM_MCP_PINNED_VERSION`).
const FILESYSTEM_SPEC_PLACEHOLDER: &str = "__JAN_FS_MCP_SPEC__";

/// Literal placeholder path shipped in older versions of Atomic Chat. Existing
/// `mcp_config.json` files on disk may still contain this value; the runtime
/// migrates it to a real per-user sandbox path on next config read.
pub const LEGACY_FILESYSTEM_PLACEHOLDER: &str = "/path/to/other/allowed/dir";

/// npm package name of the filesystem MCP server. Used both in the default
/// config template and by the on-disk config migration that pins it.
pub const FILESYSTEM_MCP_PACKAGE: &str = "@modelcontextprotocol/server-filesystem";

/// Pinned version of the filesystem MCP server (ATO-164). Unversioned installs
/// resolved relative paths against `process.cwd()` (the app dir), so relative
/// writes failed with "outside allowed directories" — upstream bug
/// servers#2526, fixed in servers#2609. Pinning a *concrete* version also
/// busts the stale `bun`/`BUN_INSTALL` cache: `bun x <pkg>@<ver>` misses the
/// cached old version and fetches the fixed build. Bump this when a newer
/// fixed release is validated.
///
/// The original pin, `2026.1.14`, did NOT carry that fix — it was published
/// 2026-01-14, four weeks before servers#2609 merged (2026-02-11). Verified
/// against the published tarballs: `dist/lib.js` in 2026.1.14 resolves a
/// relative request as `path.resolve(process.cwd(), expandedPath)`, while
/// 2026.8.31 routes it through `resolveRelativePathAgainstAllowedDirectories`,
/// which walks the allowed dirs. So every user was pinned to the broken
/// build, and the `cwd` field below was the only thing masking it — on fresh
/// installs only, since the migration never retrofits `cwd`. Re-verify the
/// same way before bumping again; publish dates alone do not prove the fix
/// is in.
pub const FILESYSTEM_MCP_PINNED_VERSION: &str = "2026.8.31";

/// Versions of the filesystem MCP server that a previous build of Atomic Chat
/// wrote into the user's `mcp_config.json` itself. The pin migration re-pins
/// only these to `FILESYSTEM_MCP_PINNED_VERSION`; a version the *user* chose
/// is left alone.
///
/// Without this the migration is a one-shot: it matches the bare package
/// token, so once an arg reads `...@2026.1.14` it never matches again and no
/// future release can correct the pin it shipped. Every entry here is a spec
/// this app authored, never a user's choice.
pub const APP_WRITTEN_FILESYSTEM_MCP_VERSIONS: &[&str] = &["2026.1.14"];

/// Fully-qualified, version-pinned spec written into args, e.g.
/// `@modelcontextprotocol/server-filesystem@2026.1.14`.
pub fn filesystem_mcp_pinned_spec() -> String {
    format!("{FILESYSTEM_MCP_PACKAGE}@{FILESYSTEM_MCP_PINNED_VERSION}")
}

/// Schema version `migrate_mcp_servers` stores in `mcp_version` once every
/// step has run. Each step is gated on its own literal (`mcp_version < N`);
/// bump this together with the newest gate.
pub const MCP_CONFIG_VERSION: i64 = 4;

/// Key of the web-search server `DEFAULT_MCP_CONFIG_TEMPLATE` seeded from its
/// introduction (`e1c8d98bf`, 2025-08-15) until `0ae50bca7` (2026-09-17)
/// dropped it: switched off behind a placeholder key, next to an always-on Exa
/// doing the same job.
pub const RETIRED_SERPER_SERVER_KEY: &str = "serper";

/// The exact entry that template wrote for `serper` — the only shape it ever
/// had. Migration 4 removes a `serper` entry from an existing
/// `mcp_config.json` only when it equals this value (key order aside); an
/// entry the user changed — switched on, a real key, other args, an added
/// field — is theirs and stays.
pub fn retired_serper_default_server() -> serde_json::Value {
    serde_json::json!({
        "command": "npx",
        "args": ["-y", "serper-search-scrape-mcp-server"],
        "env": { "SERPER_API_KEY": "YOUR_SERPER_API_KEY_HERE" },
        "active": false
    })
}

const DEFAULT_MCP_CONFIG_TEMPLATE: &str = r#"{
  "mcpServers": {
    "Jan Browser MCP": {
      "command": "npx",
      "args": ["-y", "search-mcp-server@latest"],
      "env": {
        "BRIDGE_HOST": "127.0.0.1",
        "BRIDGE_PORT": "17389"
      },
      "active": false,
      "official": true
    },
    "exa": {
      "type": "http",
      "url": "https://mcp.exa.ai/mcp",
      "command": "",
      "args": [],
      "env": {},
      "active": true
    },
    "browsermcp": {
      "command": "npx",
      "args": ["@browsermcp/mcp"],
      "env": {},
      "active": false
    },
    "fetch": {
      "command": "uvx",
      "args": ["mcp-server-fetch"],
      "env": {},
      "active": false
    },
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "__JAN_FS_MCP_SPEC__",
        "__JAN_DEFAULT_FS_DIR__"
      ],
      "env": {},
      "cwd": "__JAN_DEFAULT_FS_DIR__",
      "active": false
    },
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      "env": {},
      "active": false
    }
  },
  "mcpSettings": {
    "toolCallTimeoutSeconds": 30
  }
}"#;

/// Default sandbox directory exposed to the `filesystem` MCP server.
/// Resolves to `~/Documents/Atomic_chat` (or the platform equivalent).
///
/// Always absolute: this path is persisted as the server's `cwd`, and a
/// relative `./Atomic_chat` would be resolved against whatever the app was
/// launched from and fail the spawn with "directory name is invalid" (#259).
pub fn default_filesystem_root() -> PathBuf {
    let docs = dirs::document_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Documents")))
        .or_else(dirs::data_dir)
        .unwrap_or_else(std::env::temp_dir);
    docs.join("Atomic_chat")
}

/// Materialised default `mcp_config.json` content with a real, per-user
/// filesystem sandbox path substituted for the template placeholder.
/// Best-effort creates the sandbox directory on disk; failure to create it
/// is logged but non-fatal — the user can still edit the path manually.
pub fn default_mcp_config() -> String {
    let root = default_filesystem_root();
    if let Err(e) = std::fs::create_dir_all(&root) {
        log::warn!(
            "Failed to pre-create default MCP filesystem sandbox at {}: {e}",
            root.display()
        );
    }
    // `serde_json::to_string` produces a JSON-escaped, double-quoted literal,
    // which is safe to embed wherever a JSON string is expected.
    let path_literal = serde_json::to_string(&root.to_string_lossy().to_string())
        .unwrap_or_else(|_| "\".\"".to_string());
    DEFAULT_MCP_CONFIG_TEMPLATE
        .replace(&format!("\"{FILESYSTEM_DIR_PLACEHOLDER}\""), &path_literal)
        .replace(FILESYSTEM_SPEC_PLACEHOLDER, &filesystem_mcp_pinned_spec())
}
