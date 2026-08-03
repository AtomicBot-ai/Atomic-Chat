---
date: 2026-06-03
title: "Fix OpenClaw Launch integration: select the model as primary, use the bare catalog id, and seed `gateway.auth.mode: \"none\"` on loopback"
---

# 2026-06-03 — Fix OpenClaw Launch integration: select the model as primary, use the bare catalog id, and seed `gateway.auth.mode: "none"` on loopback

- **Context:** After installing OpenClaw via the Launch page and pressing
  Run, the CLI still booted into "deterministic typed commands until we
  configure a model" and could not reach its local gateway. Three distinct
  bugs in `configure_openclaw`
  ([`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs)),
  all confirmed against OpenClaw's own bundled docs
  (`docs/gateway/config-agents.md`, `docs/gateway/local-model-services.md`,
  `docs/gateway/openai-http-api.md`, `docs/gateway/remote.md`):
  1. We wrote the `agents.defaults.models` **allowlist** but never set
     `agents.defaults.model` (the primary selector), so no model was active.
  2. The provider catalog entry used `id: "atomic/<model>"`. OpenClaw builds
     a model ref as `<providerId>/<id>`, so the prefix doubled to
     `atomic/atomic/<model>` and lookup failed. The `id` must be the **bare**
     model id our `/v1` server reports (matching the `inferrs` example where
     `id: "google/gemma-4-E2B-it"` yields ref `inferrs/google/gemma-4-E2B-it`).
  3. OpenClaw's local gateway (`ws://127.0.0.1:18789`) refuses to open its
     websocket without connection auth (`gateway.auth.*`), which was unset.
- **Decision:**
  - Set `agents.defaults.model = "atomic/<model>"` (string form = `model.primary`)
    on every Run — Run is an explicit "use this", so it overwrites.
  - Write the provider catalog entry with the bare id (`{ id: model, name: model }`);
    the `atomic/<model>` ref form is used only for the primary selector and the
    `/model` allowlist key.
  - Seed `gateway.auth.mode: "none"` (private-ingress open auth) via `or_insert`
    so the loopback-only gateway is reachable with no token/password. This is
    documented as valid for loopback binds; **non-loopback binds still require
    token/password/trusted-proxy** and we never touch those. We preserve any
    `gateway.auth` mode a user set deliberately (seed-only, never clobber).
  - Seed `gateway.mode: "local"` (seed-only): `openclaw gateway` only starts in
    local mode, and the TUI needs it to treat the loopback gateway as locally
    managed.
  - **Launch `openclaw chat`, not bare `openclaw`.** Bare `openclaw` (once the
    config has authored settings) starts **Crestodian**, the configless-safe
    setup/repair helper that interprets input as deterministic typed commands
    (e.g. `yo` → a `status` report), not a conversation
    (`docs/cli/crestodian.md`). `openclaw chat` (= `openclaw tui --local`) runs
    the **embedded local agent runtime** (`docs/web/tui.md`), dropping the user
    straight into a chat with agent `main` on the configured model — and it
    needs **no gateway at all**. So the Launch page's auto-opened terminal runs
    `openclaw chat` for OpenClaw (other agents still launch their `detectBin`).
    This makes the gateway irrelevant to the default flow; the
    `gateway.mode`/`gateway.auth.mode` seeds above are kept only as
    forward-compat for users who manually run `openclaw` / `openclaw tui`.
    (An earlier iteration started `openclaw gateway` as a terminal background
    job via an `open_agent_terminal` `background` arg; that was removed once
    `openclaw chat` proved it needs no gateway.)
- **Consequences:** Pressing Run installs (if needed), configures, and opens a
  terminal where the user can immediately chat with the local model — verified
  end-to-end on macOS: `openclaw chat --local --message "…PONG"` replies `PONG`
  on agent `main` using `atomic/Qwen3.5-4B-MLX-4bit` via `:1337/v1`, with no
  gateway running. The loopback `auth.mode: "none"` seed is a security
  relaxation scoped to `127.0.0.1` only and only matters if the user opts into
  gateway mode manually; non-loopback binds still require explicit auth, which
  our seed-only logic leaves intact. Windows uses the same `openclaw chat`
  command (npm install path) but is **not yet validated**; flagged for a
  Windows test pass.
- **Owner:** team.
- **Links:** the 2026-06-01 ADR *Add a "Launch" page …*,
  [`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs)
  (`configure_openclaw`, `open_agent_terminal`),
  [`web-app/src/routes/launch/index.tsx`](web-app/src/routes/launch/index.tsx)
  (OpenClaw launches `openclaw chat`), OpenClaw bundled docs `docs/gateway/*`,
  `docs/start/openclaw.md`, `docs/platforms/macos.md`, `docs/cli/crestodian.md`,
  `docs/web/tui.md`.
