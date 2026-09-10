---
date: 2026-06-09
title: "Extend the PostHog telemetry channel with hardware super-properties, model download/load events, and an api_server_request error breakdown (ATO-108: ATO-111 + ATO-109 + ATO-112)"
---

# 2026-06-09 — Extend the PostHog telemetry channel with hardware super-properties, model download/load events, and an api_server_request error breakdown (ATO-108: ATO-111 + ATO-109 + ATO-112)

- **Context:** The only product-analytics surface was the single Rust-emitted
  `analytics://api_server_request` event (forwarded to PostHog by
  [`AnalyticProvider.tsx`](web-app/src/providers/AnalyticProvider.tsx)), whose
  super-properties were just `app_version` + `platform`, plus four ad-hoc
  web-app `posthog.capture` sites. Triage of crashes / load failures /
  download failures had no hardware context, no model-lifecycle events, and the
  api_server_request stream was both noisy (model-list / metrics / 404 polling)
  and lossy (every upstream failure collapsed to a single `error_kind:"upstream"`
  with the model's own HTTP status discarded). [ATO-108](https://linear.app/atomicchat/issue/ATO-108)
  scoped the fix to **PostHog only** — Sentry (ATO-110/113) explicitly deferred,
  ATO-114 cancelled, ATO-115 (hosted) out of scope.
- **Decision:** Three PostHog-only workstreams, all under a single PII rule
  (**only enum / id / number / `*_bucket` / bool / sanitized string** — never
  prompts, file paths, usernames, HF/API tokens, `base_url`, GPU serials, or
  `GpuInfo.uuid`). RAM/VRAM bucketed when surfaced.
  1. **Shared helpers** — new
     [`web-app/src/lib/telemetry.ts`](web-app/src/lib/telemetry.ts) centralizes
     all classification/sanitization: `quantFromModelId`, `sizeBucket`,
     `classifyDownloadFailure`/`parseHttpStatus`, `downloadKind`, `oomSubtype`,
     `mmprojProjectorType`, `scrubPii`/`sanitizeStderrTail`, `urlHost`/`isHfUrl`,
     `mapGpuVendor`, `cpuAvxLevel`, `loadBackendFromProvider`, and a
     download-dedup trio (`markDownloadStart` / `takeDownloadDuration` /
     `finalizeDownloadOnce`).
  2. **ATO-111 — hardware super-properties.**
     [`AnalyticProvider.tsx`](web-app/src/providers/AnalyticProvider.tsx)
     now `register()`s OS/arch/`cpu_avx`/RAM/GPU(vendor,model,VRAM,driver,
     CUDA-cc,Vulkan)/active+recommended-backend before `capture('app_opened')`
     (each probe wrapped in `withTimeout` so startup isn't blocked; the slow
     `getLlamacppDevices()` `device_parse_ok` probe is detached and registered
     onto later events since super-props persist in localStorage). A new
     optional Rust command `get_installer_type`
     ([`commands.rs`](src-tauri/src/core/system/commands.rs), registered in
     [`lib.rs`](src-tauri/src/lib.rs), surfaced via the `AppService` layer
     `getInstallerType()`) returns `appimage` (Linux `APPIMAGE` env) /
     `msi`|`setup_exe` (Windows uninstall-registry heuristic) / `dmg` (macOS
     best-effort) / `unknown`.
  3. **ATO-109 — `model_download` + `model_load`.** `model_download` `started`
     fires in [`services/models/default.ts`](web-app/src/services/models/default.ts)
     `pullModelWithMetadata`; terminal `completed`/`failed`/`cancelled` fire in
     [`DownloadManegement.tsx`](web-app/src/containers/DownloadManegement.tsx)
     listeners, deduped via `finalizeDownloadOnce` and timed via the
     `markDownloadStart`/`takeDownloadDuration` Map. `model_load`
     (success/failed, local engines only) fires in
     [`switchModel.ts`](web-app/src/utils/switchModel.ts) around `startModel`,
     carrying `backend`/`backend_version`/`ctx`/`n_gpu_layers`/`is_multimodal`/
     `device_used`/`load_duration_ms` on success and
     `error_code`/`oom_subtype`/`mmproj_projector_type`/sanitized `stderr_tail`
     on failure.
  4. **ATO-112 — api_server_request noise + breakdown** (Rust
     [`proxy.rs`](src-tauri/src/core/server/proxy.rs) + types in
     [`analytics.ts`](web-app/src/types/analytics.ts)). `skip_emit=true` added
     for `GET /models` and the catch-all 404 (`endpoint=other`). The single
     `error_kind:"upstream"` is split at every emission site by `state.backend`
     into `local_model_error` / `local_model_unreachable` /
     `remote_provider_error` / `proxy_internal` (helpers `is_local_backend`,
     `upstream_error_kind`, `unreachable_error_kind`). New `EmitState` /
     `ApiRequestEvent` fields `upstream_status` (the model's/provider's own
     status, previously discarded), `oom_detected` (new `body_indicates_oom`
     heuristic), `ctx_overflow_detected` (reuses `is_context_limit_error`), and
     `server_bind_failed` — the last emitted as a dedicated one-off event from
     the `start_server_internal` bind-error arm (it can't ride a real request).
     TS `analytics.ts` updated: new `error_kind` union, `'responses'`/`'metrics'`
     endpoints, `BIND` method, `llamacpp-upstream`/`''` backends, optional
     breakdown fields.
- **Consequences:**
  - Crash/load/download triage now has device context + lifecycle events;
    api_server_request is lower-volume and its failures are attributable to
    local-model vs remote-provider vs proxy-internal with the upstream status
    preserved. All payloads remain PII-free by construction (single helper
    module).
  - **Stringly-typed download errors are classified in web-app**, not via a Rust
    download-core refactor (deliberate, minimally invasive — a structural
    `failure_reason` from Rust is a possible later hardening). `cuda_runtime_version`
    is best-effort (supported-features + compute-capability), exact string
    deferred. `installer_type` on macOS is best-effort (`dmg`/`unknown`).
  - **Out of scope / not done:** Sentry (ATO-110/113), hosted PostHog
    (ATO-115), 404 aggregation (chose `skip_emit` over a buffered summary),
    `ctx_auto_increased`/`new_ctx_len` on `model_load` (best-effort, deferred).
  - **Verification:** `cargo check -p Atomic-Chat` passes (0 errors,
    pre-existing dead_code warnings only); `yarn lint` clean on all touched
    files (the 3 `ttft-timing.ts` errors are pre-existing and untouched);
    `ReadLints` clean on every edited TS/TSX file. Runtime confirmation via
    `posthog.debug()` on a dev build is the remaining manual step.
- **Owner:** team.
- **Links:** [ATO-108](https://linear.app/atomicchat/issue/ATO-108),
  [ATO-111](https://linear.app/atomicchat/issue/ATO-111),
  [ATO-109](https://linear.app/atomicchat/issue/ATO-109),
  [ATO-112](https://linear.app/atomicchat/issue/ATO-112), files:
  [`web-app/src/lib/telemetry.ts`](web-app/src/lib/telemetry.ts),
  [`web-app/src/providers/AnalyticProvider.tsx`](web-app/src/providers/AnalyticProvider.tsx),
  [`web-app/src/services/models/default.ts`](web-app/src/services/models/default.ts),
  [`web-app/src/containers/DownloadManegement.tsx`](web-app/src/containers/DownloadManegement.tsx),
  [`web-app/src/utils/switchModel.ts`](web-app/src/utils/switchModel.ts),
  [`web-app/src/types/analytics.ts`](web-app/src/types/analytics.ts),
  [`web-app/src/services/app/{types,default,tauri}.ts`](web-app/src/services/app/tauri.ts),
  [`src-tauri/src/core/server/proxy.rs`](src-tauri/src/core/server/proxy.rs),
  [`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs),
  [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs).
