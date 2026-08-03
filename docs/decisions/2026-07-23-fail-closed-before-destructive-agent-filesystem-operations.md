---
date: 2026-07-23
title: "Fail closed before destructive Agent filesystem operations"
---

# 2026-07-23 — Fail closed before destructive Agent filesystem operations

- **Context:** The Rust Agent accepted weakly validated destructive filesystem
  arguments, moved trash targets by renaming them into `~/.Trash`, and could
  request approval for unsafe or malformed paths. A model that intended to
  remove matching Desktop files could therefore substitute the Desktop
  directory itself or fall back to an unrelated shell deletion after trash
  failed.
- **Decision:** Validate and resolve write, mkdir, edit, trash, patch, and
  archive-extract arguments before approval. Publish `os.fs.trash` as a bounded
  exact-path batch, reject protected roots and duplicate targets, and use each
  platform's native trash mechanism. Make replacement writes and edits atomic,
  require patch targets to remain relative and dry-run immediately before
  apply, and preflight archive entries against traversal, links, special files,
  output conflicts, entry-count, per-entry-size, and total-size limits.
- **Consequences:** Invalid calls cannot produce an approval prompt or mutate
  the filesystem. Trash failures identify the failing batch item and completed
  count, file replacement avoids partial content, and archive extraction
  defaults to no overwrite. Existing single-path trash calls remain executable
  through compatibility normalization, while `os.shell.run` and its current
  `rm` policy remain unchanged by explicit scope.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/path_policy.rs`](src-tauri/src/core/agent/path_policy.rs),
  [`src-tauri/src/core/agent/tools/fs.rs`](src-tauri/src/core/agent/tools/fs.rs),
  [`src-tauri/src/core/agent/tools/archive.rs`](src-tauri/src/core/agent/tools/archive.rs),
  [`src-tauri/src/core/agent/tools/mod.rs`](src-tauri/src/core/agent/tools/mod.rs),
  [`src-tauri/src/core/agent/prompt.rs`](src-tauri/src/core/agent/prompt.rs).

---
