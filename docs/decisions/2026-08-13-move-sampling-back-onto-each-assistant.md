---
date: 2026-08-13
title: "Move sampling back onto each assistant (per-assistant sampler, popover stays the only editor)"
---

# 2026-08-13 — Move sampling back onto each assistant (per-assistant sampler, popover stays the only editor)

- **Context:** Since
 [2026-06-12](2026-06-12-make-sampling-global-model-bar-popover-slim-the-assistant-to.md)
 sampling was one app-wide bag (`useSamplingSettings`, localStorage
 `sampling-settings`) and the assistant was persona-only. Users report the
 opposite expectation: switching assistant in the model-bar popover left
 `temperature`/`top_p`/`top_k`/`min_p` untouched, so a "precise" and a
 "creative" persona could not differ in anything but the system prompt.
- **Decision:** Sampling is per-assistant again, stored in
 `assistant.parameters` on disk (`assistants/{id}/assistant.json`), and the
 model-bar popover stays its only editor — no sampling UI returns to the
 assistant dialog.
 1. **Store:** [`useAssistant.ts`](../../web-app/src/hooks/useAssistant.ts)
 gains `updateAssistantParam(id, key, value)` — applies to the store
 synchronously and upserts to disk on a 300 ms per-id debounce, because a
 slider drag emits a change per frame (the global store had no disk IO).
 `updateAssistant` now also refreshes `pendingAssistant` so a selection copy
 cannot shadow fresh values.
 2. **Override flag:** new `sampling_overridden?: boolean` on the web-app
 `Assistant` type replaces the store's global `userOverridden`. It gates the
 Gemma 4 QAT recommended sampler in `withRecommendedSampling` and lives
 *outside* `parameters`, since that bag reaches the request body verbatim.
 3. **One resolver:** new
 [`samplingParams.ts`](../../web-app/src/lib/samplingParams.ts) —
 `resolveAssistantForThread(threadId)` (thread-bound -> unsaved-chat
 selection -> default -> first, always the live store record because thread
 storage keeps only an id/name/instructions snapshot) and
 `getSamplingParamsForThread`. Used by both the popover and
 [`custom-chat-transport.ts`](../../web-app/src/lib/custom-chat-transport.ts)
 (`inferenceParams` and `maxOutputTokens`), so what the sliders show is what
 the next request sends. The popover's own priority was flipped to
 thread-first to match; switching assistant on a thread rebinds the thread,
 so the visible selection is unaffected.
 4. **Migration:** one-time, guarded by `sampling-migrated-per-assistant`,
 run in [`DataProvider.tsx`](../../web-app/src/providers/DataProvider.tsx)
 right after assistants load: the old global bag is copied onto assistants
 whose `parameters` are empty and persisted; assistants that still held
 pre-2026-06-12 values keep them. `useSamplingSettings.ts` is deleted; the
 `sampling-settings` localStorage entry is left in place for rollback.
 5. New assistants are seeded with `defaultAssistant.parameters` instead of
 `{}` so the popover opens on sane values.
- **Consequences:** Personas can carry their own sampler, and switching
 assistant switches sampling — the reported expectation. Costs: sampling edits
 now hit disk (debounced), and there is no single knob that changes sampling
 for every assistant at once. The `—` (no assistant) item behaves as before —
 it falls through to the default assistant — and the built-in defaults are the
 only fallback if the assistant list is ever empty. **Supersedes** the global
 half of 2026-06-12; the rest of that record (assistant dialog carries no
 sampling, `ModelSetting` hides the legacy load-time sampling twins) stands.
- **Owner:** team.
- **Links:**
 [`web-app/src/lib/samplingParams.ts`](../../web-app/src/lib/samplingParams.ts),
 [`web-app/src/hooks/useAssistant.ts`](../../web-app/src/hooks/useAssistant.ts),
 [`web-app/src/containers/SamplerPopover.tsx`](../../web-app/src/containers/SamplerPopover.tsx),
 [`web-app/src/lib/custom-chat-transport.ts`](../../web-app/src/lib/custom-chat-transport.ts),
 [`web-app/src/providers/DataProvider.tsx`](../../web-app/src/providers/DataProvider.tsx),
 [`web-app/src/constants/localStorage.ts`](../../web-app/src/constants/localStorage.ts),
 [`web-app/src/types/threads.d.ts`](../../web-app/src/types/threads.d.ts).

<!--
Supersedes: 2026-06-12-make-sampling-global-model-bar-popover-slim-the-assistant-to.md
-->
