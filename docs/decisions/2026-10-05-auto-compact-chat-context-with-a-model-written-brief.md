---
date: 2026-10-05
title: "Auto-compact chat context with a model-written brief"
---

# 2026-10-05 — Auto-compact chat context with a model-written brief

- **Context:** The context-growth ladder (`auto_increase_ctx_len`, see
  `web-app/src/lib/context-size.ts`) reloads a local model at a bigger
  `ctx_len` when a prompt no longer fits. It stops at the training-max
  context, at the device-memory cap (`fit`), or when the user disabled it —
  and then the request fails with an out-of-context error. On small-VRAM
  machines the ladder is unusable (a bigger window means a bigger KV cache),
  so a lengthy chat dead-ends. Coding agents (Claude Code, Codex, OpenCode)
  solve the same problem by summarizing the older conversation into a brief
  and continuing on top of it. Implements what AtomicBot-ai/Atomic-Chat#294
  asks for.
- **Decision:** Compact at request-assembly time inside the chat transport
  pre-flight (`ensureContextFits`), local providers only. Order: the growth
  ladder runs first because it keeps full fidelity; compaction fires when the
  ladder is at max, capped by `fit`, or disabled (compaction then runs
  pre-flight even with growth off). The boundary keeps the newest ~25% of the
  window verbatim and never separates a tool result from its call; everything
  older is replaced by a user-role message carrying a structured 7-section
  brief written by the same model (one `generateText` call, tools off, ~1200
  token output cap). Thread history in the database is never rewritten —
  compaction only shapes the outgoing request, so editing, regenerating and
  deleting old messages keep working. A marker (store + thread divider with
  an archive icon) records where compaction happened and shows the summary
  on click. Toggle: per-model `auto_compaction`, default on, rendered next to
  the context controls.
- **Consequences:** Long chats continue where they previously hard-stopped,
  including growth-disabled small-VRAM setups (the #294 case). The
  summarizer costs one extra local-model call at the moment of compaction,
  and detail older than the brief is irrecoverably condensed in subsequent
  requests — visible via the marker. Cloud providers are out of scope: no
  reliable window metadata exists in the provider store today, and their
  windows are large; adding a per-model window map is the natural follow-up.
  Telemetry fields (`ctx_compacted`) are a follow-up too; for now the
  transport logs to the console and the marker store is the surface.
- **Owner:** @adelzaripov
- **Links:** AtomicBot-ai/Atomic-Chat#334, AtomicBot-ai/Atomic-Chat#294,
  `web-app/src/lib/context-compaction.ts`,
  `web-app/src/lib/custom-chat-transport.ts`,
  `web-app/src/stores/compaction-marker-store.ts`
