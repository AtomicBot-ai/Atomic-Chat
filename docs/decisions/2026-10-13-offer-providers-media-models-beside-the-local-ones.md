---
date: 2026-10-13
title: "Offer providers' media models beside the local ones, through the core"
---

# 2026-10-13 — Offer providers' media models beside the local ones, through the core

- **Context:** The Images and Video pages ran only the resident stable-diffusion.cpp model. Cloud
  providers on the Cloud page (OpenAI, OpenRouter, xAI, Gemini, MiniMax, Qwen, AIMLAPI, Eden AI,
  Hugging Face, NVIDIA, Mistral, Meta) and self-hosted servers (Ollama, Automatic1111/Forge, a
  stable-diffusion.cpp `sd-server`, a custom OpenAI-compatible server) make images and video too. The core now runs them through the same job
  table, events and galleries (core ADR `2026-10-13-remote-media-shares-the-diffusion-job-table`).
- **Decision:**
  - A provider keeps its image and video models in its own list, `ProviderObject.media`
    (`{image_api?, video_api?, models: [{id, kind, name?}]}`), never in `models`: the chat pickers,
    routing and Muse Code see nothing new. Like a registry provider's chat models, every provider
    comes with all of its curated catalog models (each kind's default first), before a key is in;
    the pickers offer them once it is. `media.offered` records every catalog model the app has put
    in, so one the user removed is never put back and one conf adds later is. A keyless server of
    the user's own (Ollama) gets them only once it has answered, so they never show it connected.
    `setProviders` carries `media` over a registry refresh. Registration sends the models (not
    `offered`) to the core, which keeps them out of the key binding.
  - The app never reads conf's `providers/media.json`. What a provider offers comes from the core
    (`GET /media/catalog`, `GET /media/providers/:p/models`). A core without those routes (404, or 409
    `REMOTE_NOT_CONFIGURED`) means no remote media at all: an older core ignores `target` and would run
    the resident model instead.
  - The Cloud page has a "Media models" card per provider (catalog plus live listing, add, remove,
    Reload). A custom server picks its media API there (OpenAI-compatible or A1111/Forge for images,
    OpenAI-compatible for video). Automatic1111/Forge and the stable-diffusion.cpp server
    (`sdcpp-server`, port 1234, through the same `a1111` adapter: `sd-server` answers the A1111
    routes) are baseline, media-only, keyless self-hosted providers. They have no chat models to
    reload and no key to save, so their Connect sits by the address: it registers the address, asks
    the server for its models through the core and enables what it lists. Every provider and catalog
    model has a bundled brand mark; a test holds the catalog to it.
  - The page's pick is `selectedRemote {provider, model}` in `useImageSetting` / `useVideoSetting`.
    It wins over the resident checkpoint; picking a local quant clears it. A provider that is
    disconnected, or a model that was removed, falls back to the local target.
  - The forms show only what the model's descriptor lists (size list or range, aspect ratio,
    resolution, quality, background, file format, clip length, sound, steps and CFG for a
    self-hosted server). The provider-only settings live in `useRemoteMediaForm`, apart from the
    local draft, and are checked against the model before they are sent. Image to video is open for
    providers' models that take a first frame; the local engine still serves `create` only.
  - The Images and Video studios open when the engine is installed or a provider offers models of
    that kind. Telemetry adds `media_target` and `media_provider` (`custom` for a provider the user
    named), never the prompt or the model of a custom server.
- **Consequences:** Generating needs no engine or download for a provider's model, and its results
  land in the same gallery (JPEG/WebP pictures, MP4 clips; exports keep the file's own extension).
  Each remote request costs money: Cancel asks the provider to stop but it may still charge, and the
  core never retries the request that starts a generation. MP4 playback on Linux depends on
  WebKitGTK's GStreamer plugins; the viewer offers the external player when it cannot play a clip.
- **Owner:** `team`.
- **Links:** `web-app/src/lib/media-models.ts`, `web-app/src/lib/media-capabilities.ts`,
  `web-app/src/hooks/useRemoteMedia.ts`, `web-app/src/containers/cloud/CloudMediaModelsCard.tsx`,
  `web-app/src/containers/images/RemoteModelSections.tsx`, `web-app/src/services/media/`,
  `src-tauri/static/openapi.json` (`/images/edits`, remote fields).
