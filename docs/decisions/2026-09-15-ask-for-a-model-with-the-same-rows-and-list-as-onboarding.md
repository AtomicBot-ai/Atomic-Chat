---
date: 2026-09-15
title: "Ask for a model with the same rows and the same list as onboarding, and open the Hub from both"
---

# 2026-09-15 — Ask for a model with the same rows and the same list as onboarding, and open the Hub from both

- **Context:** The composer's blocked-send widget (2026-09-07) said "Nothing
  to reply with yet", offered one model from the bundled ladder through
  `useRecommendedLocalModel`, and ended in two wide buttons. Onboarding read
  the manifest's per-tier list through `useResolvedRecommendedModels` and
  showed its cloud routes as rows with marks. So the two screens could
  recommend different models once the manifest overrode a tier, they looked
  like two products, and neither offered the rest of Hugging Face, which
  lives in Models.
- **Decision:** The widget's title says what to do ("Pick a model to start
  chatting"), and its body that the message is saved. Its recommendation is
  the manifest's list for this machine — the tier's best fit with a filled
  button, up to two more as secondary rows that would load here, GGUF only,
  no sizes on the choice — through a new `useRecommendedDownloads` over the
  hook onboarding uses. The other ways to get a model are rows shared with
  onboarding (`RouteRow`): "Any model from Hugging Face" leaves for the Hub
  (widget outcome and onboarding exit `hub`), "ChatGPT subscription" wears
  its mark, the API-key route is called "API key". Onboarding gets the same
  Hugging Face row and always shows its "other ways" section.
- **Consequences:** One list on both surfaces; the manifest's `tiers` now
  drive the widget too. The bottom-right reminder card
  (`PromptOnboardingModel`) still reads the bundled ladder through
  `useRecommendedLocalModel` — it agrees with the widget until a manifest
  override lands on its tier, and moving it is the next step. Leaving for
  the Hub drops the queued send like a dismissal but keeps the message in
  the composer. MLX is not recommended on either surface by design; the
  Hugging Face row's hint names MLX only on macOS.
- **Owner:** @danyurkin.
- **Links:** supersedes the single-model recommendation in
  [2026-09-07 Answer a blocked send with a widget, not a red line](2026-09-07-answer-a-blocked-send-with-a-widget-not-a-red-line.md),
  [`web-app/src/containers/ReplyModelGate.tsx`](../../web-app/src/containers/ReplyModelGate.tsx),
  [`web-app/src/containers/RouteRow.tsx`](../../web-app/src/containers/RouteRow.tsx),
  [`web-app/src/hooks/useRecommendedDownloads.ts`](../../web-app/src/hooks/useRecommendedDownloads.ts),
  [`web-app/src/containers/SetupScreen.tsx`](../../web-app/src/containers/SetupScreen.tsx).
