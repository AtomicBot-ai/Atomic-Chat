---
date: 2026-10-20
title: "Show hosted providers on Cloud and the user's own servers on Custom Endpoint"
---

# 2026-10-20 — Show hosted providers on Cloud and the user's own servers on Custom Endpoint

- **Context:** `/cloud` was one centred column: a provider dropdown with a
  "Self-hosted" and a "Cloud providers" group, the connection card, the model
  list and the media models. The sidebar's Custom Endpoint row opened the same
  page with `?add=custom` (the "Custom (OpenAI-compatible)" name dialog). The
  approved prototype splits this into a two-pane Cloud page with a first-visit
  guide and a separate Custom Endpoint page; its endpoint list, ping and
  catalogue were session-only fixtures.
- **Decision:**
  - **Cloud** (`/cloud`) lists `groupCloudProviders().hosted` only. Left pane:
    every hosted provider with its model count (`provider.models`) and
    "Connected" (the same `isProviderConnected` / `isMediaConnected` the card
    uses), and a search over providers and models. A model found through
    several providers reads "Available through N providers": the match is on
    the id without its vendor prefix, lower-cased (`openai/gpt-5.4` =
    `gpt-5.4`), because the provider registry has no canonical model id. The
    right pane is the existing connection card without its dropdown
    (`hideProviderSelect`), the subscription card, the model list and the
    media models, unchanged. There is no "key error" state: nothing records
    a failed cloud request.
  - **First-visit guide**: pick a provider, then connect it with the same
    cards. It opens on a visit with no hosted provider connected and until it
    is finished or skipped (`cloudGuideDone` in the general settings store),
    so it never follows onboarding's own cloud dialog (which connects hosted
    providers); a server of one's own does not count. "Guide me" reopens it.
  - **Custom Endpoint** (`/endpoints`, new route) lists
    `groupCloudProviders().selfHosted`: Ollama, `llama-server`, the media
    servers and every provider the user added. Add / Configure is one dialog:
    name (fixed once created — providers are keyed by name), base URL and an
    optional key, written as before (`buildBaseUrlUpdate`,
    `saveProviderApiKey`); saving registers the provider with the proxy and
    reloads its models. Remove is the existing delete-provider logic, offered
    only for providers the user added. Expanding an endpoint (`?provider=`)
    shows its model list and media models, so adding a model by hand, editing
    capabilities and media setup stay. A media server keeps its Connect
    button (it lists media models; it has no `/models` to ping).
  - **Ping** is `checkProviderEndpoint` in the providers service: one
    `get_local_http` to `/models`, `/v1/models` after a 404, 8 s timeout, no
    retries, returning ok, latency, model count and the same readable error
    the model fetch gives. The last result per provider is kept in an
    in-memory store, never in the provider store, and is cleared when the
    endpoint is saved or removed.
  - `/cloud?add=custom`, and `/cloud?provider=` naming a self-hosted provider
    (where `/settings/providers/$providerName` and the model picker send it),
    redirect to `/endpoints`. The sidebar row links there.
- **Consequences:** The provider store's shape is unchanged
  ([2026-08-13](2026-08-13-revert-the-settings-and-model-providers-ui-rework-keep-runtime.md));
  `CloudProviderSelect` and `AddProviderDialog` are no longer rendered by any
  page. "Available through" can miss or merge models whose ids differ by
  more than a vendor prefix — a canonical id in the `atomic-chat-conf`
  registry is the follow-up that makes it exact. A provider the user added is
  only known as theirs once the registry has loaded; until then a deep link to
  it opens Cloud and moves to Custom Endpoint as soon as the registry answers.
- **Owner:** team
- **Links:** `web-app/src/routes/cloud/index.tsx`,
  `web-app/src/routes/endpoints/index.tsx`,
  `web-app/src/containers/cloud/CloudProviderBrowser.tsx`,
  `web-app/src/containers/cloud/CloudSetupWizard.tsx`,
  `web-app/src/containers/endpoints/`,
  `web-app/src/services/providers/tauri.ts` (`checkProviderEndpoint`),
  `web-app/src/stores/endpoint-check-store.ts`,
  `tests/e2e/desktop/cloud-provider.spec.ts`.
