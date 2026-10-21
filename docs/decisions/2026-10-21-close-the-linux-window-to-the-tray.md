---
date: 2026-10-21
title: 'Close the Linux window to the tray'
---

# 2026-10-21 — Close the Linux window to the tray

- **Context:** Linux builds install the tray icon (`ENABLE_SYSTEM_TRAY_ICON`
  in `.cargo/config.toml`), but the close veto in
  `setup_window_theme_listener` was macOS-only. Closing the only window on
  Linux therefore reached `RunEvent::Exit`, which shuts the core down and stops
  the local API server on `:1337` — under any agent, editor or script using it.
  On tiling compositors (Hyprland/Omarchy) "close window" is a routine
  keystroke, so the server died far more often than users meant to quit.
- **Decision:** On Linux, while the tray icon exists, `CloseRequested` is
  vetoed and the window is hidden; the server and loaded models keep running.
  The tray's "Open Atomic Chat" and a second launch of the app (the
  single-instance callback, Linux only) show and focus the window again; the
  tray's "Quit" still exits through `RunEvent::Exit`. If the tray failed to
  install, the close goes ahead and the app exits as before, so a window can
  never be hidden with no way back. macOS and Windows are unchanged.
- **Consequences:** Closing no longer frees RAM/VRAM on Linux — quitting is
  now an explicit tray action. A desktop without a StatusNotifier host (a bar
  with no tray module) still gets a tray object from libappindicator, so the
  window hides with no visible icon; relaunching the app brings it back. There
  is no setting to opt out yet; add one if users ask for close-to-quit.
- **Owner:** `team`
- **Links:** `src-tauri/src/core/setup.rs` (`setup_window_theme_listener`),
  `src-tauri/src/lib.rs` (single-instance callback, `RunEvent::Exit`).
