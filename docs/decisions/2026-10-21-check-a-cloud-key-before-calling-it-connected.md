---
date: 2026-10-21
title: 'Check a cloud key before calling it connected'
---

# 2026-10-21 — Check a cloud key before calling it connected

- **Context:** A saved API key was the whole of "Connected"
  (`isProviderConnected`). QA connected OpenAI with `invalid-qa-test-key`: the
  Cloud page said "OpenAI connected", every chat then failed authentication,
  and the provider stayed Connected. Onboarding's cloud dialog and Custom
  Endpoint saved keys the same way, unchecked. The 2026-10-20 Cloud record had
  no key-error state because nothing recorded a failed cloud request.
- **Decision:**
  - **Connect asks first.** The Cloud card, onboarding's cloud dialog and the
    Custom Endpoint dialog call `checkProviderKey`
    (`lib/provider-key-check.ts`): one `checkProviderEndpoint` model listing
    with the key being saved. Models listed → saved, Connected. A clear
    invalid-key answer — a 401 that is not about missing permissions and not
    the Local API Server's own "Invalid or missing authorization token", or a
    400 / 2xx body saying the key is invalid (Gemini answers a bad key with
    400 `API_KEY_INVALID`) → not saved, the reason shown inline, with "Save
    anyway" (a gateway can refuse its model list wrongly), which saves it as
    "Configured, not verified". Anything else — a 403, a 401 for a key
    without "Models: read" ("insufficient permissions", "missing scopes"),
    no network, timeout, 404, 5xx → saved as "Configured, not verified" with
    the provider's own reason: a restricted key may be refused the model list
    and still chat. `checkProviderEndpoint` now returns the `httpStatus` and
    `responseBody` it failed with. A media server (no `/models`) connects
    from its address, as before.
  - **What is known about a saved key** lives in
    `stores/provider-key-status-store.ts`: `unverified` or `rejected`, with
    the reason and a 32-bit fingerprint of the key it describes. No entry
    means nothing contradicts the key. Persisted under `provider-key-status`,
    so "not verified" survives a restart; an entry stops applying when the
    key changes on any screen. The provider store's shape is unchanged.
  - **A chat the provider answers with an invalid-key 401 marks the key
    `rejected`; a chat it answers in full clears any status.** The
    transport's stream `onError` passes the error to
    `noteProviderRequestError`, which reads the AI SDK error's `statusCode`
    and `responseBody` (not text that merely contains "401"): only an
    upstream 401 by the rule above, or Gemini's invalid-key 400, counts. A
    403 (moderation, region, a model the key may not use) and the Local API
    Server's own 401 — cloud chat goes through it with the server's key —
    leave the key alone. Its `onFinish`, for a turn that neither failed nor
    was stopped, calls `noteProviderRequestSucceeded`. Local engines,
    subscriptions and keyless servers are skipped.
  - **Display.** The Cloud card, the Cloud list, the guide's success box and
    the Custom Endpoint card read the status: "Configured, not verified" or
    "Key rejected" instead of Connected, with "Check again" on the Cloud card.
    A successful check, ping, chat, new key or Disconnect clears it.
    `isProviderConnected` keeps its meaning (a key is set), so routing, the
    model picker and the reply gate are unchanged.
  - **A registry `key_check` replaces the model list where that list is
    public.** An `atomic-chat-conf` provider entry may carry
    `key_check: { path | url, method?: "GET" }`, set only to an endpoint the
    provider documents as needing a valid key and free to call: OpenRouter
    `{ path: "/key" }`, Hugging Face
    `{ url: "https://huggingface.co/api/whoami-v2" }`. `checkProviderKey`
    asks it through `checkProviderKeyUrl` (one GET with the key and headers;
    any 2xx is verified, the same 401/403 rules otherwise) and falls back to
    the model list without one. A `url` is used only while the provider's
    base URL is on the same host or shares its parent domain, so a key typed
    for a server the user moved the provider to is never sent to the
    provider; `path` joins onto whatever base URL is set. The registry entry
    reaches the stored provider through `setProviders`' spread; older apps
    ignore the field, and the app bundles no copy of these entries.
- **Consequences:** Connect now waits for one request, at most 8 s per path.
  Providers whose model list is public and that have no `key_check` (AIML
  API and Eden AI document theirs as keyless; NVIDIA documents no key-info
  endpoint) still read a bad key as Connected until its first refused chat.
  Hugging Face rate-limits `whoami-v2` strictly; a 429 reads as "not
  verified". A status is written by the window whose chat failed; another
  open window sees it only after it reloads the store.
- **Owner:** team
- **Links:** `web-app/src/lib/provider-key-check.ts`,
  `web-app/src/stores/provider-key-status-store.ts`,
  `web-app/src/containers/cloud/CloudConnectionCard.tsx`,
  `web-app/src/containers/dialogs/AddCloudProviderDialog.tsx`,
  `web-app/src/routes/endpoints/index.tsx`,
  `web-app/src/lib/custom-chat-transport.ts`.

Supersedes the "There is no key error state" clause of
[2026-10-20-show-hosted-providers-on-cloud-and-own-servers-on-custom-endpoint.md](2026-10-20-show-hosted-providers-on-cloud-and-own-servers-on-custom-endpoint.md).
