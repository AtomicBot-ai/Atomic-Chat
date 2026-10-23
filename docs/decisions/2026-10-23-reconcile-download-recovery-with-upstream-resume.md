---
date: 2026-10-23
title: 'Reconcile model recovery with upstream checkpoint recovery and Resume'
---

# 2026-10-23 — Reconcile model recovery with upstream checkpoint recovery and Resume

- **Context:** Main added an interrupted-download journal, shared Resume helper,
  and readable inventory names after PR #370 introduced canonical model request
  recovery and serialized controls. Keeping both journals authoritative for model
  requests could restore an obsolete alias or a cancelled request. Calling the
  new helper directly from Hub/Downloads could also bypass the control owner.
- **Decision:** Keep `atomic-model-downloads-v1` authoritative for model requests.
  Import earlier `atomic-interrupted-downloads` model records through the same
  public-source/parameter allowlist, respecting canonical identity, existing rows
  and cancellation tombstones; then retain only media checkpoints in that older
  journal. Migration defaults missing verification intent conservatively, as the
  canonical parser already does. No credentials or reply-execution intent migrate.
  Keep main's checkpoint restoration and shared Resume helper. Hub and Downloads
  model actions enqueue controls through the app-wide manager; its Resume calls
  that helper without clearing Pause before the model service stops its prior
  importer. Unresolved model sources remain visible and cannot start a transfer.
  Main's paused-checkpoint cancellation removes the local row without sending a
  redundant stop to a transfer that has already stopped. Keep main's readable
  model/quant/owner names and full-ID copy action, together with overflow scrolling
  and a single provider-aware Pause/Resume control.
- **Consequences:** Existing upstream and PR installations recover through one
  model identity/lifecycle without losing media checkpoint recovery. Restart still
  restores paused jobs, and manual Resume is required. Existing files are neither
  moved nor deleted by migration. Integration tests must cover both journal
  formats, cancellation/alias precedence, credential exclusion, shared Resume,
  current settings token use and inventory naming/copy/layout.
- **Owner:** `team`
- **Links:** `web-app/src/lib/interrupted-downloads.ts`,
  `web-app/src/lib/downloadResume.tsx`,
  `web-app/src/containers/DownloadManegement.tsx`,
  `web-app/src/containers/downloads/DownloadsPage.tsx`,
  [upstream relaunch recovery](2026-10-21-bring-interrupted-model-downloads-back-after-a-relaunch.md),
  [canonical request recovery](2026-10-20-recover-and-reuse-model-download-requests.md).
