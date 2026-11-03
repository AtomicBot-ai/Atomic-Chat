---
date: 2026-11-03
title: "Start the Local API Server at launch with the model it served last"
---

# 2026-11-03 — Start the Local API Server at launch with the model it served last

- **Context:** Since ADR 2026-10-21, "Start automatically" raises the server
  at launch with no model loaded or picked: the cold launch of ADR 2026-08-19,
  applied to the server. Everything else names the model the server served
  last (`lastServerModels[0]`): Server → Overview says the server is ready for
  your tools, the sidebar shows that model with Stop, and connected agents
  were configured with its id. With "Preload last used model" off (the
  default) nothing was loaded, so Connections said "No model loaded", the
  built-in test warned, and an agent request got HTTP 503
  `selected_provider_unavailable` until the user pressed Stop and Start, which
  loads it (B01, QA 2.3.2 on core 0.20.7). Connect on such a server wrote that
  model into the agent's config all the same.
- **Decision:** When "Start automatically" starts the server at launch, the
  server's model is loaded first: `lastServerModels[0]`, else the configured
  default, the one Start and the listener recovery load, and the way Start
  loads it — `ensureModelForServer` with that model as the override, under the
  load watchdog, then `lastServerModels` and the active models recorded
  (`loadServedModel` in `utils/servedModel.ts`, called from
  `loadServedModelAtLaunch` in `DataProvider.tsx`). It does so whatever
  "Preload last used model" says; that setting still governs only the chat's
  selection. With nothing to load the server starts without a model, as
  before: no served model yet, a cloud model, a model since deleted or on an
  engine switched off (no other model is picked in its place), or an image,
  video or embedding model the server already answers with (Start loads no
  chat model over those either). A load that fails or times out is logged and
  the server starts anyway. Re-attaching to a server already running is
  unchanged and loads nothing; so are platforms without a Local API Server
  (mobile, web). Connect (`useAgentActions`) on a running server whose served
  local model has no running session loads it the same way first
  (`ensureServedModelRunning`) and writes the agent's config only once it is
  loaded; a load that fails is reported and nothing is written.
- **Consequences:** After a relaunch the server answers with the model every
  page names, and agents work without a Stop and Start. "Start
  automatically" is on by default and every chat switch records the model it
  loads as the server's (`syncModelSelection` in `switchModel.ts`), so most
  desktop installs that have chatted with a local model now load that model
  at launch: the memory and startup cost ADR 2026-08-19 removed comes back
  for them, while the composer still opens with no selection. Turning "Start
  automatically" off keeps a cold launch. The server comes up once the model
  has loaded, showing "Starting" meanwhile, instead of at once with nothing to
  serve. Supersedes in part ADR 2026-10-21 ("no model is loaded or picked for
  it") and ADR 2026-08-19 as 2026-10-21 applied it to the server ("ADR
  2026-08-19 stands").
- **Owner:** `team`.
- **Links:** `web-app/src/providers/DataProvider.tsx`,
  `web-app/src/utils/servedModel.ts`, `web-app/src/hooks/useAgentActions.ts`,
  `web-app/src/providers/__tests__/DataProvider.test.tsx`,
  [Start the Local API Server at launch without a model](2026-10-21-start-the-local-api-server-at-launch-without-a-model.md),
  [Do not preload a model on startup](2026-08-19-do-not-preload-a-model-on-startup.md)

<!--
Supersedes: 2026-10-21-start-the-local-api-server-at-launch-without-a-model.md (in part)
Supersedes: 2026-08-19-do-not-preload-a-model-on-startup.md (in part: the launch of the Local API Server)
-->
