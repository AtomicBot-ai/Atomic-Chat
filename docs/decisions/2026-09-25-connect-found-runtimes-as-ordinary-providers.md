---
date: 2026-09-25
title: "Connect a found runtime by making it an ordinary OpenAI-compatible provider"
---

# 2026-09-25 — Connect a found runtime by making it an ordinary OpenAI-compatible provider

- **Context:** The Settings > Runtimes scan (2026-09-24 record) finds running
  runtimes: Ollama, LM Studio, KoboldCpp, llama-server, vLLM and others. The next
  step asked for was using one of them from chat with one click. Radium already
  routes remote and self-hosted providers:
  - `DataProvider` registers every provider with the Local API Server proxy
    whenever the list changes;
  - `isKeylessRemoteProvider` admits keyless loopback servers;
  - `fetchModelsFromProvider` reads `/v1/models`;
  - the Cloud page lists self-hosted providers.

- **Decision:** **Connect** creates or updates a provider and fills its model
  list. It adds no new routing path.
  - **Reuse existing ids:** Ollama maps to the existing `ollama` entry and
    llama.cpp to `llamacpp-server`, so connecting fills in the entry the Cloud
    page already shows instead of duplicating it.
  - **Other runtimes** use their catalog name as the provider id: "LM Studio",
    "KoboldCpp", "vLLM", "TabbyAPI".
  - **Unidentified servers** that only answer `/v1/models` connect as
    "Local server <port>".
  - **Model list:** filled from the server's own `/v1/models`. If that read
    fails, the models the scan saw are used. A server with no models is refused,
    with a message saying to load one first.
  - **Image runtimes** (ComfyUI, InvokeAI, AUTOMATIC1111, Forge) get "Set up in
    Media" instead: the Media page already has their adapters.
  - **Runtimes with no OpenAI-compatible API** in the catalog get no Connect
    button.

- **Consequences:**
  - Connected models appear in the model picker. The proxy serves them at
    `:1337/v1` through the existing path, and they can be edited on the Cloud
    page. No new Rust command, store or migration.
  - Watch for:
    - a LM Studio or KoboldCpp instance on another machine (not loopback) has no
      catalogue self-hosted id. It is keyless, so the proxy will not register it
      until it has a key or the self-hosted list is widened; that is a separate
      decision.
    - "Connected" is derived: same address, active, and at least one model.
      Moving a runtime to another port shows it as not connected until Connect
      is pressed again.

- **Owner:** @walladanger

- **Links:**
  - `web-app/src/lib/connect-runtime.ts`
  - `web-app/src/routes/settings/runtimes.tsx`
  - [2026-09-24 runtime layer record](2026-09-24-integrate-inference-runtimes-behind-one-adapter-layer.md)
