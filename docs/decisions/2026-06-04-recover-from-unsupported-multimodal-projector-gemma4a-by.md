---
date: 2026-06-04
title: "Recover from unsupported multimodal projector (`gemma4a`) by falling back to text-only instead of crashing the load (issue #44)"
---

# 2026-06-04 — Recover from unsupported multimodal projector (`gemma4a`) by falling back to text-only instead of crashing the load (issue #44)

- **Context:** Loading a multimodal model whose `mmproj.gguf` declares a
  projector type the bundled `llama.cpp`/`libmtmd` build can't build a graph
  for — e.g. the brand-new Gemma 4 audio projector `gemma4a` in
  `unsloth/gemma-4-E4B-it-IQ4_XS` on backend `b9495/macos-arm64` — aborts the
  whole `llama-server` with `clip.cpp:4391: Unknown projector type` →
  `ggml_abort` → SIGABRT (exit code 6) **during mtmd warmup, before the server
  reports ready** ([issue #44](https://github.com/AtomicBot-ai/Atomic-Chat/issues/44),
  confirmed against the user's `app.log`). The model never started — not even
  text-only — because the provider always appends `--mmproj` when an
  `mmproj.gguf` is present, and the UI surfaced only the generic
  `LlamaCppProcessError` ("The model process encountered an unexpected error.")
  since `LlamacppError::from_stderr` had no branch for this signature, even
  though the `MultimodalProjectorLoadFailed` error code was already defined but
  unused. Scope is `llamacpp-upstream` (the macOS/Windows/Linux upstream
  provider) per the issue; the parallel turboquant `llamacpp-extension` is left
  untouched.
- **Decision:** Detect the signature and auto-recover text-only.
  1. **Rust** ([`error.rs::from_stderr`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/error.rs)):
     classify stderr containing `unknown projector type` (lowercased) as
     `ErrorCode::MultimodalProjectorLoadFailed` with an actionable message
     ("This model's multimodal projector isn't supported by the current
     llama.cpp backend. Vision/audio is unavailable …"), placed after the OOM
     and arch checks so those still win.
  2. **TS** ([`index.ts::performLoad`](extensions/llamacpp-upstream-extension/src/index.ts)):
     when `loadLlamaModel` rejects with `code ===
     'MULTIMODAL_PROJECTOR_LOAD_FAILED'` **and** an `mmprojPath` was set, retry
     the load **once** with `mmprojPath = undefined` (text-only). On success,
     cache the session as usual and emit a native Tauri event
     `local_backend://multimodal_disabled_fallback` with `{ modelId }`. Any
     other error (or a retry that also fails) propagates unchanged.
  3. **web-app** ([`DataProvider.tsx`](web-app/src/providers/DataProvider.tsx)):
     subscribe to that Tauri event (alongside the existing
     `auto_increase_ctx_*` listeners) and show a one-shot, non-fatal
     `toast.warning` keyed `mmproj-fallback-<modelId>` telling the user
     vision/audio was disabled and the model loaded text-only.
- **Consequences:**
  - Multimodal models with an unsupported projector now **load and chat
    text-only** instead of failing the whole load with an opaque error; the
    user gets a clear, non-blocking notice. Text-only is a deliberate,
    behavior-changing fallback (vision/audio are silently dropped for that
    model on that backend) — judged better than a hard failure.
  - **Lossy by design:** the model's vision/audio capability is unavailable
    until the bundled backend ships a `libmtmd` that supports the projector;
    tracking upstream `gemma4v`/`gemma4a` mtmd support + bumping the bundled
    macOS build is a separate follow-up (not done here). No backend-currency
    gate or pre-launch projector compat check was added.
  - The retry is **single-shot** and only triggers on the specific error code
    with a present mmproj, so non-multimodal loads and other failure modes are
    unaffected. No new settings, IPC commands, deps, or on-disk paths.
    `cargo check -p tauri-plugin-llamacpp-upstream` passes (pre-existing
    warnings only); the three edited files are lint-clean;
    `DataProvider.test.tsx` passes. The unrelated web-app suite failures
    (hardware/models/interface/etc.) are pre-existing and network/env-bound.
- **Owner:** team.
- **Links:** [issue #44](https://github.com/AtomicBot-ai/Atomic-Chat/issues/44),
  §4.2 *LLM backend*, the 2026-06-02 ADR *Sync `mlx-vlm` to v0.6.0* (EAGLE-3/MTP),
  files: [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/error.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/error.rs),
  [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)
  (`performLoad`),
  [`web-app/src/providers/DataProvider.tsx`](web-app/src/providers/DataProvider.tsx).
