---
date: 2026-09-14
title: "Re-pin filesystem MCP specs the app wrote itself"
---

# 2026-09-14 — Re-pin filesystem MCP specs the app wrote itself

- **Context:** ATO-164 pinned `@modelcontextprotocol/server-filesystem` to
  `2026.1.14` to escape upstream servers#2526, where a relative path was
  resolved against `process.cwd()` instead of the allowed directories. That
  version does not contain the fix: it was published 2026-01-14, four weeks
  before servers#2609 merged (2026-02-11). Verified against the published
  tarballs — `dist/lib.js` in 2026.1.14 still does
  `path.resolve(process.cwd(), expandedPath)`, while 2026.8.31 routes the same
  request through `resolveRelativePathAgainstAllowedDirectories`. Worse, the
  migration matched only the *bare* package token, so once a config read
  `...@2026.1.14` it never matched again: the bad pin was unreachable by any
  future release, and only the `cwd` field (fresh installs only) masked it.
- **Decision:** bump the pin to `2026.8.31`, and add
  `APP_WRITTEN_FILESYSTEM_MCP_VERSIONS` — the set of specs the app itself has
  written into a user's `mcp_config.json`. The migration
  (`repin_filesystem_mcp_servers`) rewrites the bare token *and* any spec in
  that set, and nothing else. A version the user pinned by hand stays theirs.
- **Consequences:** a wrong pin is now correctable on upgrade instead of being
  frozen on disk forever. Every future bump must add the outgoing version to
  the set, or it will only reach fresh installs. Re-verify a candidate version
  by reading its published `dist/lib.js`, not by its publish date. The rewrite
  is a deliberate cache miss, so the first launch after it needs the registry.
- **Owner:** `team`
- **Links:** `src-tauri/src/core/mcp/constants.rs`,
  `src-tauri/src/core/mcp/commands.rs`, `src-tauri/src/core/mcp/tests.rs`,
  supersedes [2026-06-15](2026-06-15-pin-the-filesystem-mcp-server-version-cache-bust-the-stale-bun.md).
