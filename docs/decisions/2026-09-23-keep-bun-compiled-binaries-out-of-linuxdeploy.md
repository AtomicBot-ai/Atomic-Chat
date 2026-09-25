---
date: 2026-09-23
title: "Keep bun-compiled binaries out of linuxdeploy's reach"
---

# 2026-09-23 — Keep bun-compiled binaries out of linuxdeploy's reach

- **Context:** v2.0.45 was the first release to bundle `atomic-chat-core`, and
  `build-linux-x64` died in `Build app (AppImage)` with `failed to bundle
  project: failed to run linuxdeploy` and no further output — tauri-bundler
  swallows linuxdeploy's stderr unless the bundler log level is above `Error`
  (`crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy.rs`). macOS and
  Windows passed. `tauri build` installs `bundle.resources` into
  `usr/lib/<product name>/`, and linuxdeploy walks that tree recursively
  (`AppDir::listSharedLibraries` → `deployDependenciesForExistingFiles`),
  running `ldd` on every ELF it finds and rewriting each one's rpath with
  patchelf. The three new resources — `atomic-chat-core`,
  `atomic-chat-app-core` and `jan-cli` (a copy of the core) — are `bun
  --compile` binaries: dynamically linked ELFs (`DT_NEEDED`: libc, libpthread,
  libdl, libm) carrying ~4.7MB of payload appended after the section headers.
  patchelf rewrites the ELF and drops that trailing payload, so a bundle that
  did succeed would have shipped a core that cannot start. `bun` itself was
  already kept out of the AppDir for the same family of reasons — see
  `src-tauri/build-utils/buildAppImage.sh`.
- **Decision:** bun-compiled binaries are never listed in
  `tauri.linux.conf.json :: bundle.resources`. They are copied into the AppDir
  by `buildAppImage.sh` after `tauri build` (so after linuxdeploy), into
  `usr/lib/<product name>/resources/bin/`, which is where `resource_dir()`
  resolves at runtime for an AppImage. The script then runs the copied
  `atomic-chat-core --version` and fails the build if it does not start.
  macOS and Windows keep them as ordinary bundle resources; only linuxdeploy
  rewrites binaries.
- **Consequences:** `tauri build` no longer verifies these files exist on
  Linux, so the copy loop in `buildAppImage.sh` owns that check and fails with
  a named path. Any future `bun --compile` sidecar has to follow the same route
  — adding one to the Linux resource list reintroduces both the bundle failure
  and the silent corruption. `NO_STRIP=1` remains necessary but is not
  sufficient: it disables strip, not the patchelf rpath rewrite.
- **Owner:** `team`.
- **Links:** `src-tauri/build-utils/buildAppImage.sh`,
  `src-tauri/tauri.linux.conf.json`, `scripts/download-core.mjs`,
  [failed run](https://github.com/AtomicBot-ai/Atomic-Chat/actions/runs/35748527159/job/106816344944),
  [linuxdeploy AppDir::deployDependenciesForExistingFiles](https://github.com/linuxdeploy/linuxdeploy/blob/master/src/core/appdir.cpp).
