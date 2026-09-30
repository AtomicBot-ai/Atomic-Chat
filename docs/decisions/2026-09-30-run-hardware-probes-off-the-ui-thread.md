---
date: 2026-09-30
title: "Run hardware probes off the UI thread"
---

# 2026-09-30 — Run hardware probes off the UI thread

- **Context:** `plugin:hardware|get_system_info` and `get_system_usage` were
  synchronous commands, so Tauri ran them on the main (UI) thread. Both call
  `sysinfo`'s `refresh_cpu_all`, which on Windows builds a PDH query and makes
  the OS load every registered performance-counter provider. BITS's
  `bitsperf.dll` makes an outgoing COM call to the BITS service (stopped by
  default until needed), and COM pumps window messages on the calling STA
  thread while it waits. A message re-entering the event loop there blocked on
  a lock forever: the window went "Not Responding" and Windows closed it
  (Application Hang, event 1002). A captured stack of the hung main thread
  showed `WebView2 IPC → hardware command → PdhAddEnglishCounterW →
  bitsperf.dll → COM wait → DispatchMessage → window proc → WaitOnAddress`.
  The tray sync polls `get_system_usage` every 5 s from launch on Windows
  (since 2026-07-13) and macOS, so an affected machine froze within seconds of
  starting, and every such user paid a 200 ms UI stall per poll from the
  CPU-sampling sleep.
  Running `lodctr /d:BITS` (which stops Windows from loading `bitsperf.dll`)
  made the hang disappear on the affected machine, which confirms this path.
- **Decision:** Keep the blocking `get_system_info` / `get_system_usage`
  functions for Rust callers, and register async `ipc::` wrappers under the
  same command names that run them on the blocking pool
  (`tauri::async_runtime::spawn_blocking`). The wrappers return
  `Result<_, String>`, so a panic in a probe rejects the IPC promise instead of
  taking down the event loop.
- **Consequences:** PDH, COM, Vulkan/NVML enumeration and the CPU-sampling
  sleep no longer run on the UI thread. Command names, ACL permissions and the
  success payload are unchanged, so the web app needs no edits. Probes can now
  run concurrently; their shared state is already behind `RwLock` / `Mutex` /
  `Once`, and ADL calls stay serialized. A probe that blocks for a long time
  now occupies a blocking-pool thread instead of freezing the window. This may
  also be the unresolved cause behind the ATO-104 onboarding hang
  (2026-06-08), but that is not confirmed.
- **Owner:** @xDenside
- **Links:** [`src-tauri/plugins/tauri-plugin-hardware/src/commands.rs`](../../src-tauri/plugins/tauri-plugin-hardware/src/commands.rs),
  [`src-tauri/plugins/tauri-plugin-hardware/src/lib.rs`](../../src-tauri/plugins/tauri-plugin-hardware/src/lib.rs),
  [`web-app/src/hooks/useTrayStatusSync.ts`](../../web-app/src/hooks/useTrayStatusSync.ts),
  the 2026-07-13 ADR *Run tray status synchronization on Windows*, the
  2026-06-08 ADR *Windows: fix clean-install config persistence … (ATO-104)*.
