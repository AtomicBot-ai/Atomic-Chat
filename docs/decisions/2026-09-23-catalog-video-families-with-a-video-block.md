---
date: 2026-09-23
title: "Catalog video families with a video block"
---

# 2026-09-23 — Catalog video families with a video block

- **Context:** The diffusion catalog in `atomic-chat-conf` (`models/diffusion.json`,
  [curated there](2026-09-10-curate-the-diffusion-model-catalog-in-atomic-chat-conf.md))
  described image families: a transformer with quants, a VAE, text encoders
  by field, defaults, ranges, capabilities and workflows. A video family needs
  what the engine needs at load — LTX takes an audio VAE and an
  embeddings-connectors file beside the video VAE and the Gemma LLM, Wan
  takes umT5 as `t5xxl` — and what the form needs: the frame rate, the frame
  lattice and range, the default length, the resolution presets the model
  was trained at, and for a distilled model the sigma schedule its steps
  follow.
- **Decision:** The schema grows additively, `schema_version` stays 1. A
  family may carry `audio_vae` (a file like `vae`), a text encoder with
  `field: embeddings_connectors`, `defaults.sigmas` (numbers in (0, 1], sent
  as `custom_sigmas` when the step count equals the schedule's length), and a
  `video` block `{fps, frame_step, frame_offset, frames, frame_range,
  resolution_presets}` that the schema requires when `modality` is `video`.
  The app's registry validates the block as strictly as the rest: positive
  integers, the default frame count on the lattice and in the range, every
  preset inside `ranges.dims` and a multiple of `dim_multiple`, at least one
  preset; a video family whose block is missing or wrong is dropped, and a
  `video` block on an image family is ignored. The bundled baseline is
  regenerated from the branch with the two families
  (`scripts/sync-upstream-baseline.mjs --catalog-from`), so the app offers
  them before the catalog is merged and fetched.
- **Consequences:**
  - Download planning stores the audio VAE under `shared/<owner--repo>/`
    like the other side files, and deletion keeps it while another quant of
    the family needs it. The fit estimate counts it with the video VAE.
  - The load request carries `files.audioVae`, `files.embeddingsConnectors`,
    `defaults.video` (camelCase), `defaults.sigmas` and `ranges.frames`; the
    core validates and echoes them in the video capabilities, and the form
    reads its presets, lattice and rate from there, never from the catalog.
  - An older app reading the new catalog ignores the video families (their
    `modality` was already a known value it filters on); an older catalog
    read by this app simply lists no video families.
  - The Wan logo rule now matches the catalog's spaced name (`Wan 2.2 …`) as
    well as the Hub's (`Wan2.2-…`).
- **Owner:** `team`.
- **Links:**
  - `atomic-chat-conf` branch `feat/video-families`: `models/schema.diffusion.json`, `models/diffusion.json`
  - `web-app/src/services/diffusion-catalog-registry.ts` (`sanitizeVideo`)
  - `web-app/src/lib/diffusion/{models,fit}.ts`
  - `web-app/src/services/diffusion-catalog-baseline.ts`
