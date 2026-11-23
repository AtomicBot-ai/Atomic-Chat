---
date: 2026-11-16
title: "Keep Strata source acquisition in desktop"
---

# 2026-11-16 — Keep Strata source acquisition in desktop

- **Context:** Strata models comprise several pinned files. Desktop already owns model downloads, and core owns GPU claims, the derived cache, and inference sessions.
- **Decision:** Use a native per-variant acquisition journal in the Strata provider directory. It records the descriptor, source digest, and preparation request ID before transfer. Publish verified sources from staging and pass the same request ID to core across retries. Record readiness after core confirms preparation and retain the previous installation until core completes replacement maintenance.
- **Consequences:** Reopening the UI can recover a saved operation without selecting new files. Provider discovery reads the ready record without rehashing the weights on every refresh. A change of engine build triggers a fresh core check, and core verifies inputs at load. Import preserves the source directory and requires space for a managed copy and the preparation cache.
- **Owner:** Atomic Chat team
- **Links:** [Native installer](../../src-tauri/src/core/atomic_core/strata_models.rs), [Desktop preparation flow](../../web-app/src/services/strata/install.ts), [Local development](../../DEVELOP.md#strata-desktop-development).
