---
date: 2026-09-17
title: "Keep the download panel's readout on one fixed line"
---

# 2026-09-17 — Keep the download panel's readout on one fixed line

- **Context:** Danny's 2.0.39 test drive on macOS: in the bottom-right
  download panel the "downloaded GB" readout wrapped onto a second line and
  the whole card shifted. The row's readout was two flex spans — `42% · 4.20 /
  12.40 GB` on the left, `18.4 MB/s · 12m 56s left` on the right — and only
  the right one had `nowrap`. The row has 320 px (the panel is a fixed 22 rem;
  list and row padding take 32). Measured with the bundled Inter at the
  default font size the worst realistic content needs 299.5 px, twenty pixels
  of headroom on text that changes every few seconds; at the Large and Extra
  Large font settings it needs 336 and 372 px, because `text-xs` scales with
  `--font-size-base` while the panel's `22rem` sits on the root em and does
  not. Past 320 px flexbox shrinks both spans, the left one breaks at its
  spaces, the size pair drops to a second line, and since the panel is
  anchored at the bottom its top edge moves up and `--download-panel-offset`
  moves the widgets stacked above it.
- **Decision:** A download row shows one readout line — percent · downloaded
  of total · time left, built by `formatDownloadReadout` in
  `lib/downloadFormat.ts` — as a single `truncate tabular-nums` element that
  never wraps. The parts are ordered by how much they matter, so a line that
  still cannot fit is cut with an ellipsis at its end, the estimate, and
  never at the size. The transfer speed is no longer shown in the panel: it
  is what pushed the row past its width, the estimate already folds it in,
  and the reply gate has quoted a running download without it since
  2026-09-16. The panel keeps its fixed `min(22rem, calc(100vw - 2rem))`
  width, which `panelLayout` mirrors as 352 px: the one-line readout needs
  225 px at the default size and 281 px at Extra Large, so it fits at every
  font setting with room to spare, and the width never follows the digits or
  the number of rows.
- **Consequences:** The row is one line shorter in information (no MB/s) and
  never grows in height while a transfer runs; the card and the widgets above
  it stay put. `formatSpeed` stays in the lib for the Hub and the store's
  sampling. The reply gate builds the same string in its own `inFlightHint`
  and can adopt `formatDownloadReadout` when that file is next touched. A
  download over 100 GB at the Extra Large setting is the one case that still
  exceeds the line; it loses the tail of the estimate to an ellipsis rather
  than wrapping. The quant line under the name is untouched.
- **Owner:** @danyurkin.
- **Links:** follows
  [2026-09-16 Show the running download first in the reply gate](2026-09-16-show-the-running-download-first-in-the-reply-gate.md);
  [`web-app/src/containers/downloads/DownloadProgressRow.tsx`](../../web-app/src/containers/downloads/DownloadProgressRow.tsx),
  [`web-app/src/containers/downloads/DownloadPanel.tsx`](../../web-app/src/containers/downloads/DownloadPanel.tsx),
  [`web-app/src/containers/downloads/panelLayout.ts`](../../web-app/src/containers/downloads/panelLayout.ts),
  [`web-app/src/lib/downloadFormat.ts`](../../web-app/src/lib/downloadFormat.ts).
