---
date: 2026-10-28
title: "Propagate current credentials through each external agent's native configuration"
---

# 2026-10-28 — Propagate current credentials through each external agent's native configuration

- **Context:** Integration regression testing found that Hermes and OpenClaude discarded the local API key, Zed always received a placeholder, and Muse/Poolside commands interpolated shell data without escaping. A remembered launch also appeared as a live connection after server restart.
- **Decision:** Select Hermes's named `custom:atomic-chat` provider and store its key in that provider. Update both OpenClaude startup paths. Replace removed keys with the clients' required nonempty placeholder. Start Zed with the current key in its environment, using `--foreground` for its CLI or the native macOS executable; refuse to reuse a running editor and ask the user to quit it first. Quote terminal arguments and environment values centrally: POSIX literals or a UTF-16LE encoded PowerShell script across the Windows `cmd.exe` boundary. Show configuration and an explicit Connect action, and clear launch history when the server stops.
- **Consequences:** Reconfiguration replaces stale credentials while preserving unrelated profiles. Existing external processes need a restart to adopt new credentials. Atomic Chat does not terminate an editor with unsaved work or claim to observe client liveness. PowerShell payload tests cover special characters, but native Windows and a real Zed editor still require platform validation.
- **Owner:** team.
- **Links:** [Regression report](../qa/2026-10-28-integration-regression.md), [configuration and launch commands](../../src-tauri/src/core/system/commands.rs), [terminal arguments](../../web-app/src/lib/integration-agent-run.ts), [installed-client contract tests](../../tests/e2e/desktop/integration-auth.spec.ts), [Zed API access](https://zed.dev/docs/ai/use-api-access).
