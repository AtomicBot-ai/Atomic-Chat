---
date: 2026-07-22
title: "Align Agent context budgeting with Atomic Agent"
---

# 2026-07-22 — Align Agent context budgeting with Atomic Agent

- **Context:** Atomic Chat's Rust Agent capped normal completions below Atomic
  Agent, packed conversation history by characters instead of estimated
  tokens, did not account for the active llama.cpp session's physical
  context, and could not use the Local API Server's existing context
  auto-expansion path.
- **Decision:** Set normal Agent completions to 8,192 tokens and repairs to
  1,024. Port Atomic Agent's deterministic token estimator, 32K configured
  conversation cap, 512-token safety margin and floor, and `/props` `n_ctx`
  probe. Pack the newest conversation turns within the resulting prompt-time
  budget while retaining the latest user turn and a deterministic dropped
  history summary. Extract the proxy's context-expansion coordination into a
  shared server module and let normal or repair completion retry exactly once
  after a confirmed context overflow, accepting only a reloaded session with
  the same model and backend.
- **Consequences:** Agent prompts now reserve output space against the real
  context window when available and degrade to the configured cap when
  `/props` cannot be read. A context overflow reloads through the existing
  TypeScript-owned context ladder without replaying the macro-turn or executed
  tools. Cancellation and non-context failures are not retried. No frontend,
  IPC, persisted-session-schema, or Local API Server contract changed.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/token_budget.rs`](src-tauri/src/core/agent/token_budget.rs),
  [`src-tauri/src/core/agent/llm_client.rs`](src-tauri/src/core/agent/llm_client.rs),
  [`src-tauri/src/core/agent/session.rs`](src-tauri/src/core/agent/session.rs),
  [`src-tauri/src/core/server/context_expansion.rs`](src-tauri/src/core/server/context_expansion.rs).

---
