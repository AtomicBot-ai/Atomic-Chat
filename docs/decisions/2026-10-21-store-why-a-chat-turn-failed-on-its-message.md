---
date: 2026-10-21
title: 'Store why a chat turn failed on its message'
---

# 2026-10-21 — Store why a chat turn failed on its message

- **Context:** The AI SDK keeps a failed turn's error only on the in-memory
  Chat. The thread page showed it as an error card with Retry, but `onFinish`
  also saved the failed turn as an ordinary `Ready` assistant message whose
  only content was an empty text part. After a relaunch the error was gone and
  the thread showed an empty reply with action icons (QA 2.2.23, AC-07, an
  invalid OpenAI key). It survived navigation only because the Chat was still
  in memory; any error was lost the same way on relaunch.
- **Decision:** A failed turn is saved with status `Error` and
  `metadata.turn_error = { message, statusCode? }`, keeping only the content
  that actually arrived (`finishedAssistantMessage` in
  `web-app/src/lib/turn-error.ts`). The thread page shows the error card for a
  failed turn stored as the last message, built from that record, so the
  title, text and recovery action match the live error. Any retry without a
  target (Retry, the context increase after an overflow) regenerates in place
  of a failed turn stored as the last message, so failed turns do not pile up
  in the thread file. A failed step ends the turn: the tool calls it queued are
  dropped, not run. A failed turn that produced nothing is not drawn as a
  reply and is left out of the model history by the chat transport.
- **Consequences:** The reason a turn failed survives a relaunch, and other
  windows see it too. Error classification after a reload works from the
  stored message text and status code only. Empty replies saved before this
  change carry no `turn_error` and still show as empty replies.
- **Owner:** `team`
- **Links:** `web-app/src/lib/turn-error.ts`,
  `web-app/src/routes/threads/$threadId.tsx`,
  `web-app/src/lib/custom-chat-transport.ts`.
