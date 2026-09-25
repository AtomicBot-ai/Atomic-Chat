---
date: 2026-09-18
title: "Honour 'Ignore SSL certificates' for proxied plugin requests"
---

# 2026-09-18 — Honour "Ignore SSL certificates" for proxied plugin requests

- **Context:** The HTTPS Proxy settings offer "Ignore SSL certificates". The Rust downloader honours it (`danger_accept_invalid_certs`), and both llama.cpp extensions pass it to `tauri-plugin-http` as `danger` for the backend-manifest request they send through the proxy. The plugin was built without its `dangerous-settings` feature, so it refused every such request locally (`Error::DangerousSettings`); the manifest then arrived only by the three routes that bypass the proxy, which is no route at all on a network where the proxy is the only way out. Found by the desktop e2e suite with a loopback CONNECT proxy in front of a local release.
- **Decision:** Enable `dangerous-settings` on `tauri-plugin-http`. The setting is the user's, already in the product, and already honoured by the downloader; the feature applies per request and only when a caller passes `danger`, which today is that one proxied manifest request with the setting on. Rejected: enabling it only in the e2e build (the suite would then test a build nobody ships) and dropping `danger` from the extensions (the setting would keep failing silently for exactly the users who need it).
- **Consequences:** With the setting on, the manifest request goes through the proxy and accepts its certificate, and the e2e suite drives the whole update from the UI: manifest through the proxy, archive downloaded and verified by the core, next load on the new backend. Any webview code can now ask the plugin to skip certificate checks for a request within the capability's URL scope; extensions are first-party and the scope is unchanged. The plugin path also accepts invalid hostnames, which the downloader does not. The manifest race is unchanged: three of four routes still ignore the proxy by design (ATO-243), so a proxied answer is not guaranteed to win.
- **Owner:** team
- **Links:** `src-tauri/Cargo.toml`, `extensions/llamacpp-upstream-extension/src/backend.ts`, `tests/e2e/desktop/backend-install.spec.ts`, `tests/e2e/harness/backend-mirror.ts`
