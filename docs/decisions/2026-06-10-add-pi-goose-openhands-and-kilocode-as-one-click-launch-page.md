---
date: 2026-06-10
title: "Add Pi, Goose, OpenHands, and KiloCode as one-click Launch-page coding agents"
---

# 2026-06-10 — Add Pi, Goose, OpenHands, and KiloCode as one-click Launch-page coding agents

- **Context:** The Launch page lets users one-click install + configure external
  coding agents against the local OpenAI-compatible server (port 1337). Four
  more real CLIs were requested and verified on-machine: Pi, Goose, OpenHands,
  and KiloCode — all `kind: "coding"`.
- **Decision:** Mirror the existing integration pattern exactly. Added four
  entries to `INTEGRATION_AGENTS`
  ([`web-app/src/constants/integrations.ts`](web-app/src/constants/integrations.ts)),
  an `AgentIcon` case per brand using official SVG logos self-hosted under
  [`web-app/public/images/integrations/`](web-app/public/images/integrations/)
  (`pi.svg`, `goose.svg`, `openhands.svg`, `kilo.svg`), a `configureAgent` case
  per id, and per-agent terminal commands in `handleRun`
  ([`web-app/src/routes/launch/index.tsx`](web-app/src/routes/launch/index.tsx)).
  Backend ([`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs)):
  install specs in `agent_install_spec` (Pi/Kilo = global npm; OpenHands =
  `uv tool install openhands --python 3.12`; Goose = dual-OS shell/PowerShell
  bootstrap like Hermes) and four `configure_*` commands registered in both
  `generate_handler!` lists ([`src-tauri/src/lib.rs`](src-tauri/src/lib.rs)).
  - **Pi** (`configure_pi`): strict-JSON merge of `~/.pi/agent/models.json`
    (upsert `providers.atomic`) and `settings.json` (`defaultProvider`/
    `defaultModel`); `endpointWithPrefix` true. Terminal: `pi`.
  - **Goose** (`configure_goose`): env-var agent via `write_marked_env_to_shell`
    / `setx` (marker `# Atomic Chat - Goose Config`, prefix `GOOSE_`):
    `GOOSE_PROVIDER=openai`, `GOOSE_MODEL`, `OPENAI_HOST` (bare host:port —
    `endpointWithPrefix` false), `OPENAI_BASE_PATH=v1/chat/completions`,
    `OPENAI_API_KEY`. Terminal: `goose session`.
  - **OpenHands** (`configure_openhands`): env-var agent (marker
    `# Atomic Chat - OpenHands Config`, prefix `LLM_`): `LLM_MODEL=openai/<model>`
    (litellm prefix required), `LLM_BASE_URL` (`/v1`), `LLM_API_KEY`. Read only
    with `--override-with-envs`. Terminal: `openhands --override-with-envs`.
  - **KiloCode** (`configure_kilo`): json5 parse + strict-JSON re-serialize of
    `~/.config/kilo/kilo.jsonc`; upsert `provider.atomic`
    (`@ai-sdk/openai-compatible`, `baseURL` `/v1`), set `model` to
    `atomic/<model>`; `endpointWithPrefix` true. Terminal: `kilo`.
- **Consequences:** Four more agents installable + configurable in one click.
  All `configure_*` functions preserve unrelated user content and return an
  actionable parse error (never clobber) on a malformed existing file. No new
  analytics (the generic `agent_run` capture keys on id). Icons are the agents'
  official SVG logos, self-hosted under `web-app/public/images/integrations/`
  (fetched once, not hot-linked). Watch: upstream package names / install paths
  may drift.
- **Owner:** team.
- **Links:** branch `feat/launch-agents-pi-goose-openhands-kilo`.
