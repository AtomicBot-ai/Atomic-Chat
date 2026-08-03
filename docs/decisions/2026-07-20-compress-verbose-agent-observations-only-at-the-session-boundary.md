---
date: 2026-07-20
title: "Compress verbose Agent observations only at the session boundary"
---

# 2026-07-20 — Compress verbose Agent observations only at the session boundary

- **Context:** Rust Agent retained bounded tool output for frontend activity
  events but copied up to 1,200 characters of every observation into the
  active prompt and durable session. Verbose reads, searches, logs, HTTP
  responses, and document extracts therefore consumed context with low-signal
  leading output.
- **Decision:** Port the deterministic Atomic Agent tail compressor and log
  summarizer. For potentially verbose read/inspection tools, retain the last
  12 nonblank lines, preserve the first recognized error signature, and cap
  the model-visible summary at 400 Unicode characters with explicit
  omission/truncation markers. Apply compression only when observations enter
  `AgentSessionState`; keep `ToolOutcome` and `ToolCallExecuted` unchanged.
- **Consequences:** The next model step and persisted `agent-session.json`
  receive compact observations while the activity UI retains the original
  bounded result. Concise mutation acknowledgements and control tools remain
  unchanged, and the existing 1,200-character session limit remains as
  defense in depth.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/compressor.rs`](src-tauri/src/core/agent/compressor.rs),
  [`src-tauri/src/core/agent/session.rs`](src-tauri/src/core/agent/session.rs),
  [`src-tauri/src/core/agent/runner_tests.rs`](src-tauri/src/core/agent/runner_tests.rs).

---
