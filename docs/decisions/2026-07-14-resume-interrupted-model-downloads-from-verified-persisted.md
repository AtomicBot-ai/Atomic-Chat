---
date: 2026-07-14
title: "Resume interrupted model downloads from verified persisted offsets"
---

# 2026-07-14 — Resume interrupted model downloads from verified persisted offsets

- **Context:** Large GGUF downloads failed permanently when an HTTP body ended
 early, including the `end of file before message length reached` failure in
 ATO-232. The initial PR retried stream reads but did not fully validate range
 responses, persisted offsets, or final file length.
- **Decision:** Retry transient request and body failures with
 cancellation-aware exponential backoff. Flush the partial file before every
 reconnect, resume from its measured on-disk size, require a matching
 `Content-Range` on `206` responses, and restart from byte zero when the server
 does not support ranges. Reset the retry budget only after 1 MiB of forward
 progress and verify the persisted final size before completion.
- **Consequences:** Interrupted downloads recover without discarding valid
 partial data when the server supports ranges, while non-range servers safely
 restart instead of appending incompatible content. Retry exhaustion and
 malformed range responses now produce actionable errors; cancellation remains
 immediate. Integration tests cover resume, full-restart, and mismatched-range
 paths.
- **Owner:** team.
- **Links:** [ATO-232](https://linear.app/atomicchat/issue/ATO-232),
 [PR #120](https://github.com/AtomicBot-ai/Atomic-Chat/pull/120),
 [`src-tauri/src/core/downloads/helpers.rs`](src-tauri/src/core/downloads/helpers.rs),
 [`src-tauri/src/core/downloads/tests.rs`](src-tauri/src/core/downloads/tests.rs).
