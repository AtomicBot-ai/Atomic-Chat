---
date: 2026-09-15
title: "Classify a cut-off tool call by its cause and give the repair the step's budget"
---

# 2026-09-15 — Classify a cut-off tool call by its cause and give the repair the step's budget

- **Context:** A tool-call array that never closes surfaced as
  `grammar: invalid model server response: Repair failed: invalid tool-call
  completion: tool-call JSON value is incomplete` (Discord, Linux AppImage,
  local llama.cpp). Under GBNF the shape cannot be wrong, so an unclosed array
  means generation was stopped. llama-server reports why (`stop_type`), but
  the client never read it, and the repair completion was pinned to 1,024
  tokens regardless of the batch it had to re-emit. A batch with long
  `content` arguments therefore failed twice for the same reason and blamed
  the grammar. `CompletionResult::truncated` meant prompt truncation on
  llama-server and `finish_reason == "length"` on chat transports, and had no
  reader.
- **Decision:** Replace `truncated` with `stop_reason: StopReason` (`Eos`,
  `Word`, `Limit`, `Unknown`) plus `prompt_truncated`, normalized from
  llama-server's `stop_type` + `truncated` and from chat `finish_reason`.
  Keep the single repair round trip for every parse failure — it drops the
  thinking prelude and carries the array shape on transports without GBNF, so
  it can rescue a cut-off step. When the repair output does not parse and the
  server stopped on `Limit`, fail with the cause: `ContextOverflow`
  (category `context`) if the prompt was truncated too, otherwise the new
  `OutputTruncated` (category `budget`) naming the budget and the two things a
  user can change (a smaller step, a lower reasoning level). Give the repair
  the step's budget less the repair block it appends, so prompt plus
  completion still fit the context the step reserved; keep the 1,024-token
  cap only when there is nothing to re-emit (a timed-out or empty step). The
  repair echoes the batch after the reasoning prelude, not the prelude, and
  returns its completion so turn usage counts the repair's tokens and the next
  repair echoes the latest output.
- **Consequences:** Users see what happened instead of a parser message, and
  the repair can now finish a long batch. A repair may run for as long as a
  step (bounded by the same 600 s deadline), so a doomed retry costs more time
  than the old 1,024-token cap allowed. `budget` is a new step-error category;
  the UI renders `category: message` verbatim. Two known gaps stay open: on
  thinking models the reasoning budget draws from the same `n_predict` as the
  tool call, so `xhigh` / `max` effort can consume the step budget before the
  array starts (fix at the request builder, tracked separately); and a cut-off
  final `reply` still fails the turn instead of shortening it (ATO-432 item 3).
- **Owner:** @danyurkin.
- **Links:** ATO-432 (sibling repair failure),
  [`src-tauri/src/core/agent/runner.rs`](../../src-tauri/src/core/agent/runner.rs),
  [`src-tauri/src/core/agent/llm_client.rs`](../../src-tauri/src/core/agent/llm_client.rs),
  [`src-tauri/src/core/agent/openai_client.rs`](../../src-tauri/src/core/agent/openai_client.rs),
  supersedes the fixed 1,024-token repair cap in
  [2026-07-24 Constrain and bound Agent tool-call generation](2026-07-24-constrain-and-bound-agent-tool-call-generation.md).
