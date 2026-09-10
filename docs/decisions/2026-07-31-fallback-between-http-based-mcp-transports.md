---
date: 2026-07-31
title: "Fallback between HTTP-based MCP transports"
---

# 2026-07-31 — Fallback between HTTP-based MCP transports

- **Context:** Remote MCP servers expose SSE, Streamable HTTP, or compatibility behavior for both. Atomic Chat previously tried only the transport selected in the UI, while other clients probe a second HTTP-based transport when the first handshake fails.
- **Decision:** Try the configured HTTP-based transport first, then try the other transport once. Bound each handshake with the configured timeout, log the transport that succeeds, and preserve both errors if neither succeeds. Explicit stdio configurations remain unchanged.
- **Consequences:** Servers whose advertised transport differs from the endpoint behavior can connect without manual reconfiguration. Unreachable servers incur one additional bounded handshake attempt.
- **Owner:** team
- **Links:** [ATO-384](https://linear.app/atomicchat/issue/ATO-384), [ATO-385](https://linear.app/atomicchat/issue/ATO-385), `src-tauri/src/core/mcp/helpers.rs`
