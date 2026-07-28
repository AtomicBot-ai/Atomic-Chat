---
date: 2026-07-28
title: "Isolate the unstable Tauri IPC test API"
---

# 2026-07-28 — Isolate the unstable Tauri IPC test API

- **Context:** Rust command tests called handlers directly, so they did not
  exercise command-name routing, JavaScript argument decoding, or IPC response
  serialization. Tauri marks `tauri::test` as unstable, and spreading its mock
  runtime types across feature tests would make framework upgrades expensive.
- **Decision:** Keep direct use of Tauri's IPC request/response test primitives
  in `src-tauri/src/test_support.rs`. Feature tests register real handlers
  through that facade, while path-based unit tests continue to cover business
  logic and concurrency without Tauri.
- **Consequences:** Command-boundary regressions are caught without launching a
  desktop process or touching user data. A Tauri test API change has one
  adaptation point, at the cost of maintaining both focused unit tests and a
  smaller IPC contract layer.
- **Owner:** `team`
- **Links:** `src-tauri/src/test_support.rs`,
  `src-tauri/src/core/threads/ipc_tests.rs`,
  https://docs.rs/tauri/latest/tauri/test/index.html
