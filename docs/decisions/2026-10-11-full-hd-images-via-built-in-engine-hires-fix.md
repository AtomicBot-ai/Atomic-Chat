---
date: 2026-10-11
title: "Full-HD images via the built-in engine's native hires-fix; no upscaler model download"
---

# 2026-10-11 — Full-HD images via the built-in engine's native hires-fix; no upscaler model download

- **Context:** Images from the built-in engine capped around 1216px (the largest native model size) with no upscaling. The p2 goal — "images as high-definition as the industry allows" — required an upscale stage. It was assumed the engine was a private AtomicBot `sd-server` fork whose hires request-body keys would have to be guessed, because the source was not checked out locally.
- **Decision:** The engine is upstream `leejet/stable-diffusion.cpp` release `master-866-42d6c0a` (not a custom fork). Its `examples/server/api.md` documents the full `/sdcpp/v1/img_gen` `hires` schema, and `server.rs` already passes `--hires-upscalers-dir media/upscalers`. We expose hires on image models as contract params — `hires` (bool, core, default **on**), `hires_upscaler` (enum `Latent|Lanczos|Nearest`), `hires_scale` (enum 2×/3×/4×), `hires_denoising_strength` (float, 0.2–0.9, default 0.7) — and map them to the exact engine `hires` object only for image jobs when enabled. Latent upscaling is built into the engine, so full-HD images work with no extra model download.
- **Consequences:** Images now upscale 2–4× natively, on by default, with the three knobs hidden behind the existing Advanced disclosure. Model-backed upscalers (Real-ESRGAN / 4x-UltraSharp) remain future work: their `.pth` files drop into `media/upscalers/` (top level only, no subdirectories) and would appear in the engine's `capabilities.upscalers[]`. Live discovery of those names from `GET /sdcpp/v1/capabilities` is deferred; the enum ships the built-ins first. The Rust side was not compiled in the authoring environment.
- **Owner:** team
- **Links:** `web-app/src/services/media/adapters/builtinEngine.ts`, `src-tauri/src/core/media/engine.rs`, `src-tauri/src/core/media/server.rs`
