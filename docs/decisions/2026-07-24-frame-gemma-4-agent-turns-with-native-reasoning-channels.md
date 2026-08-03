---
date: 2026-07-24
title: "Frame Gemma 4 Agent turns with native reasoning channels"
---

# 2026-07-24 — Frame Gemma 4 Agent turns with native reasoning channels

- **Context:** Gemma 4 12B could degrade into repeated tokens and expose
  `<|channel>thought` markers after several Agent tool steps. The Rust Agent
  treated every local llama.cpp model as plain instruct, while Gemma 4's chat
  template activates reasoning only when `<|think|>` is inside a native system
  turn and generation begins at the native model-turn opener.
- **Decision:** Detect the Gemma channel template from llama.cpp `/props` and
  select a run-scoped model profile. For that profile, wrap the stable prompt
  in Gemma's native system/model turn tokens, let the model emit its own
  reasoning-channel opener, constrain the completion with a channel-aware GBNF
  prelude whose post-channel whitespace is bounded to eight characters, and
  strip the channel envelope before validating tool-call JSON. Keep the
  existing plain profile as the fail-open fallback when probing or detection
  fails, and preserve the same framing during grammar-repair completions.
- **Consequences:** Gemma 4 Agent turns follow the working Atomic Agent framing
  contract instead of leaking reasoning syntax into replies or drifting in
  unbounded whitespace after tool-heavy context. The `/props` probe adds one
  bounded local request per Agent turn. Other models retain the existing prompt,
  grammar, and parser behavior.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/model_profile.rs`](src-tauri/src/core/agent/model_profile.rs),
  [`src-tauri/src/core/agent/prompt.rs`](src-tauri/src/core/agent/prompt.rs),
  [`src-tauri/src/core/agent/grammar.rs`](src-tauri/src/core/agent/grammar.rs),
  [`src-tauri/src/core/agent/llm_client.rs`](src-tauri/src/core/agent/llm_client.rs),
  [`src-tauri/src/core/agent/runner.rs`](src-tauri/src/core/agent/runner.rs).
