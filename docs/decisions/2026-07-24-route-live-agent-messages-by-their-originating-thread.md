---
date: 2026-07-24
title: "Route live Agent messages by their originating thread"
---

# 2026-07-24 — Route live Agent messages by their originating thread

- **Context:** An Agent run retained its original thread id while its React
  component instance followed route navigation. Live events therefore combined
  the originating id with the newly active thread's message ref, making a
  response from one thread appear in another thread's UI.
- **Decision:** Upsert Agent UI messages directly into the chat session keyed by
  the run's captured thread id. Do not route asynchronous Agent events through
  the currently rendered thread's message ref or setter.
- **Consequences:** Navigating between threads while an Agent runs no longer
  redirects its live or terminal response. Backend message persistence remains
  unchanged, and ordinary Chat message handling keeps its existing path.
- **Owner:** team.
- **Links:** [`web-app/src/stores/chat-session-store.ts`](web-app/src/stores/chat-session-store.ts),
  [`web-app/src/routes/threads/$threadId.tsx`](web-app/src/routes/threads/$threadId.tsx),
  [`web-app/src/stores/chat-session-store.test.ts`](web-app/src/stores/chat-session-store.test.ts).
