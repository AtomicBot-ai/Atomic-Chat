---
date: 2026-09-02
title: "Measure and surface MCP tool cost in chat; never trim or hide schemas"
---

# 2026-09-02 — Measure and surface MCP tool cost in chat; never trim or hide schemas

- **Context:** A production log showed a one-word chat message ("yo") sent as a
  19,908-token request to a 4B model with a 16,384 context: every tool of every
  active MCP server (Linear alone ≈ 70 tools) rode the request as full JSON
  schemas, llama-server rejected it, the frontend reloaded the model at a bigger
  window and regenerated, and a concurrent double-load of the same model in both
  llama.cpp providers killed the answer. The chat transport had no notion of
  what its tool block cost. The agent engine already caps and compacts its MCP
  catalogue (`src-tauri/src/core/agent/mcp_tools.rs`); chat had nothing.
  A survey of Unsloth Studio, Cherry Studio, LM Studio, Open WebUI, Continue,
  AnythingLLM, Cline/Roo, Cursor, Claude Code and OpenAI showed that no mature
  client trims tool schemas (it breaks callability); they either let the user
  scope connectors per chat, defer definitions behind a search/activate
  meta-tool once they exceed ~10% of the window, or count tokens exactly before
  sending (`/apply-template` with `tools` + `/tokenize`).
- **Decision:** Chat mode keeps sending every enabled connector's tools verbatim
  (agent mode is untouched). What changes:
  1. the transport counts the rendered prompt — tool schemas included — before
     `streamText` (exact via llama-server `/apply-template` + `/tokenize`,
     heuristic `max(chars/3.6, words×1.4)` otherwise) and grows the context
     window once, up front, when it would not fit (`lib/context-size.ts`,
     `lib/prompt-size.ts`); context-overflow errors are non-retryable;
  2. the per-connector cost (`lib/tool-cost.ts`) is shown in the plugins menu,
     a connector over 10% of the window is flagged heavy, and the composer hints
     when the total passes 25%;
  3. a connector can be switched off for one chat (`mutedServers` in
     `useToolAvailable`) without stopping the server.
  A connector that is too big for a small local model is treated as the user's
  choice: the app measures and helps, it does not silently drop or compact.
- **Consequences:** Cold prefill of a heavy connector is still paid when the
  user keeps it on, but no longer as a failure/reload/regenerate cycle, and the
  cost is visible where it can be acted on. Pre-flight adds two local HTTP
  round-trips (3 s cap, heuristic fallback) on llama.cpp. Deferred tool loading
  behind a `load_tools` meta-tool (Cherry/Claude Code pattern) and a
  relevance ranker remain follow-ups if the hint proves insufficient.
- **Owner:** @mishaskvortsov
- **Links:** `web-app/src/lib/custom-chat-transport.ts` (`ensureContextFits`,
  `refreshTools`), `web-app/src/lib/model-factory.ts`
  (`countLocalPromptTokens`), `web-app/src/containers/DropdownPlugins.tsx`,
  `web-app/src/hooks/useToolAvailable.ts`; companion race fixes in
  `web-app/src/utils/switchModel.ts`, `containers/ChatInput.tsx`,
  `providers/DataProvider.tsx`.
