---
date: 2026-10-19
title: "Reveal files in the file manager from the blocking pool"
---

# 2026-10-19 — Reveal files in the file manager from the blocking pool

- **Context:** On the Linux AppImage (2.2.14), "Open containing folder" in Settings closed the app. The log shows `Application panic: Cannot start a runtime from within a runtime` from `tokio-1.50.0/src/runtime/scheduler/multi_thread/mod.rs:88`, three seconds after the Logs window opened. The webview called `tauri-plugin-opener`'s `reveal_item_in_dir` command. That command is async, so it runs on a tokio worker, and on Linux it calls `zbus::blocking::Connection::session()`. The app enables zbus's `tokio` feature, so the blocking wrapper calls `Runtime::block_on` on the worker and panics. Release builds set `panic = "abort"`, so the panic kills the app. Every `revealItemInDir` caller hit this: Settings logs, image and video viewers, document citations and agent workspace files. Desktop notifications failed the same way (see `show_desktop_notification`).
- **Decision:** Add the app command `reveal_in_file_manager`. It calls `tauri_plugin_opener::reveal_item_in_dir` inside `spawn_blocking`, where `block_on` is allowed. `TauriOpenerService.revealItemInDir` invokes it instead of the plugin's JS `revealItemInDir`.
- **Consequences:** Linux reveals the file, or returns an error the callers already catch. macOS and Windows already ran the call off the main thread, so they behave as before. Any new code that reaches zbus from an async command needs the same treatment; the plugin's JS `revealItemInDir` must not be used from the webview.
- **Owner:** team
- **Links:** `src-tauri/src/core/system/commands.rs` (`reveal_in_file_manager`, `show_desktop_notification`), `web-app/src/services/opener/tauri.ts`, Discord #bug-reports report of 2026-10-16.
