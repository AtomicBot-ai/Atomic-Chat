---
date: 2026-10-16
title: "Media sizes come from the Rust catalog; images upscale after rendering"
---

# 2026-10-16 — Media sizes come from the Rust catalog; images upscale after rendering

- **Context:** Built-in engine sizes were hard-coded about three per family in
  `catalog.rs` and again in the web app (`FAMILY_SIZES`, `resolutionSpec`).
  Wan 2.2 TI2V 5B defaulted to 832×480 @ 16 fps although it was trained at
  1280×704 @ 24 fps. There was no way to get a 4K image other than the
  engine's hires pass, which re-diffuses at the target size (far more memory).
- **Decision:** Each catalog model carries `ResolutionRules` (native size,
  size multiple, min/max side, pixel budget, comfortable range, memory per
  megapixel, faster extra sizes) in `core/media/resolution.rs`. Rust computes
  the aspect presets (1:1 … 21:9, 5:4) at the budget, snapped to the multiple,
  and sends them with a rough memory estimate through `media_engine_status`;
  the web app holds no size tables. A custom W×H is snapped and checked with a
  small TS mirror of the Rust functions (tested on the same vectors). Images
  render at the model's size and are then upscaled to an output size (up to
  3840 on the long side) by the new `media_upscale_image` command: ESRGAN via
  the pinned release's `sd-cli -M upscale --upscale-model` when an ESRGAN model
  is downloaded, then a Lanczos resize (the `image` crate, already in the tree
  through Tauri) to the exact size; Lanczos alone otherwise. The result carries
  `upscale` metadata and the library labels it.
- **Consequences:** One place to tune sizes. Upscaling runs a second process
  next to `sd-server`; ESRGAN through `sd-cli` was verified to exist in the
  pinned build (`-M upscale`), not yet benchmarked on real hardware. Memory
  estimates are rough heuristics, labelled as such. Video is not upscaled.
- **Owner:** team
- **Links:** `src-tauri/src/core/media/resolution.rs`,
  `src-tauri/src/core/media/upscale.rs`, `web-app/src/services/media/resolution.ts`
