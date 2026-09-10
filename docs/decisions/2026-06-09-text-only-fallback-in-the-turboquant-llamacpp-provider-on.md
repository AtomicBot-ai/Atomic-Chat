---
date: 2026-06-09
title: "Text-only fallback in the TurboQuant `llamacpp` provider on unsupported multimodal projector (Gemma 4 12B unified `gemma4uv`/`gemma4ua`)"
---

# 2026-06-09 — Text-only fallback in the TurboQuant `llamacpp` provider on unsupported multimodal projector (Gemma 4 12B unified `gemma4uv`/`gemma4ua`)

- **Context:** Loading `unsloth/gemma-4-12b-it-IQ4_XS` on the TurboQuant
  macOS provider (`tauri-plugin-llamacpp` + `extensions/llamacpp-extension`,
  bundled binary `turboquant-macos-arm64-0a635dc`) crashed the whole
  `llama-server` during clip warmup:
  `clip_init: ... unknown projector type: gemma4uv` →
  `mtmd_init_from_file: error: Failed to load CLIP model ...` →
  `main: exiting due to model loading error`. The **text model loaded fine**
  (arch `gemma4` accepted, 48 layers on GPU, TurboQuant `turbo3` KV up, EOG
  `<turn|>`=106 recognised); only the multimodal projector failed. Root
  cause: the mmproj for Gemma 4's **unified** ("any-to-any") 12B declares the
  projector type `gemma4uv` (unified vision; its audio sibling is `gemma4ua`).
  Verified against sources: upstream `ggml-org/llama.cpp` master enumerates
  **four** Gemma 4 projector types (`gemma4v`, `gemma4a`, `gemma4uv`,
  `gemma4ua`), but **every branch of our fork
  `AtomicBot-ai/atomic-llama-cpp-turboquant`** (`feature/turboquant-kv-cache`,
  `feature/gemma-mtp`, …) carries only the non-unified pair `gemma4v` /
  `gemma4a`. So the fork is behind upstream on the *unified* projectors that
  the 12B uses. Compounding it, the TurboQuant extension/plugin pair lacked
  the text-only fallback we already gave the `llamacpp-upstream` pair in the
  2026-06-04 ADR (issue #44) — so instead of degrading gracefully it
  hard-failed with an opaque `[object Object]` in the UI.
- **Decision:** Port the **same text-only fallback** to the TurboQuant pair
  (path A of the user's choice; the full projector port — path B — is
  deferred). Two mirrored edits:
  1. **Rust** ([`tauri-plugin-llamacpp/src/error.rs::from_stderr`](src-tauri/plugins/tauri-plugin-llamacpp/src/error.rs)):
     classify stderr containing `unknown projector type` (lowercased) as
     `ErrorCode::MultimodalProjectorLoadFailed` (the variant already existed)
     with the same actionable message as the upstream plugin, placed after
     the OOM and arch-not-supported checks so those still win.
  2. **TS** ([`extensions/llamacpp-extension/src/index.ts::performLoad`](extensions/llamacpp-extension/src/index.ts)):
     when `loadLlamaModel` rejects with `code ===
     'MULTIMODAL_PROJECTOR_LOAD_FAILED'` **and** an `mmprojPath` was set, retry
     the load **once** with `mmprojPath = undefined` (text-only), caching the
     session and ctx size as on the happy path; any other error (or a retry
     that also fails) propagates unchanged. New module const
     `ERR_MULTIMODAL_PROJECTOR_LOAD_FAILED`.
- **Consequences:**
  - Gemma 4 12B (and any model whose mmproj uses a projector the TurboQuant
    fork can't build) now **loads and chats text-only** on macOS instead of
    failing the whole load. Vision/audio is silently dropped for that model
    on that backend until the fork ships the unified projectors.
  - **Deliberately no toast.** Unlike the upstream pair, this fallback does
    **not** emit `local_backend://multimodal_disabled_fallback` — that
    web-app listener was removed earlier this session, so emitting would be
    dead code. The fallback is logged (`logger.warn`) and otherwise silent.
  - **Lossy by design / not the full fix.** This is path A (unblock text).
    Returning vision/audio for unified Gemma 4 on TurboQuant requires path B:
    porting `gemma4uv` / `gemma4ua` (clip-impl.h enums+names, clip.cpp graph
    builders, mtmd.cpp preprocessors) from `ggml-org/llama.cpp` into the fork
    and rebuilding the sidecar — tracked as a separate follow-up.
  - Single-shot retry, gated on the specific error code + present mmproj, so
    non-multimodal loads and other failure modes are unaffected. No new
    settings, IPC, deps, or on-disk layout. `cargo check -p
    tauri-plugin-llamacpp` passes (pre-existing warnings only); both edited
    files are lint-clean.
- **Owner:** team.
- **Links:** §4.2 *LLM backend*, the 2026-06-04 ADR *Recover from unsupported
  multimodal projector (`gemma4a`) … text-only fallback* (issue #44, upstream
  pair), [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp)
  (`tools/mtmd/clip-impl.h`, four `gemma4*` projector types),
  [AtomicBot-ai/atomic-llama-cpp-turboquant](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant)
  (carries only `gemma4v` / `gemma4a`), files:
  [`src-tauri/plugins/tauri-plugin-llamacpp/src/error.rs`](src-tauri/plugins/tauri-plugin-llamacpp/src/error.rs)
  (`from_stderr`),
  [`extensions/llamacpp-extension/src/index.ts`](extensions/llamacpp-extension/src/index.ts)
  (`performLoad`, `ERR_MULTIMODAL_PROJECTOR_LOAD_FAILED`).
