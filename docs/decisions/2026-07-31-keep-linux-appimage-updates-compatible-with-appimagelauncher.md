---
date: 2026-07-31
title: "Keep Linux AppImage updates compatible with AppImageLauncher"
---

# 2026-07-31 — Keep Linux AppImage updates compatible with AppImageLauncher

- **Context:** AppImageLauncher cannot mount the zstd SquashFS emitted by the continuously published `appimagetool`. On relaunch, AppRun's inherited `LD_LIBRARY_PATH` can also make the host AppImageLauncher load Atomic Chat's bundled OpenSSL instead of the system library. Together these failures left updated installations unable to launch in issue #164.
- **Decision:** Assemble the release AppImage from the type-2 runtime and a gzip SquashFS, and strip AppImage runtime variables before relaunching an AppImage.
- **Consequences:** Linux release builders require `squashfs-tools`. Relaunch preserves the user's session environment while removing paths into the old AppImage mount.
- **Owner:** team
- **Links:** [Issue #164](https://github.com/AtomicBot-ai/Atomic-Chat/issues/164), `src-tauri/build-utils/buildAppImage.sh`, `src-tauri/src/core/system/commands.rs`, `.github/workflows/release.yml`
