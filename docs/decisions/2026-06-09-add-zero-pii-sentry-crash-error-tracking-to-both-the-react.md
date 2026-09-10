---
date: 2026-06-09
title: "Add zero-PII Sentry crash/error tracking to both the React frontend and the Rust/Tauri desktop, gated behind `productAnalytic` (ATO-113)"
---

# 2026-06-09 — Add zero-PII Sentry crash/error tracking to both the React frontend and the Rust/Tauri desktop, gated behind `productAnalytic` (ATO-113)

- **Context:** The app had no crash/error telemetry — user-facing failures
  (model-load crashes incl. OOM, download failures, context overflow) surfaced
  only as toasts / `console.error`, and Rust panics were lost entirely. There
  was no agent-fixable context (typed `error_code`, hardware tags, release =
  git SHA, symbolicated stacks). [ATO-113](https://linear.app/atomicchat/issue/ATO-113)
  scoped automatic 100%-capture for both runtimes with strict zero-PII, reusing
  the existing `productAnalytic` consent (Sentry SaaS, two projects;
  self-hosted ATO-115 + perf tracing + replay explicitly out of scope).
- **Decision:** Two Sentry SaaS projects (`atomic-chat-frontend` js-react,
  `atomic-chat-desktop` rust), two SDKs, one shared privacy doctrine, one
  git-SHA release id.
  1. **Build-time env (mirrors PostHog).** Frontend `SENTRY_DSN` /
     `SENTRY_ENVIRONMENT` / `SENTRY_RELEASE` injected via `define` in
     [`vite.config.ts`](web-app/vite.config.ts) (declared in
     [`global.d.ts`](web-app/src/types/global.d.ts), mirrored in
     [`vitest.config.ts`](web-app/vitest.config.ts)). Rust reads
     `SENTRY_DSN_DESKTOP` / `SENTRY_RELEASE` / `SENTRY_ENVIRONMENT` via
     `option_env!` (no DSN baked in ⇒ Sentry is a no-op, so local dev stays
     inert). **Dev convenience (amendment 2026-06-09):** because `cargo` does
     not read `.env` and `option_env!` resolves at compile time,
     [`src-tauri/build.rs`](src-tauri/build.rs) now hand-parses a gitignored
     `src-tauri/.env` (no new crate) and emits `cargo:rustc-env` for those three
     keys **only when the var is absent from the ambient environment** — so the
     CI `export` (production path) always wins and the file just fills the gap
     for `yarn dev:tauri`. `**/.env` is already in `.gitignore`.
  2. **Frontend** ([`web-app/src/lib/sentry.ts`](web-app/src/lib/sentry.ts)):
     `@sentry/react` (10.57.0) init early in
     [`main.tsx`](web-app/src/main.tsx) (guarded on `SENTRY_DSN` + `IS_TAURI`,
     `sendDefaultPii:false`, `tracesSampleRate:0`, default integrations so
     `window.onerror`/`unhandledrejection` auto-capture).
     `Sentry.ErrorBoundary` wraps `<RouterProvider>` (fallback = existing
     `GlobalError`); the TanStack `errorComponent` in
     [`__root.tsx`](web-app/src/routes/__root.tsx) also captures.
     **Consent without re-init churn:** `beforeSend`/`beforeBreadcrumb` read
     `useProductAnalytic.getState().productAnalytic` and return `null` when off
     (fail-closed if the store isn't ready). Identity = anonymous device id
     only (`Sentry.setUser({id})`). Explicit `captureHandledError` at the three
     choke points — `reportModelLoadError` ([`switchModel.ts`](web-app/src/utils/switchModel.ts),
     `fatal` on OOM else `error`, tags `error_code`/`oom_subtype`/`backend`/
     `model_id`/`quant`/`context_length` + scrubbed `stderr_tail`), download
     failure ([`DownloadManegement.tsx`](web-app/src/containers/DownloadManegement.tsx),
     `failure_reason`/`http_status`/`download_kind`, cancellations excluded),
     and context overflow ([`$threadId.tsx`](web-app/src/routes/threads/$threadId.tsx),
     `warning` with `model_id`/`context_length`/`total_tokens`). Zero-PII
     hardware tags + device id pushed from
     [`AnalyticProvider.tsx`](web-app/src/providers/AnalyticProvider.tsx) reusing
     `collectHardwareSuperProps`; a dedicated effect syncs consent to **both**
     SDKs on every toggle.
  3. **Rust/Tauri** (new [`src-tauri/src/core/telemetry/`](src-tauri/src/core/telemetry/mod.rs),
     desktop-only `#[cfg(not(any(android, ios)))]`): `sentry = "0.34"`
     (feature `log`) in the desktop Cargo target. `init()` guard held for the
     whole process from the **top of [`main.rs`](src-tauri/src/main.rs)** so the
     default panic hook is armed before any work (`panic = "abort"` is fine —
     the hook runs first). Consent = process-global `AtomicBool` (default ON)
     checked in `before_send`/`before_breadcrumb`, reconciled from the frontend
     via the `set_telemetry_consent` command; hardware tags arrive via
     `set_telemetry_context` (both registered in
     [`lib.rs`](src-tauri/src/lib.rs)). **Log bridge:** `tauri-plugin-log` is
     installed with `.split()` (not `.build()`) and its logger wrapped in
     `SentryLogger::with_dest` so `log::error!` → Sentry event,
     `info`/`warn` → breadcrumbs, while stdout/webview/`app.log` keep working.
     `before_send` strips `server_name`/IP/username/email, scrubs every
     free-text field + stack `filename`/`abs_path`, clears frame `vars`, and
     attaches a scrubbed ~50 KB tail of `app.log`.
  4. **Shared scrubber.** TS `scrubPii` in
     [`telemetry.ts`](web-app/src/lib/telemetry.ts) extended to redact
     sensitive query-param values; Rust mirror
     [`scrub.rs`](src-tauri/src/core/telemetry/scrub.rs) implemented **without
     `regex`** (manual string passes) to avoid a heavy new dep — masks
     `/Users|/home|C:\Users` user segment (keeps folder structure), proxy
     creds, `hf_*`, `Bearer`, and sensitive query values. Key-based redaction
     (tokens/creds/`base_url`/uuid/hostname) on object values both sides.
  5. **PII source fixes** in [`proxy.rs`](src-tauri/src/core/server/proxy.rs):
     `log_ttft_prefix_dump` now logs message/tool **counts + byte sizes**, and
     the Anthropic-fallback `log::error!` logs only the request body's
     **top-level keys** — never prompt content.
  6. **Symbolication (code side).** `vite.config.ts` emits source maps + runs
     `@sentry/vite-plugin` **only** when CI provides `SENTRY_AUTH_TOKEN` +
     `SENTRY_ORG` + `SENTRY_PROJECT_FRONTEND` (uploads, associates with the
     git-SHA release, then deletes maps from `dist` — never shipped). Rust
     `[profile.release]` now `debug = 1` + `split-debuginfo = "packed"` so a
     separate dSYM/dwp/pdb exists for `sentry-cli debug-files upload` while the
     shipped binary stays `strip = "symbols"`. **CI heap (amendment
     2026-06-09):** emitting source maps for the ~12.9k-module bundle pushes the
     `yarn build:web` step past Node's ~2 GB default and it OOM'd
     (`Reached heap limit`); the three `Build web app` steps in
     [`release.yml`](.github/workflows/release.yml) now set
     `NODE_OPTIONS=--max-old-space-size=8192`.
- **Consequences:**
  - 100% capture when consented, total silence when not — no re-init on toggle.
    Zero-PII by construction on both runtimes (single scrubber doctrine, tags
    allow-listed to enum/id/number/bucket/bool, prompts → never sent).
  - **Verified:** `cargo check -p Atomic-Chat` 0 errors; `cargo test`
    `core::telemetry` 6/6 (scrub) pass; web-app `tsc -b` clean; eslint clean on
    all touched files (one pre-existing `exhaustive-deps` warning untouched);
    provider vitest 7/7. `@sentry/react` + `@sentry/vite-plugin` installed
    (hoisted to root `node_modules`).
  - **Remaining (owned by user / out of code scope):** the GitHub Actions wiring
    — set `SENTRY_*` env on the build steps (`SENTRY_RELEASE = ${{ github.sha }}`
    shared by both projects) and add the `sentry-cli debug-files upload` /
    release-finalize steps + GitHub secrets; the Sentry.io-side org config (auth
    token scopes, server-side scrubbers, Linear+Seer integration + alert rule);
    and the **acceptance test** (trigger a crash per project on a DSN-baked build
    and eyeball the payload). `cuda_runtime_version` tag is best-effort (inherited
    from the PostHog super-prop). Mobile is entirely excluded.
- **Owner:** team.
- **Links:** [ATO-113](https://linear.app/atomicchat/issue/ATO-113), the
  2026-06-09 ADR *Extend the PostHog telemetry channel …* (shared
  `telemetry.ts` helpers + consent model), files:
  [`web-app/src/lib/sentry.ts`](web-app/src/lib/sentry.ts),
  [`web-app/src/lib/telemetry.ts`](web-app/src/lib/telemetry.ts),
  [`web-app/src/main.tsx`](web-app/src/main.tsx),
  [`web-app/src/routes/__root.tsx`](web-app/src/routes/__root.tsx),
  [`web-app/src/providers/AnalyticProvider.tsx`](web-app/src/providers/AnalyticProvider.tsx),
  [`web-app/src/utils/switchModel.ts`](web-app/src/utils/switchModel.ts),
  [`web-app/src/containers/DownloadManegement.tsx`](web-app/src/containers/DownloadManegement.tsx),
  [`web-app/src/routes/threads/$threadId.tsx`](web-app/src/routes/threads/$threadId.tsx),
  [`web-app/vite.config.ts`](web-app/vite.config.ts),
  [`src-tauri/src/core/telemetry/mod.rs`](src-tauri/src/core/telemetry/mod.rs),
  [`src-tauri/src/core/telemetry/scrub.rs`](src-tauri/src/core/telemetry/scrub.rs),
  [`src-tauri/src/core/telemetry/commands.rs`](src-tauri/src/core/telemetry/commands.rs),
  [`src-tauri/src/main.rs`](src-tauri/src/main.rs),
  [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs),
  [`src-tauri/src/core/server/proxy.rs`](src-tauri/src/core/server/proxy.rs),
  [`src-tauri/Cargo.toml`](src-tauri/Cargo.toml).
