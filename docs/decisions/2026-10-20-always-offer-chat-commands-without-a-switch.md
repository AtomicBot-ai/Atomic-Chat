---
date: 2026-10-20
title: "Always offer chat commands, with no Run commands switch"
---

# 2026-10-20 — Always offer chat commands, with no Run commands switch

- **Context:** `run_command` / `run_script` reached the model only while
  "Run commands" was on (`chatExecEnabled`, default on,
  [2026-10-15](2026-10-15-run-commands-and-scripts-from-chat.md)). The switch
  moved from the "+" menu into the access menu under Restricted and Full access
  ([2026-10-20](2026-10-20-attach-with-one-paperclip-and-gather-access-in-one-menu.md)).
  There it was a third control next to the two approval modes, and its
  description repeated what the modes already say.
- **Decision:** Remove the switch and the setting. Chat offers the two tools
  whenever `PlatformFeature.CHAT_EXEC` is on, the machine can run commands
  (`chat_exec_status.supported`) and the model calls tools. A secure project
  still gets them only inside MXC. Each run still asks unless the thread is on
  Full access. `useGeneralSetting` moves to v5, and its migration deletes a
  saved `chatExecEnabled`, so an install that had switched commands off does not
  keep them off with no control to turn them back on. The access menu keeps its
  switch slot for Agent mode, which is still hidden, so for now it shows only
  the two modes and no separator.
- **Consequences:**
  - The only way to keep the model from running something is Restricted mode
    and declining the approval dialog. No setting hides the tools.
  - The `chat:chatExec` strings are gone (en, ru).
  - An MCP tool named `run_command`/`run_script` is now always shadowed by the
    built-in one where commands are supported.
- **Owner:** team
- **Links:** `web-app/src/hooks/useGeneralSetting.ts`,
  `web-app/src/lib/chat-exec-tools.ts`,
  `web-app/src/lib/custom-chat-transport.ts`,
  `web-app/src/containers/ChatInput.tsx`,
  `web-app/src/hooks/__tests__/useGeneralSetting.migrate.test.ts`

<!--
Supersedes: the "Run commands" switch in 2026-10-15-run-commands-and-scripts-from-chat.md
and 2026-10-20-attach-with-one-paperclip-and-gather-access-in-one-menu.md
-->
