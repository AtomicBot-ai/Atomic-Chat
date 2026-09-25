---
date: 2026-09-18
title: "Keep the image-generation data layout the core now owns"
---

# 2026-09-18 — Keep the image-generation data layout the core now owns

- **Context:** `tauri-plugin-atomic-diffusion` laid its files out under the app's data folder —
  `diffusion/backends/<tag>/<backendId>/` with `install.json` and an `.atomic-owned` marker,
  `diffusion/models/`, `diffusion/scratch/`, and `images/` with the recipe in a `tEXt atomic`
  chunk, an A1111 `parameters` chunk, a thumbnail beside each output and a `.flags.json`
  ([store generated media under the data folder](2026-09-10-store-generated-media-under-the-data-folder-with-recipes-in-png-chunks.md)).
  Users of 2.0.38–2.0.40 have engines, models and galleries on disk in exactly this shape. With
  [the backends moving into the core](2026-09-18-image-generation-load-cancel-and-remote-access-run-in-the-core.md)
  the question was whether the core adopts the layout or the app migrates it.
- **Decision:** The core adopts the layout unchanged, under its own data folder (`layout.diffusion`
  there: `<data>/diffusion/{backends,models,scratch}` and `<data>/images`), and the app does not
  migrate anything. The plugin's on-disk JSON was already the wire JSON, so the core reads
  `install.json`, the PNG recipe and `.flags.json` written by the Rust plugin without a
  conversion. That was checked by hand against files 2.0.40 wrote on a developer machine; the
  core's tests use the plugin's own test values, not files from those versions. One widening was
  needed: the plugin stored seeds as `i64` and 2.0.40's `/v1/images/generations` accepted any, so
  the core reads a recipe seed up to 2^63 (as the nearest double) instead of treating that PNG as
  foreign, while new requests keep every recorded seed exact below 2^53. Three rules follow:
  - `PUT /diffusion/config` must name the core's own data folder; any other folder is refused
    with `NOT_CONFIGURED` ("Image generation runs inside the core's data folder only."). The app's
    data folder and the core's are the same folder by construction (`launch.rs` starts the core
    on it), so the store sends the folder it has on bind and again, with the output folder and the
    idle interval it keeps in its persisted settings, on every configure and every
    `atomic-core://snapshot`; the check exists so a mismatch surfaces instead of writing a second
    tree.
  - Filesystem paths travel only in request bodies, never in URLs. The core confines what it
    deletes or finalizes on the caller's word: an engine tree to finalize or remove must lie inside
    `diffusion/backends`, a model file to delete inside `diffusion/models`, a gallery id is
    `^[a-f0-9]{32}-\d{2}$`, and PNGs it did not write are neither listed nor deleted. What it only
    reads or writes where the user pointed is not confined, as with the plugin: the model files
    named by a load (they must exist), img2img and reference sources, an export target, and the
    output folder (`PUT /diffusion/output-dir`).
  - `POST /diffusion/jobs` accepts up to 64 MiB (img2img sources travel base64 in the body,
    where the plugin took them in-process); a larger body is refused by the control server with
    `INVALID_ARGUMENT` before it reaches the runner.
- **Consequences:** Nothing to migrate on upgrade, and a downgrade to 2.0.40 reads the same
  files. Free disk space for a planned download is answered by the core only for paths inside
  its data folder (`POST /disk/available`), which is where every engine and model lands. Two
  data folders (an app and a CLI core, see
  [isolate application and CLI core owners](2026-09-17-isolate-app-and-cli-cores.md)) mean two
  galleries; the Images page shows the app core's. Relocating the data folder copies the diffusion
  tree with everything else and relaunches the app, so the core it starts owns the new folder and
  the provider configures it there on mount (`configureDiffusion` in `lib/diffusion/config.ts`).
- **Owner:** team.
- **Links:** core `src/diffusion/{gallery,install,containment}.ts` and `src/config/paths.ts`;
  core ADR `2026-09-17-diffusion-speaks-the-apps-camelcase-and-error-codes-verbatim.md`;
  `web-app/src/providers/ImageGenerationProvider.tsx`, `web-app/src/services/diffusion/tauri.ts`.
