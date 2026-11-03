---
date: 2026-10-21
title: 'Give the Linux window a stable app id'
---

# 2026-10-21 — Give the Linux window a stable app id

- **Context:** `app.enableGTKAppId` was unset, so Tauri started GTK with no
  application id (`tauri` 2.10.3 `app.rs:2129-2133`) and the Wayland `app_id`
  fell back to the program name, `Atomic-Chat` — the Cargo binary name, which
  is an implementation detail and differs from what packagers name their
  launcher. Hyprland/Sway window rules, `StartupWMClass` in distro desktop
  files and docks all key on that value.
- **Decision:** Set `enableGTKAppId: true` in `tauri.linux.conf.json`, so the
  GTK application id, and with it the Wayland `app_id` (Hyprland `class`), is
  the bundle identifier `chat.atomic.app`. The bundled desktop entry (the
  AppImage reuses the deb template) gets `StartupWMClass=chat.atomic.app` from
  `src-tauri/build-utils/atomic-chat.desktop`, a copy of Tauri's default
  template with only that line changed, so docks on Wayland (GNOME, KDE) still
  match window and launcher.
- **Consequences:** Window rules use `class:^(chat\.atomic\.app)$`. GTK now
  registers `chat.atomic.app` on the session bus; a second launch still exits
  early through the single-instance plugin, whose D-Bus name is
  `chat.atomic.app.SingleInstance`. Existing user rules written for
  `Atomic-Chat` need updating. Known gap: `enableGTKAppId` does not change the
  X11 `WM_CLASS`, which GTK derives from the program name (`Atomic-Chat`), so
  under an X11 session or XWayland the desktop entry no longer matches the
  window by `StartupWMClass` (it did before). The bundler also names the entry
  `Atomic Chat.desktop`, not `chat.atomic.app.desktop`, so the app-id file
  lookup does not rescue it. The fix is to make the X11 class
  `chat.atomic.app` too (e.g. `g_set_prgname` before GTK starts) — to be done
  on a Linux machine where `xprop WM_CLASS` can confirm it; Wayland-native
  desktops (Omarchy/Hyprland, Sway) are unaffected.
- **Owner:** `team`
- **Links:** `src-tauri/tauri.linux.conf.json`,
  `src-tauri/build-utils/atomic-chat.desktop`; Tauri bundler template
  `crates/tauri-bundler/src/bundle/linux/freedesktop/main.desktop`.
