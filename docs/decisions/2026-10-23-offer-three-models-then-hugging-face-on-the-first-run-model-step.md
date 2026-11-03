---
date: 2026-10-23
title: "Offer three models, then Hugging Face, on the first-run model step"
---

# 2026-10-23 — Offer three models, then Hugging Face, on the first-run model step

- **Context:** The model step showed the tier's offer and up to three staff
  picks. The offer had no description and a pick without a summary had none
  either, so rows looked different from one another, and nothing beyond the
  four was offered. The approved prototype (`807b4d9`, `ModelSelection.tsx`)
  now asks for exactly three recommendations, a one-line tagline on every row,
  and a Hugging Face list after them, under a raised bar that names the choice.
- **Decision:** "Recommended for this device" is the tier's offer and two picks
  this machine runs. Every row carries a tagline: a staff pick's summary for
  any upload of the same model (matched by repo name without publisher and
  format), otherwise one of eight phrases read off the repo's name and tags
  (`lib/onboarding/taglines.ts`: purpose, then size or MoE, then vision). The
  Hugging Face section lists the twelve most downloaded GGUF chat repos of the
  bundled/remote curated catalog (`useModelSources`) that fit, one upload per
  base model, none already offered or installed. It leaves out media, speech
  and embedding repos and builds whose safety training was removed
  (uncensored, abliterated). The catalog, not the live Hugging Face listing,
  because it carries file sizes offline and with no request per row, and the
  live trending list is mostly such builds and non-chat models.
- **Consequences:** Rows read the same on every machine and network. The list
  follows the catalog's download counts, which refresh with the catalog, not
  in real time. Heuristic taglines are coarse; a model that matters should get
  a staff-pick summary. Memory is an estimate (download × 1.2 + 0.5 GB), shown
  next to the size; the fit warning stays only for a model that will not load.
- **Owner:** `team`.
- **Links:** `web-app/src/containers/onboarding/useModelOptions.ts`,
  `web-app/src/containers/onboarding/steps/ModelStep.tsx`,
  `web-app/src/lib/onboarding/taglines.ts`; prototype
  `web-app/src/preview/onboarding/ModelSelection.tsx`.

<!--
Supersedes: 2026-09-11-list-the-hub-picks-under-the-onboarding-offer.md (in part: three picks, not four)
-->
