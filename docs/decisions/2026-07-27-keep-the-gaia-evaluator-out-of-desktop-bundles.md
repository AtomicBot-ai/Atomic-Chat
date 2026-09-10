---
date: 2026-07-27
title: "Keep the GAIA evaluator out of desktop bundles"
---

# 2026-07-27 — Keep the GAIA evaluator out of desktop bundles

- **Context:** Tauri CLI 2.8.4 treats every file under `src/bin` as an
  application binary to bundle, independently of whether Cargo declares it as
  a feature-gated `[[bin]]` or `[[example]]`. The normal release build skipped
  `gaia-eval`, but the macOS bundler still tried to copy it and failed because
  `target/universal-apple-darwin/release/gaia-eval` did not exist.
- **Decision:** Disable Cargo's automatic binary discovery, declare the desktop
  application and legacy CLI as explicit `[[bin]]` targets, and declare
  `gaia-eval` as a feature-gated `[[example]]` outside `src/bin`, run through
  `cargo run --example gaia-eval`. Keep the evaluator's feature gate,
  arguments, and `make gaia-eval` entry point unchanged.
- **Consequences:** Tauri no longer considers the evaluator an application
  binary, so ordinary desktop bundles do not require or ship it. Explicit
  GAIA evaluations retain the same executable behavior and dependencies.
- **Owner:** team.
- **Links:** [`src-tauri/Cargo.toml`](src-tauri/Cargo.toml),
  [`Makefile`](Makefile) (`gaia-eval`).
