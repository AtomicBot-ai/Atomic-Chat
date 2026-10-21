---
date: 2026-10-21
title: 'Let a package manager own updates'
---

# 2026-10-21 — Let a package manager own updates

- **Context:** Distro packages (an AUR `atomic-chat-bin`, a pacman repo,
  Flatpak) install Atomic Chat where the package manager, not the app, owns
  the files. The built-in updater then fights it: in a root-owned path the
  install fails and the prompt comes back on every launch; in a writable one it
  silently replaces files the package manager tracks. The only switch,
  `AUTO_UPDATER_DISABLED`, is a build-time Vite define, so a packager who
  repackages the release AppImage cannot set it, and even when it is set
  `useAppUpdater.checkForUpdate` called `updater().check()` first and tested the
  flag only afterwards, so a "disabled" build still contacted the update server
  on every start.
- **Decision:** A runtime switch marks an install as package-managed: an
  empty `atomic-chat-package-managed` file next to the app executable — next
  to the `.AppImage` file (`$APPIMAGE`) for an intact AppImage, next to
  `usr/bin/Atomic-Chat` for an extracted one — or
  `ATOMIC_CHAT_PACKAGE_MANAGED=1` (also `true`/`yes`/`on`) in the environment
  (`src-tauri/src/core/updater/package_managed.rs`). Then `check_for_app_updates`
  returns no update without a request, `TauriUpdaterService` answers "no
  update" without its plugin fallback and refuses to install, the frontend
  never calls `check()`, no banner can appear, and Settings → General replaces
  "Check for updates" with "Atomic Chat was installed by your package manager.
  Update it there." (also when `AUTO_UPDATER_DISABLED` is set as well).
  `AUTO_UPDATER_DISABLED` builds now also skip `check()` instead of discarding
  its answer.
- **Consequences:** The marker is the switch to recommend: the autostart
  entry (`tauri-plugin-autostart`) runs `$APPIMAGE` or the binary directly,
  so a launcher-script environment variable does not reach an autostarted
  instance, while the marker does. The release AppImage and the macOS/Windows
  installers are unchanged because neither switch is present. The Tauri
  updater plugin stays registered; `TauriUpdaterService` is the floor for any
  caller that bypasses `useAppUpdater`. The `VITE_FORCE_UPDATE_BANNER` QA
  build still shows its preview banner — it is a build-time knob for testers,
  not a distro build.
- **Owner:** `team`
- **Links:** `src-tauri/src/core/updater/package_managed.rs`,
  `src-tauri/src/core/updater/commands.rs`, `web-app/src/lib/package-managed.ts`,
  `web-app/src/hooks/useAppUpdater.ts`, `web-app/src/services/updater/tauri.ts`,
  `web-app/src/routes/settings/general.tsx`;
  Omarchy issue omacom/omarchy#11317 (the same updater/pacman conflict in LM
  Studio).
