---
date: 2026-09-16
title: "The webview reaches the core only through Rust, and one command carries the whole control API"
---

# 2026-09-16 — The webview reaches the core only through Rust, and one command carries the whole control API

- **Context:** `atomic-chat-core` is a separate process that owns a data folder and exposes a
  loopback control API at `/atomic/v1/*`. That API can load models, start and stop child processes
  and read settings, and its only authorization is a bearer token the owner writes to a `0600` file.
  The app has to use it from the webview, where feature code lives. Two questions followed: what
  holds the token, and what shape the bridge takes — a Tauri command per control route, or one
  generic call.
- **Decision:** The token never reaches JavaScript. The webview calls the Rust command
  `atomic_core_call(method, path, body)`, and Rust attaches the credential, so no page the webview
  ever renders can read it and a dev-origin needs no CORS exception on the core. The bridge is
  generic on purpose: the control API is already a versioned HTTP contract, and forty wrapper
  commands would be a second contract to keep in step with it. Request and response bodies are
  passed through untouched. Alongside it sit only the calls that are *about* the attachment rather
  than part of the control API — `atomic_core_status`, `atomic_core_snapshot`, and the
  get/set flag pair. Core events are re-emitted as Tauri events named `atomic-core://<name>`, 1:1
  with the core's own names, plus `atomic-core://detached` and `atomic-core://snapshot` which the
  relay itself raises when the mirror must be rebuilt. What the core owns is recorded in the app's
  own `settings.json` (`atomic_core`: `attach`, `runtime`, `server`), all off by default; that file
  is read before the data folder is opened, so the rollback switch works even when the folder the
  core would own is unavailable.
- **Consequences:** Adding a control route needs no Rust change, which is what makes stages 3b–3d
  mostly webview work. The cost is that Rust cannot type-check individual routes — the typing lives
  in the core's own client and in the webview — and that `atomic_core_call` is a broad capability
  for anything that can invoke Tauri commands, no broader than the app's existing filesystem
  commands but worth remembering. Because the flags live in the app's configuration file rather
  than in the core's, a user who moves their data folder keeps their choice, and a core started by
  the CLI on the same folder is unaffected by it.
- **Owner:** team
- **Links:** `src-tauri/src/core/atomic_core/commands.rs`,
  `src-tauri/src/core/atomic_core/relay.rs`, `src-tauri/src/core/app/models.rs`
  (`AtomicCoreFlags`)
