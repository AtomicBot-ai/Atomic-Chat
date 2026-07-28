---
date: 2026-06-15
title: "Stop \"Find optimal backend\" from silently degrading to CPU when the ggml-org release stream is unreachable (ATO-161) + de-hardcode the Windows CUDA minor to a family id (ATO-174)"
---

# 2026-06-15 — Stop "Find optimal backend" from silently degrading to CPU when the ggml-org release stream is unreachable (ATO-161) + de-hardcode the Windows CUDA minor to a family id (ATO-174)

- **Context:** Two coupled `llamacpp-upstream` defects around the
 GitHub-hosted backend release stream
 (`api.github.com/repos/ggml-org/llama.cpp/releases`).
 - **[ATO-161](https://linear.app/atomicchat/issue/ATO-161):**
 `detectIdealBackendType()` returned `string | null`, conflating two very
 different outcomes in the single `null`: "CPU is genuinely the best this
 hardware can do" **and** "I couldn't fetch the GPU options because the
 release stream was unreachable / slow / rate-limited". `recheckOptimalBackend()`
 logged the merged *"CPU is optimal or detection failed"* and returned
 `null`; the "Find optimal backend" handler
 ([`$providerName.tsx`](web-app/src/routes/settings/providers/$providerName.tsx))
 then showed the reassuring **"You're already on the optimal backend"**
 toast. Net effect on a GPU-capable host with a flaky/blocked GitHub: the
 app silently stayed on (or implied) CPU and *told the user that was
 optimal* — actively misleading.
 - **[ATO-174](https://linear.app/atomicchat/issue/ATO-174):** the manual
 backend dropdown's `staticVariants` hard-coded concrete Windows CUDA
 minors (`win-cuda-12.4-x64`, `win-cuda-13.3-x64`), and
 `resolveLatestBackendString` / `newestInstalledOfFamily` matched the
 selected id against published assets by **exact string**. ggml-org bumps
 the CUDA minor over time (`13.3 → 13.4 → …`); the next bump would make the
 hard-coded sentinel exact-match nothing → `latest/win-cuda-13.3-x64`
 resolves to no asset → dead-end. Manual CUDA selection also surfaced only a
 generic failure when `api.github.com` was unreachable, with no offline path
 and no actionable guidance. This finishes the 2026-06-08 ATO-105 work
 (which already made the *detection* path family-aware but left the manual
 dropdown + resolvers on hard-coded minors).
- **Decision:** Web-app + extension only; no Rust, IPC, on-disk layout, or
 settings-schema change.
 1. **ATO-161 — discriminated detection result.** New
 `IdealBackendResult = { kind: 'gpu'; backend } | { kind: 'cpu-optimal' } |
 { kind: 'detection-failed' }` and an exported `BACKEND_DETECTION_FAILED`
 sentinel in
 [`index.ts`](extensions/llamacpp-upstream-extension/src/index.ts).
 `detectIdealBackendType()` now returns this union instead of
 `string | null`: a picked GPU tier → `{ kind: 'gpu', backend }`; a
 **GPU-capable** host (driver/feature gate says CUDA/Vulkan usable) with
 **no** GPU backend anywhere in the merged local+remote catalog → `{ kind:
 'detection-failed' }` (ggml-org *always* publishes CUDA+Vulkan Windows
 assets, so an empty GPU catalog means `fetchRemoteBackends()` returned `[]`
 — a fetch failure, not "CPU is best"); the `catch` and the genuine
 no-GPU-hardware paths → `{ kind: 'cpu-optimal' }`. Linux's non-GPU outcome
 stays `cpu-optimal` (its Vulkan recommend is a pure local libvulkan probe,
 no network). `recheckOptimalBackend()` wraps detection in the existing
 20 s `withTimeout` (timeout → `detection-failed`), **throws
 `Error(BACKEND_DETECTION_FAILED)`** on failure, and returns `null` only for
 real `cpu-optimal`/already-optimal. Its outer `catch` re-throws the
 sentinel and still swallows every *other* error to `null` (onboarding must
 not regress). All three callers handle the throw:
 [`$providerName.tsx`](web-app/src/routes/settings/providers/$providerName.tsx)
 → distinct `backendUpdater.detectionUnavailable` toast (not "already
 optimal"); [`SetupBackendStep.tsx`](web-app/src/containers/SetupBackendStep.tsx)
 → its existing `detection-failed` phase (CPU stays a usable fallback,
 onboarding advances); the `useBackendUpdater` post-upgrade auto-recheck →
 warn-and-continue.
 2. **ATO-174 — family-id resolution.** `staticVariants` (Windows) now lists
 the minor-less family ids `win-cuda-12-x64` / `win-cuda-13-x64` (the
 dropdown renders them as "Latest CUDA 12 / CUDA 13" via the existing
 `friendlyBackendLabel`). Three pure helpers in
 [`backend.ts`](extensions/llamacpp-upstream-extension/src/backend.ts) —
 `cudaFamilyMajor`, `isConcreteOfCudaFamily`, `resolveCudaFamilyConcrete`
 (picks the **highest** published minor of a major). `resolveLatestBackendString`
 falls back to `resolveCudaFamilyConcrete` when the exact id isn't a
 published asset (so `latest/win-cuda-13-x64` → `b____/win-cuda-13.<newest>-x64`
 across minor bumps); `newestInstalledOfFamily` matches a family id against
 any installed concrete minor (offline fallback returns the **concrete**
 installed id, never the family id, which would 404). `downloadManualBackend`'s
 dead-end now throws an actionable message naming `api.github.com` and
 pointing at Settings → Proxy / "Install backend from file" instead of a
 bare failure. The `detectIdealBackendType` Windows CUDA-13 picker was
 already family-aware (`^win-cuda-13\.\d+-`) from ATO-105 and is untouched;
 CUDA-12 stays `12.4` (the only 12.x ggml-org ships).
 3. **i18n:** new `backendUpdater.detectionUnavailable` (EN + RU); other
 locales fall back to EN.
- **Consequences:** A GPU-capable user with blocked/slow GitHub now sees a
 calm, accurate *"couldn't reach the release stream — keeping your current
 backend, check connection/proxy"* instead of a false "already optimal", and
 is never silently parked on CPU. Manual CUDA selection survives future
 ggml-org minor bumps and degrades to the newest locally-installed CUDA copy
 when offline. **Trade-off / lossy by design:** `detection-failed` is
 *inferred* on Windows from "GPU-capable + empty GPU catalog" rather than a
 first-class network-error signal threaded up from `fetchRemoteBackends()`
 — a rare false-positive is possible if a GPU-capable host legitimately has
 zero GPU assets for some other reason, but ggml-org's release matrix makes
 that practically impossible. Broader network resilience (retries, response
 caching, authenticated requests, a server-side mirror) was **deliberately
 deferred** — out of this slice. **Verified:** rolldown build clean
 (`dist/index.js` 213.53 kB, exit 0 — the authoritative extension compile;
 standalone `tsc --noEmit` noise from missing ambient base-class globals is
 pre-existing and not introduced here); web-app `tsc -b` clean; `eslint`
 clean on `$providerName.tsx`; both locale JSONs parse; all three
 `recheckOptimalBackend` call sites confirmed to handle the new sentinel.
- **Owner:** team.
- **Links:** [ATO-161](https://linear.app/atomicchat/issue/ATO-161),
 [ATO-174](https://linear.app/atomicchat/issue/ATO-174),
 [ATO-105](https://linear.app/atomicchat/issue/ATO-105),
 [ATO-95](https://linear.app/atomicchat/issue/ATO-95), the 2026-06-08 ADR
 *Windows: fix clean-install config persistence (ATO-107), de-hardcode the
 CUDA-13 minor (ATO-105) …* and the 2026-06-05 ADR *Resolve the
 `latest/<backend>` sentinel …*, files:
 [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)
 (`IdealBackendResult`, `BACKEND_DETECTION_FAILED`, `detectIdealBackendType`,
 `recheckOptimalBackend`, `resolveLatestBackendString`,
 `newestInstalledOfFamily`, `downloadManualBackend`, `staticVariants`),
 [`extensions/llamacpp-upstream-extension/src/backend.ts`](extensions/llamacpp-upstream-extension/src/backend.ts)
 (`cudaFamilyMajor`, `isConcreteOfCudaFamily`, `resolveCudaFamilyConcrete`),
 [`web-app/src/routes/settings/providers/$providerName.tsx`](web-app/src/routes/settings/providers/$providerName.tsx)
 (`handleFindOptimalBackend` catch),
 [`web-app/src/containers/SetupBackendStep.tsx`](web-app/src/containers/SetupBackendStep.tsx),
 [`web-app/src/locales/en/settings.json`](web-app/src/locales/en/settings.json),
 [`web-app/src/locales/ru/settings.json`](web-app/src/locales/ru/settings.json).
