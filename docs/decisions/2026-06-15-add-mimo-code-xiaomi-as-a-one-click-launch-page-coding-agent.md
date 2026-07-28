---
date: 2026-06-15
title: "Add MiMo Code (Xiaomi) as a one-click Launch-page coding agent"
---

# 2026-06-15 — Add MiMo Code (Xiaomi) as a one-click Launch-page coding agent

- **Context:** MiMo Code (Xiaomi, `XiaomiMiMo/MiMo-Code`) was requested as another
  one-click Launch-page coding agent against the local OpenAI-compatible server
  (port 1337). MiMo Code is a **fork of OpenCode**: its config system is
  OpenCode's field-for-field, just at different paths.
- **Decision:** Mirror the existing integration pattern exactly. Added a `mimo`
  entry to `INTEGRATION_AGENTS`
  ([`web-app/src/constants/integrations.ts`](web-app/src/constants/integrations.ts))
  immediately after `opencode` (`kind: "coding"`, install global npm
  `@mimo-ai/cli`, `detectBin: "mimo"`, `endpointWithPrefix` true). Because MiMo
  ships only a wide wordmark (no usable square logo), the `AgentIcon` case is an
  initial-letter tile on a branded `#ff6700` background — no image file is
  referenced. Added a `configureAgent` case (`configure_mimo`); no special
  `handleRun` command (like OpenCode it launches its TUI from the bare
  `detectBin`)
  ([`web-app/src/routes/launch/index.tsx`](web-app/src/routes/launch/index.tsx)).
  Backend ([`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs)):
  install spec in `agent_install_spec` (global npm) and `configure_mimo`
  registered in both `generate_handler!` lists
  ([`src-tauri/src/lib.rs`](src-tauri/src/lib.rs)). `configure_mimo` is a
  near-copy of `configure_opencode` — it upserts `provider.atomic`
  (`@ai-sdk/openai-compatible`, `baseURL` `/v1`) and sets `model` to
  `atomic/<model>` in `~/.config/mimocode/mimocode.json`; only the config path
  and `$schema` (`https://mimo.xiaomi.com/config.json`) differ from OpenCode.
- **Consequences:** One more agent installable + configurable in one click.
  `configure_mimo` preserves unrelated user content and returns an actionable
  parse error (never clobber) on a malformed existing file. No new analytics
  (the generic `agent_run` capture keys on id). No new image asset (initial-tile
  icon). Watch: upstream package name `@mimo-ai/cli` / config path may drift,
  and since MiMo tracks OpenCode, keep `configure_mimo` in sync with
  `configure_opencode` if the OpenCode config schema changes.
- **Owner:** team.
- **Links:** branch `feat/launch-mimo-code`; `XiaomiMiMo/MiMo-Code`.
