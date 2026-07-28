---
date: 2026-07-23
title: "Present the Agent working directory as the Files root"
---

# 2026-07-23 — Present the Agent working directory as the Files root

- **Context:** The Agent composer displayed the selected directory as a text
  control while the Files panel rendered only its children, so the workspace
  tree had no visible root and panel visibility was controlled elsewhere.
- **Decision:** Render the selected or default working directory as the
  collapsible first-level folder in Files. Keep directory selection in the
  composer and place the Files-panel toggle on its own row above the root.
  Align both the expanded-panel toggle and the collapsed-panel opener to the
  left on Windows, clear of the window controls, and to the right on macOS.
- **Consequences:** The workspace tree now reflects the real directory
  hierarchy, the selected folder remains visible and changeable in the
  composer, and panel visibility is controlled from the panel edge. Empty
  workspaces can still be opened manually while automatic opening remains
  content-driven.
- **Owner:** team.
- **Links:** [`web-app/src/containers/AgentWorkspaceFiles.tsx`](web-app/src/containers/AgentWorkspaceFiles.tsx),
  [`web-app/src/containers/AgentWorkspaceSelect.tsx`](web-app/src/containers/AgentWorkspaceSelect.tsx),
  [`web-app/src/containers/ChatInput.tsx`](web-app/src/containers/ChatInput.tsx).

---
