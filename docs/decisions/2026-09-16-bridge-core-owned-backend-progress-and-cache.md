---
date: 2026-09-16
title: "Bridge core-owned backend work into existing app events"
---

# 2026-09-16 — Bridge core-owned backend work into existing app events

- **Context:** The core takes ownership of upstream backend installation and embeddings in stages 3c–3d, while the download bar and BackendUpdater already consume legacy app events. Retrofitting those listeners would make rollback and mixed-version behavior fragile.
- **Decision:** When the core owns `llamacpp-upstream`, the extension subscribes to `download-<taskId>` before submitting an install, translates progress and terminal results into the existing `DownloadEvent`/`AppEvent` shapes, and unsubscribes on completion or failure. The Rust relay emits that legacy per-task progress event alongside the core event. Cancellation goes to the core only for a core-owned backend task; legacy tasks keep their original Rust command. The app treats the core's revisioned optimal cache as authoritative, copies a cursor-consistent snapshot into `localStorage`, waits for a successful compare-and-set before showing a new result, and adopts the current state on conflict. Core-owned embeddings use the core route; the legacy algorithm remains for rollback.
- **Consequences:** Existing UI listeners need no changes and a cancelled or failed install closes the same row as a legacy download. A lost mutation response is not retried because installation or cache writes may already have committed. The app and core must ship as a matched pair for these internal routes; the public OpenAI API and legacy package names remain unchanged. A cache moved to new hardware still needs an explicit invalidation policy.
- **Owner:** team.
- **Links:** `src-tauri/src/core/atomic_core/{commands,relay}.rs`, `extensions/download-extension/src/index.ts`, `extensions/llamacpp-upstream-extension/src/{index,adapter/coreRuntime}.ts`, `../atomic-chat-core/docs/decisions/2026-09-16-revision-optimal-cache-and-complete-internal-control-routes.md`.
