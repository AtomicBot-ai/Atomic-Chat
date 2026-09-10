---
date: 2026-07-23
title: "Reveal Agent workspace files only when content exists"
---

# 2026-07-23 — Reveal Agent workspace files only when content exists

- **Context:** Desktop Agent threads opened the Files sidebar even when the
  selected or default workspace was empty, reducing chat width without showing
  useful content.
- **Decision:** Probe the workspace root when a thread opens and after each
  Agent run. Keep the Files sidebar hidden while the root is empty, and
  automatically open it only when the workspace first contains an entry.
  Preserve a user's manual close while the workspace remains non-empty.
- **Consequences:** Empty Agent workspaces start with the full width available
  to chat. The Files sidebar appears when the Agent creates its first output,
  remains manually closable, and disappears again if a refreshed workspace is
  empty.
- **Owner:** team.
- **Links:** [`web-app/src/containers/AgentWorkspaceLayout.tsx`](web-app/src/containers/AgentWorkspaceLayout.tsx),
  [`web-app/src/containers/AgentWorkspaceLayout.test.tsx`](web-app/src/containers/AgentWorkspaceLayout.test.tsx).

---
