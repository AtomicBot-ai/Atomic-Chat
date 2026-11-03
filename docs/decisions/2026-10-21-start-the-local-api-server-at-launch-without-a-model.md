---
date: 2026-10-21
title: "Start the Local API Server at launch without a model"
---

# 2026-10-21 — Start the Local API Server at launch without a model

- **Context:** Server → Configuration's "Start automatically" says "Start the
  server when Atomic Chat opens", and `enableOnStartup` is on by default. The
  startup path (`DataProvider.tsx`) only re-attached to a running listener or
  raised the server for a chat model already running in an engine; with
  model preloading off (the default since ADR 2026-08-19) nothing is running at
  launch, so the server stayed down and port 1337 refused connections until the
  user pressed Start or loaded a model (QA AC-08 on 2.2.23). The core's public
  server runs fine with no model: it serves cloud models, the embedding, image
  and decision models, and answers a local chat request with 503 "No models
  are available" until one is loaded. It does not load a model on demand.
- **Decision:** With "Start automatically" on, the server starts at launch
  whether or not a model is running, and no model is loaded or picked for it
  (ADR 2026-08-19 stands). Like Start, it switches back on the embedding and
  decision models the last turn-off paused (`resumeServedHelperModels`).
  Where the platform has no Local API Server (mobile, web) the old rule stays:
  only a running model raises the proxy. Only the launch does this: the main
  window, once per run of the app (`claimLaunchAutoStart`, a marker in the main
  window's sessionStorage, which a reload keeps and a restart does not). Every
  window mounts `DataProvider`, and without that a chat opened in its own
  window, or a reload, would bring a server the user stopped back up.
- **Consequences:** The setting now does what it says. Since the toggle
  defaults to on, most desktop installs listen on the configured port (127.0.0.1
  unless the user chose the network) from launch, with no local model until
  one is loaded; a client that asks for a local model before then gets the
  503. Remote access and local network access, which follow the server,
  come up at launch too when their own auto-start is on. Supersedes the
  startup clauses of ADR 2026-08-19 ("stays down when nothing is running")
  and ADR 2026-09-25 ("the startup path … still raises the server only for a
  running chat model").
- **Owner:** team
- **Links:** `web-app/src/providers/DataProvider.tsx`,
  `web-app/src/providers/__tests__/DataProvider.test.tsx`,
  [Do not preload a model on startup](2026-08-19-do-not-preload-a-model-on-startup.md),
  [Raise the Local API Server for a resident image or video model](2026-09-25-raise-the-local-api-server-for-a-resident-image-or-video-model.md),
  [Turn the served models off with the server](2026-10-20-turn-the-served-models-off-with-the-server.md)

<!--
Supersedes: the startup clauses of 2026-08-19-do-not-preload-a-model-on-startup.md
and 2026-09-25-raise-the-local-api-server-for-a-resident-image-or-video-model.md
-->
