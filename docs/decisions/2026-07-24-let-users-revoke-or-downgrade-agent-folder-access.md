---
date: 2026-07-24
title: "Let users revoke or downgrade Agent folder access"
---

# 2026-07-24 — Let users revoke or downgrade Agent folder access

- **Context:** Connected external Agent folders were permanently editable for
  the thread and had no management controls after being added.
- **Decision:** Persist an explicit `canEdit` permission per external root and
  expose Can edit, View only, and Remove actions in the Files-panel overflow
  menu. Keep view-only roots available to read tools while excluding them from
  editable path policy; removing a root disconnects it from subsequent runs and
  closes its open previews without deleting anything from disk.
- **Consequences:** Users can reduce or revoke thread-scoped Agent access
  without removing local files. Existing persisted roots migrate to Can edit,
  preserving their prior behavior.
- **Owner:** team.
- **Links:** [`web-app/src/hooks/useAgentMode.ts`](web-app/src/hooks/useAgentMode.ts),
  [`web-app/src/containers/AgentWorkspaceFiles.tsx`](web-app/src/containers/AgentWorkspaceFiles.tsx),
  [`src-tauri/src/core/agent/commands.rs`](src-tauri/src/core/agent/commands.rs),
  [`src-tauri/src/core/agent/prompt.rs`](src-tauri/src/core/agent/prompt.rs).
