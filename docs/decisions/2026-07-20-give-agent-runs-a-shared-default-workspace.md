---
date: 2026-07-20
title: "Give Agent runs a shared default workspace"
---

# 2026-07-20 — Give Agent runs a shared default workspace

- **Context:** Agent mode required every new thread to select a working
  directory before its first turn. The Rust request contract already made
  `working_dir` optional, but its fallback was the desktop process current
  directory, while the frontend rejected missing values before IPC.
- **Decision:** Create `<data-folder>/agent-workspace` idempotently during app
  startup and recreate it on demand when an Agent turn omits `working_dir`.
  Keep explicit per-thread workspace selections unchanged and pass an omitted
  value through to Rust when no custom directory is selected.
- **Consequences:** Fresh installs and upgraded profiles share one reliable
  Agent workspace without an initial picker step. Existing custom thread
  workspaces remain authoritative, and changing the configured Atomic Chat
  data folder naturally moves the default workspace root.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/workspace.rs`](src-tauri/src/core/agent/workspace.rs),
  [`src-tauri/src/core/agent/commands.rs`](src-tauri/src/core/agent/commands.rs),
  [`web-app/src/containers/AgentWorkspaceSelect.tsx`](web-app/src/containers/AgentWorkspaceSelect.tsx).

---
