---
date: 2026-10-09
title: "A send waits for web search that is still connecting"
---

# 2026-10-09 — A send waits for web search that is still connecting

- **Context:** Turning on the composer's globe starts the `exa` MCP server; until the handshake ends,
  the tools are fetched and the server is marked active and unmuted, the chat transport filters its
  tools out and Agent mode sends `web_search: false`. In the RC 2.2.1 retest a message sent while the
  globe said "Connecting" went out with no tools (a 160-token prompt) and the model replied that it
  had no web access; the retry a few seconds later searched. Nothing waited and nothing warned.
- **Decision:** `web-app/src/lib/mcp-activation.ts` keeps a module-level map of activations in flight
  (outside React, because the home page's toggle unmounts when the new thread opens). The globe
  registers its whole enable sequence — activate, refresh tools, `active: true`, unmute — under the
  server key. Before collecting tools, `CustomChatTransport.sendMessages` (send, regenerate, the
  home page's first message) and `processAndRunAgent` wait for those activations, at most 12 s (under
  the 30 s MCP handshake timeout); Stop ends the chat wait. A failed activation is already reported by
  the globe, so the send just proceeds; on the timeout the send goes out without web search and a
  warning toast says so.
- **Consequences:** A message sent right after switching search on gets the search tools, at the
  cost of up to 12 s before the request starts (the user's bubble is already shown). Connector
  switches in the Plugins menu are not tracked: their tools reach the store later via `MCP_UPDATE`,
  so waiting on the activation alone would not help; they keep their own progress toast.
- **Owner:** `team`.
- **Links:** `web-app/src/lib/mcp-activation.ts`, `web-app/src/containers/WebSearchToggle.tsx`,
  `web-app/src/lib/custom-chat-transport.ts`, `web-app/src/routes/threads/$threadId.tsx`.
