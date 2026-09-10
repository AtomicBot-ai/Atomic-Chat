---
date: 2026-06-15
title: "Add Cline CLI as a one-click Launch-page coding agent (configure by running `cline auth`, not writing a file)"
---

# 2026-06-15 — Add Cline CLI as a one-click Launch-page coding agent (configure by running `cline auth`, not writing a file)

- **Context:** The Launch page one-click installs + configures external coding
  agents against the local OpenAI-compatible server. Cline CLI was requested
  (`kind: "coding"`), but unlike the other agents it has **no** clean
  user-facing config file and **no** base-URL env var; its on-disk state
  (`~/.cline/globalState.json`) is a brittle legacy format that must not be
  hand-written. Cline ships an official non-interactive setup command — the same
  one `ollama launch cline` invokes under the hood.
- **Decision:** Mirror the existing integration pattern, but configure by
  **running the `cline` binary** instead of writing a file. Added a `cline`
  entry to `INTEGRATION_AGENTS` (after `opencode`)
  ([`web-app/src/constants/integrations.ts`](web-app/src/constants/integrations.ts)),
  an `AgentIcon` case (`IconBox` bg `#2b303b` + `cline.png` with `object-cover`)
  and a `configureAgent` case
  ([`web-app/src/routes/launch/index.tsx`](web-app/src/routes/launch/index.tsx)).
  Backend ([`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs)):
  install spec in `agent_install_spec` (global npm `cline`, prereq `npm`) and a
  new `configure_cline` command that spawns
  `cline auth --provider openai-compatible --apikey <key> --modelid <model> --baseurl <api_url>`
  via `std::process::Command` (mirroring `install_agent`: `apply_login_path` so
  the GUI build finds the npm-installed `cline`, `CREATE_NO_WINDOW` on Windows,
  trimmed stderr on non-zero exit). `<key>` falls back to the placeholder
  `"local"` when no API key is set (Cline rejects an empty apikey, and an empty
  modelid — model is always present because `requiresModel` is true).
  `endpointWithPrefix` true (base URL carries `/v1`). Registered in both
  `generate_handler!` lists ([`src-tauri/src/lib.rs`](src-tauri/src/lib.rs)).
  No special `handleRun` terminal command — Cline launches its TUI with the bare
  `cline` binary (the default `agent.detectBin` path).
- **Consequences:** One more agent installable + configurable in one click. The
  configure step shells out to the vendor's supported `cline auth` path (no
  fragile file surgery on `globalState.json`), so it stays correct across
  Cline's on-disk format changes. `cline` is guaranteed installed before
  configure runs (handleRun installs first). Watch: the upstream `cline` package
  name or the `cline auth` flag surface may drift.
- **Owner:** team.
- **Links:** branch `feat/launch-cline-cli`; https://docs.cline.bot/cline-cli/getting-started.
