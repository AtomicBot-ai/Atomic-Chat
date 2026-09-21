---
date: 2026-09-16
title: "Stay on the Welcome screen until the download lands"
---

# 2026-09-16 — Stay on the Welcome screen until the download lands

- **Context:** A Download click on a recommended row in onboarding
  (`web-app/src/containers/SetupScreen.tsx`) armed a 3 s timer
  (`DOWNLOAD_ENTER_DELAY_MS`, from #265) and then navigated to the chat with
  the model, whatever the download was doing. The hold existed so the click
  visibly registered before the screen changed. Two problems in Danny's
  screen recording: (1) the row stacked two extra right-aligned lines under
  the greyed "Downloading…" button — "Starting download…" and "Download
  started — opening chat…" — so the row jumped taller and read as noise;
  (2) a cancel from the bottom-right download panel after those 3 s left the
  user in an empty chat with no model and no way back to the list.
- **Decision:** No timed handoff. The Welcome screen stays while the
  download runs. The chat opens with the model, the way the timer's
  `enterChatForDownload` did, only once the model is in the local
  provider's library: the `onModelImported` /
  `onFileDownloadAndVerificationSuccess` listener that already handled
  imports now takes that exit for a download started here (reported as
  `exit_path: 'download_started'`, not `imported`, so the funnel's series
  keep their meaning), with an effect on the library as the backstop for an
  import that lands without its event or under another id. Both go through
  `hasNavigatedRef`, so it fires once and not at all after Skip. While the
  bytes come in, the row's button slot holds one pill on one line —
  "Downloading…" with an ×, which cancels the way the Hub's pill does
  (resumable, flagged as the user's own stop, then `abortDownload`) — and
  the progress (`12% · 200 MB / 1.6 GB`) beside it once the size is known.
  Nothing is rendered under the row, so its height is the same in the
  Download and Downloading states. The cancel restores the Download button
  through the panel's stop-event cleanup of the store; another row can then
  be started. The `downloadPreparing` and `downloadStartedOpening` keys are
  removed from every locale that had them (en, ru, ja, ko).
- **Consequences:** A first-time user watches the download on the screen
  that offered it, with the list still there if they change their mind; the
  bottom-right panel keeps its own controls. The hero row's pill drops the
  primary fill while downloading, since a filled button that cancels would
  read as the call to action. A download cancelled from the panel rather
  than the row keeps its handoff entry; nothing lands, so nothing happens,
  and a later resume that completes still opens the chat. The reply-model
  gate (`ReplyModelGate.tsx`) is untouched: it closes on start but the user
  is already in the chat, and the gate returns on the next send.
- **Owner:** @danyurkin.
- **Links:** `web-app/src/containers/SetupScreen.tsx`,
  `web-app/src/containers/__tests__/SetupScreen.test.tsx`,
  `web-app/src/lib/downloadCancellation.ts`,
  `web-app/src/containers/ModelDownloadAction.tsx` (the Hub's cancel pill),
  2026-06-12 "Make the Hub download in-progress state a button-shaped pill".
