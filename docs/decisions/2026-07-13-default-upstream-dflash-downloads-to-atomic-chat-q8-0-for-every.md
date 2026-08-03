---
date: 2026-07-13
title: "Default upstream DFlash downloads to Atomic Chat Q8_0 for every target quantization"
---

# 2026-07-13 — Default upstream DFlash downloads to Atomic Chat Q8_0 for every target quantization

- **Context:** The upstream DFlash picker defaulted to a community Q4_K_M
  draft even when the selected target family had a verified Atomic Chat Q8_0
  conversion. Target-model quantization does not constrain the separate
  DFlash draft quantization, so IQ4, Q4, Q5, and other target GGUFs can all
  pair with the same Q8_0 draft.
- **Decision:** Change the registry and picker default from Q4_K_M to Q8_0.
  When an Atomic Chat Q8_0 draft exists, enabling DFlash now selects and
  downloads it regardless of the target model's quantization. Keep the other
  compatible draft quantizations available for explicit selection, and keep
  community Q8_0 as the fallback for families without a published Atomic Chat
  conversion.
- **Consequences:** Atomic Chat's draft repositories become the default test
  path without removing previously supported community drafts or changing
  existing `dflash_draft_path` values. Qwen 3.6 35B-A3B continues to use its
  verified community-hosted Q8_0 draft until an Atomic Chat conversion is
  published.
- **Owner:** team.
- **Links:** [`extensions/llamacpp-upstream-extension/src/dflashRegistry.ts`](extensions/llamacpp-upstream-extension/src/dflashRegistry.ts),
  [`web-app/src/containers/dialogs/LlamacppDflashDraftDialog.tsx`](web-app/src/containers/dialogs/LlamacppDflashDraftDialog.tsx).
