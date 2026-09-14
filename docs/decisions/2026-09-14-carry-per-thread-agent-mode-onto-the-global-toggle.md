---
date: 2026-09-14
title: "Carry per-thread Agent mode onto the global toggle"
---

# 2026-09-14 — Carry per-thread Agent mode onto the global toggle

- **Context:** until v2.0.32 Agent mode was per thread, persisted as
  `agentThreads` in the `agent-mode` store. v2.0.33 replaced it with one global
  `agentModeEnabled` in `setting-general`, defaulting to `false`, and the
  `agent-mode` v3 migration deletes `agentThreads` outright. Nothing carried
  the user's choice across, so everyone running threads on the agent engine was
  silently moved back to the chat pipeline — which is also where agent skills
  stop reaching the model, since chat has no skills catalog. Reported as "since
  the last major update the models can never see any of the new skills".
- **Decision:** add a `setting-general` v3 migration that turns
  `agentModeEnabled` on when the install had Agent mode on for any thread. The
  signal is read by `lib/legacy-agent-mode.ts`, which probes the raw
  `agent-mode` entry at module load *and* accepts a handover from the
  `agent-mode` v3 migration itself, because the two stores hydrate in an order
  nothing guarantees.
- **Consequences:** rescues installs upgrading from v2.0.32 or earlier. It
  cannot rescue anyone already on v2.0.33+ — that migration has already deleted
  the flags from disk and they are unrecoverable; those users have to flip the
  toggle themselves, which is part of why the composer's plugins menu now says
  the system MCP servers are Agent-mode only. Deleting state a later migration
  might need is the pattern to avoid repeating.
- **Owner:** `team`
- **Links:** `web-app/src/lib/legacy-agent-mode.ts`,
  `web-app/src/hooks/useGeneralSetting.ts`, `web-app/src/hooks/useAgentMode.ts`.
