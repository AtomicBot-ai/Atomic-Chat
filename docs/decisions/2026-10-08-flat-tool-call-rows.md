---
date: 2026-10-08
title: "Show tool calls as directly visible rows"
---

# 2026-10-08 — Show tool calls as directly visible rows

- **Context:** ATO-529 asks for the actual tool name and fewer disclosure levels. The turn-level activity summary hid the call list and repeated the latest call above its own row.
- **Decision:** Render calls directly in execution order, each with its exact tool name, readable activity and one disclosure for parameters/output. Keep the generic Working status only before the first call; permission waits label pending calls as waiting. Terminal turns stop stale input spinners without claiming those calls succeeded.
- **Consequences:** Users can inspect any call with one click. Long names truncate within the row, with the complete label available to assistive technology and on hover. Long sequences take one row per call; outputs stay collapsed across streamed updates. The composer has no duplicate tool activity display on current main.
- **Owner:** @plombeer31.
- **Links:** ATO-529; `web-app/src/components/ai-elements/tools/activity-group.tsx`; `web-app/src/components/ai-elements/tools/tool-renderer.tsx`.
