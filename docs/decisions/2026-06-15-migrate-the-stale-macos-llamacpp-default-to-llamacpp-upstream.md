---
date: 2026-06-15
title: "Migrate the stale macOS `llamacpp` default to `llamacpp-upstream` for pre-ATO-116 profiles (ATO-136)"
---

# 2026-06-15 — Migrate the stale macOS `llamacpp` default to `llamacpp-upstream` for pre-ATO-116 profiles (ATO-136)

- **Context:** ADR 2026-06-09 *Default the macOS local llama.cpp engine to
  `llamacpp-upstream`* (ATO-116) made upstream the default so the Recommended
  Gemma 4 vision model loads out of the box. A user on the built v1.1.106
  reported it "not effective": freshly downloaded GGUFs on macOS still ran on
  the turboquant fork (`llamacpp`), crashing on new archs (gemma4uv / lfm2moe).
  Investigation ([ATO-136](https://linear.app/atomicchat/issue/ATO-136))
  showed the reporter's "proof" (models living in `data/llamacpp/models/`,
  `data/llamacpp-upstream/models/` empty) is a **false signal** — both
  providers deliberately share the on-disk GGUF tree
  (`MODELS_PROVIDER_ROOT='llamacpp'` in
  [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)),
  so an upstream import lands there too. The **real** cause: ATO-116 only
  flipped the *constants* (`LOCAL_LLAMACPP_PROVIDER='llamacpp-upstream'`,
  `getModelToStart` order) and deliberately left the persisted-state
  migration `IS_WINDOWS`-gated (to avoid the macOS "hanging-thread" risk it
  documented). So a **pre-ATO-116 macOS profile** keeps `selectedProvider:
  'llamacpp'` in the zustand `model-provider` store *and* `{ provider:
  'llamacpp' }` in the non-zustand `lastUsedModel` localStorage blob; both
  validate fine on macOS (the turboquant provider still ships) and drive
  `DataProvider` auto-start + the model-bar default back onto turboquant.
  Fresh installs were unaffected (they start at the new default); only
  upgraded users were stuck.
- **Decision:** Move only the **global default selection** off turboquant on
  macOS, in two coordinated one-shot migrations — explicitly *not* removing
  the turboquant `llamacpp` provider (still a valid manual choice on macOS)
  and *not* touching per-thread bindings (so the ADR 2026-06-09 "don't hang
  existing threads" constraint holds). This reverses only the *default*
  clause of the `IS_WINDOWS` gate, not the whole gate.
  1. **zustand `selectedProvider`** ([`useModelProvider.ts`](web-app/src/hooks/useModelProvider.ts)):
     persist `version` bumped `13 → 14`; new `migrate` block redirects
     `selectedProvider 'llamacpp' → LOCAL_LLAMACPP_PROVIDER` when `version <=
     13 && IS_MACOS`. `selectedModel` is intentionally left untouched —
     `setProviders` re-resolves it against the upstream provider's copy of the
     same shared-tree model on first paint (same mechanism the v13 Windows
     block relies on). The version bump is required because v1.1.106 already
     persists `version: 13`, so a one-time edit to the v13 block alone would
     never re-run for those users.
  2. **`lastUsedModel` localStorage blob** (NEW
     [`web-app/src/lib/macosLlamacppDefaultMigration.ts`](web-app/src/lib/macosLlamacppDefaultMigration.ts)):
     mirrors the Windows sibling
     [`windowsProviderMigration.ts`](web-app/src/lib/windowsProviderMigration.ts)
     (shared `{ provider, model }` rewrite shape, one-shot flag
     `atomic_macos_llamacpp_default_to_upstream_v1`, non-fatal try/catch) but
     macOS-gated and trimmed to just the `lastUsedModel` rewrite (no Windows
     optimal-backend recheck). Called from
     [`main.tsx`](web-app/src/main.tsx) right after
     `runWindowsLlamacppProviderMigration()`, *before* React mounts, so the
     first `DataProvider` auto-start reads the upstream provider.
- **Consequences:** Upgraded macOS users now auto-start / default GGUFs on
  `llamacpp-upstream` (a superset of turboquant that handles the new archs),
  fixing the ATO-136 crash-on-load without re-downloading or re-importing
  models. **Trade-off:** a macOS user who *deliberately* selected turboquant
  before this build is redirected to upstream **once** and must re-select
  turboquant if they want it — accepted, matching the Windows v13 redirect's
  behaviour and the "turboquant is a manual/advanced choice" framing. Scope:
  web-app only (1 store migration + 1 new lib module + 1 `main.tsx` call); no
  Rust, IPC, on-disk layout, or settings-schema change; Windows/Linux are
  no-ops (the new module early-returns on `!IS_MACOS`, the v14 block on
  `!IS_MACOS`). **Verified:** `tsc -b` clean (exit 0); `eslint` clean on the
  three touched/new files.
- **Owner:** team.
- **Links:** [ATO-136](https://linear.app/atomicchat/issue/ATO-136),
  [ATO-116](https://linear.app/atomicchat/issue/ATO-116), the 2026-06-09 ADR
  *Default the macOS local llama.cpp engine to `llamacpp-upstream`*, the
  2026-05-22 ADR *Windows ships only `llamacpp-upstream`*, files:
  [`web-app/src/hooks/useModelProvider.ts`](web-app/src/hooks/useModelProvider.ts)
  (v14 migrate block),
  [`web-app/src/lib/macosLlamacppDefaultMigration.ts`](web-app/src/lib/macosLlamacppDefaultMigration.ts),
  [`web-app/src/main.tsx`](web-app/src/main.tsx),
  [`web-app/src/lib/windowsProviderMigration.ts`](web-app/src/lib/windowsProviderMigration.ts)
  (mirrored pattern).
