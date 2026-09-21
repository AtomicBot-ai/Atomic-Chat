---
date: 2026-09-17
title: "Fall back to keyless search when hosted Exa is unavailable"
---

# 2026-09-17 — Fall back to keyless search when hosted Exa is unavailable

- **Context:** The bundled, keyless Exa MCP endpoint can reject its initial stream with HTTP 403. That removed the advertised web-search tool and exposed the transport stack in a toast, even though Atomic Chat already has a bounded keyless HTML-search implementation.
- **Decision:** Treat only the untouched bundled Exa configuration as an app-owned search route. Keep its existing `web_search_exa` tool identity, try Exa first, and fall back per query to the existing keyless search implementation; customized Exa URLs, headers, authentication, commands, and disabled configurations keep their current behavior.
- **Consequences:** Web search remains usable during a hosted Exa outage and users see a short actionable error only when both routes fail. The fallback inherits the result quality and rate limits of the keyless provider, while custom provider semantics remain unchanged.
- **Owner:** team
- **Links:** `src-tauri/src/core/mcp/web_search.rs`, `src-tauri/src/core/agent/tools/web.rs`, `web-app/src/containers/WebSearchToggle.tsx`
