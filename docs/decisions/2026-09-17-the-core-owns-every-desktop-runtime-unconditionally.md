---
date: 2026-09-17
title: "The core owns every desktop runtime unconditionally"
---

# 2026-09-17 — The core owns every desktop runtime unconditionally

- **Context:** Stages 3–5 moved llama.cpp upstream, TurboQuant, MLX, Foundation Models and the public API into `atomic-chat-core` behind the `atomic_core` flags, with a serialized handover, runtime-load leases and external-session registration so either side could own a provider. Every migrated method kept its legacy branch, the plugins kept their process tables, and the Rust CLI kept `CLI_IMPL=rust` as a rollback.
- **Decision:** On desktop the core always owns every local runtime and the public API. The flags, handover, leases, external-session registration, legacy session-died event and the Rust CLI are deleted; the session resolver reads only the core mirror; extensions and the webview keep only their core path. The runtime plugins keep utility commands (GGUF metadata, backend selection and catalogue, `check_spec_type_support`, the MLX server version); the Foundation Models plugin, whose only remaining command moved to `GET /runtimes/foundation-models/availability`, is removed. Mobile keeps the app proxy behind `#[cfg(mobile)]` for cloud chat. Local settings in `localStorage` and `settings.json` stay untouched, and the bundled `jan-cli` stays a copy of the core.
- **Consequences:** Rollback is `git revert` only; an old `atomic_core` object in `settings.json` is read and ignored. Engine-settings reset reads the core schema from `web-app/src/lib/core-settings-schema/` (parity test `tests/core-settings-schema.test.mjs`). `tests/desktop-legacy-path.test.mjs` fails if a removed command, flag or plugin process call comes back. Launch arguments are guarded by frozen fixtures only (`tests/capabilities.test.mjs` reads them). Still open: installing a backend from a local archive bypasses the core; Windows upstream packs installed before cudart was bundled are no longer repaired; the macOS launch check of a freshly downloaded backend has no core equivalent; the runtime device is snapshotted once at readiness. Mobile builds could not be compiled locally.
- **Owner:** team.
- **Links:** [phased migration](2026-09-15-migrate-to-the-core-in-phases.md), [jan-cli becomes the core](2026-09-15-jan-cli-keeps-its-name-and-becomes-the-core.md), [lease runtime loads](2026-09-17-lease-runtime-loads-across-handover.md), [stage 6 plan](../../../atomic-chat-core/PLAN.md).

<!--
Supersedes: 2026-09-17-lease-runtime-loads-across-handover.md, 2026-09-17-reconcile-core-server-ownership.md (the handover they govern no longer exists)
-->
