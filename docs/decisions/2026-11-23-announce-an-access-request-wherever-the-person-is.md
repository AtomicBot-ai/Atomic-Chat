---
date: 2026-11-23
title: "Announce an access request wherever the person is"
---

# 2026-11-23 — Announce an access request wherever the person is

- **Context:** A device asking this computer for its models (account remote access, [2026-11-12](2026-11-12-share-and-use-models-through-the-account.md)) waits for "Allow" on Remote models (`/account/remote`) and expires after ten minutes. All it raised was a sonner toast with "Review". The toast left after a few seconds, whatever the window was doing, so a request that came in while Atomic Chat sat in the tray, minimized or behind another app was missed and expired. That record listed the OS notification as not done.
- **Decision:** The web layer announces each request once, by grant id, in the place the person can see it. The host loop's `account-remote-changed` event already reaches JS while the window is hidden, as the reply notifications rely on.
  - **Window away** (hidden, minimized or another app in front, `isWindowAway`): one OS notification per request, "Access request" / "<device> asks to use this computer's models. Open Atomic Chat to allow or deny it." The Settings switch silences it, as it does every desktop notification.
  - **Window in front on another page:** a card in the corner column (`RemoteRequestNotice`, `CORNER_ORDER.accessRequest`) with the device, its check code and "Review", which opens Remote models. It folds into a pill after three seconds like every corner card, and opens again when another device asks or the window comes back.
  - **Remote models on screen:** the page lists the request; nothing else shows. A request seen there does not bring the card back.
  - The card lists a request until it is allowed, denied or expired (it leaves the host's pending list), or until × puts it away. A request already pending at start counts as new and is announced once.
  - Clicking the OS notification is not handled: `tauri-plugin-notification` 2.3.3 shows desktop notifications through `notify-rust` and drops the handle, and its JS `onAction` is mobile-only. Instead, the card is waiting when the window comes back.
  - The request toast and its `remote.toast.request*`/`review` strings are gone. The card's strings are `account:remote.notice.*` (en, fr, ru).
- **Consequences:**
  - A request no longer goes unseen while the app is in the tray. Whatever the OS does on a notification click (often bringing the app forward), the card points to the request once the window is back.
  - With desktop notifications off, a request made while the window is away shows only when the person comes back to the window.
  - The announced ids live in memory: a request still pending after a restart notifies once more.
  - Still behind `PlatformFeature.ACCOUNTS` (dev builds only).
- **Owner:** `team`.
- **Links:** `web-app/src/lib/remoteRequestNotice.ts`, `web-app/src/stores/account-remote-store.ts`, `web-app/src/containers/account/remote/RemoteRequestNotice.tsx`, `web-app/src/containers/corner/cornerStack.tsx`, `tauri-plugin-notification` `src/desktop.rs`.

<!--
Supersedes: 2026-11-12-share-and-use-models-through-the-account.md (in part: "A request raises a toast with Review")
-->
