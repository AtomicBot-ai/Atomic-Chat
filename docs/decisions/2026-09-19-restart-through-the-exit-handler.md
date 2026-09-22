---
date: 2026-09-19
title: "Restart through the exit handler"
---

# 2026-09-19 — Restart through the exit handler

- **Context:** `relaunch` is a synchronous command, so it runs on the main thread, where `AppHandle::restart` replaces the process without `RunEvent::ExitRequested`/`Exit` (Tauri documents this and offers `request_restart` for reliable delivery). `RunEvent::Exit` is the only place that stops the app's core and cleans up its MCP servers. After every self-restart — the updater, a backend change, the setup step, and formerly the data-folder move — the old core stayed up with the data folder's lock, registered to an app that no longer existed; the new app's supervisor asked it to shut down, was refused while that registration's lease lasted (`CLIENT_EXPIRY_MS`, 45 s), and only then started its own. For the user: an updated app that cannot load a local model for most of a minute. Measured by `tests/e2e/desktop/relaunch.spec.ts`, which failed on the old build because the previous core was still alive.
- **Decision:** `restart_app` calls `app.request_restart()`. The exit handler runs, stops the core (it blocks until the lock is released) and the MCP servers, and Tauri restarts the process when the event loop ends.
- **Consequences:** Every self-restart takes a moment longer — the core's orderly shutdown — and the app that comes up starts its core at once. `restart_app` now returns; `factory_reset` returns `Ok(())` after it. The Linux AppImage branch is unchanged: it spawns the sanitized AppImage and exits on its own, still without the exit handler. The data-folder move keeps stopping the core itself, because it must happen before the copy, not after.
- **Owner:** team
- **Links:** `src-tauri/src/core/system/commands.rs`, `src-tauri/src/lib.rs`, `tests/e2e/desktop/relaunch.spec.ts`
