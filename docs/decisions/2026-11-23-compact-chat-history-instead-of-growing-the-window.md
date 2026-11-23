---
date: 2026-11-23
title: "Compact chat history instead of growing the window"
---

# 2026-11-23 — Compact chat history instead of growing the window

- **Context:** When a local chat outgrew its window, the thread showed a hardcoded `Growing the
  Mind...` while the model reloaded with a larger window and then read the whole prompt again.
  - **No feedback:** there was no progress indicator. `updatePromptProgress` had no caller.
  - **Under fit:** llama.cpp's default, growth was declined, so the user got an English error
    asking them to shorten the conversation.
  - **Only part of the engines:** the pre-flight, the token meter and recovery covered the
    llama.cpp family and partly MLX. Every other local engine reached the error card.
  - **Cloud loop:** `canGrowContext` was true for every cloud provider. A matching cloud
    overflow wrote a made-up `ctx_len`, "grew" (`stopModel` does nothing there) and regenerated.
  - **History never shrank:** nothing summarized it. "Shorten history" dropped old turns and kept
    the boundary only in memory.
- **Decision:** A local chat that does not fit is compacted. The core summarizes the oldest turns
  with the loaded model, and the chat goes on without a reload.
  - **One rule:** `decideOverflowAction`, the same function as the core's public server, decides.
    A window grows only on an engine that reloads in seconds (`reload`: llama.cpp family, MLX).
    It grows only while the window is below the device maximum that would hold the request, and
    then straight to that maximum in one reload. Every other overflow is compacted.
  - **Where it runs:**
    - The pre-flight measures every local engine through core `context/measure`.
    - The reactive paths (an overflow error, `finish_reason: length` at the window) use the same
      rule and compact at most once per turn.
  - **Storage:** the summary lives in `thread.metadata.compaction` (`summary`, `upToMessageId`,
    counts). It survives restarts and goes into the system prompt as the core's
    `<conversation_summary>` block. The core carries an earlier summary into the next one.
  - **What the user sees:**
    - **Status:** "Adding context: 16K → 64K" / "Compacting chat history…", with reading
      progress where the engine streams it (llama.cpp `return_progress`).
    - **Divider:** "Earlier messages are summarized" above the first message still sent, with
      the summary behind "Show summary". Earlier messages stay visible.
    - **Buttons:** "Compact history" in the context popover, "Compact and retry" on the error
      card. "Shorten history" stays as the fallback.
  - **Cloud providers** never grow and get no synthetic window.
  - **Older core:** the chat falls back to the previous pre-flight and growth. An older core
    answers the new routes with `INVALID_ARGUMENT` "No such control route".
- **Consequences:**
  - Overflowing chats keep going on llama.cpp, MLX, vLLM, SGLang, TensorRT-LLM, Strata,
    FastFlowLM, GenieX, LiteRT-LM, Foundry Local and Apple Foundation Models.
  - The token meter works on every local engine.
  - Foundation Models now reports `context_length_exceeded` (its Swift server), but the core
    does not compact it yet, because that engine declares no window.
  - **Cost:** a summary is a model call of seconds, longer on single-slot engines. Small models
    write weak summaries; the summary is visible and the drop-turns trim remains.
  - After the core pin, `web-app/src/lib/core-context-contract.ts` is replaced by imports from
    `@atomic-chat/core/contracts`.
  - Not run in the real app yet.
- **Owner:** `team`.
- **Links:**
  - App: `web-app/src/lib/{context-support,core-context,context-compaction,custom-chat-transport}.ts`,
    `web-app/src/components/ContextActivity.tsx`, `web-app/src/containers/CompactionDivider.tsx`,
    `foundation-models-server/Sources/FoundationModelsServer/Server.swift`.
  - Core: AtomicBot-ai/atomic-chat-core#134; core ADR
    `2026-11-23-compact-overflowing-chat-history-on-every-engine.md`.
  - ADRs refined: `2026-09-18-release-chat-after-context-growth-stops.md`,
    `2026-10-26-show-the-context-llama-cpp-fitted-not-the-one-asked-for.md`.
