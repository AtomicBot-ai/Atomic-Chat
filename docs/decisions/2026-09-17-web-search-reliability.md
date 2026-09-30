---
date: 2026-09-17
title: "Show web search availability from discovered tools"
---

# 2026-09-17 — Show web search availability from discovered tools

- **Context:** The default Exa MCP handshake returned HTTP 403 in the reported running build, leaving zero connected servers. Startup records a runtime error but retains the saved activation preference. The composer treated that preference as availability, while ordinary chat received no search tool. Exa's current official documentation still advertises the same hosted endpoint without a key; the observed failure does not establish that the endpoint or authentication contract changed.
- **Decision:** Keep the existing Exa default and connector catalog policy. Light the globe only when its active server has a discovered search tool enabled for the current chat. Otherwise show an off state with a retry/configuration explanation. Validate discovery after activation. Clear both server and tool mutes when explicitly enabling search. Apply the same availability predicate to the agent request flag, and exclude disabled search servers from ordinary chat immediately, including cached transports.
- **Consequences:** A failed or fetch-only backend cannot promise search, and normal chat does not require agent mode to send an available search tool. No keys, dependencies, endpoints, or new query recipients are introduced. Agent mode already implements native Exa search with DuckDuckGo fallback (and opt-in Serper environment keys); this change conservatively gates that existing path on the composer's discovered search availability rather than advertising an unverified fallback after MCP startup fails. Discovery establishes tool availability, not a guarantee that a later provider call will succeed. Missing search configurations retain the existing hidden globe behavior.
- **Owner:** team.
- **Links:** [Exa MCP documentation](https://exa.ai/docs/reference/exa-mcp), [Exa no-key setup](https://exa.ai/mcp), `web-app/src/containers/WebSearchToggle.tsx`, `web-app/src/lib/web-search.ts`, `web-app/src/lib/custom-chat-transport.ts`, `src-tauri/src/core/mcp/helpers.rs`, `src-tauri/src/core/agent/tools/web.rs`.
