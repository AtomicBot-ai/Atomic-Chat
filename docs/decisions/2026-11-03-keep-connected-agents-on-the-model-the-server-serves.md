---
date: 2026-11-03
title: "Keep connected agents on the model the server serves"
---

# 2026-11-03 — Keep connected agents on the model the server serves

- **Context:** Connect writes the id of the model the server serves into the
  agent's own config (`writeAgentConfig`, ADR 2026-10-27), and the server and
  the chat share one loaded model. Serve Qwen, connect agents, then open a
  chat on Gemma: `switchToModel` unloads Qwen, loads Gemma, and the server now
  serves Gemma, while every connected agent still asked for Qwen and got HTTP
  404 until it was connected again (B02, QA 2.3.2).
- **Decision:** When the model the server serves changes —
  `lastServerModels[0]`, else the default, whatever changed it: a chat switch,
  Start with another model, the Claude Code or Hermes Agent page — every agent
  in `configuredAgents` that the catalog still lists as configurable gets its
  config rewritten to the new model through `writeAgentConfig`, with the
  server's current host, port, prefix and key
  (`syncConnectedAgentsWithServedModel` in `utils/connectedAgentsModel.ts`,
  subscribed in `DataProvider` next to the served-model selection). Skipped:
  no model, an id no provider lists, an embedding model, and the model the
  agents already use. The writes run one after another; one overtaken by a
  newer change is dropped, and one that fails is logged for that agent and
  never reaches the switch. One toast per change says the connected tools now
  use the model and that a tool already running needs a restart.
- **Consequences:** An agent's next launch asks for the model actually served,
  so a chat on another model no longer leaves connected agents on 404s. An
  agent already running keeps the model it read when it started (OpenClaw and
  ZCode reload their config by themselves); the toast says so. Every switch
  rewrites the config of every connected agent, including ones the user no
  longer runs; Disconnect in Connections takes an agent out of them. A chat
  switch to a cloud model points the agents at that cloud model through the
  server, as Connect would, so their requests then go to that provider. The
  model served when the app starts is taken as the one the agents use: a
  config left stale by an earlier release is corrected at the next change, not
  at launch. A change is seen by the window that made it, with the connected
  agents that window loaded.
- **Owner:** `team`.
- **Links:** `web-app/src/utils/connectedAgentsModel.ts`,
  `web-app/src/providers/DataProvider.tsx`,
  `web-app/src/utils/__tests__/connectedAgentsModel.test.ts`,
  [Run an agent from its Server card](2026-10-27-run-an-agent-from-its-server-card.md),
  [Start the Local API Server at launch with the model it served last](2026-11-03-start-the-local-api-server-at-launch-with-its-last-model.md)
