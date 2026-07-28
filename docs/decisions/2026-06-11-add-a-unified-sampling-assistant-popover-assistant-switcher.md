---
date: 2026-06-11
title: "Add a unified \"Sampling — {assistant}\" popover (assistant switcher + sampling params in one place) (ATO-155)"
---

# 2026-06-11 — Add a unified "Sampling — {assistant}" popover (assistant switcher + sampling params in one place) (ATO-155)

- **Context:** Community request (Discord, @m.iko) for Jan.ai parity
  ([ATO-155](https://linear.app/atomicchat/issue/ATO-155)). In Atomic the
  surface was scattered: assistant selection was an inline **"Use Assistant"**
  submenu in [`ChatInput.tsx`](web-app/src/containers/ChatInput.tsx); sampling
  params had **no** dedicated UI (the gear-Sheet
  [`ModelSetting.tsx`](web-app/src/containers/ModelSetting.tsx) edits backend
  `model.settings` — `ctx_len`/`ngl`/… — not sampling); per-assistant params
  were only a generic key/value list in
  [`dialogs/AddEditAssistant.tsx`](web-app/src/containers/dialogs/AddEditAssistant.tsx).
  Confirmed data flow: sampling params are read from
  `useAssistant.getState().currentAssistant?.parameters` in
  [`custom-chat-transport.ts`](web-app/src/lib/custom-chat-transport.ts) and, for
  **local** backends, the whole `parameters` bag is injected verbatim into the
  request body (`{ ...body, ...parameters }` in
  [`model-factory.ts`](web-app/src/lib/model-factory.ts)); cloud providers strip
  local-only keys. `currentAssistant` is synced from the thread's first
  assistant on thread load ([`routes/threads/$threadId.tsx`](web-app/src/routes/threads/$threadId.tsx)).
- **Decision:** Build a single **`SamplerPopover`** trigger "Sampling —
  {assistant}" in the chat-input toolbar, with the assistant switcher in its
  header and sampling params in its body, writing into the assistant's
  `parameters`. Per the issue's approved scope (full Jan parity + **replace** the
  old submenu):
  1. **Schema** — rewrote
     [`web-app/src/lib/predefinedParams.ts`](web-app/src/lib/predefinedParams.ts):
     `paramsSettings` gains `controllerType` / `category` / `min` / `max` /
     `step` (backward-compatible — old consumers only read `key`/`value`/`title`);
     added `min_p` + `repeat_penalty`; new `paramCategories`, `paramGroups`
     (sampling / penalties / general), and `SAMPLING_PARAM_KEYS`. Keys map 1:1
     onto the OpenAI-compatible body keys local backends accept (the body-inject
     reality), so the popover is genuinely effective on llamacpp/llamacpp-upstream/mlx.
  2. **UI** — new
     [`ParametersSection.tsx`](web-app/src/containers/ParametersSection.tsx)
     (slider + number input per numeric param, switch for `stream`, grouped by
     category) and
     [`SamplerPopover.tsx`](web-app/src/containers/SamplerPopover.tsx) (trigger,
     header assistant dropdown, body = ParametersSection).
  3. **Persistence sync** — the popover edits the **effective** assistant
     (unsaved-chat `selectedAssistant` → thread-bound assistant → default →
     first). On a param change it calls `updateAssistant` (persists globally +
     keeps `currentAssistant` in sync so the transport picks it up immediately),
     and **only** when the assistant is bound to the current thread also calls
     `updateCurrentThreadAssistant` (avoids implicitly binding the default to a
     thread); if it's the unsaved-chat selection it mirrors back via the
     `onSelectAssistant` prop. Assistant switching reuses the old submenu logic.
  4. **ChatInput** — removed the "Use Assistant" submenu block and its now-orphan
     imports (`DropdownMenuSub*`, `IconUser`, `AvatarEmoji`) and store selectors
     (`currentThread`, `updateCurrentThreadAssistant`); rendered `<SamplerPopover>`
     in the toolbar next to `<ReasoningToggle />`, gated `!effectiveAgentMode &&
     !projectId`.
  5. **i18n** — `none` / `noAssistants` / `samplingTrigger` / `paramCategory.*`
     in [`en/assistants.json`](web-app/src/locales/en/assistants.json) +
     [`ru/assistants.json`](web-app/src/locales/ru/assistants.json); other locales
     fall back to EN.
- **Consequences:** Assistant choice + explicit sampling controls
  (temperature / top_p / top_k / min_p / penalties / repeat_penalty / stream) now
  live in one popover bound to the selected assistant; the old inline submenu is
  gone. **Caveat (unchanged, pre-existing):** sampling params reach **local**
  backends only — cloud providers still receive only the reasoning override (the
  transport strips local-only keys), so editing e.g. temperature for an OpenAI
  model is a no-op today; not addressed here. `max_output_tokens` /
  `max_context_tokens` / `auto_compact` were **deliberately not** re-added to the
  schema (they were trimmed from the Atomic `predefinedParams.ts` earlier and are
  consumed by separate transport logic, not body-injected). Scope: web-app only
  (1 rewritten lib + 2 new containers + ChatInput edit + 2 locale files); no Rust,
  IPC, schema, or persistence-shape change. **Verified:** `eslint` 0 errors on all
  four touched TS/TSX files (one pre-existing `exhaustive-deps` warning on the
  unrelated `processImageFiles` untouched); `tsc -b` clean ("No errors found");
  `ReadLints` clean.
- **Amendment (same day) — relocate the trigger into the model bar and soften
  the popover chrome.** Per UX feedback (the chat-input toolbar placement felt
  cramped, opened upward, and the controls looked bulky / too high-contrast), the
  `SamplerPopover` trigger was **moved out of `ChatInput`'s toolbar into the model
  bar** ([`DropdownModelProvider.tsx`](web-app/src/containers/DropdownModelProvider.tsx)),
  rendered inside the model pill to the right of the `ModelSupportStatus` dot,
  wrapped in a `stopPropagation` container so it doesn't open the model dropdown
  (same pattern as the inline `ModelSetting` gear). Because the trigger no longer
  lives next to `ChatInput`'s local `selectedAssistant` state, that unsaved-chat
  selection was **lifted into the `useAssistant` store** as `pendingAssistant` /
  `setPendingAssistant` ([`useAssistant.ts`](web-app/src/hooks/useAssistant.ts));
  `ChatInput` now reads/writes the store (and falls back to default → first
  assistant when binding a brand-new thread, preserving the old seed behaviour),
  and `SamplerPopover` reads the same store directly (its `selectedAssistant` /
  `onSelectAssistant` props were dropped). A new `showSampler` prop on
  `DropdownModelProvider` (default `true`) reproduces the old `!projectId` guard —
  the **project** route passes `showSampler={false}`. The old
  `!effectiveAgentMode` guard is **dropped** (the model bar has no per-thread
  agent-mode context; sampling controls now also show in agent-mode threads,
  judged acceptable). Styling: the per-param bordered number box (`Input` with
  `border` + `dark:bg-input/30` — the "harsh black") became a borderless,
  muted, `tabular-nums` value field; spacing tightened (`space-y-5/3` →
  `space-y-3/2`); category labels softened (`text-[11px] text-muted-foreground/70`);
  and the popover surface mirrors the model dropdown (`bg-background/95
  backdrop-blur-2xl p-3`) instead of the stark `bg-popover p-4`. Now at the top
  of the window, the popover opens downward into ample space (the earlier
  upward-open / overflow issues were a bottom-of-screen artefact). **Verified:**
  `tsc -b` clean (exit 0); `ReadLints` clean on all touched files.
- **Owner:** team.
- **Links:** [ATO-155](https://linear.app/atomicchat/issue/ATO-155), files:
  [`web-app/src/lib/predefinedParams.ts`](web-app/src/lib/predefinedParams.ts),
  [`web-app/src/containers/ParametersSection.tsx`](web-app/src/containers/ParametersSection.tsx),
  [`web-app/src/containers/SamplerPopover.tsx`](web-app/src/containers/SamplerPopover.tsx),
  [`web-app/src/containers/DropdownModelProvider.tsx`](web-app/src/containers/DropdownModelProvider.tsx),
  [`web-app/src/hooks/useAssistant.ts`](web-app/src/hooks/useAssistant.ts),
  [`web-app/src/containers/ChatInput.tsx`](web-app/src/containers/ChatInput.tsx),
  [`web-app/src/routes/project/$projectId.tsx`](web-app/src/routes/project/$projectId.tsx),
  [`web-app/src/locales/en/assistants.json`](web-app/src/locales/en/assistants.json),
  [`web-app/src/locales/ru/assistants.json`](web-app/src/locales/ru/assistants.json).
