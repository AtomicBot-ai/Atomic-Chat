---
date: 2026-09-16
title: "Explain why images need a vision model, and offer the ones that run here"
---

# 2026-09-16 — Explain why images need a vision model, and offer the ones that run here

- **Context:** With a text-only model selected, "Add images" opened a small
  bottom-right popover that named one hard-coded model ("Download Atomic Bot
  V2 VL, our recommended vision model", `janhq/Jan-v2-VL-high-gguf`) in
  untranslated English and never said what was wrong. Users read it as an ad
  and closed it; the CPO's own recording showed the same. Meanwhile the app
  already knew which repos are vision (`mmproj_models` on the catalog card,
  `mmproj_quant` in the recommended manifest, the `vision` category on staff
  picks) and already downloaded the projector alongside the weights.
- **Decision:** Replace the popover with a real dialog
  (`VisionModelDialog`) that says in plain words that the model in use is
  text-only, and lists the vision models this machine can run — the manifest's
  vision entries for the tier plus staff picks curated as `vision`, GGUF only,
  memory-gated with the same `judgeMemoryFit` as onboarding — each with a
  Download button, a model already on disk with Use, and "any vision model
  from Hugging Face" leading to the Hub (`useVisionDownloads`). No model name
  lives in code; the `JAN_V2_VL_*` constants are gone. The rows are the
  reply-model gate's `RouteRow`, so the two gates read as one product.
  Three lines that decide the list: in llama.cpp, vision is a
  vision-language checkpoint plus the multimodal projector (`mmproj-*.gguf`)
  trained for that exact checkpoint, from the same repo. A text-only model
  cannot be given sight by downloading a projector alone, so "get vision"
  always means "download a vision model together with its projector". A repo
  is therefore offered only once its card confirms a projector is there to
  fetch — a `vision` tag without one (two staff picks today) is not enough.
- **Consequences:** The offer is data-driven: adding a vision entry to a
  tier in `atomic-chat-conf/models/recommended.json`, or tagging a staff pick
  `vision`, changes the dialog without a release. The import listener lives in
  the always-mounted shell so the composer still switches to the model when a
  download the user closed the dialog on lands. What to watch: the manifest
  carries vision rungs only for the 12 GiB and 16 GiB tiers, and the
  low-spec `LFM2.5-VL-450M` sits in the `low_spec_recommendations` list this
  client ignores — small machines see only whichever staff picks fit.
  Staff-pick resolution is narrowed to vision picks (`useStaffPicks(…, only)`)
  so opening the dialog costs a dozen Hugging Face lookups, not forty, shared
  with the Hub's cache.
- **Owner:** @danyurkin.
- **Links:** `web-app/src/containers/dialogs/VisionModelDialog.tsx`,
  `web-app/src/hooks/useVisionDownloads.ts`,
  `web-app/src/containers/ReplyModelGate.tsx` (the sibling gate),
  `web-app/src/hooks/useRecommendedDownloads.ts` (the pattern),
  `atomic-chat-conf/models/recommended.json`, `atomic-chat-conf/models/staff-picks.json`.
