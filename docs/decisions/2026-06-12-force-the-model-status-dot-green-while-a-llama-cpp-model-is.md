---
date: 2026-06-12
title: "Force the model-status dot green while a llama.cpp model is running (drop the misleading \"doesn't work on your device\" red)"
---

# 2026-06-12 — Force the model-status dot green while a llama.cpp model is running (drop the misleading "doesn't work on your device" red)

- **Context:** The header model-status dot
 ([`ModelSupportStatus`](web-app/src/containers/ModelSupportStatus.tsx)) for the
 `llamacpp` / `llamacpp-upstream` providers is driven by a **static**
 `serviceHub.models().isModelSupported(path, ctxSize)` probe → GREEN/YELLOW/RED
 with tooltip "Works Well / Might work / Doesn't work on your device (ctx: N)".
 That estimate is keyed off the **configured** context size, so a model with
 ctx set to 16k–32k shows RED even though it loads and runs fine in practice
 (the user rarely reaches that context, and runtime context overflow is
 already surfaced by a dedicated error). PM: while the model is actually
 running, the dot must always be green. (MLX already worked this way — its
 status is derived from `activeModels`.)
- **Decision:** Mirror the MLX behaviour for the llama.cpp providers. Added
 `isModelRunning = !!modelId && activeModels.includes(modelId)`
 (`activeModels` is populated from `getActiveModels()`, which queries the local
 engines, so a running GGUF model's id is present). In the llama.cpp support
 effect, short-circuit to `GREEN` when the model is in `activeModels` and skip
 the static ctx probe (effect dep list gains `activeModels`). The GREEN tooltip
 now reads "Model is running" when running, else keeps "Works Well on your
 device (ctx: N)". The pre-start probe (GREEN/YELLOW/RED) is unchanged when the
 model is **not** running — the red hint still helps before load.
- **Consequences:** No more red "doesn't work" dot for a model that is in fact
 loaded; changing the ctx slider while running no longer flips the dot to red.
 Context-overflow feedback is unaffected (separate runtime error). Display-only
 — no engine/IPC/store change. Verified: `tsc -b` clean, `eslint` clean.
- **Owner:** team.
- **Links:** files:
 [`web-app/src/containers/ModelSupportStatus.tsx`](web-app/src/containers/ModelSupportStatus.tsx).
