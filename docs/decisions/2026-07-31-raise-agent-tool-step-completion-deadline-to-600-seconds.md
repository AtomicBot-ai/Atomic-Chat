---
date: 2026-07-31
title: "Raise the Agent tool-step completion deadline to 600 seconds"
---

# 2026-07-31 — Raise the Agent tool-step completion deadline to 600 seconds

- **Context:** The 180-second wall-clock deadline included prompt processing and
  generation. On slower local hardware, a healthy large prompt could spend most
  of that budget in prompt processing and time out during generation. The
  automatic repair attempt had the same limit, extending the failed run without
  making enough additional time available.
- **Decision:** Raise each Agent tool-step completion attempt from 180 seconds to
  600 seconds. Keep the existing single grammar-constrained repair attempt and
  cancellation behavior unchanged.
- **Consequences:** Healthy slow local generations have more time to finish, and
  the Agent remains bounded to at most two completion attempts per tool step. A
  fully stalled step can now take up to 1,200 seconds before failing.
- **Owner:** team.
- **Links:** [Issue #212](https://github.com/AtomicBot-ai/Atomic-Chat/issues/212),
  [`src-tauri/src/core/agent/runner.rs`](../../src-tauri/src/core/agent/runner.rs),
  [`2026-07-24-constrain-and-bound-agent-tool-call-generation.md`](2026-07-24-constrain-and-bound-agent-tool-call-generation.md).

Supersedes the 180-second duration in
`2026-07-24-constrain-and-bound-agent-tool-call-generation.md`; the remaining
decision is unchanged.
