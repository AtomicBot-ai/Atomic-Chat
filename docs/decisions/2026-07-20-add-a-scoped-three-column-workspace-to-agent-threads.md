---
date: 2026-07-20
title: "Add a scoped three-column workspace to Agent threads"
---

# 2026-07-20 — Add a scoped three-column workspace to Agent threads

- **Context:** Agent threads could operate on a selected workspace and link
  generated files, but users had no persistent workspace tree or shared place
  to inspect files and HTML artifacts alongside the conversation.
- **Decision:** On desktop Agent threads, render resizable
  `Chat → Preview → Files` columns. Keep Files permanently visible and open
  deduplicated file tabs plus the existing HTML artifact in one conditional
  preview host. Expose separate read-only Agent workspace IPC commands for
  lazy directory listing, file metadata, and bounded UTF-8 text reads; resolve
  every target against the selected or default workspace and reject traversal
  and symlink escapes after canonicalization.
- **Consequences:** Agent users can browse directories and preview text,
  images, PDFs, unsupported files, and HTML artifacts without leaving the
  thread. Ordinary Chat and narrow-screen layouts retain the existing artifact
  panel, file changes are not permitted through this surface, and text preview
  remains bounded and UTF-8-only.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/commands.rs`](src-tauri/src/core/agent/commands.rs),
  [`web-app/src/containers/AgentWorkspaceLayout.tsx`](web-app/src/containers/AgentWorkspaceLayout.tsx),
  [`web-app/src/containers/AgentWorkspaceFiles.tsx`](web-app/src/containers/AgentWorkspaceFiles.tsx),
  [`web-app/src/containers/AgentWorkspacePreview.tsx`](web-app/src/containers/AgentWorkspacePreview.tsx),
  [`web-app/src/stores/workspace-preview-store.ts`](web-app/src/stores/workspace-preview-store.ts).

---
