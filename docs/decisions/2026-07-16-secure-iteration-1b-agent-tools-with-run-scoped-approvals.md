---
date: 2026-07-16
title: "Secure iteration 1b agent tools with run-scoped approvals"
---

# 2026-07-16 — Secure iteration 1b agent tools with run-scoped approvals

- **Context:** The first autonomous Rust agent loop had mismatched archive and
  shell contracts, no interactive approval protocol, no trusted-root path
  boundary, and no way to expose complete schemas for rare tools. Clipboard
  write and desktop notification actions were also absent.
- **Decision:** Add a unified authorization preflight that combines resource
  class, canonical path resources, and shell-guard verdicts into at most one
  approval request per call. Use a run-scoped `ApprovalGate`: `auto_approve`
  permits approval-required actions; otherwise the backend emits a pending
  request and waits for `agent_resolve_approval`, timeout, or cancellation.
  Treat `working_dir` as the trusted canonical root and make path escape
  approval-mediated and call-scoped. Route shell calls through direct argv or
  a platform shell only after hard-block and approval checks. Keep rare schemas
  out of the stable prefix and expose them through bounded `tool.view` state in
  `### loaded-tools`. Add serialized `os.clipboard.write` and `os.notify`
  adapters using existing desktop services.
- **Consequences:** Read-only in-root actions remain confirmation-free;
  dangerous, destructive, and out-of-root actions fail closed unless globally
  auto-approved or explicitly resolved. Hard-block shell rules cannot be
  bypassed by auto-approval. The frontend approval UI remains deferred, so
  callers using the default `auto_approve=false` must resolve emitted requests
  through IPC or accept timeout denial. The static catalog, grammar, resource
  classes, and dispatch table gain `tool.view`, clipboard write, and notify.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/ARCHITECTURE.md`](src-tauri/src/core/agent/ARCHITECTURE.md),
  [`src-tauri/src/core/agent/approval.rs`](src-tauri/src/core/agent/approval.rs),
  [`src-tauri/src/core/agent/path_policy.rs`](src-tauri/src/core/agent/path_policy.rs),
  [`src-tauri/src/core/agent/shell_guard.rs`](src-tauri/src/core/agent/shell_guard.rs).

---
