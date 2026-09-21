---
date: 2026-09-16
title: "Check disk space before a download starts"
---

# 2026-09-16 — Check disk space before a download starts

- **Context:** Since ATO-467 the Rust downloader refuses a transfer the
  volume cannot hold (`ensure_free_space`, headroom 512 MB) before the first
  byte. That refusal is correct but it reaches the web as a download *error*:
  every entry point — onboarding, the reply-model gate, the Hub, the
  recommended list — flips its row to "Downloading" the moment it calls
  `pullModelWithMetadata`, and a moment later the "Not enough disk space"
  toast arrives, worded as the failure of something that had started. From
  the onboarding screen that read as "downloads are broken", not as "this
  model is too big for this drive". Nothing on the web side could ask about
  free space: no command exposed it.
- **Decision:** A new Tauri command, `get_download_free_space`, returns
  `{ available, headroom }` for the volume holding the data folder (reusing
  `available_space_for` and `FREE_SPACE_HEADROOM`; `available` is `null` when
  the OS cannot tell). The single download-start choke point,
  `pullModelWithMetadata`, asks it before it records or starts anything,
  taking the size from Hugging Face metadata when the caller fetched it and
  otherwise from the catalog's declared `file_size` for that file URL (model
  plus mmproj). When `size + headroom > available` it does not start: it
  undoes the pre-download state the caller set (`localDownloadingModels`,
  the Hub's download origin), shows one toast — "This model won't fit on
  your disk … Pick a smaller model or free up space" — and *returns* a typed
  `DownloadRefusal` rather than throwing, because most callers fire and
  forget the pull and a refusal is not a failure to report to Sentry or to
  the `model_download` funnel. The check is advisory: an unknown size, an
  unknown free space or a failed command means "proceed", and a resume is
  never second-guessed here (only the downloader knows how much of the
  partial counts), so the Rust check stays the guard for everything the web
  cannot see.
- **Consequences:** From every entry point, a model that will not fit is
  declined with the list still on screen, the button still "Download", and
  no entry in the download panel; a model that fits behaves exactly as
  before. Models outside the curated catalog (Hugging Face search results)
  carry no declared size and still get the transfer-time refusal, as today.
  Callers that keep their own "downloading" flag outside the download store
  must read the returned refusal to reset it; the reply-model gate closes on
  the synchronous return of `start()` before the answer arrives, so a
  refusal there leaves the gate closed with the toast showing — a gate-side
  follow-up, not a choke-point one. Because callers set their row state
  before the call, the row may show "Downloading" for the one IPC round
  trip the check takes.
- **Owner:** @danyurkin.
- **Links:** [`src-tauri/src/core/downloads/disk.rs`](../../src-tauri/src/core/downloads/disk.rs),
  [`src-tauri/src/core/downloads/commands.rs`](../../src-tauri/src/core/downloads/commands.rs),
  [`web-app/src/services/models/downloadPreflight.ts`](../../web-app/src/services/models/downloadPreflight.ts),
  [`web-app/src/services/models/default.ts`](../../web-app/src/services/models/default.ts);
  builds on the ATO-467 preflight in the Rust downloader.
