---
date: 2026-09-17
title: "Warn before a download that won't fit in memory; red rows only"
---

# 2026-09-17 — Warn before a download that won't fit in memory; red rows only

- **Context:** Since 2026-09-16 every recommended row wears a fit mark —
  green, yellow, red — whose sentence says how the file measures against
  this machine's memory pool (`judgeMemoryFit`, `describeRecommendationFit`).
  The mark was the only thing the verdict fed: the row's Download button
  started the transfer regardless. Danny, test-driving the 2.0.39 build on a
  64 GB M5 Max, clicked Download on a red row and the download simply began;
  nothing said the file would come down and then refuse to load. Red means
  exactly that — past Metal's 85 % ceiling the allocation fails outright, a
  measured 87.5 % of the time — so the click was a promise the app knew it
  could not keep. The only preflight a download had was the disk-space one,
  which asks a different question (will it fit on the drive) at a later
  point (inside `pullModelWithMetadata`).
- **Decision:** A red row's Download asks first. A dialog titled "This model
  won't fit in memory" repeats the row — its name, then the mark's own
  sentence in the machine's figures ("19.7 GB — needs more than your 64 GB
  of unified memory.") — adds the consequence ("It will download, but it
  will not load. Download anyway?") and offers "Cancel" and "Download
  anyway". Cancel is the default answer: it takes focus, so Enter, Escape,
  the close button and a click outside all leave the row as it was, with
  nothing started and nothing recorded. "Download anyway" runs the click's
  original body unchanged — telemetry, download-handoff arming, the
  transfer — so the memory question is asked before the disk-space one and
  both stand. Yellow rows are not asked: a model that runs tight or spills
  into system RAM still runs, the mark already says how, and a dialog there
  would cry wolf on the machines where most downloads are yellow. A row
  whose size or whose machine is unknown has no colour and is never asked;
  "we don't know" is not a warning here either. The guard is one hook,
  `useConfirmWontFitDownload` (`guardWontFit(row, start)`), with one dialog,
  `ConfirmWontFitDownload`, rendered by each list that calls it: the
  onboarding picker and the reply-model gate, which judges the file its row
  would fetch through the same `describeRecommendationFit` so the two
  surfaces never disagree about a model. The dialog follows the Full-access
  confirmation of 2026-09-16 (shadcn `Dialog`, ghost Cancel, primary accept
  — no destructive red, the row's mark already carries the colour). The
  copy lives under `setup:wontFitDialog.*`; Cancel reuses `common:cancel`.
- **Consequences:**
  - A red download costs two clicks and cannot happen by accident; a green
    or yellow one is exactly as before. There is no "don't ask again": the
    dialog is per click, like the Full-access one.
  - `recommended_model_clicked` fires from the start, so a cancelled dialog
    leaves no event — the funnel keeps its meaning of "a download was asked
    for from this row" and gains no new state. How often the warning fires
    and is waved through is not measured; that is a follow-up event, not a
    change to this one.
  - Red is a macOS verdict (`hardCeiling`); on a card or a CPU-only machine
    the same overshoot is yellow and never asks, which is the point — there
    it runs.
  - The reply gate imports the fit copy from `SetupScreen.tsx`, where it
    already lived for the onboarding badge; the module is in the main bundle
    through the index route, so nothing new is loaded. Its test now stubs
    the recommended-models registry store, as the onboarding test does,
    because that store fetches at import time.
- **Owner:** @danyurkin.
- **Links:** [`web-app/src/hooks/useConfirmWontFitDownload.ts`](../../web-app/src/hooks/useConfirmWontFitDownload.ts),
  [`web-app/src/containers/ConfirmWontFitDownload.tsx`](../../web-app/src/containers/ConfirmWontFitDownload.tsx),
  [`web-app/src/containers/SetupScreen.tsx`](../../web-app/src/containers/SetupScreen.tsx),
  [`web-app/src/containers/ReplyModelGate.tsx`](../../web-app/src/containers/ReplyModelGate.tsx),
  [`web-app/src/locales/en/setup.json`](../../web-app/src/locales/en/setup.json) (`wontFitDialog`);
  builds on 2026-09-16-mark-each-recommended-row-with-its-fit.md and
  2026-09-16-confirm-full-access-before-enabling-it.md; sits in front of
  2026-09-16-check-disk-space-before-a-download-starts.md.
