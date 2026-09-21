---
date: 2026-09-18
title: "Keep the HTTP plugin's JS client on the Rust plugin's version"
---

# 2026-09-18 — Keep the HTTP plugin's JS client on the Rust plugin's version

- **Context:** `@tauri-apps/plugin-http` was pinned at 2.5.0 in the web app and four extensions (since 2025-09, "lock all of the dependencies"), while `Cargo.lock` had moved `tauri-plugin-http` to 2.5.7 (2026-06). The two disagree on how a response body travels: the 2.5.0 client opens a channel and waits for chunks on it; the 2.5.7 plugin returns each chunk as the result of `fetch_read_body` and never writes to a channel. Status and headers arrived, a body never did — `await response.json()` hung for good. Seen from outside only as symptoms: the llama.cpp backend list stuck on "loading" whenever a plugin-http route won the manifest race, and registry fallbacks "via Tauri HTTP plugin" that never helped. Established by calling the plugin's commands directly from the e2e app, which returned the body as the invoke result.
- **Decision:** Pin the JS client to the Rust plugin's exact version (2.5.7) everywhere it is used, and treat the pair as one dependency: a `Cargo.lock` move of `tauri-plugin-http` needs the same move in the five `package.json` files, and the other way round.
- **Consequences:** Bodies arrive again over the plugin; the backend update scenario in the desktop e2e suite depends on it and would stall if the pair drifts. The client brings its own nested `@tauri-apps/api` 2.11 (it requires ^2.10.1; the app stays on 2.8.0) — it only uses `invoke`, which goes through the webview's internals either way. Nothing enforces the pairing yet; a contract test comparing the two lockfiles would.
- **Owner:** team
- **Links:** `web-app/package.json`, `extensions/*/package.json`, `yarn.lock`, `extensions/yarn.lock`, `src-tauri/Cargo.lock`, `tests/e2e/desktop/backend-install.spec.ts`
