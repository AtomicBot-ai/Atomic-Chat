---
date: 2026-08-07
title: "Let onboarding time out into the chat and recommend two GGUF models"
---

# 2026-08-07 — Let onboarding time out into the chat and recommend two GGUF models

- **Context:** the model step of onboarding was a full-viewport screen (`h-svh`
  plus `HeaderPage hideControls`) rendered with the sidebar collapsed, and the
  only way out was the Skip link or starting a multi-gigabyte download. A user
  who neither wanted to download nor noticed the small Skip link had no way
  into the app, and the sidebar only appeared after they got out. The
  recommendation list also differed per platform (MLX entries on macOS, a Llama
  fallback on Windows/Linux) and per source: the remote manifest listed six
  models while the bundled baseline listed a different six, so the very first
  launch showed something other than what the manifest said.

- **Decision:** the model step now renders inside the chat area (`h-full`, full
  header controls) with the sidebar opened on entry, and auto-exits into an
  empty chat after 15 seconds of inactivity. Both ways of leaving empty-handed
  — Skip and the timeout — go through one `leaveWithoutModel(reason)` path that
  arms a persisted reminder; a bottom-right popup then offers
  `AtomicChat/Qwen3.5-4B-GGUF` at `q4_k_m`. Onboarding recommends exactly two
  GGUF models on every desktop platform: `AtomicChat/Qwen3.5-4B-GGUF` and
  `unsloth/gemma-4-E2B-it-GGUF`.

- **Consequences:**
  - Onboarding can no longer trap the user, and the sidebar is in place before
    they reach the chat. The timeout is disarmed while a local import is in
    flight so a slow `engine.import` is never cut short.
  - Picking a model keeps its existing route (`handleImportedId` /
    `enterChatForDownload`) and does not arm the reminder, so the popup only
    ever appears to users who left with nothing.
  - `isOnboardingPending` is now the single gate for both the route and the
    startup backend coordinator, and the persisted `setupCompleted` flag
    short-circuits it first. `FORCE_ONBOARDING` therefore decides only whether
    onboarding is *entered* despite installed models, never whether it can be
    *left*: previously the flag pinned `SetupScreen` in place, which made the
    auto-exit, the chat handoff and the reminder unreachable in the very build
    meant for exercising them. `resetForcedOnboardingRun()` in `main.tsx` drops
    the flag once per launch so `make dev-onboarding` still replays the whole
    flow, and no factory reset is needed to test any part of it.
  - Entering the model step forces a registry refresh past the one-hour cache.
    Everywhere else the cache is the right trade-off, but onboarding is the one
    screen whose entire content *is* the recommendation list, and the loader
    serves a fresh cache without any network call — so a cache written before a
    manifest change kept offering models the manifest no longer listed, with no
    way out but waiting out the TTL. The store keeps the previous list while the
    forced fetch is in flight and falls back on its own when it fails, so the
    screen never renders empty and nothing has to be awaited.
  - The reminder's "already have it" check looks at local providers only.
    Scanning every provider let any cloud catalog that happens to list a
    Qwen3.5 4B id silently suppress the popup for a user with nothing on disk.
  - The version-pinned `PromptJanModel` / `useJanModelPrompt` pair is gone. Its
    gate was self-contradictory (`!isOnSetupScreen && !setupCompleted`) and it
    offered a third-party Qwen distill under `VERSION.startsWith('0.7.6')`. The
    replacement is triggered by an explicit event rather than inferred from
    provider state, and `localStorage` moves from
    `jan-model-prompt-dismissed` to `atomic-onboarding-model-reminder`.
  - `platforms` filtering stays in the loader and the MLX defense-in-depth check
    stays in `useResolvedRecommendedModels`; no entry uses either today, but the
    manifest contract is unchanged. MLX models are still reachable through Hub.
  - `RECOMMENDED_MODEL_FALLBACKS` still snapshots the older imatrix repos for
    offline Hub model pages, so the two onboarding entries resolve through the
    Hugging Face API on first launch. Hub staff picks are untouched.
  - The `recommended-models.json` fixture now runs ahead of the pinned
    `atomic-chat-conf` revision; refresh the revision in
    `tests/fixtures/registries/sources.json` once the manifest lands on `main`.

- **Owner:** `team`

- **Links:**
  - [`web-app/src/containers/SetupScreen.tsx`](../../web-app/src/containers/SetupScreen.tsx)
  - [`web-app/src/containers/PromptOnboardingModel.tsx`](../../web-app/src/containers/PromptOnboardingModel.tsx)
  - [`web-app/src/hooks/useOnboardingModelReminder.ts`](../../web-app/src/hooks/useOnboardingModelReminder.ts)
  - [`web-app/src/lib/onboarding.ts`](../../web-app/src/lib/onboarding.ts)
  - [`web-app/src/constants/models.ts`](../../web-app/src/constants/models.ts)
  - `atomic-chat-conf/models/recommended.json`
  - [2026-08-06 — Serve Hub staff picks from a separate manifest](2026-08-06-serve-hub-staff-picks-from-a-separate-manifest-and-split-view.md)
