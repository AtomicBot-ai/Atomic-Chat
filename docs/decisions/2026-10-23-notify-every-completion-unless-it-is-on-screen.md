---
date: 2026-10-23
title: "Notify every completion unless it is on screen"
---

# 2026-10-23 — Notify every completion unless it is on screen

- **Context:** since 2026-09-29 a download, images or a clip told the OS only while the window
  was hidden or unfocused, and a reply also when another conversation was "active". Design
  feedback: a finished model download, or any finished result (reply, images, video), must always
  reach the user as a system notification. Two gaps showed up on the way: the reply rule read
  `activeConversationId`, which follows the last chat any hook bound, so a background first send
  (`DeferredFirstSendProvider`) took it and its reply notified nobody while the user was on
  another page; and a download announced itself only while it still had a panel row.
- **Decision:** one gate, `notifyUnlessWatching(watching, title, body)` in
  `web-app/src/lib/notifications.ts`: the Settings switch still silences everything, and
  otherwise the OS is told unless `watching` holds in a focused, visible window. `watching` is
  the page that shows the result, read with `isPageOnScreen` (`lib/navigation.ts`): the thread's
  own page for a reply, the Images page (and its workflows) for images, the Videos page for a
  clip. A model download of any kind is never "watched" and always notifies, once, named as its
  panel row names it (a managed, Foundry Local or LiteRT-LM model by the name its download
  recorded, a decision model by its catalog name); an engine install keeps the old rule, its
  toast in a focused window. `DownloadManagement` counts a download as finished once if it
  reported progress or still has a row, so a second success event, or a success for a transfer
  that never ran, stays quiet. A failed turn, a failed, stopped or cancelled download, and a
  failed generation do not notify.
- **Consequences:**
  - A focused window now gets an OS notification next to the in-app toast for a model download,
    and for a reply, images or a clip that finished while the user was on another page.
  - A reply the user stopped still notifies when its thread is not on screen: the AI SDK reports
    the abort only in `onFinish`, after the status change the notification hangs on. A stop is
    pressed on the thread itself, where nothing is shown.
  - Images or a clip adopted after a reload (a job that was already running) notify like any
    other.
  - The Settings description says downloads always notify and results notify while the user is
    elsewhere.
- **Owner:** `team`.
- **Links:** `web-app/src/lib/notifications.ts`, `web-app/src/lib/navigation.ts`,
  `web-app/src/containers/DownloadManegement.tsx`, `web-app/src/lib/downloadNotification.ts`,
  `web-app/src/stores/chat-session-store.ts`, `web-app/src/stores/image-generation-store.ts`,
  `web-app/src/stores/video-generation-store.ts`.

<!--
Supersedes: 2026-09-29-notify-the-desktop-when-a-download-or-generation-finishes.md (in part:
the focused-window rule and the row-only dedupe)
-->
