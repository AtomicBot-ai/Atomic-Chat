---
date: 2026-07-24
title: "Use hosted Exa as the Agent's primary web backend"
---

# 2026-07-24 — Use hosted Exa as the Agent's primary web backend

- **Context:** The Rust Agent's web tools depended on DuckDuckGo HTML search
  and direct page downloads, which provide limited extraction quality and are
  frequently rejected by public sites.
- **Decision:** Call the keyless hosted Exa MCP endpoint first for
  `os.web.search` and `os.web.fetch`, with bounded request time, response size,
  result count, and extracted content. Preserve DuckDuckGo search and the
  SSRF-guarded direct HTTP extractor as automatic fail-open fallbacks for
  transport, HTTP, MCP, parsing, and empty-result failures. Record only a
  stable failure category in tool details; add no API key, setting, or
  dependency.
- **Consequences:** Agent web operations normally receive Exa's structured
  results and extracted page content without user configuration. Exa outages
  do not remove the existing keyless local paths, and internal MCP payloads
  are not exposed to the model. Availability still depends on the hosted Exa
  endpoint and its unauthenticated service policy.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/tools/web_exa.rs`](src-tauri/src/core/agent/tools/web_exa.rs),
  [`src-tauri/src/core/agent/tools/web.rs`](src-tauri/src/core/agent/tools/web.rs),
  [`src-tauri/src/core/agent/prompt.rs`](src-tauri/src/core/agent/prompt.rs).
