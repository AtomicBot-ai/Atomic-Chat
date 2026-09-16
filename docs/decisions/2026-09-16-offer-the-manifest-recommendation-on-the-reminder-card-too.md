---
date: 2026-09-16
title: "Offer the manifest's recommendation on the reminder card too, and stop waiting for it after 8 s"
---

# 2026-09-16 — Offer the manifest's recommendation on the reminder card too, and stop waiting for it after 8 s

- **Context:** The 2026-09-15 record moved the composer's blocked-send widget
  onto `useRecommendedDownloads`, which reads the manifest's per-tier list
  with the bundled ladder as the fallback, and named the bottom-right reminder
  card (`PromptOnboardingModel`) as the next step: it still read the bundled
  ladder through `useRecommendedLocalModel`, so a manifest override on the
  user's tier made the two surfaces recommend different models. That hook also
  always settled — on a failed repo lookup it showed the card with a disabled
  Download button — whereas the shared hook has no failure state and simply
  never resolves a lead it cannot fetch.
- **Decision:** The card reads `useRecommendedDownloads(1)` and shows its first
  item: the manifest's best fit for this machine, stepped down until it loads,
  with the pinned quant and projector the widget would download. While the
  lead is unresolved the card renders nothing; after the widget's 8 s budget
  it gives up for the session and stays hidden even if the lead arrives later,
  without clearing the reminder, so the next launch gets a fresh try.
  `useRecommendedLocalModel` is deleted; `ONBOARDING_REMINDER_MODELS` stays
  because the reminder store derives its "already on disk" tokens from it.
- **Consequences:** One recommendation on all three surfaces. A late-resolving
  lead no longer pops a nudge into the middle of a session; the cost is that a
  slow-network launch shows no card at all rather than a card with a disabled
  button. The reminder's own visibility logic (`useOnboardingModelReminder`)
  is unchanged and still recognises every rung of the bundled ladder, not
  models a manifest override introduces — a manifest-only model that has been
  downloaded will not switch the reminder off until the provider lists it.
- **Owner:** @danyurkin.
- **Links:** follows
  [2026-09-15 Ask for a model with the same rows and the same list as onboarding](2026-09-15-ask-for-a-model-with-the-same-rows-and-list-as-onboarding.md),
  [`web-app/src/containers/PromptOnboardingModel.tsx`](../../web-app/src/containers/PromptOnboardingModel.tsx),
  [`web-app/src/hooks/useRecommendedDownloads.ts`](../../web-app/src/hooks/useRecommendedDownloads.ts).
