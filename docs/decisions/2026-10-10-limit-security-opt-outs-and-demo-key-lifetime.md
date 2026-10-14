---
date: 2026-10-10
title: "Limit TLS opt-outs and concurrent demo key lifetime"
---

# 2026-10-10 — Limit TLS opt-outs and concurrent demo key lifetime

- **Context:** PR #121 hardens reasoning parsing, imported AMD table text, proxy TLS defaults, and demo session credentials. A demo launch failure previously occurred before credential cleanup began.
- **Decision:** Skip certificate verification only when a configured proxy explicitly opts in and the request actually uses that proxy. Keep demo credentials out of retained session metadata; create a separate owner-only key file exclusively and remove it on launch failure, cancellation, or completion. Bound the reasoning parser's lookahead and strip every angle bracket from imported GPU names.
- **Consequences:** Bypassed and direct downloads retain certificate checks. Child terminal windows can read the key at startup without exposing it in session.json. Abnormal process termination can still interrupt filesystem cleanup; the session directory and key file remain owner-only.
- **Owner:** @walladanger.
- **Links:** [PR #121](https://github.com/walladanger/Radium/pull/121), `scripts/concurrent-demo/demo/main.py`, `src-tauri/src/core/downloads/helpers.rs`, `core/src/browser/models/reasoning.ts`.
