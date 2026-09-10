---
date: 2026-08-18
title: "Let Agent turns think, and apply the same thinking level chat uses"
---

# 2026-08-18 — Let Agent turns think, and apply the same thinking level chat uses

- **Context:** Agent mode already received and rendered reasoning — `AgentEvent::ReasoningDelta`
  becomes a `{type: 'reasoning'}` part and its own trace block (2026-08-12) — but nothing could
  produce it. `AgentTurnRequest` carried no reasoning field, so neither transport ever asked for a
  thinking phase; the tool-call GBNF root is array-only, so a `Plain`-profile llama.cpp model was
  structurally prevented from emitting one (only `Gemma4Think` has a prelude, 2026-07-24); and the
  chat input hid the control behind `!effectiveAgentMode`. On top of that `disableReasoning`
  defaults to `true` and `buildTraceBlocks` drops every reasoning part while it is on, so with the
  bulb unreachable from an agent thread the block could never appear even where the transport did
  surface `reasoning_content`. Meanwhile chat had a complete stack: one global level, effort
  detection from the chat template (2026-08-14), and a per-provider request-field mapping.
- **Decision:** Reuse the one global control rather than adding a per-thread agent setting — just
  stop hiding it. The level is resolved on the TypeScript side, where the chat-template detection
  already lives, and shipped over IPC as a decision (`enabled`, `budget_tokens`, `effort_value`,
  `supports_thinking`) so the Rust side needs no template heuristics. `supports_thinking: false`
  means "no opinion" and leaves every transport default alone, which is what every cloud model
  looks like; it is deliberately distinct from an explicit off. On llama.cpp's raw `/completion`
  the turn gets a generic `<think>…</think>` GBNF prelude through the existing
  `write_reasoning_prelude`, plus the reasoning-budget sampler armed with
  `reasoning_budget_start_tag` / `_end_tag` / `_message` / `_tokens` and `preserved_tokens` — the
  sampler only builds when both tags are present, only closes the block when a forced message
  exists, and a control-token `<think>` is stripped from `content` unless preserved. On
  OpenAI-compatible transports MLX takes a top-level `reasoning_effort` / `thinking_budget`, and
  cloud targets get nothing when thinking is on, because without a chat template any value would be
  a guess and strict schemas answer 400. The repair completion drops the prelude for the generic
  profile — its budget is a tenth of a step's and a mandatory think block could swallow it — but
  keeps Gemma's, whose channel prelude is native turn framing rather than an effort choice.
- **Consequences:** Local agent runs can finally think, and the effort slider means something on
  every transport that has a knob. Costs: the grammar prelude and the sampler tags must stay
  byte-identical or the budget silently never arms; the `### rules` line changes when thinking is
  on, so toggling the bulb mid-thread invalidates the pinned slot-0 prompt cache once; thinking
  tokens come out of the same completion budget. Watch for models that emit thinking without
  declaring tags in their template (they get no prelude, and `extract_reasoning` handles the stray
  block exactly as before), for a cloud provider rejecting the MLX-shaped fields (a 400 naming one
  of them drops them for the rest of the run and retries once), and for the forced `</think>`
  colliding with a partially consumed GBNF fragment at very small budgets.
- **Owner:** `team`
- **Links:** [`src-tauri/src/core/agent/grammar.rs`](src-tauri/src/core/agent/grammar.rs),
  [`src-tauri/src/core/agent/llm_client.rs`](src-tauri/src/core/agent/llm_client.rs),
  [`src-tauri/src/core/agent/openai_client.rs`](src-tauri/src/core/agent/openai_client.rs),
  [`src-tauri/src/core/agent/runner.rs`](src-tauri/src/core/agent/runner.rs),
  [`src-tauri/src/core/agent/types.rs`](src-tauri/src/core/agent/types.rs),
  [`web-app/src/lib/reasoning-effort.ts`](web-app/src/lib/reasoning-effort.ts),
  [`web-app/src/containers/ChatInput.tsx`](web-app/src/containers/ChatInput.tsx).
  Extends [2026-08-14](2026-08-14-offer-a-thinking-level-only-where-the-chat-template-declares-one.md)
  and [2026-07-24](2026-07-24-frame-gemma-4-agent-turns-with-native-reasoning-channels.md).
