---
date: 2026-09-16
title: "Migrate Jan-branded assistant prompts to the Atomic Chat default by signature, not by version"
---

# 2026-09-16 — Migrate Jan-branded assistant prompts to the Atomic Chat default by signature, not by version

- **Context:** Some installs show the default assistant with the system prompt
  "You are Jan, a helpful AI assistant who assists users with their requests.
  Jan is trained by Menlo Research (https://www.menlo.ai). …", and the model
  introduces itself as Jan. No source file carries that text; it is on-disk
  data in `<data>/assistants/<id>/assistant.json`, written by upstream Jan's own
  migration v2 (janhq/jan `a4f909c9d`, "fix: default instruction update
  (#7427)", 2026-01-29), which also wrote `.migration_version = 2`. The Atomic
  rebrand (`9b5d90abd`, `df4cf9f20`) rewrote v2's *target* text to "You are
  Atomic Chat…" but kept its version number and its prefix check
  (`'You are Jan, a helpful AI assistant.'`, period-terminated). So on those
  installs v2 never re-runs, and even if it did, the Jan prompt does not start
  with the period-terminated prefix and would not match. The web app's
  `DataProvider` rebrands the `jan` assistant's name, description and avatar
  in memory at startup but never touches `instructions`, which is why the
  screenshot shows "Atomic Chat" with the Jan prompt.

  Options: (a) a new migration keyed on the *content* of the prompt; (b) reset
  every `jan` assistant's prompt to the default unconditionally; (c) fix the v2
  prefix and reset the version file so v2 re-runs.

- **Decision:** (a). `extensions/assistant-extension` gets migration v3
  (`CURRENT_MIGRATION_VERSION = 3`, `migrateJanBrandedAssistants`). For every
  assistant whose `instructions`, after trimming, start with `You are Jan`
  (case-sensitive) or contain `Menlo Research` / `menlo.ai`, the instructions
  are replaced with the extension's `defaultAssistant.instructions`. On the same
  assistants a name of exactly `Jan` becomes `Atomic Chat` and a description
  starting with Jan's default ("Jan is a helpful desktop assistant…") becomes
  the Atomic default. Every other field — sampling parameters, avatar, tools,
  `created_at`, unknown keys — is spread through unchanged. A user-authored
  prompt that merely mentions Jan mid-text (or a lowercase "you are jan") is
  not touched. The v2 log line that said "Migrated to Menlo instructions" now
  says Atomic Chat.

  Why not (b): it would wipe prompts users wrote themselves on the default
  assistant. Why not (c): v2 also overwrites `parameters` with defaults, and
  the version file is shared with future migrations; re-running it is a bigger
  blast radius than a targeted pass, and the prefix bug would still be there.

  Not changed, recorded for the product owner: the extension's
  `defaultAssistant.instructions` is the long "You are Atomic Chat… trained by
  Atomic Chat (https://atomic.chat)…" prompt, while
  `web-app/src/hooks/useAssistant.ts` `defaultAssistant.instructions` is just
  `Current date: {{current_date}}`. On a fresh install the extension writes
  its long prompt to disk (`onLoad` creates the assistant when none exists),
  and the web app's short default only applies in memory when the extension
  returns nothing. Migrated installs therefore get the extension's long prompt,
  the same text a fresh install gets. Which of the two should be the product
  default is a separate decision.

- **Consequences:**
  - Installs stuck on the Menlo prompt get the Atomic Chat prompt on next
    launch, and the version file moves to 3; a second launch is a no-op.
  - An install that never ran any migration (no version file) goes v1 → v2 →
    v3 in one launch and ends on the same text.
  - Someone who deliberately kept "You are Jan…" or a Menlo mention as their
    prompt loses it; the product owner asked for exactly that.
  - Residual: an assistant still named `Jan` whose prompt was hand-edited to
    something without the two signatures keeps its name on disk; the web app
    still shows it as "Atomic Chat" through the in-memory rebrand for `id ==
    'jan'`. The extension's default avatar (`👋`) still differs from the web
    app's (`/images/transparent-logo.png`); the same in-memory rebrand hides it.
  - The extension now has a vitest harness (`vitest.config.ts`, `test*`
    scripts, `vitest` devDependency) and is part of `make test-extensions`.
- **Owner:** @danyurkin
- **Links:** `extensions/assistant-extension/src/index.ts`
  (`runMigrations`, `migrateJanBrandedAssistants`, `hasJanDefaultPrompt`),
  tests in `extensions/assistant-extension/src/__tests__/migrations.test.ts`,
  `web-app/src/providers/DataProvider.tsx` (in-memory rebrand of `jan`),
  upstream janhq/jan `a4f909c9d`. Related: 2026-05-19 "Product identity is
  Atomic Chat".
