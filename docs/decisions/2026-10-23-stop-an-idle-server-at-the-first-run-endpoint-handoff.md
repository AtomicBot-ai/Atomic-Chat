---
date: 2026-10-23
title: "Stop an idle server at the first-run endpoint handoff"
---

# 2026-10-23 — Stop an idle server at the first-run endpoint handoff

- **Context:** The launch starts the Local API server with no model loaded
  (2026-10-21), and the core does not load one on demand. The first-run
  endpoint path hands off to the server page with a hint to press Start; with
  the server already up, the button read Stop, the first press stopped it,
  and a running server never picked up the setup model once its download
  finished. The prototype hands off with the server stopped.
- **Decision:** The endpoint handoff (`ServerStep` `connect('endpoint')`)
  stops the server only when it is running with no model loaded, through
  `setLocalApiServerRunning(false)`, and marks the endpoint configured; Start
  then loads the setup model. The chat and agents paths keep the launch
  autostart. If the server is running when the hints reach Start (a relaunch
  mid-guide, the tray or the CLI), the hint says so and offers Done and the
  connection details instead of asking for Start.
- **Consequences:** One Start press serves the setup model, as the hint says.
  A first-run user who picks the endpoint path sees the server stopped until
  they start it. Supersedes 2026-10-21 in part: on that one path the launch
  autostart is undone.
- **Owner:** `team`.
- **Links:** `web-app/src/containers/onboarding/steps/ServerStep.tsx`,
  `web-app/src/containers/onboarding/SetupGuideHint.tsx`,
  `web-app/src/containers/ServerControlPanel.tsx`.

<!--
Supersedes: 2026-10-21-start-the-local-api-server-at-launch-without-a-model.md (in part)
-->
