---
date: 2026-05-22
title: "Windows auto-updater uses NSIS as sole relauncher"
---

# 2026-05-22 — Windows auto-updater uses NSIS as sole relauncher

- **Context:** After a passive NSIS update on Windows 11, users saw a blank
  window until a manual restart. NSIS `.onInstSuccess` already launches the
  new binary via `RunAsUser`, while the frontend also called `relaunch()` →
  `app.restart()`, racing two processes.
- **Decision:** On Windows, skip `window.core.api.relaunch()` after
  `downloadAndInstallWithProgress()` completes. Let NSIS be the only
  relauncher. macOS/Linux keep the existing `relaunch()` path.
- **Consequences:** Eliminates the double-relaunch race on Win11. The old
  process may exit without an explicit `app.restart()`; users see a brief
  toast that the app will restart. No NSIS template changes required.
- **Owner:** team.
- **Links:** `web-app/src/hooks/useAppUpdater.ts`,
  `src-tauri/tauri.bundle.windows.nsis.template` (`.onInstSuccess`).
