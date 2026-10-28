---
date: 2026-10-26
title: "Show the context llama.cpp fitted, not the one the load asked for"
---

# 2026-10-26 — Show the context llama.cpp fitted, not the one the load asked for

- **Context:** QA of 2.2.25 on an 8 GB MacBook Air M3: after onboarding, LFM2.5
  1.2B on `llamacpp-upstream` showed "16K" with Fit to device memory on, while
  llama-server ran with `n_ctx_slot = 128000`. Under fit the core sends no
  `--ctx-size` (core ADR 2026-09-29), so llama.cpp starts from the trained
  context and shrinks it only to fit the budget; the model's `ctx_len` (16384,
  `DEFAULT_CTX_LEN`) is just what the load asked for. ATO-465 (2026-09-09) made
  the controls show the engine's value under fit by mirroring `/props` back
  after each load (`syncLoadedCtxSize`), but the core migration (99ecb470c,
  2026-09-17) dropped that mirror from the upstream extension and the PrismML
  extension, copied from it later, never had it; only TurboQuant kept it. The
  alternative — sending the shown value as an upper bound,
  `--ctx-size 16384 --fit on` — does not do that in llama.cpp: `--fit` adjusts
  only *unset* arguments, and with `n_ctx` set `common_params_fit_impl` skips
  the context step ("context size set by user … no change") and only moves
  layers off the GPU. Fit would silently become a fixed 16K window, the thing
  ATO-465 replaced.
- **Decision:** Keep Fit to device memory meaning "the largest window that
  fits" and make the controls tell the truth: after every chat load the
  upstream and PrismML extensions read `n_ctx` from the server's `/props` and,
  when it differs from the `ctx_size` the load asked for, emit
  `OnAutoIncreasedCtxLen` and `local_backend://auto_increase_ctx_notify`, which
  write it into the model's `ctx_len` (the path the context ladder uses). The
  reader is `extensions/shared/loadedContext.ts`; TurboQuant keeps its own
  copy. No core change.
- **Consequences:** After the first load the composer popover and run settings
  show the window the engine runs (125.0K for LFM2.5 1.2B on the 8 GB M3), and
  the token meter uses it. A core clamp to the trained context is mirrored the
  same way. Embedding loads are not asked. Before a model's first load under
  fit the controls still show the stored `ctx_len`; a reload the core does on
  its own (compute-error recovery) is not mirrored until the app loads the
  model again. Turning fit off keeps the last fitted window as the slider
  value. Whether a fitted 128K window is too much for an 8 GB Mac (that load
  spent ~15 s creating the context, a 4K load ~1.7 s in total) is a question
  for the core's fit budget, not for this label.
- **Owner:** `team`.
- **Links:** `extensions/shared/loadedContext.ts`,
  `extensions/llamacpp-upstream-extension/src/index.ts` (`load`,
  `syncLoadedCtxSize`), `extensions/atomic-prism-extension/src/index.ts`,
  `extensions/llamacpp-extension/src/index.ts` (`syncLoadedCtxSize`),
  `web-app/src/providers/DataProvider.tsx` (`applyNewCtxLen`),
  `web-app/src/hooks/useModelContextLength.ts`; commits 74d8c0eba (ATO-465),
  99ecb470c; atomic-chat-core ADR
  `2026-09-29-leave-half-of-ram-to-the-system-when-fitting-on-unified-memory.md`;
  llama.cpp `common/fit.cpp` (`common_params_fit_impl`) and `llama-server -h`
  for `--fit` / `--fit-ctx`.
