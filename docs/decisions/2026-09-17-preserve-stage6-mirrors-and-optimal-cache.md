---
date: 2026-09-17
title: "Keep app mirrors coherent and import the pre-core optimum"
---

# 2026-09-17 — Keep app mirrors coherent and import the pre-core optimum

- **Context:** Stage 6 makes the core the only desktop API owner. The app still mirrors cloud provider registrations for core recovery, while old TurboQuant installations have an optimal-backend record only in webview localStorage.
- **Decision:** Hold the owner gate until both the core cloud write and app mirror update finish. On first startup with an empty revision-zero core optimal cache, import the validated legacy TurboQuant record using expected revision zero before replacing localStorage. A nonempty or revised core record wins; no automatic import follows an explicit forget.
- **Consequences:** Recovery cannot read a half-updated cloud mirror. Existing recommendations survive upgrade and rollback. If another client wins the revision race, its committed value wins; a failed import leaves the legacy local copy available for another attempt.
- **Owner:** team.
- **Links:** `src-tauri/src/core/server/remote_provider_commands.rs`, `extensions/llamacpp-extension/src/index.ts`.
