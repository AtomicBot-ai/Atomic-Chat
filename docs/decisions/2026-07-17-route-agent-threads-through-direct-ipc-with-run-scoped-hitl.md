---
date: 2026-07-17
title: "Route Agent threads through direct IPC with run-scoped HITL"
---

# 2026-07-17 — Route Agent threads through direct IPC with run-scoped HITL

- **Context:** The isolated Rust agent loop and approval gate were exposed
  through Tauri commands, but Agent threads still submitted through the
  ordinary AI SDK chat transport and had no frontend lifecycle for workspace,
  streamed events, cancellation, or approval decisions.
- **Decision:** Route Agent-thread turns directly through `agent_run_turn` and
  keep ordinary Chat threads on `CustomChatTransport`. Persist a working
  directory and the existing manual/skip approval policy per thread. Project
  streamed events into thread-scoped live UI state, resolve sensitive actions
  through a dedicated run-scoped Approve once/Deny dialog, and persist one
  bounded `metadata.agent_run` summary on the terminal event without approval
  previews or a raw event log.
- **Consequences:** Agent v1 now has a complete text-only llama.cpp workflow
  with cancellation and human approval while ordinary chat behavior remains
  unchanged. Pending approvals do not survive restart, workspace access is
  explicit, and cloud, MLX, attachments, MCP/RAG, browser execution, approval
  history, and always-allow policies remain outside this iteration.
- **Owner:** team.
- **Links:** [`web-app/src/services/agent/tauri.ts`](web-app/src/services/agent/tauri.ts),
  [`web-app/src/hooks/useAgentRun.ts`](web-app/src/hooks/useAgentRun.ts),
  [`web-app/src/containers/dialogs/AgentApprovalDialog.tsx`](web-app/src/containers/dialogs/AgentApprovalDialog.tsx),
  [`web-app/src/routes/threads/$threadId.tsx`](web-app/src/routes/threads/$threadId.tsx).

---
