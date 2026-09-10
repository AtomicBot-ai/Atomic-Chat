---
date: 2026-07-16
title: "Bind the agent approval policy to its thread"
---

# 2026-07-16 — Bind the agent approval policy to its thread

- **Context:** Agent mode needs a visible safety policy below the composer, but
  the iteration-1 Rust gate currently exposes only `auto_approve=false`
  (pause for sensitive actions) and `auto_approve=true` (skip every approval).
- **Decision:** Offer exactly those two policies in the frontend: "Manually
  approve" as the fail-closed default and "Skip all approvals" as an explicit
  unsafe choice. Persist the policy with the temporary Home selection and
  transfer it to the created Agent thread alongside the mode.
- **Consequences:** The UI does not imply a selective safe-action policy that
  the backend cannot enforce. Agent IPC callers can map `manual` to
  `auto_approve=false` and `skip` to `auto_approve=true`; interactive rendering
  of emitted approval requests remains separate work.
- **Owner:** team.
- **Links:** [`web-app/src/hooks/useAgentMode.ts`](web-app/src/hooks/useAgentMode.ts),
  [`web-app/src/containers/AgentApprovalModeSelect.tsx`](web-app/src/containers/AgentApprovalModeSelect.tsx),
  [`src-tauri/src/core/agent/approval.rs`](src-tauri/src/core/agent/approval.rs).

---
