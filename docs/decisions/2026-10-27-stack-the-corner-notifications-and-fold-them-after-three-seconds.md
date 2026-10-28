---
date: 2026-10-27
title: "Stack the corner notifications in one column and fold them after three seconds"
---

# 2026-10-27 — Stack the corner notifications in one column and fold them after three seconds

- **Context:** QA of the new navigation, forwarded by the user: download and
  update notifications landed on top of each other, the engine-update cards
  looked nothing like the download panel's new strip look, and a card covered
  the corner for as long as its download ran. Six things pinned themselves to
  the bottom-right corner: the download panel, the app- and engine-update
  offers, a managed engine's setup card, the model reminder and the first-run
  handoff panel. The panel published its height (`--download-panel-offset`) and
  every other card sat that far up, so any two of the others showing together
  overlapped. `<BackendUpdater />` also drew a "Updating llama.cpp backend" /
  "Updating the media engine" card at `bottom-3 right-3`, ignoring the offset,
  for a transfer the download panel already listed as a row — the same download
  twice, one card on top of the other.
- **Decision:**
  - One column (`containers/corner/cornerStack.tsx`): every corner card renders
    into a fixed flex column on `<body>` (z-40) at a fixed order — handoff,
    reminder, managed engine, update offer, downloads nearest the corner — so
    a card takes the room it needs and the rest move. The column keeps clear
    of the composer with `panelLayout`, which now counts every card in it,
    not only the download panel.
  - The background engine-download card is gone. Every engine build is a row
    of the download panel named after the engine and its release
    (`lib/engineDownloadLabel.ts`: "llama.cpp · b11500", CPU mark), and
    `<BackendUpdater />` keeps only its completion toasts. The `download` slot
    of `update-banner-store` goes with it; app and engine offers still never
    both show (2026-09-14).
  - One family (`containers/corner/CornerCard.tsx`): the update offers and the
    managed engine card take the download panel's shell — 22rem, 15px corners,
    the strip's teal palette in both themes, a 13px header with fold and ×, a
    12/11px strip, teal pill actions.
  - Every card shows in full when it appears and folds into a pill three
    seconds later (`useAutoCollapse`). The pill keeps the essentials — the
    overall percent in a progress ring and the count for downloads, the version
    on offer (or the update's percent) for an offer — and opens the card again.
    Folding waits while the pointer or focus is inside; a card opened by hand
    stays open until it is left. A download joining the queue and a new setup
    phase open their card for another three seconds. The model reminder and
    the handoff panel join the column but do not fold.
- **Consequences:** No card can overlap another, whatever shows at once, and a
  new corner card is one `<CornerSlot order=…>`. This reverses ATO-462's
  "expanded panel stays put": the 3.5 s popover it replaced hid everything,
  while the pill still shows progress and count. The column docks above the
  composer more often on the home screen when several cards are open, and
  drops back to the corner once they fold. Locale keys
  `backendUpdater.backgroundUpdate*` and `media.backgroundUpdate*` are removed.
- **Owner:** @m-skvortsov
- **Links:** `web-app/src/containers/corner/`,
  `web-app/src/containers/downloads/DownloadPanel.tsx`,
  `web-app/src/containers/UpdateBanner.tsx`,
  `web-app/src/containers/managed-engine/ManagedEngineOperationBar.tsx`,
  `web-app/src/containers/dialogs/BackendUpdater.tsx`,
  `web-app/src/stores/update-banner-store.ts`

<!--
Supersedes: 2026-09-14-one-update-banner-in-the-corner-at-a-time.md (in part: the `download` slot)
-->
