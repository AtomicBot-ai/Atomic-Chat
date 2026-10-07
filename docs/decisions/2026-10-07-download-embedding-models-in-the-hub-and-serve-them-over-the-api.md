---
date: 2026-10-07
title: "Download embedding models in the Hub and serve them over the API"
---

# 2026-10-07 — Download embedding models in the Hub and serve them over the API

- **Context:** atomic-chat-core gained an embedding module (core ADR
  `2026-10-07-embedding-models-are-their-own-core-module`): one stock llama.cpp `llama-server --embedding`,
  driven through `/atomic/v1/embedding/*` and served on the Local API Server's OpenAI-compatible
  `POST /v1/embeddings` to a client that passes the module's model id as `model` (it is also listed in
  `/v1/models`, `owned_by: "atomic-embedding"`). It reads a GGUF, plus a projector for a model that reads images
  or audio, and refuses media given as links. The conf repo now has a curated catalog,
  `models/embedding.json` (EmbeddingGemma 2 by default, EmbeddingGemma 300M, Qwen3 Embedding 0.6B, Qwen3-VL
  Embedding 2B, Nomic Embed Text v1.5, BGE-M3), every entry pinned to a commit, with `dims`, Matryoshka
  lengths, pooling, modalities, the image token budget, the query/document prompts the model expects, a
  required logo key and a `b<build>` floor. The app had no way to get one onto disk or start it. Chat and the
  RAG path (the bundled `sentence-transformer-mini`) already use embeddings of their own.
- **Decision:** Embedding models are offered the way the decision models are (ADRs
  `2026-10-01-download-decision-models-in-the-hub-and-run-them-on-the-turboquant-page` and
  `2026-10-06-offer-stock-llamacpp-decision-models-on-the-llamacpp-page`), reduced to one engine:
  - *Catalog:* `embedding-catalog-registry.ts` fetches `models/embedding.json` (fresh cache, network with the
    Tauri HTTP fallback, stale cache, then the generated `embedding-catalog-baseline.ts`;
    `VITE_EMBEDDING_CATALOG_URL` overrides the URL). Until the catalog is on conf `main` the baseline serves.
    The parser mirrors the schema and `embedding-catalog-check.mjs`: one `role: "model"` GGUF, at most one
    projector and one exactly when the model reads more than text, safe `.gguf` paths, a 40-hex revision,
    64-hex hashes, `image_max_tokens` only for an image model and at most half the context, shrinking
    Matryoshka lengths, a required icon, `llamacpp-upstream` only, at most one default.
  - *Disk and download:* files go to `<data>/embedding/models/<id>/` through the ordinary downloader with size
    and sha256 checks, task id `embedding-<id>`, cancel-only in the download panel, classified as
    `embedding_model` in download telemetry and never counted as a chat-model download.
  - *One model at a time, upstream only:* Start writes `enabled`, `model_path`, `mmproj_path` (cleared for a
    text model), `model_id` (the catalog id), `ctx_size` (`context`), `pooling`, `image_max_tokens` and a
    300 s start timeout, then loads, and raises the Local API Server under the media-model auto-start rule.
    Stop turns `enabled` off; Remove clears an active model first. The engine floor is checked up front with
    the decision models' upstream build comparison (now `upstreamEngineReadiness`), so a model above the
    configured `version_backend` shows "Needs llama.cpp b<N>+" and the update button.
  - *Where:* the Hub gains an Embedding category (where stock llama.cpp has a build) with the default model
    leading; its panel shows inputs, dimensions and Matryoshka lengths, context against the trained maximum,
    pooling, the disk size with the projector, and the prompts with copy buttons and a note that the server
    does not add them. The `llamacpp-upstream` provider page lists the downloaded models under the decision
    models, plus the llama.cpp models the extension already flagged as embedding GGUFs (served from the path in
    their `model.yml`, with the model's own context and pooling). The API page names the served model by id
    with copyable curl examples (text, and an inline `data:` image for a model that reads images). Starting
    the server loads no chat model while an embedding model is switched on.
  - *Logos:* every entry names a bundled mark; `gemma-mark` is the Gemma logo already shipped
    (`/svg/gemma-color.svg`), and EmbeddingGemma names resolve to it ahead of the generic Gemma → Google rule.
- **Consequences:** Clients can embed text (and, with EmbeddingGemma 2 or Qwen3-VL Embedding, images and audio)
  through the same server as chat, by model id, with no chat model loaded. Prompts are shown, never applied:
  the request a client sends is what the engine sees. Media must be inline. Chat, RAG and their
  `sentence-transformer-mini` are untouched; that model can also be served here, as any flagged llama.cpp
  model. EmbeddingGemma 2 needs llama.cpp b11454; the rest b11443. Starting the server with "Start" still
  loads a chat model when a decision model alone is on: that gap is the decision module's, not changed here.
- **Owner:** `team`.
- **Links:** `web-app/src/services/embedding-catalog-registry.ts`, `web-app/src/services/embedding/tauri.ts`,
  `web-app/src/lib/embedding/{models,engine}.ts`, `web-app/src/stores/embedding-store.ts`,
  `web-app/src/hooks/useEmbeddingModel.ts`, `web-app/src/containers/EmbeddingModelsSection.tsx`,
  `web-app/src/containers/hub/{EmbeddingHub,EmbeddingModelDetailPanel}.tsx`,
  `web-app/src/containers/api/ApiConnectionStrip.tsx`, `web-app/src/lib/model-logo.ts`,
  `scripts/sync-upstream-baseline.mjs` (`--embedding-from`); conf `models/embedding.json`.

<!--
Supersedes: none (extends 2026-10-06-offer-stock-llamacpp-decision-models-on-the-llamacpp-page.md)
-->
