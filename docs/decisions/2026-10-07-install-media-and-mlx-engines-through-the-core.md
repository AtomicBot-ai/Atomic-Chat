---
date: 2026-10-07
title: "Install the media engine and MLX through the core, and ship mlx-server by conf's manifest"
---

# 2026-10-07 — Install the media engine and MLX through the core, and ship mlx-server by conf's manifest

- **Context:** The desktop installed stable-diffusion.cpp itself: it read conf's
  `backends/sdcpp-manifest.json` (remote → `localStorage` → a bundled
  baseline), picked the build with `backendMatrix.ts` over the deprecated Rust
  `get_supported_features`, downloaded and unpacked it, and asked the core to
  `finalize` the tree. Updates compared tags with "not equal", so an older
  manifest read as an update, and Cancel in the download panel never reached
  the transfer. `mlx-server` existed only inside the installer: the Makefile
  fetched a tag pinned in the Makefile with no hash check, and the provider
  page read its version from `mlx-server-version.txt` through
  `tauri-plugin-mlx`. The core now owns both engines' builds (core ADR
  `2026-10-07-the-core-owns-sdcpp-and-mlx-engine-builds.md`, core 0.12.0).
- **Decision:** The desktop installs, checks and updates both engines only
  through the core's `/engine-builds/:engine/*`. sd.cpp: the image store asks
  the catalog for the host's build, installs under the
  `diffusion-backend-<tag>-<backendId>` task, and the panel's Cancel stops the
  core's download (no Pause). MLX: the installer still ships `mlx-server`, now
  fetched by `backends/mlx-manifest.json` (tag, archive, sha256, size) with
  `mlx-server.json` `{tag, published_at}` beside it, and re-signed as before;
  the provider page shows the core's active build and where it came from; a
  newer build is offered on the shared engine-update banner, which installs it
  through the core under `engine-build-mlx-<tag>`, and the page has a "Check
  engine updates" button. The desktop sd.cpp installer, its baseline manifest,
  `backendMatrix.ts`, the `localStorage` caches (erased at start) and
  `tauri-plugin-mlx` are gone.
- **Consequences:** Every engine build on disk is sha256-checked and
  probed by the core before it becomes visible; a manifest rollback is never
  offered as an update; `atc` gets the same install path. The macOS build now
  needs conf's `mlx-manifest.json` on main, or `MLX_MANIFEST=<file>`: until conf
  merges it, `make build-mlx-server` fails without that override, and a dev
  build that cannot read the manifest keeps the `mlx-server` it has. Without a
  network the core offers no install (there is no bundled manifest any more).
- **Owner:** `team`.
- **Links:** openspec change `move-sdcpp-mlx-install-to-core` (design D2, D5,
  D8, D10); core ADR `atomic-chat-core/docs/decisions/2026-10-07-the-core-owns-sdcpp-and-mlx-engine-builds.md`;
  `web-app/src/services/diffusion/engine.ts`,
  `web-app/src/services/engine-builds/`, `web-app/src/stores/image-generation-store.ts`,
  `extensions/mlx-extension/src/engineUpdateOffer.ts`,
  `scripts/fetch-mlx-server.mjs`, `Makefile` (`build-mlx-server`).

<!--
Supersedes: the desktop-installer parts of 2026-10-06-fall-back-from-a-media-engine-build-that-fails-its-probe.md
(the ladder descent now runs in the core, the failed list lives in <data>/diffusion/failed-backends.json).
-->
