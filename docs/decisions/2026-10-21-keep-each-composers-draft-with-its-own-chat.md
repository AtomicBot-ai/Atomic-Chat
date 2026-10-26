---
date: 2026-10-21
title: "Keep each composer's unsent draft with its own chat"
---

# 2026-10-21 — Keep each composer's unsent draft with its own chat

- **Context:** QA AC-04 (2.2.23): a draft typed in a project composer showed
  up in every chat opened afterwards. `usePrompt` held one `prompt` string for
  the whole app, and every composer (home, project, thread) rendered it, so an
  unsent draft followed the user everywhere. Approval mode, workspace and
  voice were already keyed per composer (`lib/composer-thread-key`); the text
  was not.
- **Decision:** Key the draft by the same composer key. `usePrompt` keeps
  `prompt` as the text of the composer it is bound to (`draftKey`) and parks
  the others in `drafts`. `ChatInput` reads and writes its own key
  (`selectDraft`, `setDraft`) and binds it in a layout effect, so `prompt`
  stays right for the token counter. The thread page passes its route
  `threadId`, so the key is right on the first render: the global
  `currentThreadId` is set later, in the page's effect, and keying on it
  painted the previous chat's draft for a frame. The deferred first send
  clears New Chat's draft by key. Rejected: a keyed map with no bound
  `prompt` — it changes the store's API under the token counter and many
  tests for no gain while one composer is shown at a time.
- **Consequences:** A chat shows its own draft or an empty field from its
  first frame; going back restores the draft. Drafts stay in memory only, as
  before. A temporary chat shares the home composer's key, so those two share
  a draft slot. An empty draft is not stored. The composer key now prefers
  the route thread for approval mode and voice too.
- **Owner:** `team`.
- **Links:** `web-app/src/hooks/usePrompt.ts`, `web-app/src/containers/ChatInput.tsx`,
  `web-app/src/providers/DeferredFirstSendProvider.tsx`, `web-app/src/lib/composer-thread-key.ts`

Superseded in part by
[2026-10-26-keep-unsent-drafts-across-a-relaunch.md](2026-10-26-keep-unsent-drafts-across-a-relaunch.md):
drafts of saved chats and projects are now kept across a relaunch.
