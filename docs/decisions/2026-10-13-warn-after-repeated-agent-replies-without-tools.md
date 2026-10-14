---
date: 2026-10-13
title: "Warn after repeated Agent replies without tools"
---

# 2026-10-13 — Warn after repeated Agent replies without tools

- **Context:** A model may promise actions in Agent mode but only reply in text. Native function-calling capability alone cannot diagnose this: the Agent loop uses its own text tool contract, and a normal answer may legitimately need no tools.
- **Decision:** After two consecutive successful, nonempty Agent replies without nonterminal tool calls on the same provider/model in one thread, show an advisory with a model-picker suggestion and an explicit action to turn off Agent mode. Exclude reply/finish pseudo-tools. Reset the counter after tools, errors, cancellation, exhausted steps or a model change. Count terminal notifications once. Do not inspect prompt text or automatically change routing or approval modes.
- **Consequences:** This is evidence of repeated no-tool behavior, not a claim of incompatibility. A single answer never warns. The bounded counter is session-local; the warning boolean survives in the existing message summary so reopening the message preserves the explanation. The fallback follows the existing global Agent toggle and is offered only on the latest message while Agent mode is enabled. No new telemetry, model capability inference, dependency or backend protocol is introduced.
- **Owner:** @plombeer31.
- **Links:** ATO-506; `web-app/src/hooks/useAgentRun.ts`; `web-app/src/containers/AgentNoToolsWarning.tsx`; ADR 2026-08-18 (Agent text tool contract).
