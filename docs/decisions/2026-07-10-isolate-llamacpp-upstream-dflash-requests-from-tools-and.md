---
date: 2026-07-10
title: "Isolate `llamacpp-upstream` DFlash requests from tools and preserve model settings on restart"
---

# 2026-07-10 — Isolate `llamacpp-upstream` DFlash requests from tools and preserve model settings on restart

- **Context:** A user log showed that DFlash itself loaded successfully
  (`draft-dflash` registered and non-zero acceptance), but the next request
  included an MCP Exa tool result. The same log showed the settings-page
  DFlash restart changing the model from its persisted GPU/context settings
  (`-ngl -1`, 16K context) to raw engine defaults (`-ngl 0`, auto 262K
  context), because the UI called `engine.load(modelId)` without the model's
  stored settings.
- **Decision:** At the final `streamText` tool gate, suppress both RAG and MCP
  tool definitions when the selected provider is `llamacpp-upstream` and its
  `dflash` provider setting is enabled. Keep MCP connections and configuration
  intact; only the affected request receives no `tools` or `toolChoice`.
  During a settings-page DFlash toggle, await the provider-setting write before
  restarting, then restart through `serviceHub.models().startModel(...)`
  instead of the raw engine load so persisted model-level settings are applied.
- **Consequences:** Upstream DFlash sessions no longer receive tool calls or
  large tool-result follow-ups, while non-DFlash and other-provider sessions
  retain existing tool behavior. DFlash restarts preserve context, GPU layer,
  batch, and other per-model settings. This is request-level isolation, not a
  global MCP disable.
- **Owner:** team.
- **Links:** [`web-app/src/lib/custom-chat-transport.ts`](web-app/src/lib/custom-chat-transport.ts),
  [`web-app/src/routes/settings/providers/$providerName.tsx`](web-app/src/routes/settings/providers/$providerName.tsx),
  [`web-app/src/lib/__tests__/dflashToolIsolation.test.ts`](web-app/src/lib/__tests__/dflashToolIsolation.test.ts).
