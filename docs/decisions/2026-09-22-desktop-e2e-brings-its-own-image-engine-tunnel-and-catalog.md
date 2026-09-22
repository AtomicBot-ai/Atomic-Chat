---
date: 2026-09-22
title: "Desktop e2e brings its own image engine, tunnel and catalog, and expects what the app unpacks by itself"
---

# 2026-09-22 — Desktop e2e brings its own image engine, tunnel and catalog, and expects what the app unpacks by itself

- **Context:** The desktop suite (2026-09-18 record) drives the real app on an
  isolated profile with the core's scripted `llama-server` in the bundled
  backend's place. Image generation and Remote & LAN access moved into the
  core (2026-09-18 record) and had no desktop scenario. Writing them found four
  things about the build and the suite:
  1. Every launch fetched the image catalog and the sd.cpp release manifest
     from GitHub — `ImageGenerationProvider` binds at the root — so every
     scenario reached the network, and a catalog change could change a run.
  2. `bundled_cloudflared()` always handed the core the real `cloudflared`
     next to the binary, and the core prefers that flag over any environment:
     a remote-access scenario would have opened a public Cloudflare tunnel to
     the test's API. `launch_zcode` would have opened a real ZCode.
  3. On its first launch in a fresh data folder the app unpacks the backend
     pair it bundles (`install_bundled_backend` in each llama.cpp plugin, from
     `src-tauri/resources/llamacpp-backend{,-upstream}` when a dev build has
     fetched them). The teardown counted them as backends installed behind the
     scenario's back and failed every run on a machine that had them.
  4. The e2e window is kept on top, but a window on another Space still gets
     no animation frames from WebKit; with a full-screen app in front of
     whoever runs the tests, the splash overlay stayed and every session timed
     out, at random.
- **Decision:**
  - The e2e build bakes the dead address for `VITE_DIFFUSION_CATALOG_URL` and
    `VITE_SDCPP_MANIFEST_URL`, like the other registries; a scenario seeds the
    webview's one-hour caches (`harness/images.ts`) with a two-family catalog
    whose files are a few bytes of the sizes the catalog says — the UI decides
    "downloaded" by byte size, never by checksum — and the core's scripted
    `sd-server` is installed as the profile's engine tree.
  - An e2e build passes the core only a `cloudflared` the run put next to its
    scripted sidecars (`<root>/sidecars`), or none; `launch_zcode` records what
    it would have opened, like `open_agent_terminal`. Cloudflare's edge is a TLS
    server of the run's own, reached through the core's `ATOMIC_REMOTE_ACCESS_EDGE`
    / `_CA` hooks (`harness/remote-access.ts`).
  - The engine release and Hugging Face files a scenario downloads come from
    the same loopback CONNECT-proxy mirror the llama.cpp backend journey uses
    (`harness/image-mirror.ts`): neither address can be changed in the app, but
    every download honours the user's proxy setting.
  - The teardown expects the bundled pair (`bundledBackends()` in
    `harness/session.ts`, read from the resource folders' `version.txt` and
    `backend.txt`) on top of the scripted one, and lists image engine trees the
    same way it lists backends (`imageEngines` per session).
  - The e2e window is visible on all Spaces (`visible_on_all_workspaces`), so it
    is drawn wherever the operator is looking.
- **Consequences:** The suite runs offline again and cannot open a public URL
  or a desktop app. Image scenarios run in seconds against tiny files; the one
  real install flow (engine update, model download) goes through the mirror.
  The bundled pair is no longer a leak; a real backend the app would download
  still is. A full-screen app in front no longer stalls a run. Costs: two more
  baked URLs, one Rust seam per external program, and a harness that reads the
  app's resource folders.
- **Owner:** `team`.
- **Links:**
  - `Makefile` (`build-app-e2e`), `src-tauri/src/core/atomic_core/launch.rs`,
    `src-tauri/src/core/system/commands.rs` (`launch_zcode`), `src-tauri/src/core/e2e.rs`
  - `tests/e2e/harness/{images,image-mirror,remote-access,session}.ts`
  - `2026-09-18-drive-the-desktop-ui-through-an-embedded-webdriver-on-an-isolated-profile.md`,
    `2026-09-18-image-generation-load-cancel-and-remote-access-run-in-the-core.md`
