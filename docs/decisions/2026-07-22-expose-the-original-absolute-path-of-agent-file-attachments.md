---
date: 2026-07-22
title: "Expose the original absolute path of Agent file attachments"
---

# 2026-07-22 — Expose the original absolute path of Agent file attachments

- **Context:** Agent turns received a safe `attachment://` reference to the
  staged copy, but could not identify the original file selected through the
  composer when a workflow explicitly needed that location.
- **Decision:** Keep staging and the trusted `attachment://` reference
  unchanged, and additionally include the canonical absolute source path as
  `original_path` in the attachment manifest for file attachments. Continue
  representing in-memory image attachments with `original_path=null`.
- **Consequences:** Agent can refer to the user-selected source file directly,
  including for approval-gated operations outside its workspace. The model
  context now exposes local path information such as the OS username and
  directory layout; staged copies remain the preferred read path and the
  original file is not added to the trusted attachment root.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/attachments.rs`](src-tauri/src/core/agent/attachments.rs).

---
