---
date: 2026-07-31
title: "Surface MCP server runtime errors"
---

# 2026-07-31 — Surface MCP server runtime errors

- **Context:** A connected MCP server and a server whose tool listing failed both appeared as a green server with zero tools. Stdio initialization also replaced the protocol error with arbitrary child stderr, and duplicate frontend hooks could list tools concurrently.
- **Decision:** Keep per-server runtime errors in backend state, return structured tools plus server statuses from tool discovery, and expose statuses through a separate query for the settings UI. Preserve protocol errors, attach bounded stderr as context, and share one frontend discovery request and event listener.
- **Consequences:** Settings can distinguish a healthy empty server from a failed server and show the actual cause. The internal `get_tools` IPC response changes from an array to an object, while the frontend MCP service preserves its existing `getTools(): MCPTool[]` contract.
- **Owner:** team
- **Links:** [ATO-385](https://linear.app/atomicchat/issue/ATO-385), `src-tauri/src/core/mcp/commands.rs`, `web-app/src/hooks/useTools.ts`
