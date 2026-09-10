---
date: 2026-07-13
title: "Run tray status synchronization on Windows"
---

# 2026-07-13 — Run tray status synchronization on Windows

- **Context:** The Windows tray menu shipped and emitted the same
  `tray-start-server` / `tray-stop-server` events as macOS, but the React hook
  that updates its server/model/RAM rows and listens for those events returned
  early unless `IS_MACOS` was true. On Windows the menu therefore stayed on
  its initial "Server Stopped" placeholders and its Start/Stop action did
  nothing.
- **Decision:** Mount the existing tray synchronization and event-listener
  effects on Windows Tauri builds as well as macOS. Keep web, mobile, and Linux
  excluded.
- **Consequences:** The Windows tray reflects live state and its Start/Stop
  action reaches the existing Local API Server flow. macOS behavior is
  unchanged. No IPC, settings, or server lifecycle changes.
- **Owner:** team.
- **Links:** [Issue #167](https://github.com/AtomicBot-ai/Atomic-Chat/issues/167),
  [`web-app/src/hooks/useTrayStatusSync.ts`](web-app/src/hooks/useTrayStatusSync.ts),
  [`web-app/src/routes/__root.tsx`](web-app/src/routes/__root.tsx).
