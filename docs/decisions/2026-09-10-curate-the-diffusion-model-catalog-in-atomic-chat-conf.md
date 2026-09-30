---
date: 2026-09-10
title: "Curate the diffusion model catalog in atomic-chat-conf"
---

# 2026-09-10 — Curate the diffusion model catalog in atomic-chat-conf

- **Context:** A diffusion checkpoint for sd.cpp is not one file: a GGUF
  transformer plus a VAE plus one or two text encoders, wired to family-specific
  flags (`--llm`, `--qwen2vl`, `--clip_l`/`--t5xxl`). Quant ladders and GGUF
  uploads churn faster than app releases. The voice feature pins one model in a
  constants file; four families with ladders is data, not code.
- **Decision:** `atomic-chat-conf/models/diffusion.json` (schema
  `schema.diffusion.json`) is the source of truth, loaded remote → cache →
  bundled baseline exactly like the recommended-models registry. Every size is
  the exact byte count from the Hugging Face API, and files carry `sha256` from
  the LFS metadata. Phase 1 families: Z-Image Turbo, FLUX.2 Klein 4B, FLUX.1
  schnell and Qwen-Image, each with a Q3_K_M…Q8_0 ladder (Q2_K excluded — it
  aborts on Metal). Side files were taken from Studio's verified family table.
  Z-Image ships with the 2.4 GB GGUF Qwen3 encoder
  (`unsloth/Qwen3-4B-Instruct-2507-GGUF`, Q4_K_M) that upstream documents for
  `--llm`; it was verified on the pinned build on Apple Silicon (readiness,
  job API, step lines, and a correct 512×512 render in 45 s), which cuts the
  default install from 13.3 GB to 7.7 GB. Klein keeps the 8 GB safetensors
  encoder Studio verified until the GGUF one is tested against it too. Z-Image
  and FLUX.1 share the FLUX VAE — the ungated Z-Image mirror's `ae.safetensors`
  is byte-identical to Black Forest Labs' gated one, so no HF token is needed.
  Shared side files are stored once under `models/shared/<repo>/`.
- **Consequences:**
  - The download plan is a pure function of catalog + files on disk; a shared
    encoder is fetched once and deleted only when no installed artifact needs it.
  - Filenames are validated on parse (no `..`, `.gguf`/`.safetensors` only), so
    a malformed manifest cannot steer a download outside the models root.
  - The 8 GB safetensors Qwen3 encoder is now the largest part of a Klein
    install; moving Klein to a GGUF encoder is a catalog-only change once it is
    verified the same way (`scripts/test-local-diffusion.py`).
  - Defaults and ranges travel with the family into the plugin at load time, so
    the OpenAI facade and request validation never read the catalog.
- **Owner:** `team`.
- **Links:**
  - `atomic-chat-conf/models/diffusion.json`, `models/schema.diffusion.json`
  - `web-app/src/services/diffusion-catalog-registry.ts`
  - Reference: `unsloth/studio/backend/core/inference/diffusion_families.py`
