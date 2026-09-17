---
date: 2026-09-17
title: "Lease runtime loads across owner handover"
---

# 2026-09-17 — Lease runtime loads across owner handover

- **Context:** Stage 5 hands TurboQuant, MLX and Foundation Models between legacy plugins and the core. A load can still be preparing settings or starting a child when neither owner has published a session, so checking session lists alone can approve a handover that leaves the child with the old owner.
- **Decision:** Each desktop extension reserves its provider under the same transition gate that changes runtime ownership before beginning a load and releases the reservation in `finally`. Handover rejects while a changed provider has a load reservation; it continues to check published sessions as before. A missing desktop command on mobile leaves the existing legacy load path intact.
- **Consequences:** A concurrent handover fails visibly and can be retried after the load settles. If the webview disappears before `finally`, the reservation remains until app restart, conservatively blocking that provider's handover rather than allowing an orphan. No public API or provider setting changes.
- **Owner:** team.
- **Links:** `src-tauri/src/core/atomic_core/commands.rs`, `extensions/shared/atomicCoreRuntime.ts`, `extensions/llamacpp-extension/src/index.ts`, `extensions/mlx-extension/src/index.ts`, `extensions/foundation-models-extension/src/index.ts`.
