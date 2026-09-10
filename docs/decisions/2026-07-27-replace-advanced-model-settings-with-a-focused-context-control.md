---
date: 2026-07-27
title: "Replace advanced model settings with a focused context control"
---

# 2026-07-27 — Replace advanced model settings with a focused context control

- **Context:** The model pill exposed an advanced settings sheet whose engine
  options were too complex for the primary Chat and Agent surfaces, while
  context size still needed a direct control on Home and in active threads.
- **Decision:** Remove the per-model settings gear from the model pill and add
  one compact composer control that retains the token-usage percentage and
  circular meter on its trigger while opening a context-size editor. Back the
  popover with each selected local model's existing `ctx_len`
  metadata for `llamacpp`, `llamacpp-upstream`, and `mlx`; expose the range as
  a full-width slider whose upper bound comes from the engine's
  `getMaxCtxTrain` capability; persist changes through the model-provider store
  and restart a running model using its saved settings.
- **Consequences:** Chat and Agent share one focused context-size control on
  Home and in threads, including before token usage is available. The compact
  token meter is no longer duplicated beside a separate context-size button.
  Users can select any supported context size up to the model's training
  maximum without entering a raw value. Provider navigation gears remain
  available, and advanced model settings are no longer directly exposed from
  the model pill.
- **Owner:** team.
- **Links:** [`web-app/src/containers/ContextSizeControl.tsx`](web-app/src/containers/ContextSizeControl.tsx),
  [`web-app/src/containers/ChatInput.tsx`](web-app/src/containers/ChatInput.tsx),
  [`web-app/src/containers/DropdownModelProvider.tsx`](web-app/src/containers/DropdownModelProvider.tsx).
