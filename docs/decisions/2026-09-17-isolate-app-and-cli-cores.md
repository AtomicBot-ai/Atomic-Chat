---
date: 2026-09-17
title: "Isolate application and CLI core owners"
---

# 2026-09-17 — Isolate application and CLI core owners

- **Context:** A single owner for the app and CLI made full application exit ambiguous: keeping the core alive leaked app-loaded models, while shutting it down could interrupt CLI clients. It also shared models and secrets across two unrelated lifecycles.
- **Decision:** The application retains its configured data folder and starts a dedicated app-core binary. The CLI keeps its legacy `jan-cli` file name but uses a separate `<system data>/atomic-chat-cli/data` by default and rejects an explicit app folder. Each scope has its own lock, credentials, state and public listener; the application alone shuts its owner down on full exit or when every core flag is off. Window-to-tray does not exit. A crashed app loses its registration and its core stops after the lease expires; the CLI daemon persists until explicit shutdown.
- **Compatibility:** Pin both binaries to 0.2.0 and check the binaries themselves before packaging. The app accepts only its scope and version. Previous app owners are stopped through authenticated control only when process start identity matches and no other registered client blocks shutdown; unknown identity is never killed. No automatic data or secret copying.
- **Handover order:** App auth, provider and public-server commands share the transition gate. Handover takes the extension's ownership gate before the core-call drain gate, so a legacy operation that holds the extension gate can finish its in-flight core call without deadlocking. A failed server start withdraws app-owned sessions only after confirming the listener is stopped; an already-running listener is left untouched.
- **Consequences:** Releases now carry two signed core binaries (app owner and CLI), increasing package size. Models installed in one scope are not visible in the other. Shared legacy app/core ChatGPT token storage is still permitted only while the app hands its own public server between its legacy proxy and app-core; it is never shared with CLI.
- **Owner:** team.
- **Links:** [core decision](../../../atomic-chat-core/docs/decisions/2026-09-17-isolate-app-and-cli-owners.md), [core plan](../../../atomic-chat-core/PLAN.md).

Supersedes: [bundled independent owner](2026-09-15-the-core-is-a-bundled-resource-and-an-independent-owner.md) for app-exit and shared app/CLI ownership.
