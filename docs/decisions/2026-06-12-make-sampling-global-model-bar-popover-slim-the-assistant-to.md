---
date: 2026-06-12
title: "Make sampling global (model-bar popover) + slim the assistant to persona-only (ATO-155 rework)"
---

# 2026-06-12 — Make sampling global (model-bar popover) + slim the assistant to persona-only (ATO-155 rework)

- **Context:** Sampling parameters (`temperature`/`top_p`/`top_k`/`min_p`/
 penalties + optional `max_output_tokens`) lived **per-assistant** in
 `assistant.parameters` and were read by `custom-chat-transport`. The same
 sampling knobs *also* had dead load-time twins under `model.settings.*`
 (surfaced in the `ModelSetting` gear), so users saw two competing places to
 set temperature and were confused about what an "assistant" even was. The
 ATO-155 Sampling popover (model bar) had been wired to edit
 `assistant.parameters`, which entangled persona and sampling.
- **Decision:** Split the two concerns cleanly.
 1. **Global sampling store** (new
 [`web-app/src/hooks/useSamplingSettings.ts`](web-app/src/hooks/useSamplingSettings.ts)):
 Zustand + `persist` (new key `sampling-settings` in
 [`localStorage.ts`](web-app/src/constants/localStorage.ts)), holding one
 app-wide `params` bag. Seeded once from `defaultAssistant.parameters` so the
 historical defaults (`temperature 0.7`, `top_k 20`, `top_p 0.8`,
 `repeat_penalty 1.12`) survive the move; only keys actually present are sent,
 so untouched params keep the backend default (no behavior change).
 2. **Transport reads the global store**
 ([`custom-chat-transport.ts`](web-app/src/lib/custom-chat-transport.ts)):
 `inferenceParams` and `maxOutputTokens` now come from
 `useSamplingSettings.getState().getParams()` instead of
 `currentAssistant.parameters`. `currentAssistant` remains the
 system-prompt/identity source (instructions path untouched).
 3. **Popover** ([`SamplerPopover.tsx`](web-app/src/containers/SamplerPopover.tsx)):
 Sampling section now reads/writes the global store; added a **Context**
 section editing the current model's `ctx_len` (`model.settings.ctx_len`),
 persisted via `updateProvider` and applied to a *running* model via a
 debounced `stopModel`+`startModel` (mirrors `ModelSetting`'s restart). Takes
 `model` + `provider` props from
 [`DropdownModelProvider.tsx`](web-app/src/containers/DropdownModelProvider.tsx).
 The assistant switcher stays (persona selection for a new chat) but no longer
 carries sampling.
 4. **Assistant editor**
 ([`AddEditAssistant.tsx`](web-app/src/containers/dialogs/AddEditAssistant.tsx)):
 stripped the Settings header, predefined-param chips, and dynamic
 key/type/value rows — only emoji/name/description/instructions remain. On
 save, existing on-disk `parameters` are **preserved untouched** (vestigial,
 default `{}` for new assistants) — migrations unaffected.
 5. **Gear de-dup** ([`ModelSetting.tsx`](web-app/src/containers/ModelSetting.tsx)):
 a `LEGACY_SAMPLING_KEYS` block-list hides the load-time sampling twins
 (`temperature`/`top_p`/`top_k`/`min_p`/`repeat_penalty`/`repeat_last_n`/
 `presence_penalty`/`frequency_penalty`) from the gear UI. The gear stays the
 editor for genuine load-time/engine settings (`ctx_len`, `ngl`,
 `chat_template`, `batch_size`, `cpu_moe`, mmproj, …). Persisted
 `model.settings.*` values are left on disk (only hidden).
- **Consequences:** Exactly one place to tune sampling (the popover); the
 assistant is now unambiguously persona-only. Context size is editable inline
 and restarts a running model only on `ctx_len` change (sampling never
 restarts — applied per-request). **Deliberately not done:** per-family
 recommended sampling (ATO-99); deleting `assistant.parameters` or the
 `model.settings.*` sampling twins from disk (kept for rollback/migration).
 **Verified:** `ReadLints` clean, `eslint` clean, `tsc -b` clean on all
 touched files.
- **Owner:** team.
- **Links:** [ATO-155](https://linear.app/atomicchat/issue/ATO-155), files:
 [`web-app/src/hooks/useSamplingSettings.ts`](web-app/src/hooks/useSamplingSettings.ts),
 [`web-app/src/lib/custom-chat-transport.ts`](web-app/src/lib/custom-chat-transport.ts),
 [`web-app/src/containers/SamplerPopover.tsx`](web-app/src/containers/SamplerPopover.tsx),
 [`web-app/src/containers/DropdownModelProvider.tsx`](web-app/src/containers/DropdownModelProvider.tsx),
 [`web-app/src/containers/dialogs/AddEditAssistant.tsx`](web-app/src/containers/dialogs/AddEditAssistant.tsx),
 [`web-app/src/containers/ModelSetting.tsx`](web-app/src/containers/ModelSetting.tsx),
 [`web-app/src/constants/localStorage.ts`](web-app/src/constants/localStorage.ts).

---
