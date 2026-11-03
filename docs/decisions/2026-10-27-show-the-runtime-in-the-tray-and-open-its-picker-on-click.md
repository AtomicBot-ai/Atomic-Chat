---
date: 2026-10-27
title: "Show the runtime in the macOS tray, and open the engine or model picker on click"
---

# 2026-10-27 — Show the runtime in the macOS tray, and open the engine or model picker on click

- **Context:** The menu-bar tray (Pico-style status menu) named the loaded
  model only, and its Model row did nothing on click. The user asked for the
  runtime beside the model, and for both to open the app on their config.
- **Decision:** A disabled "Runtime" header and a value row follow the Model
  rows: the engine the loaded chat models run on and its active build
  ("llama.cpp · b11463"), "N runtimes" across several engines, "—" with nothing
  loaded (`trayRuntimeLabel` in `useTrayStatusSync`, `runtime_label` in the
  payload). Clicking the Model or Runtime row shows the window (the "Open"
  item's logic, now `show_main_window`) and emits `tray-open-model-config`;
  the frontend records a one-shot request (`server-picker-request-store`) and
  navigates to Server → Engine & model, which opens the Model or Engine
  picker. During the first-run flow the click only shows the window.
- **Consequences:** The version shown is the build the next load uses
  (`engines[provider].active`), which can differ from a running process until
  it reloads. Focus handling on macOS right after the window shows is untested
  in the real app; if the dropdown closes on focus, open it after the window's
  focus event.
- **Owner:** @m-skvortsov
- **Links:** `src-tauri/src/core/setup.rs` (`setup_tray`),
  `src-tauri/src/core/tray_status.rs`, `web-app/src/hooks/useTrayStatusSync.ts`,
  `web-app/src/containers/server/ServerModelPicker.tsx`
