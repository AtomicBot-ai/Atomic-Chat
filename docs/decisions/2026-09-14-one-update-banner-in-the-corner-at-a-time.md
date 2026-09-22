---
date: 2026-09-14
title: "One update banner in the bottom-right corner at a time"
---

# 2026-09-14 — One update banner in the bottom-right corner at a time

- **Context:** ATO-533 added an app-version banner next to the engine banner
  from ATO-528, and required that the two never stack. Three things now want
  `fixed bottom-3 right-3`: the app-update offer, the engine-update offer, and
  the unattended backend-download progress `<BackendUpdater />` has rendered
  there since before either. They are mounted in different subtrees and none of
  them can see the others, so "only one at a time" cannot be a local decision.

- **Decision:** A tiny zustand store, `update-banner-store`, holds one claim per
  slot and hands the corner to the first of `download → app → engine` that wants
  it; each banner calls `useUpdateBannerSlot(slot, wantsToShow)` and renders only
  on `true`. A live transfer outranks both offers because it is over in minutes
  and self-resolving, while an offer stays up until it is acted on — hiding
  progress behind an offer would make a multi-minute download look like nothing
  was happening. The two banners themselves share one presentational component,
  `<UpdateBanner />`, so the family resemblance the issues asked for is
  structural rather than a copied stylesheet.

- **Consequences:** Adding a fourth thing to that corner means adding a slot to
  one priority list rather than finding every other component that renders
  there. The suppressed banner is not queued or remembered — it simply renders
  again on the next paint after the winner steps down, which is what makes the
  claim safe to derive from render state. A claim is released on unmount, so a
  conditionally mounted banner cannot strand the corner. `<UpdateBanner />` owns
  no copy: labels, including the "+N more" line, arrive already translated, so
  the component stays out of i18n's way.

- **Owner:** @m-skvortsov

- **Links:** [ATO-533](https://linear.app/atomicchat/issue/ATO-533),
  [ATO-528](https://linear.app/atomicchat/issue/ATO-528),
  `web-app/src/stores/update-banner-store.ts`,
  `web-app/src/containers/UpdateBanner.tsx`,
  `web-app/src/containers/dialogs/AppUpdater.tsx`,
  `web-app/src/containers/dialogs/BackendUpdater.tsx`
