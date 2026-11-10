---
date: 2026-11-09
title: "Acknowledge FastFlowLM maintenance before finalizing"
---

# 2026-11-09 — Acknowledge FastFlowLM maintenance before finalizing

- **Context:** Final desktop review found that a restored model could retain an unfinished core maintenance hold, and that a same-digest reinstall could skip its newly verified staging files. Generic per-model context defaults also shadowed the FLM engine schema.
- **Decision:** Keep rollback in `rollback-pending` until core acknowledges maintenance completion. Persist `maintenance_completed` before treating `rolled-back` as terminal. Reconcile older rollback journals without this acknowledgement through their original request ID; do not create a new operation. The frontend and native installer use the same terminal-state rule. A promoted installation is recognized by consumed staging and, for replacement, its retained backup, as well as the descriptor digest. An older live marker with the same digest alone is insufficient.
- **Settings:** FLM launch settings belong to the engine's seven-field schema. Fresh model discovery does not seed generic llama.cpp settings, and load ignores legacy generic model bags. This preserves the core's `ctx_len=0` semantics and the user's engine context instead of injecting 16384. Sampling remains part of each chat request.
- **Controls:** An active model update takes precedence over installed-model actions. Retry/stall events retain their stage and never replace byte progress with zero counters. Onboarding preserves user pauses and cancellation semantics, and Retry recognizes FLM's native journal instead of requiring GGUF resume parameters.
- **Alternatives:** A terminal rollback before acknowledgement loses the identity needed to release the hold. A digest-only shortcut confuses an older installation with this publication and can retain corrupt bytes. Retaining generic load overrides makes the engine context control ineffective.
- **Consequences:** Old rollback journals are reconciled once, including guards whose completion response was lost. A same-revision reinstall replaces verified files and retains the previous installation until confirmation. No core protocol or runtime dependency changes are required. Targeted fixtures and Chromium geometry checks cover the repaired paths; Windows/Linux NPU acceptance remains separate.
- **Owner:** team.
- **Links:** [Desktop ownership decision](2026-11-09-install-fastflowlm-models-in-the-desktop.md), [native journal](../../src-tauri/src/core/atomic_core/fastflowlm_models.rs), [frontend state predicate](../../web-app/src/lib/fastflowlm/install-state.ts).
