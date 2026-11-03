---
date: 2026-10-21
title: 'Say on the card why an MCP server did not start'
---

# 2026-10-21 — Say on the card why an MCP server did not start

- **Context:** Switching on an MCP server with an unreachable host left the
  switch off and the card "Inactive" with nothing else: the Connectors page
  sent the failure to `useAppState.setErrorMessage`, which no component
  renders, and the card showed an error only for a server marked active.
- **Decision:** The page records each activation in an in-memory store
  (`stores/mcp-activation-store.ts`): connecting while `activateMCPServer`
  runs, then the reason it failed. The card's status reads "Connecting…",
  then "Couldn't connect"; the description slot shows the reason with Retry
  (activate again) and Edit (the server's dialog), and a toast carries the
  same reason. Switching the server off, a successful start or deleting it
  clears the record. A runtime error of a server that is running keeps its
  existing status pill.
- **Consequences:** A failed card is taller than its description while the
  reason shows; `auto-rows-fr` keeps the row even. The record is lost on
  restart, when the server is simply inactive again.
- **Owner:** team
- **Links:** `web-app/src/routes/connectors/index.tsx`,
  `web-app/src/containers/connectors/ConnectorCard.tsx`,
  `web-app/src/stores/mcp-activation-store.ts`.
