---
date: 2026-06-17
title: "Recover the poisoned Metal backend + surface a clear OOM message after a GPU compute error, instead of retrying 3× into a dead backend (ATO-197)"
---

# 2026-06-17 — Recover the poisoned Metal backend + surface a clear OOM message after a GPU compute error, instead of retrying 3× into a dead backend (ATO-197)

- **Context:** On macOS, a llama.cpp Metal GPU out-of-memory during prompt
 processing (e.g. `janhq/Jan-v2-VL-high-Q4_K_M` + an image, ~4865-token prompt)
 returns HTTP `500 {"error":{"message":"Compute error"}}` and leaves the ggml
 Metal backend in a permanent error state ("backend is in error state from a
 previous command buffer failure - recreate the backend to recover"). HTTP 500
 is retryable, so the AI SDK retried the identical request 3× into the
 still-poisoned backend → all failed identically, surfacing only
 *"Failed after 3 attempts. Last error: Compute error."* The OOM detail
 (`kIOGPUCommandBufferCallbackErrorOutOfMemory` / `Insufficient Memory`) appears
 only in `llama-server` **stderr**, never the HTTP body, so neither the proxy
 nor the UI could classify it as OOM ([ATO-197](https://linear.app/atomicchat/issue/ATO-197)).
- **Decision (minimal, reuses existing machinery; scoped to the reported
 `llamacpp-upstream` backend):**
 1. **Proxy** ([`proxy.rs`](src-tauri/src/core/server/proxy.rs)): new
 `is_compute_backend_error()` detects a fatal local-backend compute/decode
 failure from the body (`"compute error"` / `"failed to decode"` /
 `"failed to compute graph"` / `"backend is in error state"` /
 `"ggml_backend_sched_graph_compute"`, status 500 only), checked **after** the
 existing context-overflow retry path so ctx errors keep their flow. On match
 (`can_retry_local`) it **recreates the backend** for `llamacpp-upstream` by
 reusing `maybe_auto_increase_and_retry` with a new `compute_error_recovery`
 trigger (reload **same-ctx**, not a ctx grow — growing ctx would worsen an
 OOM), then returns a **non-retryable HTTP 400** structured
 `insufficient_memory` envelope (`compute_error_envelope`) with actionable
 guidance. The same request is **not** auto-retried (a deterministic prefill
 OOM would just re-poison the fresh backend); the recreate leaves the backend
 healthy for the *next* request.
 2. **Extension** ([`llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)):
 `handleAutoIncreaseCtx` handles the `compute_error_recovery` trigger by
 unload + reload with existing settings (recreate the dead backend), skipping
 the ctx-grow / `AUTO_INCREASE_CTX_NOTIFY` path.
 3. **web-app** ([`error.ts`](web-app/src/utils/error.ts),
 [`$threadId.tsx`](web-app/src/routes/threads/$threadId.tsx)): new
 `isOutOfMemoryError()` + `OUT_OF_MEMORY_TITLE`/`MESSAGE`; the thread error
 panel shows clear OOM guidance instead of the raw "Compute error".
- **Consequences:** The 3× retry-into-dead-backend loop is gone (non-retryable
 400), the poisoned backend self-heals on the failing request so the next
 message works, and the user gets an actionable OOM message. **Deliberately NOT
 done (follow-ups):** recovery is gated to `llamacpp-upstream` — the turboquant
 `llamacpp` extension gets the clearer 400 message but no auto-recreate (mlx is
 unaffected; different phrasing); reading the `llama-server` stderr tail in the
 proxy for exact OOM-vs-other-compute discrimination was avoided (needs
 per-session stderr-capture plumbing in both plugins), so the message hedges
 when the body itself doesn't pin OOM. **Verified:** `cargo check -p
 Atomic-Chat` clean; `cargo test --lib core::server::` 71 passed incl. 3 new
 (`detects_metal_compute_error_body`, `ignores_non_compute_errors`,
 `compute_error_envelope_is_structured_oom`); web-app `vitest` `error.test.ts`
 28/28, `eslint` 0 errors, `tsc -b` clean; upstream extension rolldown build
 clean. The end-to-end reload round-trip (proxy → extension → done event) was
 **not** integration-tested (no Metal hardware / live `llama-server` in the
 sandbox) — PR opened as `[needs-review]`.
- **Owner:** team.
- **Links:** [ATO-197](https://linear.app/atomicchat/issue/ATO-197),
 [PR #80](https://github.com/AtomicBot-ai/Atomic-Chat/pull/80), the 2026-06-16
 ADR *Tiered graceful backend fallback …* + the auto-increase-ctx reload
 machinery, §4.2 *LLM backend*, files:
 [`src-tauri/src/core/server/proxy.rs`](src-tauri/src/core/server/proxy.rs)
 (`is_compute_backend_error`, `compute_error_envelope`, the `is_error`
 recovery block),
 [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)
 (`COMPUTE_ERROR_RECOVERY_TRIGGER`, `handleAutoIncreaseCtx`),
 [`web-app/src/utils/error.ts`](web-app/src/utils/error.ts)
 (`isOutOfMemoryError`),
 [`web-app/src/routes/threads/$threadId.tsx`](web-app/src/routes/threads/$threadId.tsx).
