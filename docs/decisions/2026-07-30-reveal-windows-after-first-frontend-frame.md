---
date: 2026-07-30
title: "Reveal the Windows window after native setup"
---

# 2026-07-30 — Reveal the Windows window after native setup

- **Context:** The transparent Windows window was visible while Tauri setup synchronously verified the bundled llama.cpp backend and before WebView2 painted. DWM exposed an uninitialized Mica backdrop as white bands for several seconds.
- **Decision:** Create the Windows main window hidden and show it natively at the end of Tauri setup, when WebView2 can begin navigation. Let the provider extension perform the bundled-backend installation it already owns instead of duplicating that work synchronously in Tauri setup.
- **Consequences:** Normal startup no longer exposes the transparent window during native initialization or blocks window readiness on backend verification. The window must be shown by Rust because a fully hidden Windows WebView2 does not navigate and therefore cannot reveal itself from JavaScript; bundled backend availability continues to be established by `llamacpp-upstream-extension` before backend configuration.
- **Owner:** team
- **Links:** `src-tauri/tauri.windows.conf.json`, `src-tauri/src/lib.rs`, `web-app/src/routes/__root.tsx`
