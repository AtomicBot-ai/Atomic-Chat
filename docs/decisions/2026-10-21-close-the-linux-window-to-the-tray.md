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
- **Decision:** On Linux, while the tray icon exists *and a StatusNotifier
  host shows it*, `CloseRequested` is vetoed and the window is hidden; the
  server and loaded models keep running. The tray's "Open Atomic Chat" and a
  second launch of the app (the single-instance callback, Linux only) show and
  focus the window again; the tray's "Quit" still exits through
  `RunEvent::Exit`. The host is looked up at close time on the session bus
  (`org.kde.StatusNotifierWatcher` → `IsStatusNotifierHostRegistered`, with a
  2 s timeout), because `libappindicator` creates the tray object whether or
  not anything displays it. If the tray failed to install, or there is no
  host, or the lookup fails or times out, the close exits the app as before —
  a window is never hidden with no visible way back and no "Quit". macOS and
  Windows are unchanged.
- **Consequences:** Closing no longer frees RAM/VRAM on Linux under a bar
  with a tray (Omarchy's shell, Waybar's `tray`, KDE) — quitting is an explicit
  tray action there. On GNOME without an indicator extension, closing still
  quits. The close is vetoed first and the D-Bus answer decides a few
  milliseconds later, so an exit-on-close is marginally slower than before.
  There is no setting to opt out yet; add one if users ask for close-to-quit.
  Not verified on a Linux machine: that Omarchy's shell registers a
  StatusNotifier host (it has an `omarchy.tray` module), which is what makes
  this hide rather than quit there.
- **Owner:** `team`
- **Links:** `src-tauri/src/core/setup.rs` (`setup_window_theme_listener`),
  `src-tauri/src/lib.rs` (single-instance callback, `RunEvent::Exit`).
