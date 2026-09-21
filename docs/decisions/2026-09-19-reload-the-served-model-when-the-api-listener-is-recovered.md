---
date: 2026-09-19
title: "Reload the served model when the API listener is recovered"
---

# 2026-09-19 — Reload the served model when the API listener is recovered

- **Context:** The Local API's listener belongs to the core. When the core dies the app's supervisor starts another and `recover_public_server` has it listen again on the same address — but the core's public server serves only the sessions that exist (`503 No models are available` otherwise), sessions die with the core, and it is the app that loads a model when the user presses "Start server". Nothing loaded one after a recovery: an outside client found the server up and useless until somebody used the app. The chat path does not have this gap, because the next message loads the model. Found by the second scenario of `tests/e2e/desktop/local-api.spec.ts`. The same scenario found that `lastServerModels` named the wrong provider: it took the first provider that lists the model, and both llama.cpp providers list the same folder, so a model run by `llamacpp-upstream` was remembered under `llamacpp` (TurboQuant — off on a fresh install, no backend).
- **Decision:** On `atomic-core://server-state-changed` for the core with a `generation` — which only a recovered listener carries — the web app runs `ensureModelForServer` for the model the server was last started with, else the user's default server model, else whatever "Start server" would pick. A failed load is logged and leaves the listener up. `lastServerModels` is recorded with `findProviderForModel`, which prefers an active provider, as loading already did.
- **Consequences:** A script talking to the Local API survives a core crash without the user. One load per new core generation, so a core that keeps dying does not turn into a load loop of its own. `lastServerModels` had no reader before this; it has one now. Not done: a recovery while the app's window has never opened the API page still works, since the listener for the event lives in `DataProvider`.
- **Owner:** team
- **Links:** `web-app/src/providers/DataProvider.tsx`, `web-app/src/hooks/useLocalApiServerControl.ts`, `web-app/src/utils/ensureModelForServer.ts`, `src-tauri/src/core/atomic_core/commands.rs`, `tests/e2e/desktop/local-api.spec.ts`
