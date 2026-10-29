---
date: 2026-10-26
title: 'Keep unsent drafts across a relaunch'
---

# 2026-10-26 — Keep unsent drafts across a relaunch

- **Context:** QA 2.2.25 NEW-03: "DRAFT RESTART 274", typed but not sent in
  a saved chat, was gone after Cmd-Q and a relaunch. The 2026-10-21 record
  keyed drafts per composer but kept them in memory only, so any quit lost
  them. Navigation-only isolation (AC-04) passed and has to keep passing.
- **Decision:** `usePrompt` writes every change of a composer's draft to
  localStorage, one item per composer key:
  `composer-draft:<thread id | project:<id>>` → `{ text, at }`
  (`localStorageKey.composerDraftPrefix`). The store starts from the stored
  drafts; `bindDraft` restores a key from storage, which wins over the copy
  parked in memory unless this window's last write of that key failed
  (quota). Clearing a draft (send, an emptied field) removes its item.
  - **One item per key, not one blob.** A detached chat window runs its own
    store over the same localStorage. Each window writes only the keys it
    changes, so it never replaces another window's drafts, and coming back
    to a chat shows the newest text even when another window changed or
    sent it. Windows are not synced live: a chat open in two windows keeps
    the text each one last typed until the user switches chats.
  - **The home composer is not stored.** Its key, `temporary-chat`, is also
    the temporary chat's thread id, and a temporary chat writes nothing to
    disk by design (`services/messages/default.ts`). Giving the home composer
    a key of its own would mean changing `composerThreadKey`, which also
    carries voice, workspace and approval-mode state across the first send.
    Its draft stays in memory for the session, as before.
  - **Pruning.** At launch, drafts untouched for 30 days, beyond the newest
    50, unreadable, or under an unstored key are removed. Deleting a chat
    (single, all, a project's chats) drops its draft at once
    (`clearDraft`, next to the agent-mode and read-status cleanup in
    `useThreads`).
- **Consequences:** A quit, crash or update keeps what the user typed in a
  saved chat or a project's composer. Drafts are plain text in the webview's
  localStorage, like the rest of the app's local state; a factory reset clears
  them. A deleted project's composer draft is not dropped at once; it ages
  out. Every keystroke costs one small synchronous localStorage write.
  Attachments, the selected skill and voice state are still per session.
- **Owner:** `team`
- **Links:** `web-app/src/hooks/usePrompt.ts`, `web-app/src/hooks/useThreads.ts`,
  `web-app/src/constants/localStorage.ts`,
  `web-app/src/hooks/__tests__/usePrompt.test.ts`; QA package
  atomic-chat-e2e-2026-10-23 (NEW-03, AC-04).

Supersedes the "Drafts stay in memory only" clause of
[2026-10-21-keep-each-composers-draft-with-its-own-chat.md](2026-10-21-keep-each-composers-draft-with-its-own-chat.md).
