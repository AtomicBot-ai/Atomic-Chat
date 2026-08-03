---
date: 2026-06-01
title: "Add a \"Launch\" page to install + configure external coding agents / assistants against the local OpenAI-compatible API"
---

# 2026-06-01 — Add a "Launch" page to install + configure external coding agents / assistants against the local OpenAI-compatible API

- **Context:** To use Atomic Chat's local models from external agents
 (Claude Code, Codex CLI, OpenCode, Hermes, OpenClaw) users had to
 hand-edit each agent's config to point at `http://localhost:1337/v1`.
 Ollama solves the same problem with `ollama launch <agent>`
 (docs.ollama.com/integrations). We wanted the same one-click ergonomics
 without inventing a new CLI surface. The repo already had the building
 blocks: a Settings → Integrations section, the Rust writers
 `launch_claude_code_with_config` / `configure_hermes_agent`, and the
 `start_server` / `get_server_status` commands.
- **Decision:** Ship a **buttons-only, top-level "Launch" page** (no new
 CLI binary — "Variant A"). Each agent card has two actions:
 **Install** (`install_agent` spawns the agent's official installer via
 `std::process::Command`, streaming stdout/stderr to the UI through the
 `agent_install_log:<id>` Tauri event; a missing prerequisite such as
 `npm` returns a clear error with the agent's docs URL — no browser
 auto-open) and **Enable** (ensures the local server is running, then
 writes the agent's config pointing at
 `http://${serverHost}:${serverPort}${apiPrefix}`). New Rust commands in
 `src-tauri/src/core/system/commands.rs`: `detect_agent_installed`,
 `install_agent`, `configure_codex` (`~/.codex/config.toml`, managed
 block), `configure_opencode` (`~/.config/opencode/opencode.json`, strict
 JSON merge, always sets `provider.atomic.name` so options forward),
 `configure_openclaw` (`~/.openclaw/openclaw.json` + the
 `agents.defaults.models` allowlist; honours `OPENCLAW_CONFIG_PATH`).
 Claude Code and Hermes reuse the existing writers. First iteration =
 Claude Code, Codex CLI, OpenCode (coding) + Hermes, OpenClaw
 (assistants). New frontend: route `web-app/src/routes/launch/index.tsx`,
 sidebar item in `NavMain.tsx`, catalog `web-app/src/constants/integrations.ts`,
 locale namespace `web-app/src/locales/en/launch.json`.
- **Consequences:**
 - Reuses the established Rust home-dir config-writer pattern; no new
 top-level folders or dependencies. The whole surface is gated behind a
 single new top-level page marked "Experimental".
 - **No CLI surface.** A future CLI epic (`atomic-chat-cli launch <agent>`)
 can reuse the same Rust config-writers; the logic deliberately lives in
 `core/system/commands.rs` rather than a UI-only path.
 - **Install depends on host tooling.** Install paths verified against each
 vendor (2026-06-01): Claude Code (`npm i -g @anthropic-ai/claude-code`),
 Codex (`npm i -g @openai/codex`), OpenCode (`npm i -g opencode-ai`) and
 OpenClaw (`npm i -g openclaw`, needs Node 22+) ship as global npm
 packages. **Hermes is a Python project**, installed via its official
 bootstrap script (`curl -fsSL .../scripts/install.sh | bash` on Unix,
 `iex (irm .../scripts/install.ps1)` on Windows) — so `install_agent`
 spawns that script for Hermes instead of npm; its prerequisite is
 `curl` (Unix) / `powershell` (Windows).
 - **OpenClaw config is JSON5** but we parse/merge with `serde_json`; if a
 user's file contains comments/trailing commas the parse fails and we
 return an actionable error instead of clobbering it (no `json5` dep
 added).
 - **API key** from `useLocalApiServer` is passed automatically when set;
 it is usually empty, so Codex omits auth and OpenCode/OpenClaw fall back
 to a placeholder key.
 - **Per-agent request timeouts are seeded for local models.** Small local
 GGUF/MLX models, once wrapped in an agent's system prompt + tools, take
 longer per turn than these agents' cloud-tuned defaults expect.
 `configure_openclaw` seeds `agents.defaults.timeoutSeconds = 240` (its
 default is far shorter). `configure_hermes_agent` seeds
 `providers.custom.request_timeout_seconds = 180` — note Hermes' own
 default is the opposite extreme (1800s via `HERMES_API_TIMEOUT`), so for
 Hermes this is a *tightening* so a wedged turn fails fast rather than
 hanging 30 min. The key is the resolved provider id (Hermes reads
 `providers.<id>.request_timeout_seconds` in
 `run_agent.py::get_provider_request_timeout`; our model uses provider
 `custom`). Both writers **preserve any value the user already set** —
 they only fill the gap, never clobber.
- **Owner:** team.
- **Links:** docs.ollama.com/integrations,
 [`web-app/src/routes/launch/index.tsx`](web-app/src/routes/launch/index.tsx),
 [`web-app/src/constants/integrations.ts`](web-app/src/constants/integrations.ts),
 [`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs),
 [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs),
 [`web-app/src/components/left-sidebar/NavMain.tsx`](web-app/src/components/left-sidebar/NavMain.tsx).
