---
date: 2026-07-17
title: "Make each Agent thread a durable session and recover invalid tool batches"
---

# 2026-07-17 — Make each Agent thread a durable session and recover invalid tool batches

- **Context:** Every Agent IPC run previously started with only its current
  user message, so sequential turns in one thread lost tool observations and
  loaded rare-tool schemas. A malformed or structurally invalid tool-call
  batch also failed the run immediately, including recoverable attempts to
  batch approval-gated tools.
- **Decision:** Treat `threadId` as the durable Agent `session_id` and keep
  `run_id` as the ephemeral macro-turn identifier. Persist one bounded,
  semantic `agent-session.json` inside the existing thread directory, restore
  its transcript and rare-tool LRU on every run, and serialize same-session
  runs with per-session FIFO locks. Trim a batch whose only violation is an
  approval-gated solo constraint to its first gated call and add a one-shot
  notice; for parse errors and all other validation failures, perform exactly
  one grammar-preserving repair completion capped at 1024 tokens.
- **Consequences:** Agent turns in one thread retain bounded context across app
  restarts while different threads remain isolated. Session files contain no
  raw tool arguments, approval previews, or event logs. Recovery diagnostics
  are streamed as `parse_retry` / `batch_trimmed` but remain absent from
  persisted message metadata; approvals themselves remain run-scoped and do
  not survive restart.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/session.rs`](src-tauri/src/core/agent/session.rs),
  [`src-tauri/src/core/agent/runner.rs`](src-tauri/src/core/agent/runner.rs),
  [`src-tauri/src/core/agent/commands.rs`](src-tauri/src/core/agent/commands.rs),
  [`web-app/src/hooks/useAgentRun.ts`](web-app/src/hooks/useAgentRun.ts).

---
