---
date: 2026-06-11
title: "Add pause/resume for model downloads in the global Download popover (ATO-154)"
---

# 2026-06-11 — Add pause/resume for model downloads in the global Download popover (ATO-154)

- **Context:** Community request (Discord, @m.iko) — parity with Jan.ai. The
  global Download popover ([`DownloadManegement.tsx`](web-app/src/containers/DownloadManegement.tsx))
  only offered **cancel (X)** per download; no pause/resume. The plumbing was
  already half-present: the Rust downloader
  ([`src-tauri/src/core/downloads/helpers.rs`](src-tauri/src/core/downloads/helpers.rs))
  **keeps the partial file on cancel** (`keep_partial_on_cancel = true`) and
  **resumes** from the `.tmp` + saved-`url` match (`_get_maybe_resume`, `resume`
  flag); `download_files`/`cancel_download_task` and `pullModelWithMetadata(…,
  resume)` already thread `resume`; and the store
  ([`useDownloadStore`](web-app/src/hooks/useDownloadStore.ts)) had
  `resumableDownloads` + `markResumableDownload`/`clearResumableDownload`. But
  "resumable" was only used for retry/error toasts and Hub-card re-clicks — no
  pause/resume control was surfaced in the popover, and the popover had no way
  to resume because it only knows the model id, not the HF paths/token.
- **Decision:** Ship Jan-parity pause/resume, **gated to resumable GGUF model
  downloads only** (the team chose parity over extending it to backend
  binaries). The gate is `!id.startsWith('llamacpp') && !id.startsWith('mlx')`,
  identical to Jan — which conveniently also excludes **MLX model repos**
  (`mlx-community/*` starts with `mlx`, and MLX downloads go through
  `engine.import` directly, not `pullModelWithMetadata`) and **backend-binary
  downloads** (`llamacpp*`). So pause/resume covers exactly the
  `pullModelWithMetadata` (llama.cpp GGUF) path; MLX + binaries keep cancel-only.
  1. **Store** ([`useDownloadStore.ts`](web-app/src/hooks/useDownloadStore.ts)):
     new `pausedDownloads: Set<string>` (+ `markPausedDownload` /
     `clearPausedDownload`) and `resumeParams: { [id]: DownloadResumeParams }`
     (+ `setResumeParams` / `clearResumeParams`), where `DownloadResumeParams =
     { modelPath, mmprojPath?, hfToken?, skipVerification? }`.
  2. **Resume-param capture at the single GGUF choke point**
     ([`services/models/default.ts :: pullModelWithMetadata`](web-app/src/services/models/default.ts)):
     `setResumeParams(id, …)` right beside the existing `markDownloadStart`
     telemetry anchor — so **every** initiator (Hub, onboarding, prompts,
     claude-code) populates resume params without touching ~7 call sites.
  3. **Swallow-on-paused** (same method): if
     `useDownloadStore.getState().pausedDownloads.has(id)` in the catch, return
     instead of emitting `onFileDownloadError` / rethrowing — so a paused
     download (which rejects the in-flight import with a cancellation error)
     does **not** trigger the initiator's "download failed" toast or row
     cleanup. Read from `getState()` (not a React closure) to avoid racing the
     async stop event.
  4. **Popover** ([`DownloadManegement.tsx`](web-app/src/containers/DownloadManegement.tsx)):
     per-row Pause (`IconPlayerPause`) / Resume (`IconPlayerPlay`) buttons shown
     only when `isPausableDownload(id)`; `handlePauseDownload` =
     `markPausedDownload` + `markResumableDownload` + `abortDownload`;
     `handleResumeDownload` = read `resumeParams[id]`, `clearPausedDownload`,
     `pullModelWithMetadata(…, resume=true)` (falls back to a cancel-style
     cleanup + toast if params are missing, e.g. after an app restart).
     `onFileDownloadStopped` early-returns (keeping the `downloads[id]` row +
     last progress) when the store says paused; all true-terminal handlers
     (success / verification-success / validation-failed / error) and the X
     button now also `clearPausedDownload` + `clearResumeParams`.
  5. **i18n:** `pauseDownload` / `resumeDownload` added to
     [`en/common.json`](web-app/src/locales/en/common.json) +
     [`ru/common.json`](web-app/src/locales/ru/common.json) (other locales fall
     back to EN); the X title now uses the existing `cancelDownload` key.
- **Consequences:** Resumable GGUF downloads can be paused and resumed from the
  popover; the partial file on disk means resume continues from where it
  stopped. MLX (`mlx-community/*`) and backend binaries stay cancel-only —
  accepted per the chosen Jan parity. **Scope:** web-app only (store + service +
  popover + 2 locales); no Rust, IPC, on-disk layout, or settings-schema change
  — the Rust resume support already existed. **Caveat:** resume params are
  in-memory (cleared on app restart / cleared localStorage); a paused download
  resumed after a restart hits the missing-params fallback (cancel-style toast)
  rather than continuing — acceptable, the partial file is still reusable via a
  fresh Hub-card download (which already passes `resume`). **Verified:**
  `tsc -b` clean; `eslint` clean on all three edited TS/TSX files;
  `useDownloadStore.test.ts` 18/18. The `models.test.ts` failures are
  **pre-existing** (`fetchHuggingFaceRepo` headers + `pullModel` resume arg;
  `pullModelWithMetadata` is not referenced by that suite) and unrelated.
- **Owner:** team.
- **Links:** [ATO-154](https://linear.app/atomicchat/issue/ATO-154), files:
  [`web-app/src/hooks/useDownloadStore.ts`](web-app/src/hooks/useDownloadStore.ts),
  [`web-app/src/services/models/default.ts`](web-app/src/services/models/default.ts)
  (`pullModelWithMetadata`),
  [`web-app/src/containers/DownloadManegement.tsx`](web-app/src/containers/DownloadManegement.tsx),
  [`web-app/src/locales/en/common.json`](web-app/src/locales/en/common.json),
  [`web-app/src/locales/ru/common.json`](web-app/src/locales/ru/common.json),
  Rust resume support in
  [`src-tauri/src/core/downloads/helpers.rs`](src-tauri/src/core/downloads/helpers.rs).
