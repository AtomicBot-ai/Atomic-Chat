---
date: 2026-10-21
title: 'Bring interrupted model downloads back after a relaunch, paused'
---

# 2026-10-21 — Bring interrupted model downloads back after a relaunch, paused

- **Context:** QA 2.2.23 (AC-10): an image-model download paused and followed
  by a restart was gone from the download panel and the Downloads page, and the
  model picker offered "Download" instead of "Resume". The download store
  (`useDownloadStore`) lives in memory, so a relaunch forgot every paused or
  running download, including the resume parameters ATO-154 recorded (that
  record already named the gap: "resume params are in-memory"). The partial
  files were still on disk. A checkpoint's Download happened to resume from
  them (it always asks the downloader to resume); a chat-model file's Download
  after a relaunch asked for a fresh transfer, because `resumableDownloads` was
  empty too. The disk scan of the Downloads page (`lib/downloads-disk.ts`)
  lists leftovers under `llamacpp/models` and `mlx/*` for removal only; it does
  not read `diffusion/models`, and a diffusion `.tmp` cannot be mapped to one
  artifact when the side files are shared.
- **Decision:** Keep a small record of each download the panel can resume —
  a chat-model file with its `pullModelWithMetadata` parameters, or an
  image/video checkpoint task id — in localStorage
  (`atomic-interrupted-downloads`, `lib/interrupted-downloads.ts`): id, name,
  bytes, progress and the resume parameters without the Hugging Face token. It
  follows the store (written at most once per percent) and is restored once per
  app start by the download panel's mount, in the main window only, as paused
  and resumable rows. A resume reads the token from Settings. The resume logic
  moved from the panel into `lib/downloadResume.tsx`, so the panel, the
  Downloads page (new Resume button on a paused row), the Hub variant card and
  the image picker (outer slot and quant menu) all offer the same explicit
  Resume for a paused download instead of Cancel or a fresh Download.
  Cancelling a paused row now clears it locally (no transfer is left to emit a
  stop event), and a checkpoint resume whose files are already complete closes
  its row with the ordinary success event. A Resume nothing can serve (the
  image catalog not loaded or no longer listing the quant, or a file without
  parameters) drops the row and its record and says it cannot be resumed; the
  partial files stay marked resumable for the model's own Download.
- **Consequences:** A paused download, or one a quit or crash cut off, comes
  back after the relaunch where the user left it. Engine builds, MLX repos,
  embedding/decision models, managed and Foundry Local downloads are not
  recorded: they are cancel-only and resume from their own cards. A record can
  outlive its partial files (deleted by hand); resuming it then starts from
  byte 0, as a fresh download would. A detached thread window neither restores
  nor writes the list. Only `common:resumeDownload` names the action; it is
  translated in en/ja/ko/ru and falls back to English elsewhere, as the
  panel's Resume already did.
- **Owner:** `team`
- **Links:** `web-app/src/lib/interrupted-downloads.ts`,
  `web-app/src/lib/downloadResume.tsx`,
  `web-app/src/containers/DownloadManegement.tsx`,
  `web-app/src/lib/downloadCancellation.ts`,
  `web-app/src/containers/images/ImageArtifactDownloadButton.tsx`,
  `web-app/src/containers/downloads/DownloadsPage.tsx`,
  [2026-06-11 pause/resume (ATO-154)](2026-06-11-add-pause-resume-for-model-downloads-in-the-global-download.md).
