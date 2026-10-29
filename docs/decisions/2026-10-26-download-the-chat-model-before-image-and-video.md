---
date: 2026-10-26
title: 'Download the first-run chat model before image and video, even when chosen last'
---

# 2026-10-26 — Download the first-run chat model before image and video, even when chosen last

- **Context:** The first-run queue runs one job at a time, chat model first,
  but only by the order jobs were added in. A user who kept a model already
  on the device, queued Z-Image or LTX-2 on the media step, then went back
  and picked a model to download got both transfers at once, with the media
  job shown on the strip and listed first in "Download order". The
  prototype always puts the language model first and sends a running media
  job back to the queue.
- **Decision:** A new chat job goes to the front of the run's queue
  (`onboarding-store` `enqueue`). A media job whose model file is
  downloading when it arrives pauses that file (the same pause as the
  strip's) and goes back to `queued`; once the chat model is over — done or
  taken off — the file resumes from its bytes on disk without a toast. A
  media job installing the image engine lets the install finish (engine
  installs cannot be paused) and then waits, queued, before its model file.
  A download the user paused is left to them.
- **Consequences:** The strip, the picker and "Download order" show the chat
  model first in every order of choices. A relaunch while a media file is
  paused this way brings it back paused, with Resume, as any paused
  download. The engine install can still overlap the chat download for its
  own duration.
- **Owner:** `team`.
- **Links:** `web-app/src/stores/onboarding-store.ts`,
  `web-app/src/lib/onboarding/media-jobs.ts` (`waitForChatModel`,
  `yieldToChatModel`), prototype `preview/onboarding/state.ts` `start()`.
