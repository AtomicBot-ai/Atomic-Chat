---
date: 2026-07-17
title: "Collapse Agent, tool, and MCP traces into one compact activity block"
---

# 2026-07-17 — Collapse Agent, tool, and MCP traces into one compact activity block

- **Context:** Chat tool/MCP calls and direct Agent runs rendered reasoning,
  tool cards, and Agent status as separate heavy surfaces. Active work also
  lacked one consistent label, and completed history did not retain the full
  wall-clock duration of the response.
- **Decision:** Project reasoning plus all tool/MCP calls into one expandable
  activity block. Render `Working` while the response is active, then
  `Worked for N s`, with nested `Called N tool(s)` and `Reasoned` details.
  Persist the Chat request duration in message metadata and the Agent duration
  in `metadata.agent_run.duration_ms`. Remove the standalone Agent status card.
  Keep Chat activity live across intermediate AI SDK finishes while tool calls
  remain pending, and hide completion actions and token metrics until the
  whole request chain ends.
  Keep existing specialized tool renderers inside the compact expansion.
  Preserve all packed Exa search results in a bounded scroll area and render
  multiline or long tool parameters as tail-following syntax-highlighted
  blocks, retaining the authored commits from PRs #172 and #189.
  Remove only the amber warning icon and styling from the approval dialog.
- **Consequences:** Agent and ordinary Chat traces now share one minimal,
  durable presentation while retaining tool parameters, results, errors,
  reasoning, and approval behavior. Duration is client wall-clock time and is
  rounded up to seconds for display; existing histories without duration
  metadata display the one-second floor. Tool-step boundaries no longer make
  an active request appear completed.
- **Owner:** team.
- **Links:** [`web-app/src/components/ai-elements/agent-activity.tsx`](web-app/src/components/ai-elements/agent-activity.tsx),
  [`web-app/src/lib/tools/message-trace-parts.ts`](web-app/src/lib/tools/message-trace-parts.ts),
  [`web-app/src/lib/tools/presenters/web-search-exa.ts`](web-app/src/lib/tools/presenters/web-search-exa.ts),
  [`web-app/src/lib/toolParamPreview.ts`](web-app/src/lib/toolParamPreview.ts),
  [`web-app/src/lib/agent-run-message.ts`](web-app/src/lib/agent-run-message.ts),
  [`web-app/src/containers/MessageItem.tsx`](web-app/src/containers/MessageItem.tsx),
  [`web-app/src/containers/dialogs/AgentApprovalDialog.tsx`](web-app/src/containers/dialogs/AgentApprovalDialog.tsx),
  [PR #172](https://github.com/AtomicBot-ai/Atomic-Chat/pull/172),
  [PR #189](https://github.com/AtomicBot-ai/Atomic-Chat/pull/189).

---
