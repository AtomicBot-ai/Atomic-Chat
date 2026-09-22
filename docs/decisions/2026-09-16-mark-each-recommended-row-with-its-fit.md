---
date: 2026-09-16
title: "Mark each recommended row with its fit, and list the picks by it"
---

# 2026-09-16 — Mark each recommended row with its fit, and list the picks by it

- **Context:** The first-run screen leads with one offer whose badge tooltip
  says why it fits this machine (`describeRecommendationFit`, judged by
  `judgeMemoryFit` against the memory pool the weights will occupy). Every
  other row under it — the Hub's curated picks — showed a name and a size and
  nothing else, in the Hub's own order. On an 18 GiB Mac a 20 GB pick could
  head the list above a 7 GB one that runs, and the only way to know which was
  which was to know the machine's memory and Metal's 85 % ceiling by heart.
  Unsloth's quant picker solves the same problem with a coloured "i" per row
  and a sentence on hover ("Full offload likely possible on your system",
  "Exceeds combined VRAM and system RAM budget").
- **Decision:** Every row wears a small circled mark next to its name/size
  line — green when the model fits comfortably, yellow when it will run but
  tight or spilling into system RAM, red when it will not load — with the
  existing `setup:recommend.why*` sentence as its tooltip and as its
  accessible name behind a short level label. The mark is a focusable
  button, so the keyboard and a screen reader reach the same sentence. A row
  whose size or whose machine is unknown wears nothing: "we don't know" is
  never drawn as a warning. The verdict is `judgeMemoryFit` on the size the
  row shows (quant plus projector, or every MLX shard), so the mark and the
  order agree. The picks are listed green, then yellow, then red, then
  unknown, and inside each group the publisher interleave still applies; the
  offer stays first above the list. The mapping (`fitLevel`) and the ordering
  (`orderRowsByFit`) are pure functions in `SetupScreenHelpers.ts`. The level
  labels speak of memory ("Fits your memory", "Runs, but tight on memory",
  "Won't fit in memory"), not of speed, because memory is what was measured:
  on a CPU-only machine the badge keeps explaining the offer by the CPU, while
  the mark reports the memory fit through a `memoryOnly` reading of the same
  copy function.
- **Consequences:** A user reads the list top-down and finds what runs first,
  and a hover or a Tab explains each colour in the machine's own figures. A
  pick whose card resolves after the first paint sits in the unknown group
  until it does, then moves up to its colour; the impressions effect already
  re-reports rows whose index changed, so the funnel stays attributable. Two
  verdicts share the yellow (`tight`, `spills`) — the sentence tells them
  apart. The reply-model gate lists the same models through `RouteRow`, which
  has no slot beside its title, so it does not carry the mark yet; that is a
  follow-up, not a difference of opinion. The mark is a fourth tooltip
  provider per row (one per mark), the same pattern `Capabilities` uses.
- **Owner:** @danyurkin.
- **Links:** [`web-app/src/containers/SetupScreenHelpers.ts`](../../web-app/src/containers/SetupScreenHelpers.ts),
  [`web-app/src/containers/ModelFitIndicator.tsx`](../../web-app/src/containers/ModelFitIndicator.tsx),
  [`web-app/src/containers/SetupScreen.tsx`](../../web-app/src/containers/SetupScreen.tsx),
  [`web-app/src/lib/hardware-tier.ts`](../../web-app/src/lib/hardware-tier.ts);
  builds on the memory-fit copy and the publisher interleave already on the
  screen (see the *Models, Hub & downloads* and *UI / UX* sections).
