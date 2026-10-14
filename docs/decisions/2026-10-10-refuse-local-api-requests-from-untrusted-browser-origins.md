---
date: 2026-10-10
title: 'Refuse Local API Server requests from untrusted browser origins'
---

# 2026-10-10 — Refuse Local API Server requests from untrusted browser origins

- **Context:** The Local API Server checked the `Host` header (which blocks DNS rebinding) and, only when an API key was set, the bearer token. The default API key is empty. A browser's `Origin` header affected only whether CORS headers were added, so a cross-site request was still *executed*; the page just could not read the reply. A web page could therefore send a "simple" `no-cors` POST to `http://127.0.0.1:1337/v1/chat/completions` with no preflight. If the model belonged to a remote provider, the proxy forwarded it with the user's stored cloud API key. Any site the user visited while Radium ran could spend their cloud credits or load their GPU.
- **Decision:** Before routing, refuse with `403` any request whose `Origin` header is present and is not allowed. Allowed origins are: the app's own webview (`tauri://localhost`, `http(s)://tauri.localhost`), the loopback hosts that are always trusted, and the user's Trusted Hosts (`*` still allows everything). Requests without an `Origin` (SDKs, curl, coding agents) are unaffected. Opaque `null` origins are refused. The documentation paths that already skip the Host check (`/`, `/openapi.json`, Swagger assets) skip this check too. A JSON content-type requirement was considered and rejected: browsers always send `Origin` on cross-site POSTs, so it adds nothing, and it would break `curl -d` users.
- **Consequences:** A browser page on a host that isn't trusted can no longer use the server at all, even for requests the user intended. Users who call the API from their own web app on another host add that host to Trusted Hosts, which the 403 message says. Generating a random API key by default would add a second layer and is a separate decision. The analytics `error_kind` for these refusals is `origin`.
- **Owner:** @walladanger.
- **Links:** `src-tauri/src/core/server/proxy.rs` (`is_request_origin_allowed`, `APP_WEBVIEW_ORIGINS`); tests `request_origin_tests` and `integration_tests::a_cross_site_post_is_refused_before_it_reaches_a_model`.
