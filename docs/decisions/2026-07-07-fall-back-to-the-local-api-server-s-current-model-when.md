---
date: 2026-07-07
title: "Fall back to the Local API Server's \"Current Model\" when configuring Launch-page agents against a cloud-provider selection"
---

# 2026-07-07 — Fall back to the Local API Server's "Current Model" when configuring Launch-page agents against a cloud-provider selection

- **Context:** A user reported Launch-page agents (Claude Code) failing when
  their globally selected model was a **cloud** provider (e.g. `gpt-5.4-mini`
  via OpenRouter/OpenAI) even though the Local API Server panel correctly
  showed that model as the "Current Model" being served at
  `http://127.0.0.1:1337/v1`. `app.log` showed
  `Claude Code configured: base_url=http://127.0.0.1:1337, model=None`.
  Root cause traced to
  [`web-app/src/routes/launch/index.tsx`](web-app/src/routes/launch/index.tsx):
  `activeModel` (passed as the `model` arg to every `configure_*` Tauri
  command, incl. `configure_claude_code` in
  [`commands.rs`](src-tauri/src/core/system/commands.rs)) was sourced only
  from `runningModels[0]`, itself populated by
  `serviceHub.models().getActiveModels()` — a **local-engine-only** query
  (llamacpp/mlx), which is empty whenever the active model is a remote/cloud
  provider. With `model=None`, `configure_claude_code` skips writing
  `ANTHROPIC_MODEL`/tier-alias env vars entirely, so Claude Code falls back
  to its internal default Anthropic model names, which don't match any
  locally-configured remote provider at the proxy (`proxy.rs`) → 404s.
  `claude-code`'s `requiresModel: false` in
  [`integrations.ts`](web-app/src/constants/integrations.ts) meant the UI
  never forced a model pick to mask this gap.
- **Decision:** Add a fallback in `launch/index.tsx`: when no local engine
  model is running, use `defaultModelLocalApiServer?.model` from
  [`useLocalApiServer`](web-app/src/hooks/useLocalApiServer.ts) — the same
  value the Local API Server panel's "Current Model" row displays, kept in
  sync with the global model/provider selection via `syncModelSelection`
  in [`switchModel.ts`](web-app/src/utils/switchModel.ts) regardless of
  whether the selection is local or cloud. `activeModel` becomes
  `runningModels[0] ?? defaultModelLocalApiServer?.model ?? null`.
- **Consequences:** Launching/configuring an agent while a cloud model is
  selected now passes that model's id to `configure_*`, so Claude Code (and
  any other agent reading the `model` param) gets pinned to exactly what
  "Current Model" advertises, matching what the proxy will actually route.
  No IPC, schema, or on-disk-layout change — a one-line data-source swap in
  a single web-app file. Local-model launches are unaffected (still take
  the `runningModels[0]` branch first). **Verified:** `tsc -b` clean;
  `ReadLints` clean on the edited file.
- **Owner:** team.
- **Links:** the 2026-06-01 ADR *Add a "Launch" page …* (the agent
  install/configure flow this fixes), files:
  [`web-app/src/routes/launch/index.tsx`](web-app/src/routes/launch/index.tsx)
  (`activeModel`),
  [`web-app/src/hooks/useLocalApiServer.ts`](web-app/src/hooks/useLocalApiServer.ts)
  (`defaultModelLocalApiServer`),
  [`web-app/src/utils/switchModel.ts`](web-app/src/utils/switchModel.ts)
  (`syncModelSelection`).
