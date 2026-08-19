---
date: 2026-08-19
title: 'Offer a low-spec model tier in onboarding'
---

# 2026-08-19 — Offer a low-spec model tier in onboarding

- **Context:** onboarding recommended the same two models to everyone —
  `AtomicChat/Qwen3.5-4B-GGUF` and `AtomicChat/gemma-4-E2B-it-GGUF`. Field
  evidence says most users are on weaker machines than those assume, so the
  first model a new user downloaded was often one their hardware could not run
  well: a multi-gigabyte download followed by a slow first impression.

- **Decision:** the recommended-models manifest gains a sibling
  `low_spec_recommendations` array that **replaces** `recommendations` on
  machines `classifyHardwareTier` (`web-app/src/lib/hardware-tier.ts`) calls
  low-spec. Those machines are offered `LiquidAI/LFM2.5-2.6B-GGUF` (Q4_K_M,
  1.67 GB) and `LiquidAI/LFM2.5-VL-450M-GGUF` (Q8_0, 379 MB). Three parts are
  load-bearing:

  1. **A sibling array, not a per-entry `tier` field.** `fetchManifest` rebuilds
     the manifest from a fixed three-key whitelist, so a client built before
     this key existed ignores it and keeps showing `recommendations` exactly as
     today. A per-entry field would instead be stripped by
     `sanitizeRecommendation`, leaving old clients showing *both* lists — the
     inverse of the intent, and silently. `schema_version` stays `1` for the
     same reason: bumping it makes old clients reject the manifest and fall back
     to their bundled baseline permanently. The two arrays are disjoint by
     construction, so "replace, don't supplement" is enforced by the manifest's
     shape rather than by client logic (asserted in
     `tests/registry-contracts.test.mjs`).

  2. **The tier branches are ordered, not OR-ed.** macOS is checked *first*, on
     unified memory. `vendor/vulkan.rs` returns an empty GPU list on macOS
     unconditionally (inference goes through Metal; MoltenVK's relative dlopen
     breaks under Hardened Runtime), so every Mac reports zero VRAM — a flat
     `RAM < 16 GB OR VRAM < 8 GB` rule would classify a 128 GB M3 Max as
     low-spec. Non-Macs are judged on **max** single-GPU VRAM rather than the
     sum: two 4 GB cards cannot hold an 8 GB model. Unknown hardware yields
     `null` and the caller assumes `standard`, so a slow enumeration never
     downgrades a fast machine.

  3. **Quants are pinned per entry.** `quant` and `mmproj_quant` pins flow from
     the manifest through to `pullModelWithMetadata`. Without them both failures
     are silent: the VL repo also ships a Q4_K_M that
     `DEFAULT_MODEL_QUANTIZATIONS` matches, and `getPreferredMmprojModel` looks
     for the literal id `mmproj-f16`, which never matches LiquidAI's
     `mmproj-LFM2_5-VL-450m-F16`, so it falls through to `mmproj_models[0]` —
     the 181 MB BF16 projector instead of the 98 MB Q8_0 one. Each case
     downloads a working-but-wrong file and reports no error anywhere.

  Supersedes the model list in
  [2026-08-07 — Let onboarding time out into the chat and recommend two GGUF models](2026-08-07-let-onboarding-time-out-into-the-chat-and-recommend-two-gguf.md)
  for low-spec machines only; the standard pair set by
  [2026-08-14 — Recommend our own Gemma 4 E2B build in onboarding](2026-08-14-recommend-our-own-gemma-4-e2b-build-in-onboarding.md)
  is unchanged for everyone else.

- **Consequences:** weak machines get a first model that actually runs, and the
  tier is reported on `setup_screen_shown` (`hardware_tier`,
  `hardware_tier_resolved`) so we can tell how often it fires. Costs: the
  recommendation JSON now exists in three places that must stay in sync (the
  conf manifest, `BASELINE_LOW_SPEC_RECOMMENDED_MODELS`, and the contract
  fixture); a third tier would mean a third array; and the picker now waits on
  hardware enumeration behind a 4 s deadline shared with the on-disk scan.
  **Watch for:** `ONBOARDING_REMINDER_MODEL_HF_REPO` is not tier-aware, so the
  bottom-right reminder still offers Qwen3.5-4B on a low-spec machine that
  skipped onboarding. Also note `LFM2.5-VL-450M` is a small vision model and a
  weak general chat model; the 2.6B is listed first for that reason.

- **Owner:** `team`

- **Links:** `web-app/src/lib/hardware-tier.ts`,
  `web-app/src/hooks/useHardwareTier.ts`,
  `web-app/src/services/recommended-models-registry.ts`,
  `atomic-chat-conf/models/recommended.json`,
  `atomic-chat-conf/models/schema.json`,
  https://huggingface.co/LiquidAI/LFM2.5-2.6B-GGUF,
  https://huggingface.co/LiquidAI/LFM2.5-VL-450M-GGUF
