---
date: 2026-09-30
title: "Run Agent turns on TensorRT-LLM through its session gateway"
---

# 2026-09-30 — Run Agent turns on TensorRT-LLM through its session gateway

- **Context:** A `tensorrt-llm` session is `trtllm-serve` in a container behind the core's session gateway, which checks the session's Bearer key and refuses what the model's family does not declare: `tools`, and a JSON `response_format` unless the family has structured output. Its context is fixed at load; the core never grows it. The Rust agent had routes for llama.cpp, MLX and cloud providers only, so it answered `AGENT_PROVIDER_UNSUPPORTED` for this engine.
- **Decision:** The agent drives a `tensorrt-llm` session like MLX's, over the session's OpenAI-compatible endpoint with its key, as a target kind of its own (`OpenAiTargetKind::LocalTensorrtLlm`): no `response_format` (the agent does not know the family; the prompt contract and the repair step carry the tool-call shape, as for cloud targets), no vision, no context growth, and reasoning turned off only through `chat_template_kwargs: {enable_thinking: false}`, the field the core's live test shows the engine reading. `tensorrt-llm` is in the web-app's `AGENT_LOCAL_PROVIDERS`; whether one model can call tools is checked per model before a run.
- **Consequences:** Agent works on TensorRT-LLM models whose family has a tool parser. A family whose template ignores `chat_template_kwargs` keeps thinking on in agent turns. Adding `reasoning_effort` or a budget waits for evidence that the engine reads them.
- **Owner:** `team`
- **Links:** `src-tauri/src/core/agent/target.rs`, `src-tauri/src/core/agent/openai_client.rs`, `web-app/src/lib/agent-provider.ts`; `atomic-chat-spec` change `add-tensorrt-llm-linux` (ruling `R-app-2`).
