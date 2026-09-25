---
date: 2026-09-15
title: "Extract the inference core into atomic-chat-core"
---

# 2026-09-15 — Extract the inference core into atomic-chat-core

- **Context:** Model loading, backend selection, downloads, settings and the
  `:1337` server are split between the webview extension
  (`extensions/llamacpp-upstream-extension`), five Rust plugins under
  `src-tauri/plugins/`, `src-tauri/src/core/server` and `jan-cli`. Policy lives
  in TypeScript that only runs inside the webview, mechanics live in Rust that
  only runs inside Tauri, and `jan-cli` re-implements a subset in Rust. Nothing
  can drive inference without the app, and every fix lands in two or three
  places. We want one reusable engine for a CLI, the desktop app, external
  OpenAI-compatible clients and library use.
- **Decision:** The inference core moves to a separate repository,
  `atomic-chat-core`, written in TypeScript against the Node-compatible API and
  packaged with `bun build --compile` into a standalone binary. It owns local
  runtimes (llama.cpp upstream, TurboQuant fork, MLX, Apple Foundation Models),
  cloud provider configs, the router and the public `/v1` server. Rust is not
  used for new core code. The on-disk data layout stays identical; the only
  new path is `<data>/atomic-core/`.
- **Consequences:** The app becomes a client of the core (see the migration
  order and ownership records). Code that is policy today gets ported verbatim
  with fixtures pinning the Rust behaviour it replaces. Bun adds a packaging
  step and a signed binary per platform; the core stays runnable under plain
  Node for tests and library consumers. Mobile keeps the legacy path.
- **Owner:** team
- **Links:** `../../../atomic-chat-core/PLAN.md` (§1–§3),
  `../../../atomic-chat-core/docs/decisions/`,
  [Migrate to the core in phases](2026-09-15-migrate-to-the-core-in-phases.md),
  [Pin wire contracts with Rust fixtures](2026-09-15-pin-wire-contracts-with-rust-fixtures.md)
