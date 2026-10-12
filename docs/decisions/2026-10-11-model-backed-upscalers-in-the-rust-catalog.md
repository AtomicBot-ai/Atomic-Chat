---
date: 2026-10-11
title: "Model-backed upscalers ship in the Rust catalog with a dedicated install path"
---

# 2026-10-11 — Model-backed upscalers ship in the Rust catalog with a dedicated install path

- **Context:** The built-in engine's hires-fix already enlarges images 2–4× with its native `Latent`/`Lanczos`/`Nearest` upscalers (ADR 2026-10-11, "Full-HD images…"). That ADR explicitly deferred model-backed upscalers (Real-ESRGAN / 4x-UltraSharp): their `.pth` files were known to belong in `media/upscalers/`, but no catalog entry or install command existed, so a user could not download them.
- **Decision:** Add the two upscalers as a small dedicated catalog — not as `CatalogModel`s, because upscalers are not models: they have no quantisations or shared parts, and the engine discovers them by scanning `media/upscalers/` (`--hires-upscalers-dir`) rather than loading them through a `--model`-style flag. Each is pinned to a Hugging Face commit with the file's exact size and SHA-256 (the HF LFS `oid`), matching the model catalog's convention. `upscaler_install_plan` saves the file flat into `media/upscalers/{name}.pth`, a new `media_upscaler_install` Tauri command downloads it through the existing size/checksum-checked download manager, and `EngineStatus` gains an `upscalers: UpscalerStatus[]` field so the frontend knows what is installed.
- **Consequences:** The upscalers can be downloaded and their presence reported, but they are not yet selectable in the image `hires_upscaler` enum. Surfacing them requires the engine's `capabilities.upscalers[]` names (live discovery), which is a separate follow-up; the enum continues to ship the built-in upscalers first. This also fixes the Rust unit suite, which had not compiled since `GenerationDefaults` gained `resolutions`/`video` (a test fixture in `server.rs` was missing those fields).
- **Owner:** team
- **Links:** `src-tauri/src/core/media/catalog.rs`, `src-tauri/src/core/media/runtime.rs`, `src-tauri/src/lib.rs`, `web-app/src/services/media/adapters/builtinEngine.ts`
