---
date: 2026-07-24
title: "Connect editable Agent folders per thread"
---

# 2026-07-24 — Connect editable Agent folders per thread

- **Context:** Agent threads exposed one working directory, so users could not
  attach additional project folders or grant access when a filesystem call
  targeted an unconnected location such as Desktop.
- **Decision:** Keep the primary workspace as the base for relative paths and
  persist canonical external roots per thread as `CAN EDIT`. Permit reads and
  ordinary write/edit/mkdir calls inside those roots without action approval,
  while retaining approval for destructive tools. Gate an explicit filesystem
  path outside all connected roots through a separate run-scoped Allow folder
  request; on approval, add the canonical folder to the active run and thread
  before retrying the original call. Keep attachment roots read-only and
  separate.
- **Consequences:** Agent can browse and modify several independent roots,
  manually connected folders survive restart, and dynamically approved folders
  appear in the Files panel immediately. Relative paths remain unambiguous.
  Shell strings are not inspected for paths, and trash, patch, archive extract,
  shell, and other high-risk actions still require their existing approval.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/path_policy.rs`](src-tauri/src/core/agent/path_policy.rs),
  [`src-tauri/src/core/agent/folder_access.rs`](src-tauri/src/core/agent/folder_access.rs),
  [`web-app/src/hooks/useAgentMode.ts`](web-app/src/hooks/useAgentMode.ts),
  [`web-app/src/containers/AgentWorkspaceFiles.tsx`](web-app/src/containers/AgentWorkspaceFiles.tsx),
  [`web-app/src/containers/dialogs/AgentFolderAccessDialog.tsx`](web-app/src/containers/dialogs/AgentFolderAccessDialog.tsx).
