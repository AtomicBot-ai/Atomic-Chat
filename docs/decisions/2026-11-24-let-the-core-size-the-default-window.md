---
date: 2026-11-24
title: "Let the core size the default window"
---

# 2026-11-24 — Let the core size the default window

- **Context:** The core now gives a model the largest window that fits this device when a load
  names none (core ADR `2026-11-23-default-every-engine-to-the-largest-window-that-fits`). The app
  defeated that on every load:
  - **llama.cpp and MLX:** every listed model carries `ctx_len` 16384 (8192 in older releases),
    and `startModel` sent it as `ctx_size`. So llama.cpp with fit off and MLX always ran at 16K.
  - **MLX also on its own:** the extension sized an unset window to `min(trainMax, 16384)`
    (`2026-06-15-raise-the-mlx-default-load-context-to-min-train-max-16384`).
  - **TensorRT-LLM:** the extension schema's `context_length` 8192 was imported over the core's
    new automatic default on fresh installs.
- **Decision:** A window nobody chose is left to the core.
  - **Marker.** `ctx_len_user_set` is set only when the user commits a context size: the header
    slider, run settings, or the model setting. It is never sent to an engine.
  - **What is left out.** For llama.cpp, llama.cpp upstream, PrismML and MLX, a `ctx_len` with no
    marker and still on an old default (16384 or 8192) is not sent. Every other value is sent:
    one the user chose, a grown window, a mirrored one.
  - **MLX.** The extension no longer invents a window. An explicit one is still clamped to the
    training max. After such a load the app reads the session's window from core
    `context/measure` and writes it into `ctx_len`. That is what the llama.cpp extensions already
    do from `/props` (`2026-10-26-show-the-context-llama-cpp-fitted-…`).
  - **TensorRT-LLM.** The extension schema is the core's again: `context_length` 0, automatic.
  - **Hint.** The context controls show "Up to N on this device" from the plan the core reports
    on capabilities.
- **Consequences:**
  - Fit-off llama.cpp, MLX and Strata now start at the device plan, often several times 16K.
  - fit on a discrete GPU keeps the plan's window instead of shrinking to 4096.
  - A user who picked 16K by hand before this change has no marker and is re-planned once.
  - MLX gets no device hint yet: the capabilities route plans only GGUF files.
  - A TensorRT-LLM install that registered the extension but never loaded a model still stores
    8192.
  - The vendored core schemas must be refreshed at the core pin.
- **Owner:** `team`.
- **Links:**
  - `web-app/src/lib/planned-context-window.ts`, `web-app/src/lib/context-plan.ts`,
    `web-app/src/services/models/default.ts`, `extensions/mlx-extension/src/buildMlxConfig.ts`,
    `extensions/tensorrt-llm-extension/settings.json`.
  - AtomicBot-ai/atomic-chat-core#134.

<!--
Supersedes: 2026-06-15-raise-the-mlx-default-load-context-to-min-train-max-16384.md
-->
