---
date: 2026-07-24
title: "Schedule Agent batches by resource class"
---

# 2026-07-24 — Schedule Agent batches by resource class

- **Context:** Valid multi-tool Agent steps executed every non-terminal call
  concurrently, despite the existing resource taxonomy requiring serial access
  for stateful same-class tools. The loop tracker also implemented whole-batch
  observation but the runner never invoked it.
- **Decision:** Group non-terminal calls by `ResourceClass`, run `PureRead`
  calls concurrently within their group, serialize every other batchable class,
  and run distinct groups concurrently while restoring outcomes to original
  batch order. Classify vision as its own serial resource and retain the
  terminal-tail barrier. Observe executed multi-call batches as advisory
  composites: emit deduplicated warnings and next-step guidance without vetoing
  calls or advancing the breaker.
- **Consequences:** Independent reads retain fan-out, stateful tools no longer
  overlap with same-class siblings, distinct resources still make concurrent
  progress, and final `reply`/`finish` runs only after all preceding groups.
  Repeated identical batches become visible to the model and activity stream;
  permuted batches remain distinct and composite signals cannot end a turn.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/batch_executor.rs`](src-tauri/src/core/agent/batch_executor.rs),
  [`src-tauri/src/core/agent/resource_class.rs`](src-tauri/src/core/agent/resource_class.rs),
  [`src-tauri/src/core/agent/runner.rs`](src-tauri/src/core/agent/runner.rs),
  [`src-tauri/src/core/agent/runner_tests.rs`](src-tauri/src/core/agent/runner_tests.rs).
