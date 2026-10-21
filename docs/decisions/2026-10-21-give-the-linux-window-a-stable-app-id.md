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
  template with only that line changed, so docks still match window and
  launcher.
- **Consequences:** Window rules use `class:^(chat\.atomic\.app)$`. GTK now
  registers `chat.atomic.app` on the session bus; a second launch still exits
  early through the single-instance plugin, whose D-Bus name is
  `chat.atomic.app.SingleInstance`. Existing user rules written for
  `Atomic-Chat` need updating. Under X11/XWayland `WM_CLASS` still comes from the
  program name — not verified on a machine.
- **Owner:** `team`
- **Links:** `src-tauri/tauri.linux.conf.json`,
  `src-tauri/build-utils/atomic-chat.desktop`; Tauri bundler template
  `crates/tauri-bundler/src/bundle/linux/freedesktop/main.desktop`.
