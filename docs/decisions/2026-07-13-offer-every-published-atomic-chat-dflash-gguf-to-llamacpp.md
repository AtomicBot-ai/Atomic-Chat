---
date: 2026-07-13
title: "Offer every published Atomic Chat DFlash GGUF to `llamacpp-upstream`"
---

# 2026-07-13 — Offer every published Atomic Chat DFlash GGUF to `llamacpp-upstream`

- **Context:** Atomic Chat now publishes eight MIT-licensed Q8_0 DFlash GGUF
  conversions on Hugging Face, while the upstream llama.cpp DFlash registry
  covered only three target families and downloaded exclusively from community
  repositories.
- **Decision:** Register the published Atomic Chat Q8_0 drafts for Qwen3 4B/8B,
  Qwen3.5 4B/9B/27B, Qwen3.6 27B, Qwen3-Coder 30B-A3B, and
  Qwen3-Coder-Next. Prefer the Atomic Chat Q8_0 file for the two previously
  supported families while retaining their other community-hosted
  quantizations. Keep Qwen3.6 35B-A3B on its existing community source because
  Atomic Chat does not publish that draft. Pin every Atomic Chat file's live
  Hugging Face LFS SHA-256 and byte size.
- **Consequences:** Users running any matching target are offered the
  additional Q8_0 draft download directly from the Atomic Chat organization.
  Existing quant choices remain available for Qwen3.5 9B, Qwen3.6 27B, and
  Qwen3.6 35B-A3B. Families with only a published Q8_0 draft fall back to that
  sole option when no quant is specified.
- **Owner:** team.
- **Links:** [`extensions/llamacpp-upstream-extension/src/dflashRegistry.ts`](extensions/llamacpp-upstream-extension/src/dflashRegistry.ts),
  [`extensions/llamacpp-upstream-extension/src/dflashRegistry.test.ts`](extensions/llamacpp-upstream-extension/src/dflashRegistry.test.ts),
  [AtomicChat models](https://huggingface.co/AtomicChat/models).
