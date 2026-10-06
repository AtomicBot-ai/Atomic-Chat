---
date: 2026-10-06
title: "Drive managed engines from one registry and one model store"
---

# 2026-10-06 — Drive managed engines from one registry and one model store

- **Context:** TensorRT-LLM was the only engine the core runs in a container, and about 130 files of
  the app named `tensorrt-llm`: the plan and Hub hooks, the setup panel, the operation card, the
  download service, the extension, the chat gating, the Rust agent target. The core (openspec change
  `add-vllm-runtime`) adds vLLM as a second managed engine, keeps one model store for both
  (`GET /managed-models/location`, `DELETE /managed-models/:id`) and removed the TensorRT-LLM
  location and delete routes.
- **Decision:** the app reads managed engines from one registry, `web-app/src/lib/managed-engines.ts`
  (`id` = the core's `engine_id` = the provider id, a label, the key of the engine's own block in
  `providers.json`/`hub.json`; order = priority). Every shared screen takes the engine as a
  parameter: `useManagedPlan(engine)`, `useManagedHubState(s)`, `useManagedCurated`,
  `useManagedVerdicts`, `ManagedEngine*` components, `ManagedHub*`. Chat, agent, deletion and
  session paths ask `isManagedProvider` instead of comparing ids. Models live in the core's shared
  store: one download (`installManagedModel`, ids `managed-*`), `model.yml` without `quantization`,
  deletion through the store route, one "Downloaded" row however many providers list it. A model
  card shows every visible engine's verdict and offers Download once an installed engine accepts
  the model, "Install <engine>" beside an engine that is not installed and does not refuse it, and
  an engine choice for New chat when several take it. Extensions share
  `extensions/shared/managed-engine` through a class factory that takes the extension's own
  `@janhq/core` and Tauri functions (`shared/` has no `node_modules`). Rust keeps one list,
  `MANAGED_PROVIDERS` in `sessions/resolver.rs`, and builds one `LocalManaged` agent target from the
  session gateway for any of them.
- **Consequences:** a new managed engine is a registry entry, its locale blocks, a thin extension and
  one Rust list entry — no new branches. TensorRT-LLM texts and test expectations are unchanged;
  its behaviour changes only where the shared store requires it (routes, `model.yml`, download id)
  and in one card case: a TensorRT-LLM that is not installed and refuses the model no longer offers
  "Install the engine". Engine-specific wording is duplicated per locale block by choice, so one
  engine's text never leaks into another's.
- **Owner:** `team`.
- **Links:** openspec change `add-vllm-runtime` (atomic-chat-spec), design D4 and D14; rulings in
  `openspec/changes/add-vllm-runtime/rulings/app.md`; core `docs/contracts.md` rows for the store.
