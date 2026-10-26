---
date: 2026-10-26
title: 'Ask before removing a file from a project'
---

# 2026-10-26 — Ask before removing a file from a project

- **Context:** QA 2.2.25 AC-14: in Project → Files the indexed file's row
  action was an icon with no accessible name and no tooltip, visible only on
  mouse hover, and one click dropped the file's indexed copy at once with a
  "File Deleted" toast. Getting it back means uploading and indexing it again.
- **Decision:** The action is named and titled after the file ("Remove
  qa-project-note.txt from project", aria-label and tooltip) and also shows
  on keyboard focus. It opens a confirmation, as deleting a chat, a project or
  an assistant does (`RemoveProjectFileDialog`): it names the file, says the
  file on disk is not deleted, and focuses Remove like those dialogs. The
  toast after removal reads "Removed from project" and names the file. An
  undo toast was not used: the app has no undo for comparable removals, and
  undoing this one means indexing the file again.
- **Consequences:** Removing a file takes two steps. Re-adding it still
  re-indexes it, which can be slow for large files.
- **Owner:** `team`
- **Links:** `web-app/src/containers/ProjectFiles.tsx`,
  `web-app/src/containers/dialogs/RemoveProjectFileDialog.tsx`; QA package
  atomic-chat-e2e-2026-10-23 (AC-14).
