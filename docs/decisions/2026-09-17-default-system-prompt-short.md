---
date: 2026-09-17
title: 'Use a short default assistant prompt and migrate only exact defaults'
---

# 2026-09-17 — Use a short default assistant prompt and migrate only exact defaults

- **Context:** The assistant extension seeded a 1,231-character prompt that required tool use and lengthy reasoning narration, while the frontend fallback contained only a date. Migrations v1–v3 used prefix or substring matches that could overwrite customized instructions. The previous Jan migration test used a truncated historical prompt.
- **Decision:** Use `You are Atomic Chat, a helpful AI assistant.` followed by a blank line and `Current date: {{current_date}}` for both fresh-install paths. Migration v4 supersedes v1–v3 and replaces only complete strings matching verified historical app defaults, including their known v1 branding transformations and the frontend date-only fallback. Preserve custom whitespace, appended instructions, brand mentions, empty/missing instructions, sampling and other assistant fields. Keep the existing Jan name/description migration only for exact stock metadata on matching prompts.
- **Consequences:** Upgrades from any earlier migration version converge on the short prompt. Unknown historical variants remain untouched; previously overwritten custom text cannot be recovered. Historical strings are frozen in the extension and independently captured in test fixtures. No runtime dependency, locale key or API contract changes. Assistant write failures leave the migration version unchanged for retry.
- **Owner:** team.
- **Links:** [Assistant extension](../../extensions/assistant-extension/src/index.ts), [historical defaults](../../extensions/assistant-extension/src/legacy-default-instructions.ts), [frontend fallback](../../web-app/src/hooks/useAssistant.ts), [migration tests](../../extensions/assistant-extension/src/__tests__/migrations.test.ts).

<!--
Supersedes: 2026-09-16-migrate-jan-branded-assistant-prompts.md
-->
