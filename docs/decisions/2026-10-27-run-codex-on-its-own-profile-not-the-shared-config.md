---
date: 2026-10-27
title: "Run Codex on an Atomic Chat profile, never the shared config.toml"
---

# 2026-10-27 — Run Codex on an Atomic Chat profile, never the shared config.toml

- **Context:** To make Atomic the default Codex provider, `configure_codex`
  (and the core's `configureCodex` for `launch codex`) wrote root `model` /
  `model_provider` keys and `[model_providers.atomic]` into
  `~/.codex/config.toml`, between `# >>> Atomic Chat (managed) >>>` markers.
  That file is shared with plain `codex` runs and the ChatGPT app. If the user
  already had a root `model`, the result had two of them, and ChatGPT refused
  to start with `config.toml:6:1: duplicate key` (reproduced with codex-cli
  0.146). Removing Codex under Server → Connected tools only forgot the row,
  so nothing undid the edit. The Launch terminal also never set
  `ATOMIC_CHAT_API_KEY`, the variable the config named for a keyed server.
- **Decision:** Atomic Chat writes only `<codex home>/atomic-chat.config.toml`
  (`$CODEX_HOME` or `~/.codex`). It names provider `atomic-chat`, so it never
  merges into a user's own `[model_providers.atomic]`. It starts with
  `# Managed by Atomic Chat`, and a file without that line is never
  overwritten or deleted. The Launch page runs `codex --profile atomic-chat`,
  with `ATOMIC_CHAT_API_KEY` set when the server has a key. Codex supports a
  file `--profile` from 0.134.0 (0.131–0.133 named it `--profile-v2`), so an
  older installed Codex is refused with an update message.
  Releases before this one left blocks in `config.toml`. The app takes them
  out at every start, before configuring, and on Disconnect. A block is
  removed only if its markers are whole lines that pair up, it parses as TOML,
  and it holds nothing but keys Atomic Chat wrote (either shape:
  `[profiles.atomic]` from the first release, or head + provider table from
  later ones). The result must also parse. The original is copied first to
  `config.toml.atomic-chat-backup[-N]`, which is never overwritten. The file
  is re-read before the atomic write, keeps its permission bits, is written
  through a symlink rather than replacing it (dotfile managers), and is left
  byte for byte otherwise, with a reason a person can act on. Old settings
  found at start become the profile, if none exists yet.
  Server → Connected tools shows Disconnect for Codex (`disconnect_codex`).
  The row goes only once the profile and the old blocks are gone. For other
  tools the button still only forgets the row.
- **Consequences:** A plain `codex` and the ChatGPT app run on the user's own
  settings again; only `codex --profile atomic-chat` uses the local model, and
  the configured toast says so. Someone who ran a bare `codex` against Atomic
  must now add the flag. The core CLI makes the same change: `launch codex`
  passes the flag and the key variable. The Rust shell gains the `toml` crate
  as a direct dependency (0.9, already in the lock). A config that is broken
  for reasons of its own is not repaired; it is reported.
- **Owner:** `team`.
- **Links:** `src-tauri/src/core/system/codex_config.rs`,
  `src-tauri/src/core/system/commands.rs` (`configure_codex`),
  `src-tauri/src/core/system/agent_config_detection.rs`,
  `web-app/src/routes/launch/index.tsx`,
  `web-app/src/containers/server/ConnectedTools.tsx`,
  `tests/e2e/desktop/launch-integration.spec.ts`,
  atomic-chat-core `src/integrations/configure/codex.ts`,
  https://learn.chatgpt.com/docs/config-file/config-advanced#profiles.
