---
date: 2026-07-16
title: "Isolate the first autonomous agent loop in the Rust backend"
---

# 2026-07-16 — Isolate the first autonomous agent loop in the Rust backend

- **Context:** Atomic Chat needs a grammar-constrained autonomous mode without
  coupling its execution loop to the regular web chat or Vercel AI SDK path.
- **Decision:** Add an isolated `core::agent` Rust module that talks directly
  to the active local llama.cpp session over `/completion`, uses a static
  array-only GBNF tool grammar and stable prompt prefix, executes the
  iteration-one OS tool catalog behind resource-class, approval, SSRF, loop,
  and cancellation guards, and exposes `agent_run_turn` /
  `agent_cancel_turn` through Tauri IPC channels. Keep the web app, memory,
  tasks, browser, vision, MLX, and cloud-provider integration out of this
  iteration.
- **Consequences:** A future frontend can consume streamed agent events without
  changing ordinary chat behavior. The first iteration is local llama.cpp
  only, uses a fixed tool catalog, and defaults approval-gated calls to denial
  until an interactive approval surface is connected.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/`](src-tauri/src/core/agent/),
  [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs).

---
