---
date: 2026-10-26
title: "Judge an image model against the RAM it shares on a Mac, and ask before a run that will not fit"
---

# 2026-10-26 — Judge an image model against the RAM it shares on a Mac, and ask before a run that will not fit

- **Context:** The image fit (`lib/diffusion/fit.ts`) left a CPU-side text encoder out (always
  the case under Metal) and checked the rest against Metal's ceiling (85 % of RAM). On an 8 GB
  MacBook Air Z-Image Turbo Q3_K_M came out "Might fit" (6.1 GB of 7.3 GB), while sd.cpp held
  6.5 GB of weights in RAM, the 2.5 GB Qwen3 encoder included, next to macOS and the app. The run
  swapped (3 min to stage the weights, 442 s for one of 8 steps) until the core stopped (QA
  2026-10-23). The Video page already asks "This clip won't fit in memory" before such a run; the
  Images page did not. The arbiter's byte count for evicting chat/voice models had the same gap.
- **Decision:** On unified memory with the encoder on the CPU, the fit is also checked against
  RAM less the core's reserve (`UNIFIED_RESERVE_BYTES`, 2.13 GiB) with every file counted
  (`estimateFootprintBytes`); the worse verdict is shown with its own reason, and the offload
  policy stays the GPU side's (offloading on unified memory frees no RAM). The picker's badge and
  the recommended/default quant follow automatically. Generate on a local model whose fit at the
  requested size (`fitForQuant` with `width`/`height`) is "no" opens `ConfirmImageExceedsMemory`
  (needs ~X GB of ~Y GB; it will swap and the engine may stop); Cancel starts nothing. The arbiter
  counts the text encoder on unified memory. Chat models need no change: core GPU residency already
  stops every non-auxiliary session before `sd-server` starts on a Mac (log 14:44:00 → 14:44:01).
- **Consequences:** Over the baseline catalog: on an 8 GB Mac every image quant now reads "Won't
  fit", at 1024² and at 512² (FLUX.2 Klein and Z-Image Q3_K_M read "Good fit"/"Might fit" before);
  on 16 GB the recommended Z-Image Q4_K_M stays "Good fit", FLUX.2 Klein (8 GB bf16 encoder) and
  Z-Image Q8_0 become "Might fit", and every FLUX.1 quant (9.8 GB fp16 T5) becomes "Won't fit" —
  so those users now see the confirmation on Generate. The first-run media step offers only a
  family with a quant that is not "no", so on an 8 GB Mac it no longer offers Z-Image and leaves
  the flow. sd.cpp keeps the encoder's buffers through
  sampling and, under group/model offload, stages the transformer a second time to Metal, so the
  sum is if anything low. The reserve and the 70/90 % shares are estimates for an 8 GB Mac to
  confirm. Windows/Linux and discrete GPUs are unchanged.
- **Owner:** `team`.
- **Links:** `web-app/src/lib/diffusion/fit.ts`, `web-app/src/hooks/useImageGeneration.ts`,
  `web-app/src/containers/images/ConfirmImageExceedsMemory.tsx`,
  `web-app/src/stores/image-generation-store.ts` (arbiter bytes), ADR
  2026-10-26-keep-a-slow-core-that-is-still-alive-attached.
