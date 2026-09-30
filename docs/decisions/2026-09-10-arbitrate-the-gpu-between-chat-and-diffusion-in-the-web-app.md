---
date: 2026-09-10
title: "Arbitrate the GPU between chat and diffusion in the web app"
---

# 2026-09-10 — Arbitrate the GPU between chat and diffusion in the web app

- **Context:** An image model and a chat model rarely fit on one consumer GPU
  together. Studio solves this with a Python `gpu_arbiter` (owners
  CHAT | DIFFUSION | VIDEO, eviction under one lock, then waiting for the driver
  to release VRAM). In Atomic Chat the chat engines' caches (`sessionCache`,
  `loadingModels`, idle timers) live in the TypeScript extensions, so a
  Rust-side kill would leave them stale — the same reason the proxy's
  auto-increase reload round-trips into TS.
- **Decision:** Arbitration lives in `web-app/src/lib/diffusion/arbiter.ts`.
  `acquireGpuForDiffusion` unloads every non-embedding session on every
  `EngineManager` engine when the fit estimate says the image model will not
  coexist (setting `evictChatModel: whenNeeded | always`); embedding sessions
  stay for RAG; the voice model is unloaded only when still needed afterwards.
  The reverse path, `releaseGpuForChat`, unloads the diffusion session before a
  chat model load that would not fit. On CUDA/ROCm the plugin waits 500 ms
  before spawning so the driver can reclaim VRAM; Metal needs no settle.
- **Consequences:**
  - Because the diffusion session is not a chat session, `performLoad`'s
    auto-unload can never kill it by accident; the cost is that the reverse
    eviction must be called explicitly at the chat model-load chokepoint.
  - Fit is estimated in binary units end to end (`budgetMib × 1024²`); the
    catalog stores exact bytes from the HF API. Mixing decimal GB here sends
    capable hosts to the smallest quant.
  - The idle-unload timer (default 10 minutes, Rust-owned so a hidden webview
    does not matter) frees the GPU for chat without user action.
- **Owner:** `team`.
- **Links:**
  - `web-app/src/lib/diffusion/{arbiter,fit}.ts`
  - Reference: `unsloth/studio/backend/core/inference/gpu_arbiter.py`
