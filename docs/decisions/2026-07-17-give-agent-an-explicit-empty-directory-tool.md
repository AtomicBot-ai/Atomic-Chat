---
date: 2026-07-17
title: "Give Agent an explicit empty-directory tool"
---

# 2026-07-17 — Give Agent an explicit empty-directory tool

- **Context:** Agent could only approximate empty-directory creation by writing
  an empty placeholder file. The Rust `os.fs.write` contract also rejected
  empty content, so this strategy could fail or oscillate between writing a
  marker and deleting the now-nonempty directory.
- **Decision:** Align `os.fs.write` with the Atomic Agent file contract by
  accepting empty content and append mode. Add approval-gated
  `os.fs.mkdir { path, recursive? }` to the Rust Agent grammar, prompt catalog,
  path policy, resource taxonomy, and executor. Default `recursive` to true.
- **Consequences:** Agent can create a genuinely empty directory without a
  `.gitkeep` artifact, while directory creation remains path-normalized,
  run-scoped approval-gated, and restricted to a length-1 tool-call batch.
  `recursive=false` preserves strict single-level creation semantics.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/tools/fs.rs`](src-tauri/src/core/agent/tools/fs.rs),
  [`src-tauri/src/core/agent/path_policy.rs`](src-tauri/src/core/agent/path_policy.rs),
  [`src-tauri/src/core/agent/prompt.rs`](src-tauri/src/core/agent/prompt.rs).

---
