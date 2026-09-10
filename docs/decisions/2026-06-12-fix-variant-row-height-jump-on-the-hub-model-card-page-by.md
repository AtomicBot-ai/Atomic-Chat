---
date: 2026-06-12
title: "Fix variant-row height jump on the Hub model-card page by giving the in-progress download the same pill button as the rest of the Hub"
---

# 2026-06-12 — Fix variant-row height jump on the Hub model-card page by giving the in-progress download the same pill button as the rest of the Hub

- **Context:** The earlier same-day pill ADR (below) only converted the three
 shared download components, but the **model-card variant table** renders its
 action cell **inline** in
 [`$modelId.tsx`](web-app/src/routes/hub/$modelId.tsx), not via
 `ModelDownloadAction`. So clicking "Download" on a variant swapped a
 `Button size="sm"` (~h-8) for a shorter inline cluster (thin `Progress w-12`
 + percent text + an `icon-xs` ghost X), shrinking the `td` content height and
 making the whole table jump.
- **Decision:** Replace the inline in-progress cluster with the exact same
 button-shaped pill used elsewhere — `Button variant="outline" size="sm"`
 (`group relative ml-auto w-24 …`) with a `bg-primary/20` width-driven progress
 fill, a `group-hover`-revealed `IconX` cancel, keeping the existing
 `markResumableDownload` / `markDownloadCancellationRequested` /
 `abortDownload` cancel wiring. Same footprint as the "Download" / "New chat"
 buttons in the other two row states, so the row height is constant across
 idle → downloading → downloaded. Removed the now-unused `Progress` import.
- **Consequences:** No more layout shift when a variant download starts; the
 variant table now matches the Hub-wide pill look. `tsc -b` + eslint clean.
 Scope limited to the one inline surface that the prior pass missed.
- **Amendment (same day) — variant-row pill is pause/resume, cancel moves to the
 download popover.** The PM asked that the in-progress pill on the model-card
 variant rows ([`$modelId.tsx`](web-app/src/routes/hub/$modelId.tsx)) toggle
 **pause/resume** on hover (an `IconPlayerPause` / `IconPlayerPlay` revealed
 over the percent), with **cancel (`IconX`) available only in the title-bar
 download-management popover** ([`DownloadManegement.tsx`](web-app/src/containers/DownloadManegement.tsx)).
 Implemented by mirroring that popover's ATO-154 pause/resume wiring into the
 row: `handlePauseDownload` = `markPausedDownload` + `markResumableDownload` +
 `abortDownload` (the partial GGUF is kept on disk; the global
 `onFileDownloadStopped` paused-branch keeps the `downloads[id]` entry so the
 pill survives with frozen progress), and `handleResumeDownload` = replay the
 stored `resumeParams[id]` via `pullModelWithMetadata(..., resume=true)`.
 Gated by `isPausableDownload` (non-`llamacpp*` / non-`mlx*`) — always true for
 the GGUF variant table, kept as a safety gate (`disabled` + no hover icon
 otherwise). The previous cancel wiring (`markDownloadCancellationRequested` +
 `abortDownload`) and its now-unused import were dropped from the row.
- **Owner:** team.
- **Links:** the same-day ADR *Make the Hub download in-progress state a
 button-shaped "pill" …* (below), the ATO-154 pause/resume model-download work,
 files:
 [`web-app/src/routes/hub/$modelId.tsx`](web-app/src/routes/hub/$modelId.tsx),
 [`web-app/src/containers/DownloadManegement.tsx`](web-app/src/containers/DownloadManegement.tsx)
 (cancel stays here).
