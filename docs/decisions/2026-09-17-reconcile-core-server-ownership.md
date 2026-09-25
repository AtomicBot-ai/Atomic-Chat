---
date: 2026-09-17
title: "Reconcile app-core server ownership before reporting success"
---

# 2026-09-17 — Reconcile app-core server ownership before reporting success

- **Context:** The saved owner flag, the actual public listener and the UI port could diverge when a flags write failed after handover, a stop response was lost, or the app-core restarted. A new app process could also inherit the prior process's same-version core and models.
- **Decision:** Read and commit owner flags under one transition gate. A failed settings write compensates by handing the listener back; if that cannot be confirmed, control/server operations remain blocked until app restart reconciles the old process. Lost stop and start responses are checked against actual listener status before another listener starts; if the incoming status is unknown or still running, fail closed. Keep the last successful server configuration separate from the running intent, restore the listener once for a new core generation, and tell the webview only the confirmed owner and bound port.
- **Lifecycle:** A fresh app process never adopts a previous app-core just because its version matches. It verifies lock, health and start identity, waits up to 55 seconds for an old registration to expire, then requests authenticated shutdown without force. Unknown identity or a still-live client fails closed. Startup with all flags off retires the orphan without starting a replacement. Full exit clears running intent; window-to-tray does not.
- **Consequences:** Restart after a crash can wait for the 45-second client lease, and an ambiguous failed rollback may require restarting Atomic Chat. Recovery does not reload old core-owned model processes; the public listener returns with the currently available app-owned and cloud routes. No secret-bearing configuration route is introduced.
- **Owner:** team.
- **Links:** [core decision](../../../atomic-chat-core/docs/decisions/2026-09-17-bind-cloud-keys-and-lease-cli-operations.md), [stage 4 plan](../../../atomic-chat-core/PLAN.md).
