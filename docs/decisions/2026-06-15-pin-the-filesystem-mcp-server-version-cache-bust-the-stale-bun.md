---
date: 2026-06-15
title: "Pin the filesystem MCP server version (cache-bust the stale `bun` copy) + add a `cwd` field for spawned stdio servers (ATO-164)"
---

# 2026-06-15 — Pin the filesystem MCP server version (cache-bust the stale `bun` copy) + add a `cwd` field for spawned stdio servers (ATO-164)

- **Context:** A Windows user set the filesystem MCP
  (`@modelcontextprotocol/server-filesystem`) with allowed dir
  `…\Documents\Atomic_chat`, but the model writing a **relative** path
  (`test_data/test.md`) failed with `Access denied - path outside allowed
  directories`, resolving against the **app** dir
  (`…\AppData\Local\Atomic Chat\…`) instead of the allowed dir; absolute paths
  worked ([ATO-164](https://linear.app/atomicchat/issue/ATO-164)). Root cause
  (code-reviewed): the user ran an **outdated** server. Old versions resolved
  relative paths against `process.cwd()` (upstream
  [servers#2526](https://github.com/modelcontextprotocol/servers/issues/2526),
  fixed in [servers#2609](https://github.com/modelcontextprotocol/servers/pull/2609));
  current npm `latest` is **`2026.1.14`** (the issue's "0.6.3" was stale info,
  verified via `npm view`), which resolves relative paths against the allowed
  dirs and succeeds. Why users got the old build is **our** side: (1) the
  default config template and the user's config invoke the server via
  `npx -y @modelcontextprotocol/server-filesystem` **with no pinned version**,
  and `start_mcp_server` rewrites `npx` → `bun x` with `BUN_INSTALL` pointing
  at our app cache (`<app>/.npx`) — a stale cached copy keeps being served;
  (2) spawned stdio MCP servers never set `current_dir`, so the child inherits
  the app CWD (`AppData\Local\Atomic Chat`), which is exactly where old-version
  relative resolution lands. The "different dir each retry" loop is model
  behaviour (small local model hallucinating paths), **not** the cwd/version
  bug, and is out of scope.
- **Decision (per chosen scope — primary fix + defense-in-depth #2; pin a
  concrete version):**
  1. **Pin a concrete version (primary).** New constants in
     [`constants.rs`](src-tauri/src/core/mcp/constants.rs):
     `FILESYSTEM_MCP_PACKAGE`, `FILESYSTEM_MCP_PINNED_VERSION = "2026.1.14"`,
     and `filesystem_mcp_pinned_spec()` (=
     `@modelcontextprotocol/server-filesystem@2026.1.14`). The default config
     template's filesystem arg now uses a `__JAN_FS_MCP_SPEC__` placeholder
     substituted from that single source of truth in `default_mcp_config()`
     (no literal/const drift). Pinning a **concrete** version is the
     cache-bust: `bun x <pkg>@2026.1.14` misses the cached old version and
     fetches the fixed build — `@latest` would not reliably do so. Trade-off:
     the version must be bumped manually when a newer fixed release is
     validated (deliberately chosen over `@latest`).
  2. **Migrate existing on-disk configs** ([`commands.rs :: get_mcp_configs`](src-tauri/src/core/mcp/commands.rs),
     mirroring the existing `LEGACY_FILESYSTEM_PLACEHOLDER` migration): scan
     **every** server's `args` (not just the one named `filesystem`, so
     custom-named entries are covered) and rewrite a **bare** unpinned
     `@modelcontextprotocol/server-filesystem` token → the pinned spec. Only
     the bare token is rewritten — an explicit user pin (`…@<ver>`) is left
     untouched — and the rewrite is idempotent (once pinned it equals the
     spec and never re-triggers).
  3. **`cwd` field for spawned stdio servers (defense-in-depth #2).** Added
     `cwd: Option<String>` to `McpServerConfig`
     ([`models.rs`](src-tauri/src/core/mcp/models.rs)), parsed in
     `extract_command_args` ([`helpers.rs`](src-tauri/src/core/mcp/helpers.rs),
     empty-string filtered), and applied via `cmd.current_dir(cwd)` in
     `start_mcp_server` before spawn (no-op when unset → inherits app CWD).
     The default template's `filesystem` entry now also carries
     `"cwd": "__JAN_DEFAULT_FS_DIR__"` (= the sandbox root) so relative paths
     land in the allowed dir even on an old server. TS parity:
     `cwd?: string` added to `MCPServerConfig`
     ([`useMCPServers.ts`](web-app/src/hooks/useMCPServers.ts)).
- **Consequences:** Fresh installs get the fixed, version-pinned server with a
  sandbox CWD; existing installs are auto-migrated to the pinned version on
  next config read (the concrete-version pin busts their stale `bun` cache),
  so relative-path writes resolve against the allowed dir. **Deliberately NOT
  done:** defense-in-depth #3 (advertising MCP **roots** / injecting allowed
  dirs into the system prompt — deferred per chosen scope); retrofitting `cwd`
  into *existing* on-disk filesystem entries (the version pin already fixes
  them; `cwd` default ships only for fresh installs and manual use); upgrading
  an explicitly user-pinned *old* version (left to the user). The retry-loop
  is a model-quality issue, untouched. Scope: 3 Rust files (mcp constants /
  commands / models / helpers) + 1 web-app type; no IPC, on-disk layout, or
  settings-schema-shape change beyond the additive optional `cwd` field.
  **Verified:** `cargo check -p Atomic-Chat` 0 errors (pre-existing
  unrelated `dead_code` warnings only); `tsc -b` clean; `eslint` clean on the
  touched TS file.
- **Owner:** team.
- **Links:** [ATO-164](https://linear.app/atomicchat/issue/ATO-164),
  [servers#2526](https://github.com/modelcontextprotocol/servers/issues/2526),
  [servers#2609](https://github.com/modelcontextprotocol/servers/pull/2609),
  files:
  [`src-tauri/src/core/mcp/constants.rs`](src-tauri/src/core/mcp/constants.rs)
  (`FILESYSTEM_MCP_*`, `filesystem_mcp_pinned_spec`, template placeholders),
  [`src-tauri/src/core/mcp/commands.rs`](src-tauri/src/core/mcp/commands.rs)
  (`get_mcp_configs` pin migration),
  [`src-tauri/src/core/mcp/models.rs`](src-tauri/src/core/mcp/models.rs)
  (`McpServerConfig.cwd`),
  [`src-tauri/src/core/mcp/helpers.rs`](src-tauri/src/core/mcp/helpers.rs)
  (`extract_command_args`, `start_mcp_server` `current_dir`),
  [`web-app/src/hooks/useMCPServers.ts`](web-app/src/hooks/useMCPServers.ts)
  (`MCPServerConfig.cwd`).
