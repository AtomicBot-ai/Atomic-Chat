---
date: 2026-09-17
title: 'Describe collapsed tool calls with localized human actions'
---

# 2026-09-17 — Describe collapsed tool calls with localized human actions

- **Context:** Collapsed activity rows exposed internal tool IDs and full local paths. Long IDs could push the disclosure outside the message at supported interface font sizes.
- **Decision:** Derive a localized action from the tool name, presentation and state. File writes show a basename and immediate readable folder; reads show a basename. List/glob, folder creation and commands use concise actions. Web search/fetch retain query or hostname context. Unknown tools use a humanized presentation title with a localized state. Collapse errors to the action's failure or denied state; retain tool IDs, raw errors and parameters inside the disclosure.
- **Consequences:** A single shrinking, ellipsized label handles long filenames and translations. The full friendly label is available to screen readers and in the tooltip, with result counts as an accessible description. Standard home folder names are localized; other immediate folder names preserve workspace context without revealing path prefixes. Only English locale keys are added, using existing locale fallback. Tool execution and stored presentations are unchanged.
- **Owner:** team.
- **Links:** `web-app/src/lib/tools/activity-label.ts`; `web-app/src/components/ai-elements/tools/tool-renderer.tsx`.

Supersedes the collapsed row copy policy in [2026-09-15 — Show every tool call as its own line](2026-09-15-show-every-tool-call-as-its-own-line.md). The one-row-per-call disclosure structure remains.
