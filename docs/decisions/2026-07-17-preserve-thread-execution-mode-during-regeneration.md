---
date: 2026-07-17
title: "Preserve thread execution mode during regeneration"
---

# 2026-07-17 — Preserve thread execution mode during regeneration

- **Context:** New turns in Agent threads routed through `agent_run_turn`, but
  regenerate and edit-regenerate always called the AI SDK `regenerate`
  function, silently recreating the response through ordinary Chat transport.
- **Decision:** Resolve regeneration from the thread's persisted mode. Keep
  Chat regeneration on `CustomChatTransport`; in Agent threads, retain the
  selected user message, remove following messages, and rerun its text through
  Agent IPC without inserting a duplicate user message.
- **Consequences:** A thread now uses one execution mode for sends,
  regeneration, edit-regeneration, and failed-run retries. Agent regeneration
  retains the thread's workspace and approval policy; staged composer
  attachments are left untouched.
- **Owner:** team.
- **Links:** [`web-app/src/routes/threads/$threadId.tsx`](web-app/src/routes/threads/$threadId.tsx).

---
