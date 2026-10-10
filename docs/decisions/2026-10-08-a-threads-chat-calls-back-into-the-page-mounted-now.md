---
date: 2026-10-08
title: "A thread's Chat calls back into the page mounted now"
---

# 2026-10-08 — A thread's Chat calls back into the page mounted now

- **Context:** `useChat` builds one AI SDK `Chat` per thread and `ensureSession` hands it to every
  later mount of the thread page; the SDK never updates a `Chat`'s callbacks. So `onFinish`,
  `onToolCall` and `sendAutomaticallyWhen` stayed the closures of the first mount. Once the page had
  unmounted — the user opened Settings, the Hub, a project or a new chat and came back — a finished
  reply cleared `isChatRequestActive` on a page that no longer existed. The answer was on screen,
  Working stayed and Enter did nothing until Stop (ATO-538; RC 2.2.0 QA: EDIT_OK visible at 9 s,
  composer blocked past 60 s). The logs showed the MLX request finished at 6 s with no further work.
  The same flag lived in component state, shared by every thread one page instance showed, and the
  terminal check read `sessionData.tools`, which can keep entries from an earlier step (PR #335).
- **Decision:** The `Chat` is created with callbacks that look up, on every call, those of the hook's
  latest render for that session (`latestCallbacks` in `use-chat.ts`). The request flag moves to the
  session store, per thread (`requestActive` / `setRequestActive`), and so does the tool-call abort
  controller (`SessionData.toolAbort`). A turn is terminal when its finished message has no tool part
  still waiting on output (`hasUnresolvedToolCallParts`, from PR #335), and the tool queue is cleared
  then.
- **Consequences:** A turn finishes in whatever page shows its thread, including after remounts;
  Stop aborts that thread's tool calls; one thread's turn no longer blocks another's composer. Two
  pages mounted on the same thread at once would share the later one's callbacks. The Rust agent
  path (Agent mode) is separate and unchanged.
- **Owner:** team
- **Links:** `web-app/src/hooks/use-chat.ts`, `web-app/src/stores/chat-session-store.ts`,
  `web-app/src/routes/threads/$threadId.tsx`, `web-app/src/lib/execute-chat-tool-calls.ts`,
  `web-app/src/hooks/__tests__/use-chat.test.tsx`; Linear ATO-538; GitHub PR #335.
