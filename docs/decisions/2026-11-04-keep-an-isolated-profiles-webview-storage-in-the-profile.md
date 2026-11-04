---
date: 2026-11-04
title: "Keep an isolated profile's webview storage in the profile"
---

# 2026-11-04 — Keep an isolated profile's webview storage in the profile

- **Context:** `ATOMIC_CHAT_PROFILE_DIR` moved `settings.json` and the data
  folder, but the webview kept the bundle's default storage. Projects
  (`thread-management`), onboarding progress and frontend settings live in
  localStorage, so QA of 2.3.4 (AC-07) saw the usual profile's projects in a
  new, empty profile unless `CFFIXED_USER_HOME` was redirected as well. The
  e2e build already gave each run its own WebKit store and data directory.
- **Decision:** With a valid `ATOMIC_CHAT_PROFILE_DIR`, the configured windows
  are built in `setup` with the profile's own webview storage, the way the e2e
  build does: `<profile>/webview` as the WebView2/WebKitGTK data directory, and
  a WebKit data store (macOS 14+) whose UUID is drawn once and kept in
  `<profile>/webview-store-id`. A random id, not a hash of the path, so a QA
  folder deleted and created again at the same path starts empty (the WebKit
  store itself lives under `~/Library/WebKit`, outside the profile). The
  shared helpers move from `core::e2e` to `core::webview_store`; e2e keeps its
  path-derived store and its window options.
- **Consequences:** `CFFIXED_USER_HOME` is no longer needed for a clean
  profile. The app identifier and the single-instance lock stay as they are,
  because the window-state file, the updater session, MCP lock files and the
  default WebView2 folder are named after the identifier: quit the usual app
  before starting a profile, and two profiles cannot run side by side. Windows
  the frontend opens itself (App Logs, System Monitor, Local API Server Logs)
  still use the usual storage. macOS 13 and earlier have no per-identifier
  stores and fall back to the default one. Only the macOS path is modelled on
  a verified precedent (e2e); Windows and Linux are untested.
- **Owner:** `team`
- **Links:** `src-tauri/src/core/webview_store.rs`,
  `src-tauri/src/core/app/commands.rs` (`isolated_profile_webview_storage`),
  `src-tauri/src/lib.rs`, `DEVELOP.md` ("Isolated QA/dev profile"),
  [Keep an unseen e2e window rendering](2026-09-22-keep-an-unseen-e2e-window-rendering.md).
