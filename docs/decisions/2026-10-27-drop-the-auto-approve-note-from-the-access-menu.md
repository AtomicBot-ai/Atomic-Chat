---
date: 2026-10-27
title: "Drop the auto-approve note from the access menu"
---

# 2026-10-27 — Drop the auto-approve note from the access menu

- **Context:** Since the 2026-10-21 record, while "Auto-approve tool calls" is
  on and no mode is picked for the thread, the Restricted row of the
  composer's access menu carried an amber line saying web search and other
  connector tools run without asking, plus an "Open Settings" item under it.
  Product review: users do not need it in the menu, the switch is easy to
  find in Settings, and the extra line and item made the menu change height
  and layout depending on a setting.
- **Decision:** Remove the note and the "Open Settings" item. The access menu
  always shows the two modes (and the switches below them) and nothing else.
  The approval rule in `lib/mcp-approval.ts` is unchanged: until a mode is
  picked, MCP tools follow the global switch.
- **Consequences:** The menu keeps one layout. Restricted's description again
  does not say that the global switch can run connector tools unasked; the
  Settings switch is the only place that says so. The deferred first send
  still carries New Chat's approval mode to the new thread (that part of the
  2026-10-21 record stands).
- **Owner:** `team`.
- **Links:** `web-app/src/containers/AgentApprovalModeSelect.tsx`,
  `web-app/src/containers/ChatInput.tsx`, `web-app/src/lib/mcp-approval.ts`

<!--
Supersedes: 2026-10-21-say-in-the-access-menu-when-auto-approve-overrides-restricted.md
-->
