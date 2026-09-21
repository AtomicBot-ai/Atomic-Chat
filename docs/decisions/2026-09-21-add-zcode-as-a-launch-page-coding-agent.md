---
date: 2026-09-21
title: "Add ZCode as a Launch-page coding agent, configured by merging an `atomic-chat` provider into `~/.zcode/v2/provider_config.json` — no install"
---

# 2026-09-21 — Add ZCode as a Launch-page coding agent, configured by merging an `atomic-chat` provider into `~/.zcode/v2/provider_config.json` — no install

- **Context:** ZCode (`zai-org/ZCode`, Apache-2.0, open-sourced 2026-09-20 at
 3.14) is Z.ai's Electron desktop coding workspace; its terminal agent is
 built from the same repo but not published anywhere. It reads no
 `OPENAI_BASE_URL`-style variables: the single source of custom providers for
 the desktop app, its web UI and its CLI is
 `<dataBase>/.zcode/v2/provider_config.json`, which ZCode polls every second.
 The official docs still name `~/.zcode/v2/config.json`, but the code only
 imports that legacy file once — on the first start that finds no
 `provider_config.json` (`packages/services/src/node.ts`) — and never writes
 it again. The file is validated with strict Zod (`schemaVersion: 1`, unknown
 keys rejected, a provider/model pair may not have both a regular and a manual
 rule), and a file that fails validation is not reported: ZCode treats it as
 empty, so every custom provider the user has disappears.
- **Decision:** Add a `zcode` card (coding, `RunMode::Gui`, `installable:
 false`) whose Run only writes the provider file, then opens the app if one is
 found.
 - `configure_zcode` resolves the directory the way the desktop does
 (`dataBaseDir` from `~/.zcode/v2/setting.json`, then `$ZCODE_DATA_BASE_DIR`,
 then home) and replaces only entries whose `providerId` is `atomic-chat`: a
 `standard-personal` provider with `api.type: openai-chat-completions`, the
 `/v1` base URL and a non-blank key (`atomic` when the server has none); one
 `providerModelRules` entry for the running model, with our rows dropped from
 both rule lists first; `defaultModelSelection` with `reasoningLevel:
 "enabled"`; our id prepended to `providerOrder` only when that list exists.
 - The model rule declares `contextWindow` 65536 / `maxOutputTokens` 8192
 (ZCode otherwise assumes 200K for an unknown id, as DeepSeek Harness does)
 and replaces ZCode's option maps: reasoning becomes
 `chat_template_kwargs.enable_thinking` and the cap `max_tokens`, because the
 default `thinking` / `enable_thinking` / `reasoning_effort` /
 `max_completion_tokens` fields are ignored by llama-server.
 - Writes happen under ZCode's own lock (`provider_config.json.lock/` holding
 `owner-<token>.json`, waited on for 8 s, reclaimed after 60 s of inactivity)
 via temp file + rename, owner-only, with a one-time
 `provider_config.json.atomic-backup` of the user's version.
 - **Refuse, don't repair:** an unknown `schemaVersion`, invalid JSON or a
 wrongly-typed section returns an error and leaves the file alone. When a
 legacy `config.json` exists without `provider_config.json`, Run asks the
 user to open ZCode once first, since writing the file would cancel ZCode's
 import of their old providers.
 - Detection and launch share `zcode_app_candidates` (`ZCode.app` in
 `/Applications` or `~/Applications`, `%LOCALAPPDATA%\Programs\ZCode` /
 `%ProgramFiles%\ZCode`, `/opt/ZCode` plus `/usr/bin/zcode`). A missing app
 gets a toast pointing to zcode.z.ai, not an error.
- **Consequences:** ZCode picks the provider up live, including when it is
 already running, and a user who installs ZCode later finds Atomic Chat ready.
 Run owns the `atomic-chat` provider: a manual rule the user added for it in
 ZCode's Advanced settings is dropped on the next Run, and the provider lists
 only the model Run was pressed for. Rewriting the file sorts its keys. There
 is no in-app install (Homebrew `zcode` and winget `ZhipuAI.ZCode` exist if
 that is wanted later). Every generated file was run through ZCode's own
 `decodeProviderConfigFile` and `ProviderConfigResolver` (fresh and merged
 over a user provider): zero issues, both providers executable, option maps
 compile. Watch the schema version and the lock format when ZCode updates.
- **Owner:** `team`
- **Links:** `src-tauri/src/core/system/commands.rs` (`configure_zcode`,
 `launch_zcode`, `zcode_tests`), `src-tauri/src/core/cli/integrations.rs`,
 `web-app/src/routes/launch/index.tsx`,
 `web-app/src/routes/launch/__tests__/zcode.test.tsx`;
 upstream `packages/provider-node/src/provider-config-file-codec.ts`,
 `packages/provider/src/config/rule-data-schema.ts`,
 `packages/shared/src/node/atomicFileLock.ts`,
 `config/provider/zcode-builtin.json`.
