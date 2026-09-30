---
date: 2026-09-10
title: "Generate images locally with stable-diffusion.cpp in its own Tauri plugin"
---

# 2026-09-10 — Generate images locally with stable-diffusion.cpp in its own Tauri plugin

- **Context:** Users asked for local image (and later video) generation
  (ATO-513, ATO-514). Nothing in the tree touched diffusion. Unsloth Studio, the
  reference we followed, runs two engines: Python diffusers on CUDA/ROCm and
  `stable-diffusion.cpp` (`sd-server`) on CPU and Apple Metal, selected by a pure
  function. Atomic Chat ships no Python; its only Python-shaped backend is the
  PyInstaller `mlx-vlm` sidecar, which is bundled into the macOS installer and
  would be several gigabytes for a torch+CUDA build.
- **Decision:** Phase 1 generates images with `stable-diffusion.cpp` only, on
  every desktop platform (Metal / CUDA / Vulkan / ROCm / CPU prebuilts), driven
  by a new Rust plugin `tauri-plugin-atomic-diffusion` that spawns one resident
  `sd-server` per loaded model, submits jobs to its `/sdcpp/v1/*` API, parses
  step progress from the server's verbose stdout, and owns the gallery on disk.
  The web app talks to it through `services/diffusion/{types,default,tauri}.ts`,
  the same seam shape as voice input. The plugin holds exactly one session
  (`Option<DiffusionSession>`), not a map: one GPU, one selected model. A Python
  diffusers sidecar speaking the same job protocol is phase 1b (see the
  `capabilities.cancel_generating` field, which is what lets the client stay
  engine-agnostic).
- **Consequences:**
  - The diffusion session is deliberately invisible to every "what is loaded"
    surface of the chat engines (`performLoad` auto-unload, `getLoadedModels`,
    `/v1/models` on port 1337). Putting it into `AIEngine`/`EngineManager` would
    have made an image model selectable as a chat model. GPU arbitration is a
    separate, explicit step (see the arbiter record).
  - `AIEngine` is chat-shaped, and an extension is a `janhq-*.tgz` pre-install
    artefact; neither fits a job-based engine. No `MediaEngine` was added to
    `core/`.
  - Cancelling a *running* generation kills `sd-server`: the upstream job API
    can only cancel queued jobs (`cancel_generating = false`). The plugin keeps
    the spawn spec and respawns transparently on the next job, and the UI says
    the renderer is being stopped rather than pretending a soft cancel.
  - Readiness is `GET /v1/models` (the port binds only after the model is
    loaded), disambiguated by `GET /sdcpp/v1/capabilities`, which llama-server
    404s. Studio additionally proves the listener's pid with psutil; we have no
    cheap cross-platform equivalent and accept that residual race.
  - A ggml `unsupported op` abort is the only crash that is retried, once, on
    the CPU backend. OOM kills and real bugs surface as errors.
- **Owner:** `team`.
- **Links:**
  - `src-tauri/plugins/tauri-plugin-atomic-diffusion/`
  - `web-app/src/services/diffusion/types.ts` — the contract
  - Reference: `unsloth/studio/backend/core/inference/sd_cpp_{args,server,engine,backend}.py`
  - Plan: image → video phasing, ATO-513 / ATO-514
