---
date: 2026-06-09
title: "Default the macOS local llama.cpp engine to `llamacpp-upstream` so the Recommended Gemma 4 vision model loads out of the box (ATO-116)"
---

# 2026-06-09 — Default the macOS local llama.cpp engine to `llamacpp-upstream` so the Recommended Gemma 4 vision model loads out of the box (ATO-116)

- **Context:** On macOS the default local engine was the **TurboQuant fork**
  (`llamacpp`), not vanilla upstream. The Hub "Recommended" model
  `unsloth/gemma-4-12b-it-IQ4_XS` (vision, ships an `mmproj.gguf`) downloaded
  into and started on TurboQuant, which can't parse Gemma 4's unified
  multimodal projector `gemma4uv` (the fork carries only `gemma4v`/`gemma4a`;
  upstream `b9562` has the full set). The load crashed entirely and the UI
  showed only `[object Object]` ([ATO-116](https://linear.app/atomicchat/issue/ATO-116);
  the `[object Object]` rendering is its own ticket, [ATO-117](https://linear.app/atomicchat/issue/ATO-117)).
  Switching the model's engine to `llamacpp-upstream` made it load fine. So
  **out of the box on macOS the Recommended model crashed with an opaque
  error.** Confirmed root cause in code (branch `main`): `LOCAL_LLAMACPP_PROVIDER`
  resolved to `llamacpp` on macOS (`web-app/src/lib/utils.ts`), `pullModel()`
  routes downloads through it, and `getModelToStart.ts` tried `llamacpp` first.
- **Decision (per the ticket's accepted resolution):** Make the **default**
  local engine `llamacpp-upstream` on macOS too; keep TurboQuant available as
  an explicit manual choice (do **not** remove it, do **not** migrate existing
  models). Three edits:
  1. [`web-app/src/lib/utils.ts`](web-app/src/lib/utils.ts): `LOCAL_LLAMACPP_PROVIDER`
     and its mirror `LOCAL_LLAMACPP_EXTENSION_NAME` are now unconditionally
     `'llamacpp-upstream'` / `'@janhq/llamacpp-upstream-extension'` (previously
     `IS_WINDOWS || IS_LINUX ? upstream : turboquant`). Both flip together so
     downloads, model start, onboarding (`SetupBackendStep`), the backend
     updater, and the hardware probe all resolve the **same** engine — leaving
     the provider on upstream while the extension stayed on turboquant would
     make onboarding fetch the turboquant backend under an upstream-routed
     model.
  2. [`web-app/src/utils/getModelToStart.ts`](web-app/src/utils/getModelToStart.ts):
     start order `['llamacpp-upstream', 'llamacpp', 'mlx']` (upstream first).
  3. The session's earlier text-only fallback in the TurboQuant pair (ADR
     below) stays as **complementary defense-in-depth** for users whose models
     already live under `engine: llamacpp`.
- **Consequences:**
  - Fresh macOS installs download + start the Recommended Gemma 4 vision model
    on upstream, which supports `gemma4uv`/`gemma4ua`, so **vision works out of
    the box** (the text-only fallback degrades; this flip keeps vision).
  - **Backwards-compatible, by the ticket's explicit constraints.** Only the
    default for fresh downloads / empty state changes. Existing models stay in
    `data/llamacpp/models/` with `engine: llamacpp` and keep running on
    TurboQuant; a user's explicitly-selected `selectedProvider` (zustand-persist)
    is preserved. **No** forced `engine` migration and **no** macOS runtime
    alias — the `llamacpp → llamacpp-upstream` alias + v13 purge in
    `useModelProvider.ts` remain `IS_WINDOWS`-gated, so macOS threads /
    `lastUsedModel` bound to `llamacpp` are untouched (copying the Windows
    approach would hang them).
  - TurboQuant remains a first-class manual provider on macOS (turbo3 KV-cache
    memory savings); `getProviderTitle('llamacpp')` still renders "Atomic
    Llama.cpp Turboquant" on macOS.
  - **Rejected alternatives** (per ticket): TurboQuant-default + auto-fallback
    to upstream on load failure (leaves first run failing); route vision→upstream
    / text→TurboQuant (needs projector-type detection, fragile on new archs);
    forced model migration (risks hanging others' threads, removes user choice).
  - Scope: web-app only; no Rust, IPC, on-disk layout, or settings-schema
    change. `IS_WINDOWS`/`IS_LINUX` are still used elsewhere in `utils.ts`
    (`getProviderTitle`), so no dead globals. Lint-clean; the
    `models.windowsProviderRouting` suite (4 tests) passes; no test asserted
    the old macOS default.
  - **`[object Object]` (ATO-117) not fixed here** — that's the generic
    load-error rendering in `llamacpp-extension`; this ADR just stops the
    Recommended model from reaching the crash path on a fresh install.
- **Owner:** team.
- **Links:** [ATO-116](https://linear.app/atomicchat/issue/ATO-116),
  [ATO-117](https://linear.app/atomicchat/issue/ATO-117), the same-day ADR
  *Text-only fallback in the TurboQuant `llamacpp` provider …* (below), the
  2026-05-22 ADR *Windows ships only `llamacpp-upstream`*, the 2026-05-19 ADR
  *Ship upstream `ggml-org/llama.cpp` as a second macOS provider*, files:
  [`web-app/src/lib/utils.ts`](web-app/src/lib/utils.ts)
  (`LOCAL_LLAMACPP_PROVIDER`, `LOCAL_LLAMACPP_EXTENSION_NAME`),
  [`web-app/src/utils/getModelToStart.ts`](web-app/src/utils/getModelToStart.ts).
