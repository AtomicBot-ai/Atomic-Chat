---
date: 2026-10-15
title: "Hide Agent mode; every turn runs on the chat pipeline"
---

# 2026-10-15 — Hide Agent mode; every turn runs on the chat pipeline

- **Context:** Agent mode is the opt-in route to the Rust agent loop (`agent-ipc`,
  `2026-08-27-unify-chat-and-agent-on-the-agent-engine.md`). It is not finished
  as a product, and the one thing users wanted from it in chat — running a
  command or a script — now exists in the chat pipeline itself
  (`2026-10-15-run-commands-and-scripts-from-chat.md`). Installs migrated by
  `2026-09-14-carry-per-thread-agent-mode-onto-the-global-toggle.md` may have
  `agentModeEnabled` persisted as `true`, so removing the toggle alone would
  strand them on the agent engine with no way to turn it off.
- **Decision:** A new `PlatformFeature.AGENT_MODE`, `false` on every platform,
  gates the mode. `isAgentModeOn(state)` (`hooks/useGeneralSetting.ts`) is the
  only way the app reads the flag: the send-time and render-time routing, the
  composer chip and "+" item, the files panel and the plugins menu's "system
  servers are Agent-mode only" note. Settings → General hides "Legacy chat
  engine", which only meant something next to Agent mode. The persisted
  `agentModeEnabled` is left exactly as the user had it (the lesson of
  2026-09-14: never delete state a later release may need).
- **Consequences:** Every turn routes to `chat-transport` with reason
  `default-chat`. The agent engine, its commands and its tests stay; tests that
  exercise it switch the feature on. Bringing the mode back is flipping the
  flag. The composer's approval select stays, because it governs chat tool
  calls too. The TensorRT-LLM spec requirement that the app disable Agent mode
  for models without tool calling (`atomic-chat-spec`,
  `tensorrt-llm-desktop/spec.md`) has nothing to act on while the mode is
  hidden; the spec is updated in its own repository.
- **Owner:** `team`
- **Links:** `web-app/src/lib/platform/const.ts`,
  `web-app/src/hooks/useGeneralSetting.ts` (`isAgentModeOn`),
  `web-app/src/lib/thread-execution-route.ts`,
  `web-app/src/hooks/useMessageExecutionRoute.ts`,
  `web-app/src/containers/ChatInput.tsx`, `web-app/src/routes/settings/general.tsx`.
