---
date: 2026-09-17
title: "Lay the onboarding rows out as one column: a fit badge with a word, the size inside the button, one button width"
---

# 2026-09-17 — Lay the onboarding rows out as one column: a fit badge with a word, the size inside the button, one button width

- **Context:** Danny test-drove the 2.0.39-fixes build on a 64 GB M5 Max and
  sent layout feedback on the first-run screen
  (`web-app/src/containers/SetupScreen.tsx`). The per-row fit mark (a circled
  i / ! from the 2026-09-16 fit-indicator record) sat in a `flex-wrap` line
  after the name and its " · 2.5 GB" suffix, so it wrapped under some names
  and not others and the marks drifted out of line down the list. The
  Download buttons were fat: `RowActionLabel` stacked an invisible copy of
  every label a row button could wear ("Downloading…" the widest) inside each
  button so the column stayed one width, which padded "Download" by ~30 px a
  side. While a download ran, the "12% · 0.20 / 1.60 GB" readout rendered in
  the button column before the pill and shoved it left. The route rows' marks
  (Hugging Face, ChatGPT, Cloud) drew 16 px glyphs in a 32 px circle beside
  32 px model logos. The content column was 520 px.
- **Decision:** Every row on the screen is mark (32 px) · one name line ·
  one hint line · one button, and the buttons of every list stand in one
  column. (1) The fit mark is a badge with a word — Fits / Tight / Won't fit
  (`setup:recommend.fitBadge*`) — in the style of the source badges the
  on-disk rows wear (`ModelSourceBadge`: 10 px uppercase, 6 px radius,
  emerald / amber / red with dark variants). `ModelFitIndicator` keeps its
  props and its accessible name (level label + reason) and tooltip (reason),
  and translates the word itself, so other lists get it unchanged. The name
  line no longer wraps: the name truncates, the badges are `shrink-0`.
  (2) The size rides inside the button — "Download 2.5 GB", the size the row
  already quoted (`getTotalDownloadFileSize`, one decimal), plain "Download"
  when unknown, "Downloaded" as before — and leaves the name. (3) One width
  for every action button through `ROUTE_ROW_ACTION_CLASS =
  'min-w-[9.25rem] shrink-0 rounded-full px-3'`: 148 px holds the widest
  label, "Download 19.7 GB" at 117.5 px in Inter Medium 14 px, with the
  size's own 12 px padding; shorter labels (Browse, Add, Run) centre in it;
  a longer label (a German "Herunterladen 19.7 GB") widens its own button
  rather than clipping. `RowActionLabel` and its `rowActionLabels` list are
  retired — the class does the job for every consumer of `RouteRow` too.
  (4) While a download runs the slot shows the same-width "Downloading… ×"
  pill and the readout takes the hint line under the name, `aria-live`
  kept; the offer, which has no summary, keeps that line empty so its
  button does not move when the readout appears. This amends the 2026-09-16
  "stay on the Welcome screen" record, which put the figures beside the
  pill. (5) `RouteRow`'s icon slot draws an svg at 20 px and lets a brand
  image fill the 32 px circle. (6) The content column is 640 px, which still
  sits inside the 1024 px minimum window beside the sidebar.
- **Consequences:** Badges line up down the list and say what they mean
  without a hover; the button column is one straight edge from the on-disk
  rows through the picks to Browse / Connect / Add, and it does not move
  when a download starts or ends. The reply-model gate and the vision-model
  dialog share `ROUTE_ROW_ACTION_CLASS`, so their buttons widen to the same
  148 px pill — intended, since they are the same rows, but their lists are
  narrower and want a look in the app. The width is a measured constant, not
  a per-language reservation: a locale whose "Download …" label outgrows it
  gets one wider button in the column. The offer's second line is blank until
  a download starts; if that reads as a gap, the fit sentence could fill it,
  which the 2026-09-16 fit record chose not to do. The on-disk rows keep
  their " · 4.0 GB" beside the name: "Run 4.0 GB" would say nothing.
- **Owner:** @danyurkin.
- **Links:** [`web-app/src/containers/SetupScreen.tsx`](../../web-app/src/containers/SetupScreen.tsx),
  [`web-app/src/containers/RouteRow.tsx`](../../web-app/src/containers/RouteRow.tsx),
  [`web-app/src/containers/ModelFitIndicator.tsx`](../../web-app/src/containers/ModelFitIndicator.tsx),
  [`web-app/src/containers/__tests__/SetupScreen.test.tsx`](../../web-app/src/containers/__tests__/SetupScreen.test.tsx);
  amends 2026-09-16 "Stay on the Welcome screen until the download lands"
  (readout placement) and builds on 2026-09-16 "Mark each recommended row
  with its fit" (the badge's meaning, name and tooltip are unchanged).
