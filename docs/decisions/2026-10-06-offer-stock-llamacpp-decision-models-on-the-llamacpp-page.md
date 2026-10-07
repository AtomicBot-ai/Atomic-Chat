---
date: 2026-10-06
title: "Offer stock llama.cpp decision models, each on the page of the engine that runs it"
---

# 2026-10-06 — Offer stock llama.cpp decision models, each on the page of the engine that runs it

- **Context:** Decision models ran on TurboQuant only (ADR
  `2026-10-01-download-decision-models-in-the-hub-and-run-them-on-the-turboquant-page`): laya checkpoint
  folders, the card on the `llamacpp` page, the Hub's Open going there, and the Convai mark on every row. Stock
  ggml-org llama.cpp now serves decision GGUFs itself (`<arch>.decision.type`, `/v1/systemone`): laya, lev, kev,
  nimble and openjev from b11370, clef from b11371, clef with images from b11418. The core runs such a file on a
  `llamacpp-upstream` pack at the type's floor (core ADR `2026-10-06-run-decision-models-on-upstream-llamacpp`).
  The conf catalog (`models/decision.json`) now lists eight of them (Julia 1, Laya GGUF, lev, Kev 4B, Bespoke
  Nimble 9B, Clef Flash, Clef, OpenJev) next to the three checkpoints, with new optional fields `engine`,
  `format`, `decision_type`, `icon`, `vision` and `files[].role`. Our upstream manifest is still at b11344, so
  none of them can start until the engine moves.
- **Decision:**
  - *Catalog:* the parser reads the new fields with the old shape as the default (`engine: 'llamacpp'`,
    `format: 'checkpoint'`). A GGUF model needs exactly one `role: 'model'` file and at most one projector; an
    upstream model must be a GGUF; `min_engine` is a fork tag for TurboQuant and `b<build>` for upstream.
    `schema_version` stays 1: clients from before this drop the GGUF models (they lack the checkpoint files)
    and keep the rest. The baseline is regenerated from the new catalog.
  - *One card per engine page:* `DecisionModelsSection` takes the provider and lists only that engine's
    downloaded models; it is mounted on `llamacpp` and on `llamacpp-upstream`. One model still runs at a time,
    whichever page it is on. The core's failure shows on the page of the active model's engine. The engine
    button installs TurboQuant or updates llama.cpp through that provider's own backend updater.
  - *Engine version up front:* for a stock llama.cpp model the app compares `min_engine` with the provider's
    `version_backend`; an older build marks the row "Needs llama.cpp b<N>+", disables Start, and shows the
    update notice (in the Hub's panel too). TurboQuant stays gated by the core alone, as its gate is `-h`.
  - *Activation:* `model_path` is the GGUF file (the folder for a checkpoint), plus `mmproj_path`, `ctx_size`
    (the catalog's `context`) and `startup_timeout_secs` (600 s for stock llama.cpp models, which run up to
    20 GB; 60 s for checkpoints), always written, so one model's values never leak into the next.
  - *Hub:* rows carry the engine as a badge and the maker's logo (`icon` → `ICON_KEY_LOGOS`: Supersonic Labs,
    Interfaze, Bespoke Labs, Cloudflare, OpenJev; Convai stays the default for checkpoints only, and Kev, whose
    maker has no logo but a personal photo, falls back to a letter). The panel shows the quantization instead of
    "CPU", the engine and image input, a non-commercial license as such, and Open leads to the model's engine
    page. A model whose engine has no build here is not listed; the category shows where either engine runs
    (stock llama.cpp adds Windows on arm64).
- **Consequences:** The eight models appear in the Hub now and start once the upstream manifest reaches their
  floor, with no further app change. OpenJev and Bespoke Nimble are CC BY-NC 4.0; the panel says so. Clef and
  OpenJev need about 20 GB of memory. The router (`/v1/router/score`) stays a TurboQuant feature: the core
  answers it with 501 for an upstream model.
- **Owner:** `team`.
- **Links:** `web-app/src/services/decision-catalog-registry.ts`, `web-app/src/lib/decision/{engine,models,platform}.ts`,
  `web-app/src/containers/DecisionModelsSection.tsx`, `web-app/src/containers/hub/{DecisionHub,DecisionModelDetailPanel}.tsx`,
  `web-app/src/hooks/useDecisionEngineReadiness.ts`, `web-app/src/lib/model-logo.ts`; conf `models/decision.json`.

<!--
Supersedes: none (extends 2026-10-01-download-decision-models-in-the-hub-and-run-them-on-the-turboquant-page.md)
-->
