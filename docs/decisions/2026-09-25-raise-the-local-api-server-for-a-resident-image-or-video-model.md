---
date: 2026-09-25
title: "Raise the Local API Server for a resident image or video model"
---

# 2026-09-25 — Raise the Local API Server for a resident image or video model

- **Context:** `/v1/images/generations` and `/v1/videos` are served on the
  Local API Server (ADR 2026-09-10; the core since ADR 2026-09-18), and the
  core answers them with no chat model loaded. The app, though, only ever
  raised that server with a chat model: at startup for a chat model already
  running (`DataProvider.tsx`), when a local chat model loads with auto-start
  on (`switchModel.ts`), and from "Start server", which loads the default chat
  model first (`useLocalApiServerControl` → `ensureModelForServer`). A user
  report on 2.0.44 showed the result: an image made on the Images page, a
  refused connection on the endpoint the page advertises. The server had not
  run for days; the only chat model's GGUF had been deleted, so "Start server"
  hung in its load and never reached the listener. With no chat model at all
  it fails with "No model available to load". And since the GPU arbitration
  was wired (ADR 2026-09-22), a chat model that does load can unload the
  image model it was started for, leaving the endpoint at 503.
- **Decision:** An image or video model is a model the server serves.
  1. Once one is resident, `image-generation-store.loadModel` raises the
     server by the rule a local chat model follows: when auto-start
     (`enableOnStartup`) is on and the server is stopped
     (`raiseLocalApiServerForMediaModel`). No chat model is loaded for it, and
     a failed start never fails the model load.
  2. "Start server" skips its chat-model step while an image or video model
     is resident or loading (`hasResidentMediaModel`, read live from the
     core).
  3. The embedded API card on the Images and Video pages says when the server
     is stopped and starts it in place, never loading a chat model.
- **Consequences:** An image-only user gets a working endpoint without a chat
  model, and "Start server" no longer evicts the image model it would serve.
  Loading an image model now starts a stopped server when auto-start is on,
  as loading a chat model already did; with auto-start off nothing starts on
  its own. The startup path is unchanged and still raises the server only for
  a running chat model: an image model a still-attached core kept across an
  app restart does not start it there, the card's Start does.
- **Owner:** `team`.
- **Links:**
  - `web-app/src/utils/localApiServerControl.ts`
  - `web-app/src/hooks/useLocalApiServerControl.ts`
  - `web-app/src/stores/image-generation-store.ts`
  - `web-app/src/containers/images/ImageApiSettingsCard.tsx`
  - `tests/e2e/desktop/image-api.spec.ts`, `tests/e2e/desktop/video-api.spec.ts`
  - `2026-09-10-serve-openai-images-generations-from-the-local-api-server.md`
  - `2026-09-22-wire-the-chat-side-of-the-gpu-arbitration.md`
