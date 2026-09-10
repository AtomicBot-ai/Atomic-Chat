---
date: 2026-08-24
title: "Spill oversized observations to the workspace instead of compressing them"
---

# 2026-08-24 — Spill oversized observations to the workspace instead of compressing them

- **Context:** Supersedes
  [2026-07-20 — Compress verbose Agent observations only at the session boundary](2026-07-20-compress-verbose-agent-observations-only-at-the-session-boundary.md)
  for content-bearing tools. The 400-character/12-line tail compressor meant
  the model never saw the body of a fetched page, parsed document, shell
  output, search result, or vision description — a hard blocker for GAIA-style
  research tasks (57% of GAIA L1 is web browsing, 21% is attachments), and its
  only recovery path was re-running the tool against a 25-step budget.
- **Decision:** Content-bearing observations (`os.web.fetch`,
  `os.fs.read_document`, `os.web.search`, `os.shell.run`, `os.http.request`,
  `os.fs.grep`, `os.fs.archive.read_entry`, `vision.describe`, `os.media.*`)
  over 4,000 chars are written in full to `.agent/observations/` inside the
  working dir; the model-visible summary becomes a head(2,600)+tail(1,000)
  preview with an omission marker and a locator naming `os.fs.read
  {path, offset, limit}` and `os.fs.grep {pattern, path}` as the paging and
  in-file search routes (paginated browsing without new tools). The locator's
  cost is inside the preview budget; spill failures fall back to the original
  summary. `os.fs.read` is fully exempt (bounded, model-paged; exemption
  prevents read→spill→read loops). Cheap-to-regenerate listings
  (`os.fs.list/glob/diff`, `os.fs.archive.list`, `os.git.*`, `os.proc.list`)
  keep the legacy tail compressor. Session ceilings moved in lockstep:
  `MAX_TOOL_SUMMARY_CHARS` 1,200 → 4,800, `MAX_SESSION_FILE_BYTES` 512 KiB →
  2 MiB.
- **Model experience:** a spilled result reads as the raw head, `… [omitted N
  of M chars] …`, the raw tail, then one locator sentence; the persona gains
  one line instructing the model to page saved outputs before concluding
  information is absent. Token effect: up to ~4,100 chars per verbose
  observation (was ≤400); the newest-first conversation packer with the
  n_ctx-probed cap evicts older previews, which stay recoverable from disk.
- **Consequences:** Answers buried in the middle of a page or document are
  reachable via targeted `os.fs.read`/`os.fs.grep` instead of lost;
  `ToolOutcome` events and the UI activity trace keep the full bounded output
  as before; workspaces gain a `.agent/` dot-directory.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/spill.rs`](src-tauri/src/core/agent/spill.rs),
  [`src-tauri/src/core/agent/compressor.rs`](src-tauri/src/core/agent/compressor.rs),
  [`src-tauri/src/core/agent/session.rs`](src-tauri/src/core/agent/session.rs),
  [`src-tauri/src/core/agent/runner.rs`](src-tauri/src/core/agent/runner.rs).
