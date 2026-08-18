---
date: 2026-08-18
title: "Add DeepSeek Harness (`dsh`) as a one-click Launch-page coding agent, configured by merging a hand-declared `llm-pi-ai` route into `$DSH_HOME/settings.yaml`"
---

# 2026-08-18 — Add DeepSeek Harness (`dsh`) as a one-click Launch-page coding agent

- **Context:** DeepSeek AI published [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`, npm `@deepseek-ai/dsh`, MIT) — a plugin-based agent harness in the same class as the Codex CLI, OpenCode, Cline and Goose entries the Launch page already ships. It is the first integration whose config file is YAML and the first that is a browser app rather than a terminal chat, so neither the JSON-merge shape (`configure_opencode`) nor the plain `detectBin` launch path applied unchanged.

- **Decision:** Ship it as an ordinary Launch-page coding agent, with four shape changes forced by how `dsh` reads configuration:
  - **Provider route.** Upsert `llm-pi-ai.providers.atomic` in `$DSH_HOME/settings.yaml` (default `~/.dsh`) — [`configure_dsh`](../../src-tauri/src/core/system/commands.rs). The `llm-pi-ai` adapter is mounted **dormant** by the shipped base bundle (`packages/bundle/base/cordis.patch.yml`), so writing the section is the entire integration: routes register live and no restart is needed.
  - **Replace the route wholesale, never deep-merge.** `apiKeyEnv` is a *reference to an env var name*. `dsh` fails requests with `MISSING_CREDENTIAL` when the field is present but resolves to nothing, and leaves the route plainly unauthenticated when it is absent — so the keyless path must **omit** the field, and a merge that let a stale `apiKeyEnv` survive from an earlier keyed run would break every request.
  - **The secret goes to `$DSH_HOME/.env`**, as `ATOMIC_API_KEY` inside a managed marker block, never into `settings.yaml`. `ATOMIC_API_KEY` is exactly the `<ROUTE>_API_KEY` reference `dsh`'s own Models page derives for route `atomic`, so our route stays editable *and deletable* from inside `dsh`. `.env` is the lowest layer in its credential resolution order (inherited env → `.credentials.yaml` → project `.env` → `$DSH_HOME/.env`), so anything the user sets deliberately still wins.
  - **`requiresModel: true`, enforced twice.** A route the pi-ai catalog does not ship is only valid with `api`, `baseURL` and a **non-empty** `models` list, and `dsh` rejects the *whole* `llm-pi-ai` section when one route is invalid. An unset model would therefore take the user's other `dsh` providers down with it, not merely fail to help — so `apply_dsh_provider` hard-errors before mutating the tree rather than writing a best-effort route.

  Also: the terminal command is `dsh web` (a bare `dsh` has no profile to hand its arguments to and only prints launcher help); explicit `contextWindow` 65536 / `maxTokens` 8192 replace pi-ai's 262144/32768 route fallbacks, which over-claim wildly for a local model and surface as a mid-turn rejection; and the icon is the official fish mark inlined from the harness' own `FishLogo.tsx`.

- **Consequences:**
  - `settings.yaml` is a **shared multi-plugin document** — every top-level key is another plugin's namespace. So this is the first `configure_*` that (a) writes atomically via a temp sibling + rename instead of `std::fs::write`, and (b) **errors instead of clobbering** when `llm-pi-ai` or `providers` holds a non-mapping, where the JSON siblings reset the node (`if !x.is_object() { *x = {} }`). Both divergences are deliberate: a truncated or reset write here destroys configuration we do not own.
  - The parse/re-serialize round trip **drops YAML comments and expands anchors/aliases** — the same trade `configure_zed` makes for JSONC, but with a larger blast radius since the file is hand-edited. Mitigated by copying the pre-existing contents to `settings.yaml.atomic-backup` once, on the first write only.
  - This is the first `configure_*` with test coverage. `apply_dsh_provider` and `dsh_home_from` were split out as pure functions specifically to make that possible; the other 17 remain untestable because `agent_home_dir()` reads process env directly. Thirteen tests, the load-bearing one being that a stale `apiKeyEnv` cannot survive a reconfigure.
  - `dsh` is a **developer preview at v0.1.0-rc.7** whose README promises compatibility-breaking changes in capitals. If the `llm-pi-ai` settings schema moves, `configure_dsh` writes a section `dsh` refuses — and because a rejected section disables the user's other `dsh` providers too, that failure is louder than the usual "this integration stopped working". Worth re-checking the schema when bumping.
  - Model selection inside `dsh` stays manual: unlike `configure_opencode`, which overwrites a top-level `model` key, `dsh` keeps the active model in its own session state. We register the provider; the user picks it once.
  - A project-local `.env` outranks `$DSH_HOME/.env`, so a user running `dsh` inside a repo that sets its own `ATOMIC_API_KEY` silently wins. Nothing to fix, but it presents as "I pressed Run and still get `MISSING_CREDENTIAL`" — which is why `configure_dsh` logs the resolved `$DSH_HOME`.
  - `DSH_HOME` is probed from the user's login shell as well as the process env (same mechanism and same reason as `login_shell_path`): a Finder/Dock-launched app does not inherit rc-file exports, and getting this wrong would silently write a file nobody reads.

- **Owner:** `team`.

- **Links:**
  - [`web-app/src/constants/integrations.ts`](../../web-app/src/constants/integrations.ts) — the `dsh` entry
  - [`web-app/src/routes/launch/index.tsx`](../../web-app/src/routes/launch/index.tsx) — `AgentIcon` case, `configureAgent` case, `dsh web` terminal case
  - [`src-tauri/src/core/system/commands.rs`](../../src-tauri/src/core/system/commands.rs) — `agent_install_spec` arm, `configure_dsh` and its helpers, `dsh_tests`
  - [`src-tauri/src/lib.rs`](../../src-tauri/src/lib.rs) — registered in both `generate_handler!` lists
  - Upstream: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), its [provider guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md) and [`llm-pi-ai` README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/README.md)
  - Prior art for this integration shape: [2026-06-15 — Add Cline CLI](2026-06-15-add-cline-cli-as-a-one-click-launch-page-coding-agent-configure.md)
