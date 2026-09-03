---
date: 2026-08-14
title: "Offer a thinking level only where the chat template declares one"
---

# 2026-08-14 — Offer a thinking level only where the chat template declares one

- **Context:** The chat input had a single on/off reasoning bulb, and Settings →
  General had a "Reasoning budget" select whose value was sent as a top-level
  `reasoning_budget` field. Neither backend reads that field: llama.cpp reads
  `reasoning_budget_tokens` (alias `thinking_budget_tokens`) in
  `tools/server/server-common.cpp`, and mlx-vlm reads `thinking_budget`. The
  select was therefore a no-op for every level except `off`, which worked only
  because of the separate `chat_template_kwargs.enable_thinking: false`.
  Meanwhile users expect a Claude-style effort picker. Local models expose three
  unrelated knobs, and only a chat template says which one a model has: a named
  `reasoning_effort` (5 of the 63 reference templates in llama.cpp, each with
  its own value set — Hunyuan 3 raises on anything outside
  `no_think|low|high`), a template-rendered `thinking_budget` (Seed-OSS), or
  nothing beyond `enable_thinking` plus thinking tags, which is the common case
  (21 templates read `enable_thinking`, 29 carry thinking tags). No backend
  reports any of this over HTTP: `/props` returns the raw template and
  `chat_template_caps`, which covers tools and roles but not reasoning.
- **Decision:** Detect the knobs by parsing the model's chat template at list
  time (`detectReasoningControls` in `core/src/browser/models/reasoning.ts`,
  a port of the detector in the fork's `tools/ui`), surface the result as
  `Model.reasoning`, and show a level picker next to the bulb only for models
  that declare a thinking phase. The two controls stay separate: the bulb
  remains the only way to switch reasoning on and off, and the picker only
  chooses how hard the model thinks. One UI level on a single effort scale
  (`low|medium|high|xhigh|max`, still stored in
  `useGeneralSetting.reasoningBudget`) maps to whichever knob the model has:
  `chat_template_kwargs.reasoning_effort` for native-effort models,
  `chat_template_kwargs.thinking_budget` for template-rendered budgets, and
  `reasoning_budget_tokens` (llama.cpp) / `thinking_budget` (mlx-vlm)
  otherwise. The scale is named after effort rather than tokens — `max` is the
  model's strongest declared value, or no cap for a budget model — because
  effort is what the user is choosing; the token amounts behind it (256 / 1024
  / 4096 / 8192) are an implementation detail of the models that have no effort
  of their own. A native effort value is only ever sent if the template
  declared it: levels the model does not have are hidden, and a stale stored
  level is clamped to the nearest declared one. We do not send the OpenAI-style
  top-level `reasoning_effort` to llama.cpp, which ignores it; mlx-vlm is the
  exception and takes it top-level because its `chat_template_kwargs` reader
  only consumes `enable_thinking` and the thinking-token keys.
- **Consequences:** The level now takes effect on most thinking models instead
  of none, and the picker cannot push a value that makes a template raise.
  The cost is a second GGUF header read per model when a provider list is
  built (alongside the existing `isToolSupported` probe), and a template-text
  heuristic that will need a new pattern whenever a family invents another
  spelling — a `supports_thinking` flag on `/props` would retire it. Levels are
  global rather than per model: switching to a model that lacks the stored
  level shows the clamped one, and changing it there changes it everywhere.
  Watch for native-effort families whose legal values are neither validated by
  a `not in [...]` guard nor enumerated in a raise message; those fall back to
  `low|medium|high`, which all five known families accept.
- **Owner:** `team`
- **Links:** `core/src/browser/models/reasoning.ts`,
  `web-app/src/lib/reasoning-effort.ts`,
  `web-app/src/containers/ReasoningToggle.tsx`,
  `web-app/src/lib/custom-chat-transport.ts`,
  `extensions/{llamacpp,llamacpp-upstream,mlx}-extension/src/index.ts`
