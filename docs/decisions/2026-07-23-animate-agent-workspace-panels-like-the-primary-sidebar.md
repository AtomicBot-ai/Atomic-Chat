---
date: 2026-07-23
title: "Animate Agent workspace panels like the primary sidebar"
---

# 2026-07-23 — Animate Agent workspace panels like the primary sidebar

- **Context:** The Agent Files and Preview panels appeared by changing the
  resizable layout immediately, while the primary left sidebar slides into and
  out of view over 200 ms.
- **Decision:** Apply the same 200 ms linear layout transition to the Agent
  panel group and slide Files and Preview across their full width on mount and
  unmount. Keep panel content mounted through its exit animation.
- **Consequences:** Opening a workspace file or toggling the Files panel no
  longer causes an abrupt layout jump. Chat width and both right-side panels
  move together, while manual resizing and the existing three-panel structure
  remain unchanged.
- **Owner:** team.
- **Links:** [`web-app/src/containers/AgentWorkspaceLayout.tsx`](web-app/src/containers/AgentWorkspaceLayout.tsx),
  [`web-app/src/containers/AgentWorkspaceLayout.test.tsx`](web-app/src/containers/AgentWorkspaceLayout.test.tsx).

---
