---
date: 2026-09-22
title: "Keep the composer's approval label plain"
---

# 2026-09-22 — Keep the composer's approval label plain

- **Context:** Since the 2026-09-19 record, the composer's approval select read
  "Ask for approval · MCP tools auto-approved" on a thread whose approval mode
  the user never picked, while the global "Allow All MCP Tool Permissions"
  switch was on — which it is for everyone. So on every new thread the toolbar
  carried the long label, and it never folded back into the plain trigger the
  released app shows.
- **Decision:** The select shows its plain default, "Ask for approval", again.
  Auto-approval of MCP tools stays where it was before: behind the "Allow All
  MCP Tool Permissions" switch in Settings, on by default. The behaviour is
  unchanged — MCP tools on an untouched thread still follow that switch, and a
  mode the user picks still governs them.
- **Consequences:** The composer is back to what the released app shows. The
  mismatch the 2026-09-19 record fixed returns on purpose: on an untouched
  thread the label reads "Ask for approval" while MCP tools run unasked, and
  the only place that says so is the Settings switch. `mcp-tool.spec.ts` pins
  both the plain label and the unasked call.
- **Owner:** `team`.
- **Links:** `web-app/src/containers/ChatInput.tsx`, `web-app/src/lib/mcp-approval.ts`,
  `web-app/src/hooks/useToolApproval.ts`, `tests/e2e/desktop/mcp-tool.spec.ts`

<!--
Supersedes: 2026-09-19-say-when-mcp-tools-are-auto-approved.md
-->
