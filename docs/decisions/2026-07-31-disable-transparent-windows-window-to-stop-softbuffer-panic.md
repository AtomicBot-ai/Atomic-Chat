---
date: 2026-07-31
title: "Disable the transparent Windows window to stop the softbuffer fatal panic"
---

# 2026-07-31 — Disable the transparent Windows window to stop the softbuffer fatal panic

- **Context:** The previous day’s ADR (2026-07-30) kept the Windows main window hidden until setup completed to avoid a white Mica backdrop. The Windows config remained `transparent: true` and `decorations: false`, so Tauri used the undecorated-resizing path. That path calls `softbuffer::Surface::resize` on every redraw; when the client area becomes `0×0` (minimised, corrupted `window-state.json`, monitor/DPI changes) `CreateDIBSection` returns `NULL` and `softbuffer` panics with `assertion failed: !bitmap.is_null()`, killing the process. The panic reached only Sentry (gated by telemetry consent) and stderr, while `app.log` recorded a clean `RunEvent::Exit` cleanup block.
- **Decision:** Make the Windows main window `transparent: false` and `decorations: true` in `tauri.windows.conf.json`, removing the softbuffer `draw_surface`/`resize` path entirely. Add a panic hook that logs panics to `app.log` before chaining to Sentry, and log `RunEvent::ExitRequested` / `WindowEvent::CloseRequested` / `WindowEvent::Destroyed` sources so future shutdowns can be diagnosed from the log file alone.
- **Consequences:** The Windows window loses the custom transparent Mica/Acrylic frame; it gains a native title bar like Linux and a non-transparent background. The most common fatal desktop crash on Windows is eliminated. Panics and shutdown reasons are now visible in `app.log` regardless of whether the user opted into telemetry.
- **Owner:** team
- **Links:** PR #214, ATO-386, `src-tauri/tauri.windows.conf.json`, `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`
