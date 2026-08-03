---
date: 2026-07-23
title: "Remember exact Agent approvals globally"
---

# 2026-07-23 — Remember exact Agent approvals globally

- **Context:** Agent approval requests supported only deny, one-time approval,
  or the turn-wide unsafe skip policy, so users had to approve an identical
  safe action again in every thread and after every restart.
- **Decision:** Add `always_allow` for approval-gated actions whose prepared
  paths remain inside the trusted workspace. Fingerprint the tool name and
  canonicalized prepared arguments with full SHA-256, store only that digest
  in the versioned global `agent-approval-allowlist.json`, and update it
  atomically before execution continues. Evaluate shell hard blocks before
  allowlist matching, and never offer or honor remembered approval when path
  preparation reports an escape from the trusted root.
- **Consequences:** An exact action can be approved once and reused across all
  Agent threads and application restarts without persisting commands, paths,
  URLs, or secrets. Any argument change requires approval again. Shell hard
  blocks, timeouts, cancellation, stale decisions, and workspace escapes
  remain fail-closed. Revoking saved approvals has no UI in this iteration.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/approval_allowlist.rs`](src-tauri/src/core/agent/approval_allowlist.rs),
  [`src-tauri/src/core/agent/tools/mod.rs`](src-tauri/src/core/agent/tools/mod.rs),
  [`src-tauri/src/core/agent/approval.rs`](src-tauri/src/core/agent/approval.rs),
  [`web-app/src/containers/dialogs/AgentApprovalDialog.tsx`](web-app/src/containers/dialogs/AgentApprovalDialog.tsx).

---
