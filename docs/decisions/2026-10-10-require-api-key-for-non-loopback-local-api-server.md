---
date: 2026-10-10
title: "Require an API key before the Local API Server binds a non-loopback address"
---

# 2026-10-10 — Require an API key before the Local API Server binds a non-loopback address

- **Context:** The `/v1` proxy only enforces its API-key check when
  `proxy_api_key` is non-empty (`proxy.rs`, the `!config.proxy_api_key.is_empty()`
  gate), and the frontend default is an empty key. The proxy also resolves the
  user's stored cloud-provider API keys server-side and attaches them to
  upstream requests. So a user who set the server host to `0.0.0.0` or a LAN IP
  (a documented feature for driving the API from other devices) with the key
  empty was exposing an unauthenticated endpoint that any LAN host could use to
  bill their paid Anthropic/OpenAI/OpenRouter accounts. The Host-header allow
  list did not help because loopback names are always trusted by default.

- **Decision:** Refuse to bind the Local API Server to any non-loopback address
  (detected from the bound socket's IP, so `0.0.0.0`, `::`, and any concrete LAN
  IP all count) unless a non-empty API key is configured. Loopback (`127.0.0.0/8`,
  `::1`) stays unrestricted for the common local case. The check lives in
  `start_server_internal` at the single bind point, so it also covers the CLI
  and future callers.

- **Consequences:** LAN access now requires the user to set an API key first;
  the refusal returns an actionable error naming Settings → Local API Server.
  Local-only use is unaffected. This closes the highest-severity issue from the
  2026-10-10 security audit without changing the on-wire auth model — it only
  forbids the no-auth + non-loopback combination. A future refinement could
  auto-generate and display a key when the user picks `0.0.0.0` instead of
  refusing.

- **Owner:** team

- **Links:** `src-tauri/src/core/server/proxy.rs` (`start_server_internal`);
  `web-app/src/hooks/useLocalApiServer.ts` (host `'127.0.0.1' | '0.0.0.0'`, empty
  key default).
