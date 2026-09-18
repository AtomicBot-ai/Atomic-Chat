---
date: 2026-09-10
title: "Pin the text encoder to CPU under Metal, and restart on the CPU backend after a ggml abort"
---

# 2026-09-10 — Pin the text encoder to CPU under Metal, and restart on the CPU backend after a ggml abort

- **Context:** ggml's Metal backend gates `RMS_NORM` on contiguous rows and calls
  `GGML_ABORT` with no per-op CPU fallback, so an LLM text encoder (Qwen3 for
  Z-Image / FLUX.2, T5 for FLUX.1) takes the whole `sd-server` down mid-generation
  with exit −6. Studio observed this on macos-14 arm64 with FLUX.2-klein Q2_K
  and documented the fix. Some quants abort in the denoise loop as well.
- **Decision:** On macOS the server is always started with `--clip-on-cpu`
  (kill switch `ATOMIC_DIFFUSION_METAL_TE_GPU=1`). The encoder runs once per
  prompt while the DiT runs every step, so pinning only the encoder keeps Metal
  for the part that matters. When the process dies and its tail carries the
  deterministic signature `unsupported op` + `ggml_abort`, the plugin respawns
  it once with `--backend cpu` (every other `--backend` pair stripped, because
  sd.cpp *concatenates* repeated `--backend` values) and marks the session
  `cpuFallback`. Any other death — OOM kill, corrupt file, real bug — is
  surfaced, never retried.
- **Consequences:**
  - First-step latency on Metal is higher than an all-GPU run would be.
  - A CPU fallback is slow and visible in status and in every recipe written
    while it is active, so a surprising render time has a recorded cause.
  - The signature check is a pure function with tests; a change in ggml's
    message wording silently disables the recovery, which is the safe direction.
- **Owner:** `team`.
- **Links:**
  - `src-tauri/plugins/tauri-plugin-atomic-diffusion/src/args.rs`
  - Reference: `metal_text_encoder_flags`, `is_ggml_unsupported_op_abort` in
    `unsloth/studio/backend/core/inference/sd_cpp_args.py`
