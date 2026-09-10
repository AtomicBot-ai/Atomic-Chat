---
date: 2026-08-18
title: "Extend Agent mode to MLX and cloud tool providers"
---

# 2026-08-18 — Extend Agent mode to MLX and cloud tool providers

- **Context:** Agent mode ran only on `llamacpp` / `llamacpp-upstream`. The
  limitation was structural, not a policy: `LlamaServerClient` was a concrete
  type wired straight into `run_turn`, `agent_run_turn` resolved sessions only
  from the two llama.cpp plugin state maps, and three frontend gates keyed on
  `isLlamacppProvider`. Meanwhile the agent loop itself — tools, path policy,
  shell guard, approvals, loop guard, batching, sessions — is entirely
  transport-agnostic.
- **Decision:** Introduce `AgentLlmClient`, a four-method trait
  (`probe_model_profile`, `fetch_context_window`, `complete`,
  `describe_images`) plus a capability descriptor, and add one
  OpenAI-compatible implementation alongside `LlamaServerClient`. Route by
  provider, mirroring the conventions the regular chat path already uses rather
  than inventing a third:
  - `llamacpp` / `llamacpp-upstream` → direct `/completion`, unchanged (GBNF
    `grammar`, `cache_prompt`, pinned `slot_id`);
  - `mlx` → direct at the session port, as `ModelFactory.createMlxModel` does;
  - cloud → the Local API Server proxy, as `getLocalApiServerBaseURL` does, so
    the proxy resolves the provider by model id, substitutes its key and custom
    headers, and translates Anthropic `/messages`.

  The tool-call contract is unchanged: the model emits a text JSON array of
  `{tool, args}`. Where a target is known to honour an array-root
  `response_format`, `tool_schema.rs` renders the same catalog as a JSON Schema;
  otherwise the prompt contract plus the existing one-shot repair step carry the
  shape. Native OpenAI `tools`/`tool_calls` is explicitly out of scope.
- **Consequences:**
  - Agent runs work on MLX with no Local API Server dependency, and on any
    registered cloud provider that has an API key. Anthropic works without a
    dedicated client because the proxy already translates it.
  - Agent availability is a **provider**-level question, not a model-level one.
    The `tools` capability is deliberately *not* required: it means "supports
    native OpenAI function calling", which this agent never uses, and it is
    derived from a static table (`getModelCapabilities`) that omits newer and
    custom models. Requiring it would block models that work fine under the
    text-array contract. Whether a model is selected and loaded is checked at
    run time, so the sidebar toggle is not greyed out before the user picks one.
  - No provider credential reaches the agent backend; it only ever holds the
    Local API Server's own key.
  - The prompt is now built as `PromptParts { system, tail }`. llama.cpp still
    receives the byte-identical concatenation — pinned by
    `prompt_parts_concatenate_to_the_legacy_prompt` — so its KV prefix cache is
    unaffected.
  - Chat transports pin `AgentModelProfile::Plain`: `Gemma4Think` hand-emits
    turn framing that a `/v1/chat/completions` server would double-apply. They
    also skip the per-step `/props` probe and take the context window from the
    turn request instead.
  - `supports_array_json_schema` ships with an empty cloud arm on purpose.
    OpenAI historically requires an object-root schema even with
    `strict: false`, so enabling optimistically would burn a failed request per
    turn. Add providers one at a time, each after a live check and with a test.
  - Cloud runs inherit `proxy_timeout` from the Local API Server settings
    (default 600 s, matching the agent's own step deadline). Lowering it in
    Settings will truncate long agent steps.
  - Agent traffic on cloud models now appears in Local API Server logs and
    analytics.
  - Keyless loopback providers (Ollama, LM Studio) are included: they travel the
    same proxy path as cloud providers, and `DataProvider` already registers
    them on exactly the condition the agent gate now uses
    (`api_key || isKeylessRemoteProvider`). `foundation-models` stays excluded
    and fails closed with `AGENT_PROVIDER_UNSUPPORTED` rather than silently
    degrading.
  - Streaming remains out of scope: `run_turn` consumes whole completions and
    never emits `AssistantDelta` from the transport.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/llm_client.rs`](src-tauri/src/core/agent/llm_client.rs),
  [`src-tauri/src/core/agent/openai_client.rs`](src-tauri/src/core/agent/openai_client.rs),
  [`src-tauri/src/core/agent/target.rs`](src-tauri/src/core/agent/target.rs),
  [`src-tauri/src/core/agent/tool_schema.rs`](src-tauri/src/core/agent/tool_schema.rs),
  [`src-tauri/src/core/agent/ARCHITECTURE.md`](src-tauri/src/core/agent/ARCHITECTURE.md),
  [`web-app/src/lib/agent-provider.ts`](web-app/src/lib/agent-provider.ts).

<!--
Supersedes: 2026-07-24-restrict-agent-mode-to-local-llama-cpp-providers.md
-->
