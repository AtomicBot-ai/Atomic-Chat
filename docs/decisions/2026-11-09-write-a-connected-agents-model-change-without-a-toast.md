---
date: 2026-11-09
title: "Write a connected agent's model change without a toast"
---

# 2026-11-09 — Write a connected agent's model change without a toast

- **Context:** Since 2026-11-03 every change of the served model rewrote each
  connected agent's config and showed "Connected tools now use {model}" with
  "Restart a tool that is already running to switch it over." Since the
  record earlier today, a switch asks before it cuts off the agents Atomic
  Chat opened and restarts them on a yes, so the toast came after every
  model change and said what the user had just seen or decided. The switch
  kept it quiet only for the model whose agents it restarted.
- **Decision:** The configs are still rewritten on every change of the
  served model, silently. The toast and its strings
  (`api:connected.modelSwitched*`) are gone, and so is the switch's
  quiet-toast hand-off (`quietAgentsToastFor` / `consumeQuietAgentsToast`).
  The restart's own toasts ("Restarted on …", "Agents stopped …") stay.
- **Consequences:** An agent the user started in a terminal of their own
  gets no hint after a model change; it picks the new model up at its next
  start, as before.
- **Owner:** `team`.
- **Links:** `web-app/src/utils/connectedAgentsModel.ts`,
  `web-app/src/utils/agentSwitchGuard.ts`,
  [Keep connected agents on the model the server serves](2026-11-03-keep-connected-agents-on-the-model-the-server-serves.md),
  [Ask before a model switch restarts running agents](2026-11-09-ask-before-a-model-switch-restarts-running-agents.md)

<!--
Supersedes: 2026-11-03-keep-connected-agents-on-the-model-the-server-serves.md (in part: the toast)
Supersedes: 2026-11-09-ask-before-a-model-switch-restarts-running-agents.md (in part: the follow toast kept quiet)
-->
