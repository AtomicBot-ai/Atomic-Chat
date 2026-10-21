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
- **Decision:** A runtime switch marks an install as package-managed:
  `ATOMIC_CHAT_PACKAGE_MANAGED=1` (also `true`/`yes`/`on`) in the environment,
  or an empty `atomic-chat-package-managed` file next to the app executable
  (`src-tauri/src/core/updater/package_managed.rs`). Then `check_for_app_updates`
  returns no update without a request, the frontend never calls `check()` or
  installs, no banner can appear, and Settings → General replaces "Check for
  updates" with "Atomic Chat was installed by your package manager. Update it
  there." `AUTO_UPDATER_DISABLED` builds now also skip `check()` instead of
  discarding its answer.
- **Consequences:** Packagers set the variable in their `/usr/bin` launcher
  (or drop the marker beside an extracted binary); the release AppImage and the
  macOS/Windows installers are unchanged because neither switch is present. The
  Tauri updater plugin stays registered, so its JS `check()` still works if some
  future caller bypasses `useAppUpdater` — keep update calls behind the hook.
- **Owner:** `team`
- **Links:** `src-tauri/src/core/updater/package_managed.rs`,
  `src-tauri/src/core/updater/commands.rs`, `web-app/src/lib/package-managed.ts`,
  `web-app/src/hooks/useAppUpdater.ts`, `web-app/src/routes/settings/general.tsx`;
  Omarchy issue omacom/omarchy#11317 (the same updater/pacman conflict in LM
  Studio).
