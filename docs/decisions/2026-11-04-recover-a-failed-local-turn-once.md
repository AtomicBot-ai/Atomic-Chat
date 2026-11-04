---
date: 2026-11-04
title: 'Recover a failed local turn once, and grow the fitted context on GPU builds'
---

# 2026-11-04 — Recover a failed local turn once, and grow the fitted context on GPU builds

- **Context:** In the 2026-11-03 churn handoff, 73% of people whose last chat
  error had no later reply churned, against 51% of those who recovered; the
  last errors were mostly context overflow and a dropped local engine. Retry
  existed but dialled a stale session straight away, threw away finished tool
  steps and ran them again. With "fit to device memory" on (the default) an
  overflow never grew the context: overflow reached 30–39% of users on
  CUDA/Vulkan builds against 6–12% on CPU builds, because the fitted window is
  VRAM-bound with a 4096-token floor.
- **Decision:** A local turn that fails because the engine is gone
  (`engine_unreachable` / `engine_exited`, or Windows 10061/10054/10053) is
  retried automatically once per turn: wait for the engine (`/health` on
  127.0.0.1, start the model when there is no session, restart a stale one once,
  120 s limit), then continue. When tool calls had already finished, the failed
  assistant message is cut back to its last finished tool call and the chat
  continues from the stored results, so no tool runs twice; otherwise the turn
  is regenerated. User stops, 4xx and context overflow are never auto-retried.
  On a GPU build with fit on, an overflow raises the model-level `fit_ctx` to
  the next step of the context ladder (capped at the trained context, after a
  rough RAM check) and reloads once per turn; core makes a model's `fit_ctx` win
  and keeps `--ctx-size` at or above it. If growth is impossible, "Shorten
  history and retry" leaves the oldest whole turns out of the request (the
  thread itself is untouched) and retries.
- **Consequences:** A dropped engine costs a short wait instead of an error card.
  Raising `fit_ctx` trades speed for context by offloading fewer layers. The
  shortened history lasts for the chat session only. CPU and fit-off behaviour
  are unchanged. Not verified on a Windows machine at the time of writing.
- **Owner:** `team`
- **Links:** `web-app/src/lib/turn-recovery.ts`,
  `web-app/src/lib/engine-readiness.ts`, `web-app/src/lib/context-size.ts`,
  `web-app/src/routes/threads/$threadId.tsx`,
  `web-app/src/lib/custom-chat-transport.ts` (`setHistoryStart`).
