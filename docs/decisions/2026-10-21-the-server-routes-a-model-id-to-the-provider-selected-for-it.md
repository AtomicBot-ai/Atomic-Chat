---
date: 2026-10-21
title: "The Local API Server routes a model id to the provider selected for it"
---

# 2026-10-21 — The Local API Server routes a model id to the provider selected for it

- **Context:** QA AC-03 (2.2.23): with a custom endpoint exposing the same model id as a local
  model, used and then switched back to llama.cpp, the server page showed llama.cpp while
  `/v1/models` said `owned_by: remote` and `/v1/chat/completions` went to the endpoint (502). The
  core served by id alone, a remote provider that lists the id first ("remote wins over local"),
  while the page shows `lastServerModels` / `defaultModelLocalApiServer`, which the core never saw.
- **Decision:** The webview sends the server page's selection to the server: one provider per
  model id, `lastServerModels` first, then the default (`web-app/src/utils/serverModelSelection.ts`),
  on startup and after every change, through the new command `set_server_model_selection`. Rust
  keeps the last copy in `AppState.server_model_selection`, forwards it to the core
  (`PUT /atomic/v1/server/selection`) and hands it over again before a recovered server starts
  (`CoreOwner.selection`, after the providers; a core that refuses it still serves). The core sends
  an id selected on a cloud provider to that provider only; an id selected on a local engine goes to
  that engine's session, else to any other local session of it, else gets 503
  `selected_provider_unavailable` naming model and engine — never to a remote endpoint (core ADR
  `2026-10-21-route-a-selected-model-id-to-its-selected-provider-only.md`). The endpoint dialog and
  the endpoint's expanded card, for an endpoint whose models include a local model id, say which
  provider the server uses for it (`LocalModelCollisionNotice`), without blocking anything.
- **Consequences:** Switching the chat model — which already switches the server's model — now
  also moves where requests for that id go. An id the page does not show keeps the core's rules.
  Until the core with the route is pinned, the command logs the core's refusal and nothing changes.
  Mobile's proxy keeps "remote wins over local": it does not read the selection. A new endpoint's
  models arrive after its dialog closed; the card shows the note with them.
- **Owner:** team
- **Links:** `web-app/src/utils/serverModelSelection.ts`, `web-app/src/providers/DataProvider.tsx`,
  `src-tauri/src/core/server/{remote_provider_commands,ownership,commands}.rs`,
  `src-tauri/src/core/state.rs`, `web-app/src/containers/endpoints/LocalModelCollisionNotice.tsx`,
  `web-app/src/lib/local-model-collisions.ts`.
