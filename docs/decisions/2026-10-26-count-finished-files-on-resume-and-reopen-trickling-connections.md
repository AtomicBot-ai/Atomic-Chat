---
date: 2026-10-26
title: "Count a task's finished files on resume, and reopen a connection that only trickles"
---

# 2026-10-26 — Count a task's finished files on resume, and reopen a connection that only trickles

- **Context:** QA 2.2.25 (NEW-04 / AC-10, MacBook Air M3 on flaky Wi-Fi).
  Voxtral is one download task with two files: `model.gguf` (2,473,001,920 B)
  and `mmproj.gguf` (715,714,080 B); a pause cancels the task and keeps its
  files. Three things showed in the app log. (1) A resume fetched a finished
  file again: `mmproj.gguf` finished at 14:20:40, the task was paused at
  14:20:45, and the resume at 14:21:41 began it at "0 of 715714080 bytes";
  later `model.gguf` finished and passed its hash (14:25:51), and the resume
  at 14:43:34 began it at "0 of 2473001920" — the bar fell from 99.33% to 26%
  and 2.4 GB came again. `download_single_file` only looked for a `.tmp` with
  a matching `.url`, and the multi-connection path for a `.parts` map; a
  finished file has been renamed into place and has neither. The free-space
  preflight demanded room for it again too. (2) The other backward jump (2.09
  to 1.53 GB) was the same thing for `mmproj.gguf`. Every resume found at
  least the bytes the bar had shown for the file it resumed; the map only
  ever records landed bytes. But each file reported progress only when its own
  transfer began, so a resumed task's first events summed one file and zero
  for the rest. (3) From 14:25:51 to the pause at 14:35:17 the projector made
  no progress and logged no retry: the idle watchdog fires only after 30 s of
  total silence, a connection's bytes counted only once it had gathered 1 MiB
  or reached its range's end, and a range under two 16 MB minimum segments is
  never split, so a connection that trickled held the file's tail with a
  frozen bar. A fresh connection after the pause fetched those 21 MB in 15 s.
- **Decision:** Three changes in the app's downloader.
  1. **Finished files count.** Once a file's path lock is held and before any
     request, a file already at its save path with the expected size counts
     as downloaded when its hash matches the item's sha256; for an item
     without a hash, only on a resume and with no `.tmp` of the path waiting.
     It is reported at full size, skips the validation pass after the
     transfers (it was just checked), and stale partials of its path are
     removed. A copy that fails its hash is downloaded as before.
  2. **A resume starts where it is.** Before any transfer, a resumed task
     reports what every file keeps — the partial saved for that file's
     identity, or a finished copy — in one event. The free-space preflight
     reads the same number.
  3. **Slow connections.** A connection of a multi-connection download lands
     what it has gathered at least every progress interval (500 ms), not only
     per 1 MiB, so the bar, the map and the "stalled" status follow the bytes
     that arrive. One that brings under 64 KiB in a 30 s idle window is
     reopened from where it stopped, with the "connection too slow" error
     going through the same five-retry budget as a silent one.
- **Consequences:** Resuming a model with its projector costs one hash of the
  finished file (about 16 s for 2.4 GB on an M3) instead of fetching it again;
  the post-download check of that file is skipped, so the total hashing is
  unchanged. Without a catalog hash a same-size file is trusted on a resume:
  Resume does not repair a corrupted file of the right size (removing the
  model does). The first event counts a finished copy before its hash check;
  in the rare case the check fails, that file's share of the bar drops back.
  On a link where each of eight connections gets under about 2 KiB/s (under
  17 KiB/s in all), connections are recycled, and five recycles without 1 MiB
  of progress now fail the download where it used to crawl on. Slow
  connections write more often (once per 500 ms at most). Whether the QA
  stall was a trickle is inferred from the code, not measured: the new
  "connection too slow" retry line will say so on a real network.
- **Owner:** `team`
- **Links:** [`src-tauri/src/core/downloads/helpers.rs`](../../src-tauri/src/core/downloads/helpers.rs),
  [`src-tauri/src/core/downloads/segmented.rs`](../../src-tauri/src/core/downloads/segmented.rs),
  [`src-tauri/src/core/downloads/tests.rs`](../../src-tauri/src/core/downloads/tests.rs);
  builds on [several connections and quiet ones](2026-09-29-fetch-large-files-over-several-connections-and-give-up-on-quiet-ones.md)
  and [verified persisted offsets](2026-07-14-resume-interrupted-model-downloads-from-verified-persisted.md).
