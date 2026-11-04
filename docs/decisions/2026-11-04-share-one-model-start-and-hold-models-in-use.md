---
date: 2026-11-04
title: 'Share one model start, and never stop a model a request is using'
---

# 2026-11-04 — Share one model start, and never stop a model a request is using

- **Context:** 42 users had a model load followed by a turn with no response
  (32 on Windows). A send from the home composer could go out while the model
  was starting, and the transport's own `startModel` raced `switchToModel`'s
  `stopAllModelsExcept` / `stopServer`. The backend-mismatch prompt opened on
  the first send after a load, and its Fix (unload) and Restart (relaunch)
  killed that request. Queued sends were dropped silently when the selection
  changed. The web download preflight was advisory and skipped unknown sizes,
  and the onboarding picker gave up on the hardware probe after 4 s although the
  Windows probe can take 15 s.
- **Decision:** `lib/model-lifecycle.ts` shares one start per provider+model:
  the transport and `switchToModel` join the same start. Every request holds the
  model it uses from creation until its body is read, fails or is aborted (a
  quiet hold lapses after 30 min); a switch waits for holds before stopping a
  model. Local engines are dialled on `127.0.0.1`. The mismatch prompt opens
  after a turn finishes or after 10 s idle, and its actions refuse while a
  request holds the provider's models. A queued send that loses its model keeps
  the text and says why. Downloads are admitted only when
  `get_disk_space_info` shows the remaining bytes plus max(512 MiB, 2%) free, and
  a FAT volume refuses files of 4 GiB or more. Onboarding keeps a provisional
  recommendation and takes the real tier for up to 20 s unless the user picked a
  row. Model auto-start stops once `app-shutting-down` fires.
- **Consequences:** A switch can wait for a long reply to finish before it
  stops the old model. Not verified in the running app or on a Windows machine
  at the time of writing.
- **Owner:** `team`
- **Links:** `web-app/src/lib/model-lifecycle.ts`, `web-app/src/lib/model-factory.ts`,
  `web-app/src/utils/switchModel.ts`, `web-app/src/containers/ChatInput.tsx`,
  `web-app/src/containers/dialogs/SuboptimalBackendDialog.tsx`,
  `web-app/src/services/models/downloadPreflight.ts`,
  `web-app/src/containers/onboarding/useModelOptions.ts`, `web-app/src/lib/app-shutdown.ts`.
