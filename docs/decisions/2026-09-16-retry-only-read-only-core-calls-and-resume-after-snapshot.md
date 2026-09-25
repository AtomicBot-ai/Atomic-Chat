---
date: 2026-09-16
title: "Retry only read-only core calls and resume events after the snapshot cursor"
---

# 2026-09-16 — Retry only read-only core calls and resume events after the snapshot cursor

- **Context:** The app reaches `atomic-chat-core` through loopback HTTP and keeps a local mirror from
  a snapshot plus SSE deltas. A lost HTTP response does not prove that the core did not apply the
  request, and a resync cursor received before a later snapshot does not describe that snapshot.
  Retrying every request could therefore apply a mutation twice; continuing SSE from the resync
  frame could apply events already represented in the snapshot or skip events emitted while the
  snapshot was being read.
- **Decision:** After an ambiguous transport failure the supervisor retries only `GET` and `HEAD`;
  mutating methods invalidate the attachment and return the original error. Model load has no Rust
  client deadline because the core owns its provider-specific readiness timeout. Every event mirror
  starts from a snapshot whose `instance_id` and cursor are validated. On resync the app discards
  the old mirror, fetches a fresh snapshot, closes the old stream and reconnects from the snapshot's
  cursor. The SSE parser buffers bytes and decodes only complete frames, so network chunk boundaries
  cannot corrupt UTF-8.
- **Consequences:** A caller may need to reconcile an ambiguous mutation from a fresh snapshot rather
  than receiving an automatic answer, but the app never silently performs it twice. Snapshot and
  events form one ordered state stream, and a failed snapshot cannot be followed by unbased deltas.
  Any future long-running control route must opt into core-owned timeout semantics explicitly.
- **Owner:** team
- **Links:** `src-tauri/src/core/atomic_core/{client,supervisor,relay}.rs`
