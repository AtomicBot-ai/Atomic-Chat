---
date: 2026-09-18
title: "Keep a reply the user stopped"
---

# 2026-09-18 — Keep a reply the user stopped

- **Context:** Pressing Stop left the partial reply on the page, but `onFinish` skipped persistence for an aborted message, so the thread store held the question alone: after a restart, or on returning to the thread, the text the user had read was gone and the question stood unanswered. A cancelled agent run in the same route was already persisted with `MessageStatus.Stopped`. The desktop e2e suite pinned the behaviour (`tests/e2e/desktop/chat-workflows.spec.ts`).
- **Decision:** A stopped chat reply is saved as `MessageStatus.Stopped` with what was actually received: non-empty text and reasoning, images, and tool calls that already have an output. A tool call cut off before its result is dropped, because a stored call with no answer makes the next request invalid for providers that require one. Nothing is saved when nothing was received.
- **Consequences:** The page and the store agree after Stop, and the stopped turn is part of the history sent with the next message, as it already was within the session. Regenerate replaces it like any other assistant turn. Nothing in the UI marks a stored reply as stopped yet; the status is there for it.
- **Owner:** team
- **Links:** `web-app/src/routes/threads/$threadId.tsx`, `tests/e2e/desktop/chat-workflows.spec.ts`
