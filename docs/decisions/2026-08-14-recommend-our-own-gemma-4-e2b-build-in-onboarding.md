---
date: 2026-08-14
title: 'Recommend our own Gemma 4 E2B build in onboarding'
---

# 2026-08-14 — Recommend our own Gemma 4 E2B build in onboarding

- **Context:** the second onboarding recommendation pointed at
  `unsloth/gemma-4-E2B-it-GGUF`, so the first Gemma a new user downloaded came
  from a third-party quantizer even though `AtomicChat/gemma-4-E2B-it-GGUF`
  exists and is what Hub staff picks already offer under "Gemma 4 E2B". The two
  entry points into the same model disagreed on its source.

- **Decision:** onboarding recommends `AtomicChat/gemma-4-E2B-it-GGUF`.
  `atomic-chat-conf/models/recommended.json`, the bundled
  `BASELINE_RECOMMENDED_MODELS` mirror and the
  `tests/fixtures/registries/recommended-models.json` contract fixture all name
  the AtomicChat repo. Supersedes the model list in
  [2026-08-07 — Let onboarding time out into the chat and recommend two GGUF models](2026-08-07-let-onboarding-time-out-into-the-chat-and-recommend-two-gguf.md);
  everything else in that record stands, including the reminder popup, which
  tracks the *first* entry (`AtomicChat/Qwen3.5-4B-GGUF`) and is unaffected.

- **Consequences:**
  - Onboarding's Gemma is now text-only. Our E2B repo ships no `mmproj`, while
    the unsloth repo shipped `mmproj-{F16,BF16,F32}.gguf` plus MTP draft
    weights, so the pick loses image and audio input and speculative decoding.
    `SETUP_SCREEN_QUANTIZATIONS` is satisfied — the repo has
    `gemma-4-E2B-it-Q4_K_M.gguf` — so the quick-start download itself is
    unaffected. Vision on Gemma 4 remains available through Hub via
    `AtomicChat/gemma-4-E4B-it-GGUF`, which does ship an `mmproj`.
  - The existing `AtomicChat/gemma-4-E2B-it-GGUF` staff pick still declares
    `vision` and `audio` categories, which the GGUF build cannot serve without
    an `mmproj`. Badges come from the manifest by
    [2026-08-07 — Take Recommended capability badges from the staff-picks manifest](2026-08-07-take-recommended-capability-badges-from-the-staff-picks-manifest.md),
    so those two categories are wrong today. Left as-is here because fixing them
    is a Hub curation change, not an onboarding one.
  - `RECOMMENDED_MODEL_FALLBACKS` snapshots neither repo, so the entry keeps
    resolving through the catalog / Hugging Face API exactly as before. The
    AtomicChat org is scraped into `catalog.json`, so the new entry resolves
    from the catalog rather than needing a direct API call.
  - The `recommended-models.json` fixture continues to run ahead of the pinned
    `atomic-chat-conf` revision in `tests/fixtures/registries/sources.json`;
    refresh the revision once the manifest lands on `main`.

- **Owner:** `team`

- **Links:**
  - `atomic-chat-conf/models/recommended.json`
  - [`web-app/src/constants/models.ts`](../../web-app/src/constants/models.ts)
  - [`tests/fixtures/registries/recommended-models.json`](../../tests/fixtures/registries/recommended-models.json)
