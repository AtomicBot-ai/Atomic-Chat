---
date: 2026-11-09
title: "Ask before a model switch restarts running agents"
---

# 2026-11-09 — Ask before a model switch restarts running agents

- **Context:** Since 2026-11-03 a change of the served model rewrites every
  connected agent's config, but an agent already running keeps the model it
  read at start (only OpenClaw and ZCode reload). The server serves one chat
  model, the one the chat uses, so a pick in the model dropdown, a send that
  starts another model, a thread's own model or Start on an engine page left
  a running agent on HTTP 404 until the user restarted it, with only a toast
  to say so. A switch to a cloud model unloads every local one, which left the
  agents on nothing at all.
- **Decision:**
  - Every switch already runs through `switchToModel`. Before it touches an
    engine it asks the app which agents Atomic Chat opened still run
    (`list_agent_terminals`); any opened for another model makes it ask the
    user (`AgentSwitchDialog`, mounted at the root), naming the agents and the
    target, and for a cloud target the provider their requests and bill go
    to. Auto-starts ask too: a silent switch is what broke the agents.
  - No: the switch ends as a cancelled load (no error anywhere) and the
    selection goes back to the model the server serves. A switch for the same
    model queued while the question was open is dropped, not asked again.
  - Yes: the agents are stopped before the old model is unloaded, the switch
    runs, and once no switch is left in the queue each agent is opened again
    through Connect (`useAgentActions().connect`: its config for the model now
    served, its minimum window, its terminal). A cloud model the user confirmed
    is written into their configs like a local one. One toast names the
    restarted agents; the follow toast of `connectedAgentsModel.ts` ("restart
    a running tool") is kept quiet for that model. A switch that fails or is
    cancelled after the stop says the agents were stopped; one a newer switch
    takes over opens them on what that one serves. Conversations start over:
    no agent is resumed.
  - The process: on macOS and Linux the launcher writes `$$` to a 0600 file
    the app made for it (`create_new`) before it `exec`s the agent, so that pid
    is the agent's. On Windows the console is no longer opened through
    `start`: `cmd /K "title …& …"` is spawned with `CREATE_NEW_CONSOLE` and its
    pid kept; the agent runs under it, and a console back at its prompt counts
    as no agent. A pid is believed only while its process keeps the start
    time first seen, and a pid from a file only when that process started
    after the terminal opened (`agent_sessions.rs`). A stop sends SIGTERM to
    the agent and everything under it, waits 3 s and kills what is left (on
    Windows it ends the tree at once, which closes the console).
  - macOS keeps the agent's Terminal tab: the open script now takes the tab
    the agent ran in and, when it is idle, runs the launcher there, so a
    restarted agent stays in its window (a plain Connect after the agent
    exited reuses it too). The launcher leaves an alternate screen and shows
    the cursor first, for a tab whose agent was killed mid-draw.
- **Consequences:** Only agents Atomic Chat opened during this app run are
  known; one the user started in a terminal of their own still follows the
  config at its next start, with the toast as before. Linux opens a new
  window for the restarted agent (the old one closes with it); Windows does
  the same, and a Windows Terminal set as the default console host may keep
  the old tab open with an exit code. A switch now waits for the user while
  agents run, so a chat send that starts another model holds until the answer.
  The Windows console path needs a run on real Windows (2026-11-09: the office
  PC was offline).
- **Owner:** `team`.
- **Links:** `web-app/src/utils/agentSwitchGuard.ts`,
  `web-app/src/utils/switchModel.ts`,
  `web-app/src/containers/dialogs/AgentSwitchDialog.tsx`,
  `src-tauri/src/core/system/agent_sessions.rs`,
  `src-tauri/src/core/system/agent_terminal.rs`,
  [Keep connected agents on the model the server serves](2026-11-03-keep-connected-agents-on-the-model-the-server-serves.md),
  [Say Connected only after an agent's first request](2026-11-03-say-connected-only-after-an-agents-first-request.md)

<!--
Supersedes: 2026-11-03-keep-connected-agents-on-the-model-the-server-serves.md (in part: an agent Atomic Chat opened no longer keeps running on the old model, and a confirmed cloud model is written into agent configs)
-->
