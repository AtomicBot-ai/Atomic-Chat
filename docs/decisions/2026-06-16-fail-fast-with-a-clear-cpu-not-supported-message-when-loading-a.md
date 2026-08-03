---
date: 2026-06-16
title: "Fail fast with a clear \"CPU not supported\" message when loading a CPU backend on an x86 CPU without AVX (ATO-185)"
---

# 2026-06-16 — Fail fast with a clear "CPU not supported" message when loading a CPU backend on an x86 CPU without AVX (ATO-185)

- **Context:** `LLAMA_CPP_PROCESS_ERROR` over-indexes ×9.5 on CPUs reporting
  `cpu_avx='none'` — measured rate 31.6% (700/2 216) vs avx 0.39%, avx2 1.95%,
  avx512 2.55% (PostHog 30d, [ATO-185](https://linear.app/atomicchat/issue/ATO-185),
  Bug #8 of [ATO-181](https://linear.app/atomicchat/issue/ATO-181)). Root cause:
  the shipped ggml-org CPU build executes AVX instructions unconditionally, so on
  an x86 host with **no AVX at all** `llama-server` dies with SIGILL (Unix signal
  4) / `STATUS_ILLEGAL_INSTRUCTION` (Windows) the instant it starts. The crash
  leaves empty stderr, and `is_crash_exit`
  ([`error.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/error.rs))
  only recognises access-violation / segfault / abort codes (not SIGILL /
  illegal-instruction), so `from_exit_status` fell through to the opaque generic
  `LLAMA_CPP_PROCESS_ERROR` "unexpected error". The crashing population is the
  Windows/Linux upstream CPU build (macOS is excluded — Apple Silicon has no AVX
  concept and Intel Macs all ship AVX). Crucially the measured floor is **AVX,
  not AVX2**: AVX-only machines fail at just 0.39%, so only `cpu_avx='none'` is
  unsupported.
- **Decision (per the issue's accepted "clearly report incompatibility instead
  of a silent crash" option):** Detect the incompatibility up front in the
  `llamacpp-upstream` extension's `performLoad`, before spawning `llama-server`,
  and throw a structured, actionable error instead of letting the process
  SIGILL. New pure, unit-tested helpers in
  [`util.ts`](extensions/llamacpp-upstream-extension/src/util.ts):
  `isCpuBackend` (matches `*-cpu-*` ids, never the macOS `macos-*` ids),
  `cpuHasAvx` (mirrors the web-app `cpuAvxLevel`: avx / avx2 / avx512* ⇒ true),
  `isUnsupportedNoAvxCpu` (blocks **only** on a positive no-AVX signal — x86
  arch + CPU backend + a **non-empty** extension list lacking AVX — so an empty
  list from a non-x86 host or a hardware-probe failure never false-blocks), and
  the `CPU_NO_AVX_ERROR_CODE` constant. `performLoad`
  ([`index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)) probes
  `getSystemInfo()` (gated to CPU backends so GPU loads don't pay for it; a probe
  failure is logged and the load proceeds) and throws an `Error` carrying
  `code = 'CPU_NO_AVX'`. The web-app surfaces it via a new branch in
  `reportModelLoadError`
  ([`switchModel.ts`](web-app/src/utils/switchModel.ts)) with new
  `cpuNoAvx*` keys in
  [`en/model-errors.json`](web-app/src/locales/en/model-errors.json) +
  [`ru/model-errors.json`](web-app/src/locales/ru/model-errors.json) (other
  locales fall back to EN), and `CPU_NO_AVX` is added to
  `RECOVERABLE_MODEL_LOAD_CODES`
  ([`telemetry.ts`](web-app/src/lib/telemetry.ts)) so this expected
  hardware-incompatibility condition is not reported to Sentry as a crash.
- **Consequences:** No-AVX x86 users now see a plain "Your CPU is not supported"
  message instead of a silent crash + opaque error, and the distinct
  `CPU_NO_AVX` code de-noises the `LLAMA_CPP_PROCESS_ERROR` bucket in telemetry.
  **Deliberately NOT done (out of this slice):** shipping a separate no-AVX
  fallback `llama-server` binary — ggml-org publishes no such asset and adding
  one means changes to the CI release pipeline, Makefile download targets, the
  backend matrix, and signing; it's a larger, riskier effort tracked separately.
  The gate requires **AVX** (the build's real floor per the data), not AVX2, so
  AVX-only machines (which work fine) are never blocked. Scope: 1 extension TS
  module + the extension entry + 1 test file; web-app = 1 util + 1 util branch +
  2 locale files; no Rust, IPC, on-disk layout, or settings-schema change. The
  turboquant macOS `llamacpp` provider is untouched (macOS unaffected).
  **Verified:** extension rolldown build clean (`dist/index.js` 221.06 kB, exit
  0 — the authoritative compile); new `util.test.ts` cases pass (57/57, +26 for
  `isCpuBackend` / `cpuHasAvx` / `isUnsupportedNoAvxCpu`); web-app `tsc -b` clean;
  `eslint` clean on `switchModel.ts` + `telemetry.ts`; both locale JSONs parse.
- **Owner:** team.
- **Links:** [ATO-185](https://linear.app/atomicchat/issue/ATO-185),
  [ATO-181](https://linear.app/atomicchat/issue/ATO-181),
  [ATO-116](https://linear.app/atomicchat/issue/ATO-116), the 2026-06-11 ADR
  *Quiet the top-10 Sentry desktop anomalies …* (native-crash classification),
  §4.2 *LLM backend*, files:
  [`extensions/llamacpp-upstream-extension/src/util.ts`](extensions/llamacpp-upstream-extension/src/util.ts)
  (`isCpuBackend`, `cpuHasAvx`, `isUnsupportedNoAvxCpu`, `CPU_NO_AVX_ERROR_CODE`),
  [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)
  (`performLoad` AVX preflight),
  [`extensions/llamacpp-upstream-extension/src/util.test.ts`](extensions/llamacpp-upstream-extension/src/util.test.ts),
  [`web-app/src/utils/switchModel.ts`](web-app/src/utils/switchModel.ts)
  (`reportModelLoadError`),
  [`web-app/src/lib/telemetry.ts`](web-app/src/lib/telemetry.ts)
  (`RECOVERABLE_MODEL_LOAD_CODES`),
  [`web-app/src/locales/en/model-errors.json`](web-app/src/locales/en/model-errors.json),
  [`web-app/src/locales/ru/model-errors.json`](web-app/src/locales/ru/model-errors.json).
