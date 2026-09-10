---
date: 2026-08-27
title: 'Connect a ChatGPT subscription as a model provider'
---

# 2026-08-27 — Connect a ChatGPT subscription as a model provider

- **Context:** every cloud provider we support is reached with an API key the
  user pastes into Settings (now the Cloud page,
  [2026-08-27](2026-08-27-move-cloud-providers-into-a-cloud-page.md)). A large
  share of our users already pay for ChatGPT Plus/Pro and have no separate
  platform key, so for them "connect a cloud model" means buying inference
  twice. The `codex` CLI reaches that same subscription over an OAuth flow
  against `auth.openai.com`, then talks to
  `https://chatgpt.com/backend-api/codex/responses`. Nothing in this repo has
  ever done OAuth; `codex` appears only on the Integrations page, as an external
  CLI we configure to point *at* our local server.

- **Decision:** add a `chatgpt` provider that is authorised by signing in, not
  by a key. Four choices are load-bearing:

  - **The client identity question was decided deliberately, not by default.**
    Reaching this endpoint means presenting OpenAI's **public** Codex OAuth
    `client_id`. It does *not* require claiming to be the Codex CLI in the
    request: `originator` and `User-Agent` carry our own name
    (`atomic_chat` / `atomic-chat/1`), which is how at least one other shipping
    product does it. So the exposure is narrower than "impersonating another
    client" — but it is not nil: the client id is OpenAI's to revoke, and a
    revocation breaks every installed copy of Atomic Chat at once. Recorded
    here as an owner decision made before any code was written. Revisit it if
    the product's distribution or licensing changes.
  - **Tokens never reach the webview.** Existing API keys live in plaintext
    `localStorage` under `model-provider`; a refresh token is longer-lived and
    higher-value than an API key, and refreshing it is a background concern the
    frontend has no part in. They are written by Rust to
    `<jan_data>/atomic-chatgpt-auth.json` with mode `0600` on Unix, and only a
    status struct (`connected`, `email`, `plan_type`, `expires_at`) crosses IPC.
    Raw `std::fs` rather than `tauri-plugin-store`, which offers no control over
    file mode and shares its store with migration data.
  - **The loopback callback may not fall back to another port.** OAuth redirect
    URIs are matched exactly, so `http://localhost:1455/auth/callback` is the
    only address that works — unlike the Local API Server, which reassigns its
    port when 1337 is taken (`proxy.rs`). A busy 1455 (the real Codex CLI
    mid-login) is reported as its own error rather than silently retried
    elsewhere.
  - **"Use device code" is not shipped yet, but it is real.** OpenAI serves a
    device flow of its own shape rather than RFC 8628:
    `POST {issuer}/api/accounts/deviceauth/usercode` with the client id, then
    poll `POST {issuer}/api/accounts/deviceauth/token` with
    `{device_auth_id, user_code}` until it returns
    `{authorization_code, code_verifier}`, which is then exchanged against
    `redirect_uri = {issuer}/deviceauth/callback`. `ChatGptAuthState` is shaped
    so this is an addition rather than a restructure. The button ships disabled
    until it is wired, because a control that looks live and does nothing is
    worse than one that is honestly labelled.

- **Consequences:** a subscriber connects once and gets working models without a
  platform key. Costs and things to watch:

  - `chatgpt.com/backend-api` is an internal surface with no versioning,
    changelog or deprecation window. It can change shape on any ChatGPT web
    deploy, so a failure must degrade to a legible "ChatGPT connection
    unavailable" rather than a stack trace.
  - **The wire contract was verified against a shipping implementation**, not
    inferred. Three things that only that check revealed, each of which would
    have failed every request or corrupted a conversation:
    `max_output_tokens` is *rejected* here even though the public Responses API
    accepts it (the subscription applies its own cap); the account id lives on
    the **access** token, not the id token, so reading it from the latter
    leaves every refreshed session unable to address its account; and the
    session affinity header is `session-id`, not `session_id`. Sampling knobs
    are not part of this contract either and are dropped rather than forwarded.
  - The account's catalogue comes from `GET {base}/codex/models?client_version=…`
    — the version we claim is what decides which slugs the account is shown.
    Models are therefore fetched, never curated: a hardcoded list offers models
    an account may not carry, and every send then fails with nothing to act on.
    An unreachable catalogue leaves the models off for the same reason.
  - Access tokens last about an hour. Refresh is on demand with a 120 s safety
    margin plus one forced refresh on an upstream 401, single-flighted the way
    `AutoIncreaseState` single-flights context reloads. A refresh failure clears
    the tokens and emits an event so the card can ask for a reconnect. A stream
    already in flight when the token expires still dies — there is no way to
    re-authenticate mid-body.
  - Subscription quotas are per-account and opaque. A user who burned their
    Codex quota elsewhere sees failures here with no explanation unless we pass
    the upstream 429 body through verbatim.
  - Three frontend gates assume a cloud provider has a non-empty `api_key`
    (`registerRemoteProvider.ts`, `ensureRemoteProviderReady.ts`,
    `lib/onboarding.ts`). They take an explicit subscription predicate rather
    than a faked key.
  - No new Rust dependency: `sha2`, `base64`, `rand`, `url`, `uuid`, `hyper`,
    `reqwest` and `tokio` are already in `Cargo.toml`.

- **Owner:** `team`

- **Links:** `src-tauri/src/core/auth/`,
  `src-tauri/src/core/server/proxy.rs`,
  `src-tauri/src/core/server/responses_shim.rs`,
  `web-app/src/containers/cloud/CloudSubscriptionCard.tsx`,
  [Move cloud providers out of Settings into a Cloud page](2026-08-27-move-cloud-providers-into-a-cloud-page.md),
  [Add a `/v1/responses` translation shim to the local proxy so Codex CLI works on llama.cpp models](2026-06-02-add-a-v1-responses-translation-shim-to-the-local-proxy-so-codex.md)
