---
date: 2026-08-20
title: "Narrow `atomic-chat-cli` to models / serve / launch / server status"
---

# 2026-08-20 — Narrow `atomic-chat-cli` to models / serve / launch / server status

- **Context:** The CLI had grown to 8 leaf commands around the Jan fork and did
  not work on a fresh install. `list_models` and `resolve_model_engine` probed
  the `llamacpp` and `mlx` providers, and `discover_llamacpp_binary` looked in
  `<data>/llamacpp/backends` — but `LOCAL_LLAMACPP_PROVIDER` is
  `llamacpp-upstream` on every platform, so backends land in
  `<data>/llamacpp-upstream/backends` and nothing was ever found: `models list`
  returned `[]` and `serve` reported "llama-server binary not found". Around
  that had accumulated `threads` (a JSON dump of chat history duplicating
  `core/threads/file_store.rs`), `models load` (a literal duplicate of `serve`),
  `models load-mlx` (a duplicate that orphaned its `mlx-server`), three unused
  `cli_*_server` helpers that require an `AppHandle` a headless process cannot
  build, and a private `configure_openclaw` that parsed OpenClaw's JSON5 config
  as JSON and replaced it with `{}` on any parse failure.
- **Decision:** Reduce the surface to `models list`, `serve`, `launch` and
  `server status`, and target a single engine — upstream `ggml-org/llama.cpp`.
  Note the on-disk asymmetry this exposes: backends are per-provider
  (`<data>/llamacpp-upstream/backends/`) while the GGUF tree is shared by both
  llama.cpp providers (`<data>/llamacpp/models/`, `MODELS_PROVIDER_ROOT` in the
  extension). `launch` now drives the same catalog and the same `configure_*`
  functions as the desktop Launch page — 17 agents instead of 2 — with a test
  asserting the Rust catalog and `integrations.ts` do not drift. `server status`
  only *reports* on the app's proxy: it never starts or stops it. Because the
  proxy's host/port/prefix live in the webview's localStorage, the app mirrors
  them to `<data>/local-api-server.json` on start/stop (never the API key), and
  the CLI treats that file as a hint it confirms over HTTP against the
  whitelisted `GET /`.
- **Consequences:** `models list` and `serve` work on a fresh install, and
  embedding models are filtered out of everything that leads to a chat endpoint.
  Passing the real `<version>/<backend>` instead of the placeholder
  `"cli/llama-server"` lets the argument builder parse a build number again, so
  flash attention, `--reasoning-preserve` and KV-cache quantization stop being
  silently dropped. `--port 0` resolves to a real port. A stale mirror file
  self-heals, since the HTTP probe decides. MLX is no longer reachable from the
  CLI — it remains fully supported in the desktop app. `models list` prints a
  table by default; `--json` keeps the previous machine-readable output.
  `serve --detach` now honours SIGTERM, so the PID it prints actually shuts the
  model server down, and it reports the port it bound.
- **Owner:** team.
- **Links:** `src-tauri/src/bin/jan-cli.rs`, `src-tauri/src/core/cli/mod.rs`,
  `src-tauri/src/core/cli/integrations.rs`,
  `src-tauri/src/core/server/state_file.rs`,
  `src-tauri/src/core/server/commands.rs`,
  `web-app/src/constants/integrations.ts`,
  `web-app/src/routes/launch/index.tsx`.

<!--
Supersedes: 2026-05-22-windows-ships-atomic-chat-cli-exe-as-a-copy-of-jan-exe.md
-->
