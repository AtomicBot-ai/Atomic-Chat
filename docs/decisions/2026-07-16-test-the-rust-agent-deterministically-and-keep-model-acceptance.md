---
date: 2026-07-16
title: "Test the Rust agent deterministically and keep model acceptance local"
---

# 2026-07-16 — Test the Rust agent deterministically and keep model acceptance local

- **Context:** The autonomous Rust agent needed coverage of its complete
  prompt-decide-execute-observe loop and real OS tool contracts, while a model
  acceptance test must use a large local GGUF and a specific TurboQuant
  backend that are unsuitable for mandatory CI or automatic download.
- **Decision:** Make the default `core::agent` suite deterministic: use a
  scripted loopback `/completion` server for runner tests and isolated local
  workspaces for filesystem, archive, Git, and shell contracts. Add one
  sequential ignored acceptance ritual that starts an
  env-supplied `AtomicBot-ai/atomic-llama-cpp-turboquant` `llama-server`,
  requires the exact
  `unsloth/Qwen3_5-9B-GGUF-Qwen3_5-9B-IQ4_XS` IQ4_XS GGUF, records backend
  provenance, runs all scenarios against one slot, and owns process cleanup.
- **Consequences:** Normal Rust tests need no model, network, or artifact
  download and can run routinely. Model/tool regressions can be checked
  locally against the production-class stack, but that ignored suite depends
  on explicit local paths, GPU/CPU capacity, and operator invocation. CI
  provisioning and automated model/backend downloads remain deferred.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/runner_tests.rs`](src-tauri/src/core/agent/runner_tests.rs),
  [`src-tauri/src/core/agent/tools/contract_tests.rs`](src-tauri/src/core/agent/tools/contract_tests.rs),
  [`src-tauri/src/core/agent/model_e2e.rs`](src-tauri/src/core/agent/model_e2e.rs),
  [`src-tauri/src/core/agent/ARCHITECTURE.md`](src-tauri/src/core/agent/ARCHITECTURE.md).

---
