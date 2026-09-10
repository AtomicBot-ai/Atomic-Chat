---
date: 2026-06-11
title: "ATO-135 (web-app slice): clear the stuck \"Failed to load\" toast on a successful load (ATO-63) + map classified engine errors to actionable messages (ATO-121)"
---

# 2026-06-11 — ATO-135 (web-app slice): clear the stuck "Failed to load" toast on a successful load (ATO-63) + map classified engine errors to actionable messages (ATO-121)

- **Context:** Epic [ATO-135](https://linear.app/atomicchat/issue/ATO-135) bundles
  one root pattern (bundled runtime forks lag upstream on new architectures —
  `lfm2moe`/LFM2.5, Gemma 4 `gemma4uv`) plus the poor UX around the resulting
  load failures. Two of its sub-tickets are clean, self-contained **web-app**
  fixes (the rest — MLX `mlx-vlm` bump for `lfm2_moe` (ATO-62), the TurboQuant
  `GGML_ASSERT` crash on `lfm2moe`, the macOS-default-not-effective-in-release
  investigation, and LFM2.5 native tool-call parsing (ATO-64) — are
  backend-coupled / external-repo and deliberately out of this slice).
  - **ATO-63** — in [`switchModel.ts`](web-app/src/utils/switchModel.ts) the
    `reportModelLoadError` toast (`id:'model-load-error'`) was raised on a failed
    load but **never dismissed on a later success**. So when MLX fails to load a
    model (e.g. `lfm2_moe`) and the user then starts the same model on llama.cpp,
    the stale "Failed to load" toast keeps hanging while the model is actually
    running and answering.
  - **ATO-121** — `reportModelLoadError` always rendered the generic
    `modelLoadFailedDescription` ("…encountered an unexpected error"). The Rust
    plugins already classify the cause (`LlamacppError::from_stderr` /
    `from_exit_status`: `MULTIMODAL_PROJECTOR_LOAD_FAILED`,
    `MODEL_ARCH_NOT_SUPPORTED`, native-crash, OOM) and ATO-117's
    `formatLoadError` carries `message`/`details`/`[CODE]` to the UI — but the UI
    never used `err.code` to give a clean, actionable message with a next step.
- **Decision:** Web-app only; no Rust, IPC, schema, or backend change.
  1. **ATO-63** — new `clearModelLoadError()` helper (`toast.dismiss('model-load-error')`
     + `useModelLoad.setModelLoadError(undefined)`), called on **both** success
     paths: the `switchToModel` "already serving" early return and the
     `doSwitchToModel` happy path (step 7). Failures are untouched (the toast
     still appears), and successes never throttle.
  2. **ATO-121** — `reportModelLoadError` now branches on `err.code` before the
     generic fallback: `MULTIMODAL_PROJECTOR_LOAD_FAILED` →
     `multimodalUnsupported*`, `MODEL_ARCH_NOT_SUPPORTED` → `archNotSupported*`,
     `MODEL_FILE_NOT_FOUND` → `modelFileMissing*` — each a clean title +
     actionable hint ("Try a different backend in Settings → Model Providers, or
     update the app." / "Try re-downloading the model."). OOM keeps its existing
     persistent toast; `LLAMA_CPP_PROCESS_ERROR` deliberately stays on the
     generic path because its `from_exit_status` crash message is already
     meaningful and re-routing every generic process error to "incompatible"
     would over-claim. New keys in
     [`en/model-errors.json`](web-app/src/locales/en/model-errors.json) +
     [`ru/model-errors.json`](web-app/src/locales/ru/model-errors.json); other
     locales fall back to EN.
- **Consequences:** The stuck "Failed to load" toast no longer survives a
  successful cross-backend load; engine-incompatibility / missing-file / unknown
  projector failures now show a clear cause + next step instead of "unexpected
  error". **Scope:** 1 util + 2 locale files. **Verified:** `tsc -b` clean;
  `eslint` clean on `switchModel.ts`; `ReadLints` clean on all three; both JSON
  files parse. **Not done (out of this slice, still open under ATO-135):**
  ATO-62 (MLX `lfm2_moe` bump + sidecar rebuild), the TurboQuant `lfm2moe`
  `GGML_ASSERT` crash defense, the macOS-default-not-effective-in-v1.1.106
  investigation, and **ATO-64** — found to be **backend-coupled**: the
  `Failed to parse input at pos N` originates in `llama-server`'s own
  chat-format parser (the model never reaches the web-app as clean text), and
  the `<|tool_call_start|>` markers would also be eaten by
  `stripSpecialTokensTransform` in [`custom-chat-transport.ts`](web-app/src/lib/custom-chat-transport.ts);
  a pure web-app parser would not fix the reported case, so it was left for a
  backend-coupled follow-up.
- **Owner:** team.
- **Links:** [ATO-135](https://linear.app/atomicchat/issue/ATO-135),
  [ATO-63](https://linear.app/atomicchat/issue/ATO-63),
  [ATO-121](https://linear.app/atomicchat/issue/ATO-121),
  [ATO-117](https://linear.app/atomicchat/issue/ATO-117),
  [ATO-62](https://linear.app/atomicchat/issue/ATO-62),
  [ATO-64](https://linear.app/atomicchat/issue/ATO-64), files:
  [`web-app/src/utils/switchModel.ts`](web-app/src/utils/switchModel.ts)
  (`clearModelLoadError`, `reportModelLoadError`),
  [`web-app/src/locales/en/model-errors.json`](web-app/src/locales/en/model-errors.json),
  [`web-app/src/locales/ru/model-errors.json`](web-app/src/locales/ru/model-errors.json),
  Rust classifier
  [`tauri-plugin-llamacpp/src/error.rs`](src-tauri/plugins/tauri-plugin-llamacpp/src/error.rs)
  (`from_stderr`, `from_exit_status`).
