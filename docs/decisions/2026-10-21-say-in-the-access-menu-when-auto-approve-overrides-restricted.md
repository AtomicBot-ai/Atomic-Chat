---
date: 2026-10-21
title: "Say in the access menu when auto-approve overrides Restricted"
---

# 2026-10-21 — Say in the access menu when auto-approve overrides Restricted

- **Context:** QA AC-05 (2.2.23): with "Auto-approve tool calls" on, Restricted
  promises to ask before tool calls use the internet, yet Exa web search ran
  unasked while a command did ask. That is the rule in `lib/mcp-approval.ts`:
  until a mode is picked for the thread, MCP tools follow the global switch
  (on for everyone); commands and scripts ask unless the mode is Full access.
  The behaviour was triaged as intended on 2026-10-21. Since the 2026-09-22
  record the composer label stays plain, and only the Settings switch said so.
- **Decision:** Keep the behaviour and the plain trigger label. While the
  global switch decides (switch on, no mode picked), the Restricted row in the
  access menu adds one line saying the setting is on, so web search and other
  connector tools run without asking, and an "Open Settings" item right under
  it opens Settings → General. Once a mode is picked the select governs MCP
  tools, Restricted asks, and the line goes away.
- **Consequences:** The menu no longer promises what does not happen. Copy is
  EN + RU; other locales fall back to English. The hidden agent engine is not
  covered: its built-in web tools are pure reads that never ask. A first
  message that waits for a model download and is sent after the user left New
  Chat (`DeferredFirstSendProvider`) used to start its thread with no mode, so
  it followed the global switch whatever New Chat showed. The queued send now
  carries New Chat's approval mode and workspace from the moment Send was
  pressed, and the new thread gets exactly those (`handOffThreadState`), as a
  direct send's `transferThreadState` does. Tool and web search choices need
  no copy: New Chat edits the app-wide defaults, which every new thread
  follows on either path.
- **Owner:** `team`.
- **Links:** `web-app/src/containers/AgentApprovalModeSelect.tsx`,
  `web-app/src/containers/ChatInput.tsx`, `web-app/src/lib/mcp-approval.ts`,
  [2026-09-22 record](2026-09-22-keep-the-composers-approval-label-plain.md)
