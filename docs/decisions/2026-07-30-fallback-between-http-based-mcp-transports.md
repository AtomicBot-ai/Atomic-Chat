---
date: 2026-07-30
title: "Fallback between HTTP-based MCP transports"
---

# 2026-07-30 — Fallback between HTTP-based MCP transports

- **Context:** Remote MCP servers expose either SSE or Streamable HTTP (or both, or one with a legacy route). Users configure a transport type in the UI, but several popular servers (for example, WordPress AI Engine) only answer one of the two on a given route. The previous code tried only the configured transport, so a server configured as SSE but answering Streamable HTTP appeared "connected" with zero tools and no visible error.
- **Decision:** When a remote MCP server config has a URL, try the configured HTTP-based transport first, then fall back to the other one. A missing or invalid `type` with a URL defaults to Streamable HTTP first. Explicit `stdio` is unchanged. Log the transport that succeeded and include both errors when both fail.
- **Consequences:** Servers that advertise one transport but answer another now connect automatically. The trade-off is one extra connection attempt per server on startup; for truly dead servers, both attempts will fail and the combined error is surfaced. stdio servers are unaffected.
- **Owner:** team
- **Links:** [ATO-385](https://linear.app/atomicchat/issue/ATO-385), PR #211, `src-tauri/src/core/mcp/helpers.rs`
