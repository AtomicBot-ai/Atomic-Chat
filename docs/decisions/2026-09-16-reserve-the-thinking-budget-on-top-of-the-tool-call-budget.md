---
date: 2026-09-16
title: "Reserve the thinking budget on top of the tool-call budget"
---

# 2026-09-16 — Reserve the thinking budget on top of the tool-call budget

- **Context:** An agent step asks the model server for one completion that
  holds the thinking block and the tool-call array, and both draw from the
  same output cap: `n_predict` on llama.cpp's `/completion`, `max_tokens` on
  the chat transports (mlx-vlm counts thinking tokens against it too). The
  cap was the tool-call budget alone (`COMPLETION_MAX_TOKENS`, 8,192), while
  the web-app maps the reasoning level to a thinking budget of 256 / 1,024 /
  4,096 / 8,192 tokens (`low` … `xhigh`) or no cap (`max`). At `xhigh` a model
  that used its budget had zero tokens left for the array, and at `max` any
  long thought did the same; the step then failed with the `budget` category
  the previous record introduced, which named this gap and pointed at the
  request builder. The conversation cap reserved the same 8,192, so the
  prompt was sized as if no thinking would happen.
- **Decision:** The step's completion budget is the tool-call budget plus a
  thinking reserve, computed once per turn in the runner and used for both
  the request's `max_tokens` (hence `n_predict` / `max_tokens` on every
  transport) and the context reservation in
  `compute_effective_conversation_cap`, so prompt plus completion still fit
  `n_ctx`. The reserve is the level's budget when it has one. For the
  uncapped level it is the top finite tier (8,192): a reservation must be a
  finite number to size the prompt against, and the sampler budget itself
  stays `-1` so `max` keeps its meaning — the same headroom as `xhigh`, and
  the model may still think past it into the tool-call budget. The web-app's
  level-to-budget mapping is unchanged. The repair completion inherits the
  step's total as before: it is a cap, not a spend, and on a native-channel
  model (Gemma) the repair keeps its prelude and needs the reserve.
- **Consequences:** At every finite level the array always has its full
  8,192 tokens after the block closes, and `n_predict` grows by the budget
  (16,384 at `xhigh` and `max`). The conversation cap shrinks by the same
  amount on thinking turns, so older turns are dropped sooner; on a 16k
  context `xhigh` / `max` leaves no room at all and the cap sits at its
  512-token floor — such a context could never hold the prompt plus both
  blocks, and the step failed there before too, only later and with less
  history to blame. Offering only the levels a context can hold is a
  web-app follow-up, not part of this record. `max` is
  best-effort by design: a thought longer than 8,192 tokens eats into the
  array's budget and past 16,384 the step still fails as `budget`, and the
  message already tells the user to lower the level. The alternative —
  arming the sampler with the reserve at `max` — would have made `max` and
  `xhigh` identical on the agent path and was rejected for that reason. The
  `OutputTruncated` message now reports the combined limit.
- **Owner:** @danyurkin.
- **Links:** [`src-tauri/src/core/agent/token_budget.rs`](../../src-tauri/src/core/agent/token_budget.rs),
  [`src-tauri/src/core/agent/runner.rs`](../../src-tauri/src/core/agent/runner.rs),
  [`web-app/src/lib/reasoning-effort.ts`](../../web-app/src/lib/reasoning-effort.ts),
  closes the request-builder gap named in
  [2026-09-15 Classify a cut-off tool call by its cause and give the repair the step's budget](2026-09-15-fail-truncated-tool-calls-as-budget-and-size-the-repair.md).
