---
date: 2026-09-10
title: "Store generated media under the data folder with recipes in PNG chunks"
---

# 2026-09-10 — Store generated media under the data folder with recipes in PNG chunks

- **Context:** Generated images need a home, a history and a way to reproduce
  them. Studio writes `{uuid}.png` with two `tEXt` chunks (`unsloth` JSON recipe
  + an Automatic1111 `parameters` string), pin/archive flags in a sidecar
  `.flags.json`, and serves files over authenticated or HMAC-signed routes.
- **Decision:** Three new data paths, approved by the owner: `<dataFolder>/diffusion/`
  (`backends/`, `models/<family>/`, `models/shared/<repo>/`, `scratch/`),
  `<dataFolder>/images/` and, for phase 2, `<dataFolder>/videos/`. Model files
  live outside `<dataFolder>/llamacpp/models` and never carry a `model.yml`, so
  the llama.cpp extensions, the hub and the local-model scanner never list them.
  Output files are `<jobId>-<index:02>.png` (the job id doubles as the artifact
  id) with a 256 px `.thumb.png` beside them; the recipe is spliced into the PNG
  as a `tEXt` chunk `atomic` (JSON, the `ImageRecipe` type) plus a `parameters`
  chunk for A1111/ComfyUI interop, without re-encoding the image. Writes are
  tmp + rename. PNGs without an `atomic` chunk are foreign: neither listed nor
  deleted. Files are shown through `convertFileSrc` — no signed links, no auth
  routes, because the webview and the files share a machine.
- **Consequences:**
  - "Save as" is a byte copy, so an exported PNG keeps its recipe.
  - Restoring a recipe uses `batchSeed`, not the per-image `seed`: the engine
    derives image seeds as `base + index`, so restoring the derived seed would
    not reproduce the image.
  - Thumbnails are written by Rust (`image` crate, already in the lock file) so
    a grid of sixty tiles does not decode sixty full-size PNGs.
  - `fetch(convertFileSrc(...))` is never used for gallery bytes; WebView2 cannot
    deliver large asset-protocol bodies (see `chatInput/imageFromPath.ts`).
- **Owner:** `team`.
- **Links:**
  - `src-tauri/plugins/tauri-plugin-atomic-diffusion/src/gallery.rs`
  - `DEVELOP.md` — data folder table
  - Reference: `unsloth/studio/backend/core/inference/image_gallery.py`
