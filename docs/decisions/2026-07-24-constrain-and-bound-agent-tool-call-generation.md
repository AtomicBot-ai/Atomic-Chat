---
date: 2026-07-24
title: "Constrain and bound Agent tool-call generation"
---

# 2026-07-24 — Constrain and bound Agent tool-call generation

- **Context:** Agent completions could satisfy a permissive generic-argument
  grammar with malformed payloads, hallucinate unavailable skill names, or
  spend an unbounded interval generating a tool step. Repeated `skill.view`
  guesses also evaded the URL-oriented wandering-loop detector.
- **Decision:** Build one schema-specific GBNF grammar per turn from the static
  tool catalog, enabled skills, and actual rare tools, and reuse it unchanged
  for normal and repair completions. Apply a 180-second deadline to each
  completion attempt; after an initial timeout, allow exactly one
  grammar-constrained repair capped at 1,024 tokens. Keep user cancellation
  distinct, and classify varying `skill.view` names as wandering with
  skill-specific redirect guidance.
- **Consequences:** Malformed argument shapes and unavailable skill/tool names
  are rejected during generation, while stalled generations terminate within
  a bounded two-attempt window. Runtime validators remain defense in depth.
  The grammar now changes when enabled skills or the rare-tool catalog changes,
  intentionally invalidating that turn's prompt cache prefix.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/grammar.rs`](src-tauri/src/core/agent/grammar.rs),
  [`src-tauri/src/core/agent/runner.rs`](src-tauri/src/core/agent/runner.rs),
  [`src-tauri/src/core/agent/llm_client.rs`](src-tauri/src/core/agent/llm_client.rs),
  [`src-tauri/src/core/agent/loop_guard.rs`](src-tauri/src/core/agent/loop_guard.rs).
