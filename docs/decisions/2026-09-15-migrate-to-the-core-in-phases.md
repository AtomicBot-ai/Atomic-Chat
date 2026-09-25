---
date: 2026-09-15
title: "Migrate to the core in phases"
---

# 2026-09-15 — Migrate to the core in phases

- **Context:** The core replaces code that ships in every desktop release.
  A single cut-over would put runtime, CLI, settings migration and the public
  server at risk in one change, and the mobile builds share several of the
  modules that the desktop legacy path would drop.
- **Decision:** Migration proceeds in this order, each phase gated by its own
  exit criteria in `atomic-chat-core/PLAN.md` §4: (0) library with no consumers
  plus contract fixtures; (1) CLI, control API and a single owner per data
  folder; (2) the compiled core ships as `resources/bin` under the existing
  `jan-cli` file name; (3) the app attaches to the core and local runtime
  moves over behind a flag; (4) the `:1337` server and cloud routing move;
  (5) TurboQuant, MLX and Foundation Models; (6) legacy removal and
  deduplication. Desktop legacy is removed last; mobile keeps its modules and
  build checks. Each phase can be rolled back independently (flag off, emitters
  deleted, previous binary).
- **Consequences:** The app carries both paths for several releases, so shared
  resources (model roots, backends, the public port) need an explicit owner
  and a legacy guard before the new CLI is distributed. Settings move per
  scope with revisions rather than in one import. Phase 0 changes only tests
  in this repository.
- **Owner:** team
- **Links:** `../../../atomic-chat-core/PLAN.md` (§4, §6),
  [Extract the inference core](2026-09-15-extract-the-inference-core-into-atomic-chat-core.md)
