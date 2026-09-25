---
date: 2026-09-21
title: "A factory reset removes the core's folder and keeps every provider's backends"
---

# 2026-09-21 — A factory reset removes the core's folder and keeps every provider's backends

- **Context:** `factory_reset` removes a fixed list of entries from the data folder (`JAN_DATA_SUBDIRS`, `JAN_DATA_FILES`) and sets `llamacpp/backends` aside so that large downloads survive. Both lists predate the inference core. The core's folder, `atomic-core/`, was not on the list: a reset cleared the webview's providers and left `atomic-core/credentials.json` — every cloud provider's API key — and the core's copy of all provider settings on disk; `atomic-chatgpt-auth.json`, the ChatGPT subscription's tokens, stayed as well. And only `llamacpp` (TurboQuant) had its backends kept, while the default provider is `llamacpp-upstream`: its backend was deleted and downloaded again on the next launch. Found by reading the command while writing `tests/e2e/desktop/factory-reset.spec.ts`, which would otherwise have fetched a real backend.
- **Decision:** `atomic-core` joins the removed folders, and `atomic-chatgpt-auth.json` and `local-api-server.json` the removed files. Backends are kept for every provider in `BACKEND_PRESERVING_PROVIDERS` (`llamacpp`, `llamacpp-upstream`), each parked under its own name in the temp dir. The core is already stopped before anything is removed, so its lock and journal are not in use.
- **Consequences:** A reset leaves no credential under the data folder. The core's `optimal-backend.json` goes too and is recomputed; the backends it would choose among are still installed. Files that are not the app's are still left alone — the reset removes named entries, not the folder. Covered by a unit test over a fake data folder and end to end.
- **Owner:** team
- **Links:** `src-tauri/src/core/app/constants.rs`, `src-tauri/src/core/system/commands.rs`, `tests/e2e/desktop/factory-reset.spec.ts`
