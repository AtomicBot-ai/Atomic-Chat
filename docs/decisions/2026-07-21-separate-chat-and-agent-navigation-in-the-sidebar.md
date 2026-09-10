---
date: 2026-07-21
title: "Separate Chat and Agent navigation in the sidebar"
---

# 2026-07-21 — Separate Chat and Agent navigation in the sidebar

- **Context:** Chat and Agent shared one sidebar history and selected their
  execution mode inside the composer, which crowded the input and mixed
  mode-specific navigation, search, and bulk actions.
- **Decision:** Persist a top-level Chat/Agent sidebar mode while retaining
  `agentThreads` as the source of truth for each thread. Synchronize the mode
  when Home or an existing thread opens; scope history, search, and bulk
  deletion to it. Show Projects and Integrations only in Chat, move Models and
  Settings to the shared footer, and remove the composer mode switch.
- **Consequences:** Chat and Agent now have separate navigation surfaces and
  histories without changing thread storage or routes. Existing Agent approval
  and workspace settings remain thread-bound, and MLX still cannot start a new
  Agent chat.
- **Owner:** team.
- **Links:** [`web-app/src/components/left-sidebar/index.tsx`](web-app/src/components/left-sidebar/index.tsx),
  [`web-app/src/components/left-sidebar/NavChats.tsx`](web-app/src/components/left-sidebar/NavChats.tsx),
  [`web-app/src/containers/dialogs/SearchDialog.tsx`](web-app/src/containers/dialogs/SearchDialog.tsx),
  [`web-app/src/hooks/useAgentMode.ts`](web-app/src/hooks/useAgentMode.ts).

---
