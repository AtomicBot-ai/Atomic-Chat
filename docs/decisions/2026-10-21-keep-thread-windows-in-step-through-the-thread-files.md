---
date: 2026-10-21
title: 'Keep thread windows in step through the thread files'
---

# 2026-10-21 — Keep thread windows in step through the thread files

- **Context:** "Open in new window" opens `/threads/<id>` in a second Tauri
  window, which runs its own copy of the web app: its own message store and
  its own AI SDK Chats, over the same `messages.jsonl` files. A conversation
  continued there was saved, but the main window kept what it had loaded — the
  thread page skips its load when the thread's Chat is still in memory — so
  the new exchange showed only after a relaunch (QA 2.2.23, AC-02).
- **Decision:** The thread files stay the one source of truth, and windows
  only tell each other which thread changed. `useMessages` counts each write
  as in flight until it lands, then emits `atomic://thread-messages-changed`
  (`{ threadId, origin, deletedIds? }`) to every window
  (`lib/thread-message-sync.ts`); one listener per window, started by the
  first thread page, remembers the deletions other windows announce. The
  thread page (`useThreadMessagesSync`) re-reads its thread from disk when
  another window announces a write to it, and when the thread is opened with
  its Chat already in memory. Like the page's own load it keeps the messages
  this window holds that never reached disk (a failed save), except those
  another window deleted. It replaces the message store and the Chat only when
  the result differs from what it holds — compared field by field, newest
  message first, without serializing the thread — and never while the thread
  is busy in this window (a reply streaming, tool calls or an agent run
  running, its own writes in flight); a busy thread is re-read once idle.
- **Consequences:** Both windows show the same saved conversation, message by
  message (a reply appears in the other window when it is saved, not token by
  token). Each announced write costs the other windows one read of the
  thread file. An empty read is never applied, because the messages service
  answers a failed read with `[]`; a thread emptied in another window
  therefore keeps its old view here until a relaunch. Thread metadata (title,
  order in the list) is not synced by this. Two windows sending to the same
  thread at once are not coordinated.
- **Owner:** `team`
- **Links:** `web-app/src/lib/thread-message-sync.ts`,
  `web-app/src/hooks/useThreadMessagesSync.ts`,
  `web-app/src/hooks/useMessages.ts`,
  `web-app/src/routes/threads/$threadId.tsx`.
