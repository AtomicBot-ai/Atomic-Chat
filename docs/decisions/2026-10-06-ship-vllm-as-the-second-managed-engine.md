---
date: 2026-10-06
title: "Ship vLLM as the second managed engine"
---

# 2026-10-06 — Ship vLLM as the second managed engine

- **Context:** TensorRT-LLM needs NVIDIA driver 615+ and reads only ModelOpt quantizations. The core
  (openspec change `add-vllm-runtime`) runs `vllm serve` from `vllm/vllm-openai:v0.31.0-cu129` as a
  second managed engine on the same environment, with its own descriptor (`runtimes/vllm.json` in
  conf) and the shared model store. The app already drives managed engines from one registry
  (record of the same date).
- **Decision:** vLLM is a registry entry ahead of TensorRT-LLM (`vllm`, label `vLLM`, locale blocks
  `providers.vllm` and `hub.vllm` in en and ru), the extension `@janhq/vllm-extension` built for
  Linux and Windows on `extensions/shared/managed-engine`, `vllm` in `MANAGED_PROVIDERS` in Rust,
  its settings schema vendored from the core, and a Model Hub format before TensorRT-LLM. The
  provider shows only when the core's plan for `vllm` says it can run or be set up — until conf
  publishes `runtimes/vllm.json` the core reports the descriptor unavailable and the extension hides
  it. While another engine's environment operation runs, the vLLM page explains that and keeps
  Install unavailable instead of failing on a conflict.
- **Consequences:** a machine whose driver TensorRT-LLM refuses can still run safetensors models
  (AWQ, GPTQ, compressed-tensors, FP8) through vLLM; a model downloaded once serves both engines.
  The extension keeps the legacy `@janhq/` scope because the installer and
  `tests/pre-install-tarballs.test.mjs` require it. `vllm.svg` is a placeholder monogram until the
  project's own logo (Apache-2.0) is added. The vendored `vllm.json` and the app's `atomicCore`
  pin follow the core release (change task 6.3).
- **Owner:** `team`.
- **Links:** openspec change `add-vllm-runtime` (atomic-chat-spec), spec `vllm-desktop`; rulings
  `openspec/changes/add-vllm-runtime/rulings/app.md`;
  [2026-10-06-drive-managed-engines-from-one-registry-and-one-model-store.md](2026-10-06-drive-managed-engines-from-one-registry-and-one-model-store.md).
