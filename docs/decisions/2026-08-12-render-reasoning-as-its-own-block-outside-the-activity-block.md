---
date: 2026-08-12
title: "Render reasoning as its own block outside the activity block"
---

# 2026-08-12 — Render reasoning as its own block outside the activity block

- **Context:** Since the compact activity projection landed, reasoning was a
  nested `Reasoned` detail inside the `Working` / `Worked for N s` collapsible,
  two clicks deep and indistinguishable from tool traces. With reasoning
  enabled it was not obvious that the model was thinking, or where the thinking
  ended and tool work began.
- **Decision:** Project reasoning parts into a dedicated `reasoning` trace
  block rendered directly above the activity block, using the existing
  `Reasoning` / `ReasoningTrigger` / `ReasoningContent` elements: `Thinking...`
  while the stream is live, `Thought for N s` afterwards, auto-expanded during
  thinking and auto-collapsed when it ends. The activity block keeps only tool
  calls, agent loops and errors, and still renders `Worked for N s` without an
  expander when no tool ran.
- **Consequences:** Supersedes the reasoning half of the 2026-07-17 compact
  activity decision; everything else in that record stands. Reasoning
  liveness is derived per message — an explicit `state: 'streaming' | 'done'`
  on the AI SDK part when present, otherwise "no answer text emitted yet",
  which is what Agent runs produce since they synthesize reasoning parts
  without state. Thinking duration is measured client-side while the component
  is mounted and is not persisted, so restored history falls back to the
  `Reasoned` label.
- **Owner:** team.
- **Links:** [`web-app/src/lib/tools/message-trace-parts.ts`](web-app/src/lib/tools/message-trace-parts.ts),
  [`web-app/src/lib/tools/types.ts`](web-app/src/lib/tools/types.ts),
  [`web-app/src/containers/MessageItem.tsx`](web-app/src/containers/MessageItem.tsx),
  [`web-app/src/components/ai-elements/reasoning.tsx`](web-app/src/components/ai-elements/reasoning.tsx).

<!--
Supersedes: 2026-07-17-collapse-agent-tool-and-mcp-traces-into-one-compact-activity.md
-->
