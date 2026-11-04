---
date: 2026-11-04
title: 'Close the Windows window to the tray only while a reply or download runs'
---

# 2026-11-04 — Close the Windows window to the tray only while a reply or download runs

- **Context:** On Windows the window's X destroyed the last window, so the app
  reached `RunEvent::Exit` and stopped the core with every loaded model. A reply
  that was still streaming and any model download died with it, and the last
  ~3 s of analytics were never sent. macOS hides on close and Linux hides to the
  tray (2026-10-21), so Windows was the only platform where closing the window
  interrupted work. Windows is ~80% of senders.
- **Decision:** On Windows, `CloseRequested` hides the window to the tray only
  while a loopback stream (`STREAMS_IN_FLIGHT`) or a model download
  (`DownloadManagerState.cancel_tokens`) is in flight and the tray icon exists;
  the first time, a Windows notification says the app keeps finishing in the
  tray and that the tray's "Quit" exits (`close_to_tray_notice_shown` in
  `store.json`). When idle, closing quits as before. A second launch now shows
  the window on Windows too. Separately, every platform's first exit request is
  deferred ~400 ms: the core call gate closes, `app-shutting-down` is emitted
  and the web flushes analytics; restarts and macOS Cmd+Q are not deferred.
  `SetErrorMode` suppresses crash dialogs for the core and llama-server so a
  crashed engine exits instead of holding its port behind a WER dialog.
- **Consequences:** An idle close still frees RAM/VRAM at once, so habits are
  unchanged; a close during work keeps the app running until the user quits from
  the tray. Cloud streams that do not use `stream_local_http` and agent runs are
  not counted as busy yet. Not verified on a Windows machine at the time of
  writing (type-checked for `x86_64-pc-windows-gnu` only).
- **Owner:** `team`
- **Links:** `src-tauri/src/core/setup.rs` (`windows_close_action`,
  `defer_exit_for_shutdown_flush`), `src-tauri/src/core/notifications.rs`,
  `src-tauri/src/core/atomic_core/launch.rs` (`suppress_crash_dialogs`),
  `src-tauri/src/lib.rs`, [Close the Linux window to the tray](2026-10-21-close-the-linux-window-to-the-tray.md).
