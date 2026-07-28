---
date: 2026-06-15
title: "Raise the MLX default load context to `min(train-max, 16384)` + surface a clear context-overflow message instead of raw \"Error generating response\" (ATO-170)"
---

# 2026-06-15 — Raise the MLX default load context to `min(train-max, 16384)` + surface a clear context-overflow message instead of raw "Error generating response" (ATO-170)

- **Context:** With Exa (or any large tool-result) enabled, generation on MLX
  models failed with a raw "Error generating response". Root cause (proven in
  [ATO-170](https://linear.app/atomicchat/issue/ATO-170)) is **context
  overflow**, not a tool/serialization bug: the bundled mlx-vlm server
  preflights the budget (`validate_context_budget` → `PromptTooLongError`) and
  rejects an over-budget request with HTTP 400 `Request needs N context tokens
  (...), but MAX_KV_SIZE is M`. MLX models were loaded at a **hardcoded 4096**
  (`extensions/mlx-extension/src/index.ts` `ctx_size: Number(cfg.ctx_size ??
  4096)`); Exa returns full-text pages so 2-3 results blow past 4096. The
  extension already reads the model's training-max
  (`resolveModelMaxCtxTrain`, resolved into `modelMaxCtxTrain` early in
  `performLoad`) for the auto-increase ceiling but never used it at load time.
  MLX `model.yml` carries **no** `settings` block (`import` writes only
  `model_path`/`name`/`size_bytes`/caps), so `startModel` passes
  `settings=undefined` → `cfg.ctx_size` is genuinely unset on a normal start,
  which lets us distinguish "default" from a user-pinned value.
- **Decision (scope = #1 prevention + #2 graceful degradation; #3 KV-quant
  no-op deferred, needs reporter logs):**
  1. **#1 Prevention (the proven primary fix).** In `performLoad`, when
     `cfg.ctx_size` is not a valid positive number, default the load context to
     `min(trainMax, MLX_DEFAULT_CTX_CAP)` (`MLX_DEFAULT_CTX_CAP = 16384`),
     falling back to `MLX_DEFAULT_CTX_FALLBACK = 4096` only when the
     training-max couldn't be read from `config.json`. An explicit, valid
     `ctx_size` (user-pinned, or the auto-increase override `{ ctx_size: … }`)
     always wins. The cap (chosen over the issue's literal "full
     `max_position_embeddings`") avoids blindly allocating a huge KV cache —
     **OOM risk** on smaller Macs and on huge-context coder models (Qwen3-Coder
     train-ctx reaches 256K). The auto-increase ladder still has headroom
     (`computeNextCtxLen(16384) → 32768`, capped at train-max).
  2. **#2 Graceful degradation.** New `isContextLimitError(error)` +
     `CONTEXT_OVERFLOW_TITLE` / `CONTEXT_OVERFLOW_MESSAGE` in
     [`web-app/src/utils/error.ts`](web-app/src/utils/error.ts), mirroring the
     Rust `is_context_limit_error` matcher in
     [`proxy.rs`](src-tauri/src/core/server/proxy.rs) (matches `max_kv_size`,
     `kv cache` + exceed/overflow/too, and `context` + size/length/limit/…).
     [`$threadId.tsx`](web-app/src/routes/threads/$threadId.tsx) now uses the
     helper for **both** the client-side auto-increase trigger effect and the
     error-render block; when the failure is a context overflow it shows the
     clear title/message (and keeps the existing "Increase Context Size" button)
     instead of the generic "Error generating response" + raw engine 400 body.
- **Consequences:** The common Exa scenario no longer 400s on the first
  large turn (load floor is now up to 16K), and a genuine overflow (auto-increase
  exhausted / at train-max) renders an actionable message rather than opaque
  engine text. **Deliberately not done:** the issue's #3 — when KV-quant
  (TurboQuant) is on, the mlx-vlm server can't raise `MAX_KV_SIZE` on reload
  (`". uses QuantizedKVCache, can't set max KV size."`) so auto-increase
  silently no-ops; fixing that needs the reporter's `app.log` (to split case
  (a) retry-still-too-big vs (b) KV-quant block) and likely a Python-side
  change in the `mlx-vlm` fork + sidecar rebuild — out of this slice. **Scope:**
  one MLX extension TS file + two web-app files; no Rust, IPC, schema, or
  persistence change. **Verified:** `tsc -b` clean on web-app; eslint clean on
  the two web-app files (one pre-existing `exhaustive-deps` warning untouched,
  confirmed by stash-baseline). The 2 standalone `tsc --noEmit` errors in the
  MLX extension (`eagle3`/`DraftKind`) are **pre-existing** (confirmed by
  stash-baseline on HEAD) and unrelated; the extension ships via rolldown.
- **Owner:** team.
- **Links:** [ATO-170](https://linear.app/atomicchat/issue/ATO-170),
  [ATO-135](https://linear.app/atomicchat/issue/ATO-135) (TurboQuant epic; KV-quant
  no-op lives there), the 2026-06-02 ADR *Surface MLX KV-cache quantization …*,
  files:
  [`extensions/mlx-extension/src/index.ts`](extensions/mlx-extension/src/index.ts)
  (`MLX_DEFAULT_CTX_CAP`, `performLoad` ctx resolution),
  [`web-app/src/utils/error.ts`](web-app/src/utils/error.ts)
  (`isContextLimitError`, `CONTEXT_OVERFLOW_TITLE`/`_MESSAGE`),
  [`web-app/src/routes/threads/$threadId.tsx`](web-app/src/routes/threads/$threadId.tsx),
  [`src-tauri/src/core/server/proxy.rs`](src-tauri/src/core/server/proxy.rs)
  (`is_context_limit_error`).

---
