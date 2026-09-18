---
date: 2026-09-18
title: "Stop the core before moving the data folder"
---

# 2026-09-18 — Stop the core before moving the data folder

- **Context:** Changing the data folder copied the whole old folder — including `atomic-core/instance.lock`, `control-token`, `processes.json` and `model-claims/` — while the core was still running, then restarted the app. The restart runs on the main thread, where `AppHandle::restart` replaces the process without `RunEvent::Exit`, the only place that stops the core. The new folder therefore held a `ready` lock naming a live pid; the core judges a lock stale by its pid alone, so the restarted app waited for the old core to give up — about 40 s, until its registration of the vanished app lapsed (`CLIENT_EXPIRY_MS`), barely inside the supervisor's 55 s reclaim timeout. The desktop e2e suite measured it (`tests/e2e/desktop/data-folder.spec.ts`).
- **Decision:** `change_app_data_folder` stops the core itself before copying (the same `atomic_core::commands::shutdown` factory reset uses, which returns once the lock is released), leaves the core's runtime state out of the copy by path (`CORE_RUNTIME_STATE`; user state in `atomic-core/` — settings, credentials, the optimal-backend record — still moves), and starts the core again (`resume`) if the copy fails, since the app then stays up on the old folder. The settings page shows the reason the command returned instead of a general message.
- **Consequences:** The app restarted on the new folder finds no lock and launches its core at once; the e2e check "serving within fifteen seconds" is a plain test now. The live core's control token is no longer written into a folder the user picked. The exclusion is by relative path, so a user's file that happens to be called `instance.lock` elsewhere is copied. Not changed: `restart_app` still skips `RunEvent::Exit`, so other relaunch paths (the updater) still leave the core to be reclaimed by the next launch — that path has no copied lock and reclaims immediately, but MCP cleanup is skipped there too. The dead `KILL_SIDECAR` emit and the 1 s timer in `general.tsx` were left in place.
- **Owner:** team
- **Links:** `src-tauri/src/core/app/commands.rs`, `src-tauri/src/core/app/helpers.rs`, `src-tauri/src/core/atomic_core/commands.rs`, `web-app/src/routes/settings/general.tsx`, `tests/e2e/desktop/data-folder.spec.ts`
