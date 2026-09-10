---
date: 2026-07-27
title: "Evaluate the Rust Agent sequentially on gated GAIA validation"
---

# 2026-07-27 — Evaluate the Rust Agent sequentially on gated GAIA validation

- **Context:** Atomic Chat needed a repeatable benchmark for its direct Rust
  Agent loop that fits one local model in memory and does not depend on the
  Tauri UI or IPC.
- **Decision:** Add a feature-gated headless `gaia-eval` binary and
  `make gaia-eval`. Load and cache the official gated GAIA 2023 validation
  split through Hugging Face, start one dedicated `llama-server` with one
  slot, and call `core::agent::runner::run_turn` directly for isolated tasks
  in a strictly sequential loop. Keep workspace path policy, shell hard
  blocks, SSRF protections, task timeouts, event capture, GAIA-compatible
  scoring, and JSON plus terminal reporting. Default runs to Level 1 while
  retaining `GAIA_LEVEL` / `--level` as an explicit override.
- **Consequences:** Local models can be compared through one reproducible
  command without competing inference jobs or GUI state. A valid gated
  Hugging Face token and local server/model paths remain operator
  prerequisites. Unconfigured runs cover only Level 1; Levels 2 and 3 require
  an explicit filter. Parallel execution is deliberately deferred until
  models or hardware can support multiple independent slots.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/eval/`](src-tauri/src/core/agent/eval/),
  [`src-tauri/src/bin/gaia-eval.rs`](src-tauri/src/bin/gaia-eval.rs),
  [`Makefile`](Makefile) (`gaia-eval`).
