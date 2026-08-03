---
date: 2026-07-20
title: "Keep the Agent preview panel structurally stable"
---

# 2026-07-20 — Keep the Agent preview panel structurally stable

- **Context:** Opening the first workspace file dynamically inserted a new
  resizable panel and changed the Files panel's default width, causing the
  entire Agent thread layout to visibly jump.
- **Decision:** Keep all three panels mounted and set the complete group layout
  atomically when Preview or Files visibility changes. Allocate 24% to each
  visible workspace panel and take that space only from Chat. Present the
  single file preview as a compact, icon-labelled tab instead of an unbounded
  rectangular tab.
- **Consequences:** Replacing the active file no longer reconstructs or
  renormalizes the three-column panel group. Opening or closing Preview still
  resizes Chat as intended, while Files retains its current width.
- **Owner:** team.
- **Links:** [`web-app/src/containers/AgentWorkspaceLayout.tsx`](web-app/src/containers/AgentWorkspaceLayout.tsx),
  [`web-app/src/containers/AgentWorkspacePreview.tsx`](web-app/src/containers/AgentWorkspacePreview.tsx).

---
