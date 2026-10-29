---
date: 2026-10-27
title: "Ship only upstream llama.cpp in the installer"
---

# 2026-10-27 — Ship only upstream llama.cpp in the installer

- **Context:** Measured on an installed v2.2.26 (macOS), three bundled resources carried most of
  the download: `resources/bin/mlx-server` (212 MB, arm64 only), the TurboQuant fork in
  `resources/llamacpp-backend/` (66 MB, b10298-2.0.0) and `resources/bin/jan-cli` (142 MB), a byte
  copy of `resources/bin/atomic-chat-core`. The core already installs MLX and TurboQuant builds on
  its own (`2026-10-07-install-media-and-mlx-engines-through-the-core.md`), TurboQuant is off by
  default on a fresh install, and `jan-cli`'s only consumer was `install_jan_cli_sync`, behind a
  Settings row that is hidden (`2026-10-09-hide-the-cli-in-the-app.md`).
- **Decision:** Every installer (macOS, Windows x64 and arm64, Linux x64 and arm64) ships upstream
  llama.cpp (`resources/llamacpp-backend-upstream/`) as its only engine build. MLX and TurboQuant
  are installed on demand through the core: downloading a new MLX model installs the MLX engine
  alongside it; an existing user whose first MLX load fails with `BINARY_NOT_FOUND` gets an
  "Install" action; TurboQuant downloads on first use and never while its provider is off.
  `jan-cli` is no longer bundled: Install CLI (`install_jan_cli_sync`, and the refresh on a version
  change in `setup_jan_cli`) copies the bundled `atomic-chat-core[.exe]` onto the PATH as
  `atomic-chat-cli[.exe]`, as before. The Rust command names stay.
- **Consequences:** The macOS download drops from about 573 MB to about 285 MB; Windows and Linux
  lose the TurboQuant CPU/Vulkan fallback and the `jan-cli` copy. A first MLX or TurboQuant use
  needs the network once; offline, those providers have no engine until it is fetched. The dev
  chains (`make dev`, `dev-fast`, `dev-windows`, …) and the release workflow no longer fetch MLX or
  TurboQuant; `make build-mlx-server`, `make download-llamacpp-backend` and
  `download-llamacpp-backend-win-cpu` stay as manual targets for trying a build locally, but what
  they put in `resources/` is not bundled, so a dev app no longer sees it either. Installs that
  already unpacked the bundled TurboQuant into the data folder keep it; the plugins'
  `install_bundled_backend` already copes with a missing bundled folder. The installed CLI is the
  same binary under the same name, so scripts that call `atomic-chat-cli` are unaffected.
- **Owner:** `team`.
- **Links:** `src-tauri/tauri*.conf.json` (`bundle.resources`), `.github/workflows/release.yml`,
  `Makefile` (`dev*`, `build-cli-core`, `stub-resources`),
  `src-tauri/scripts/sign-macos-resource-binaries.sh`, `src-tauri/build-utils/buildAppImage.sh`,
  `scripts/linux-packaging.mjs`, `src-tauri/src/core/system/commands.rs` (`install_jan_cli_sync`),
  `tests/macos-signing.test.mjs`, `tests/cli-launch-catalog.test.mjs`.

<!--
Supersedes: 2026-09-15-jan-cli-keeps-its-name-and-becomes-the-core.md (the file-name part: the
bundled CLI is `atomic-chat-core` itself, with no `jan-cli[.exe]` copy)
Supersedes: 2026-10-07-install-media-and-mlx-engines-through-the-core.md (the part that keeps
shipping mlx-server in the installer)
Supersedes: 2026-06-23-ship-the-turboquant-llamacpp-provider-on-windows-linux-as-a.md (the
bundled windows-x64-cpu / linux-x64-vulkan fallback; the provider itself stays)
-->
