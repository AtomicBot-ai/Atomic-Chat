---
date: 2026-09-15
title: "The core ships as a bundled resource and runs as an independent owner"
---

# 2026-09-15 — The core ships as a bundled resource and runs as an independent owner

- **Context:** The desktop app owns every local model today: the webview extension decides, the
  Rust plugins spawn, and everything dies with the app. A CLI that loads its own copy of a model
  would either double-load the GPU or fight the app for the same ports and files. The core needs
  one place to live in the bundle and one rule about who owns what.
- **Decision:** The compiled `atomic-chat-core` binary is a bundled resource
  (`src-tauri/resources/bin/atomic-chat-core[.exe]`, listed in the three platform
  `tauri.*.conf.json` files) and runs as a process that owns a data folder, not as a child of
  whoever started it. It takes `<data>/atomic-core/instance.lock` with a process-start identity,
  publishes a loopback-only control listener (`/atomic/v1`) whose token lives in a `0600` file, and
  exposes the OpenAI-compatible API on a second, independently startable listener. The app and the
  CLI are both clients: they attach to a running owner, or launch one and attach. Clients exchange
  a snapshot plus an SSE stream with replay cursors; the owner's first stdout line is its
  `core:ready` handshake. A client exiting detaches and leaves models loaded.
- **Consequences:** Ctrl+C in the CLI no longer unloads the model — stated in the help and covered
  by tests, because it differs from the Rust `jan-cli`. Stopping the public API no longer stops
  management. A crashed owner leaves a journal the next owner uses to reap only *confirmed* orphan
  backends. Until the CLI is distributed, the app must not reap a live owner's processes and the
  CLI must refuse to mutate resources the legacy path owns.
- **Owner:** team
- **Links:** `../../../atomic-chat-core/PLAN.md` (§3.4, §3.6), `scripts/download-core.mjs`,
  [Extract the inference core](2026-09-15-extract-the-inference-core-into-atomic-chat-core.md)
