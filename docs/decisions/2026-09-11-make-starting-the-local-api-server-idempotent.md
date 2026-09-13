---
date: 2026-09-11
title: "Make starting the Local API Server idempotent"
---

# 2026-09-11 — Make starting the Local API Server idempotent

- **Context:** `start_server` was a strict singleton: a call that found the
  proxy up returned `Err("Server is already running")`. Several frontend paths
  raise the proxy on their own — the message send (`ensureRemoteProviderReady`),
  the model switch, the startup autostart, the Launch page, the Hermes / Claude
  Code settings — each as check-then-start with no shared lock. Three had grown
  a `msg.includes('already running')` guard; the send path had not, so on a
  fresh profile the first message after connecting Codex lost the race and
  failed with "Failed to create model: Server is already running" (ATO-524). The
  losing call left no line in `app.log`.
- **Decision:** starting is idempotent. `proxy::start_server` returns
  `ServerStart::Started(port)` or `ServerStart::AlreadyRunning(port)`, decided
  under the handle mutex; `ServerHandle` records the bound port. The Tauri
  command returns the port either way and, on `AlreadyRunning`, leaves the
  published endpoint and the CLI state file untouched. The reuse is logged at
  debug. `ensureRemoteProviderReady` also treats an "already running" rejection
  as ready, like the three guarded paths.
- **Consequences:** a start can no longer fail because another path won. The
  existing string guards are now dead but harmless. A start that arrives with a
  different config (port, prefix, API key) while the proxy is up does not apply
  it — as before, when every caller swallowed the error; applying new settings
  still takes stop → start.
- **Owner:** `team`
- **Links:** ATO-524; `src-tauri/src/core/server/proxy.rs` (`ServerStart`,
  `start_server_internal`), `src-tauri/src/core/server/commands.rs`,
  `src-tauri/src/core/state.rs`, `web-app/src/utils/ensureRemoteProviderReady.ts`;
  test `a_second_start_reuses_the_running_server` in
  `src-tauri/src/core/server/integration_tests.rs`
