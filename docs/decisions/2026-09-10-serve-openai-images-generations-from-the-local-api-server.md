---
date: 2026-09-10
title: "Serve /v1/images/generations from the local API server, b64 only, hidden from /v1/models"
---

# 2026-09-10 — Serve `/v1/images/generations` from the local API server, b64 only, hidden from `/v1/models`

- **Context:** `http://localhost:1337/v1` is an OpenAI-compatible contract that
  OpenCode, Codex, Hermes and others depend on (AGENTS.md §6 rule 3). The proxy's
  endpoint list is closed (`allowed_methods_for_path`, `endpoint_from_path`).
  Studio exposes `/v1/images/generations` and lists image models in
  `/v1/models` with a `task` field.
- **Decision:** Add `POST /v1/images/generations` backed by the resident
  diffusion session through the plugin's shared `run_image_job`, so the facade
  gets the same validation, progress events, gallery writes and idle timer as
  the page. `response_format` accepts only `b64_json`; `url` is a 400 naming the
  parameter, because the files are local paths and a `url` variant would need
  the signed keyless route Studio built. No resident model, or a `model` that
  is not the loaded one, is a 503 — the proxy cannot load models (TS owns
  loading, as for chat). The image model is **not** listed in `GET /v1/models`:
  several clients treat the first id as a chat model.
- **Consequences:**
  - Steps and guidance come from the loaded family's defaults; the OpenAI
    request has no knob for them. A non-standard `atomic` object carries
    `job_id`, `seed` and `paths` (extra fields are allowed by the contract).
  - The route uses its own 30-minute ceiling instead of the chat proxy timeout.
  - Phase 2 adds `/v1/videos` in the shape of the OpenAI Videos API as mirrored
    by Studio (PR #9891), which needs on-disk job persistence.
- **Owner:** `team`.
- **Links:**
  - `src-tauri/src/core/server/proxy.rs`
  - `web-app/src/services/diffusion/types.ts`
