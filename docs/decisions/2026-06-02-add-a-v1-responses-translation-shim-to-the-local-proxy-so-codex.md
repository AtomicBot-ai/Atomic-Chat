---
date: 2026-06-02
title: "Add a `/v1/responses` translation shim to the local proxy so Codex CLI works on llama.cpp models"
---

# 2026-06-02 — Add a `/v1/responses` translation shim to the local proxy so Codex CLI works on llama.cpp models

- **Context:** Codex CLI (added as a Launch integration in the 2026-06-01 ADR
  below) failed at the first turn against a local GGUF model with
  `unexpected status 404 Not Found, url: http://127.0.0.1:1337/v1/responses`.
  Root cause is twofold. (1) Codex speaks **only** the OpenAI **Responses**
  wire protocol: its `model_providers.<id>.wire_api` setting accepts
  `responses` as *the single supported value* and it is the default
  ([Codex config reference](https://developers.openai.com/codex/config-reference)).
  The legacy `wire_api = "chat"` escape hatch was removed, so Codex cannot be
  pointed at a Chat Completions endpoint from its own config — the
  `configure_codex` comment that says as much is correct. (2) The `404` was
  emitted by **our own proxy**, not the backend:
  [`proxy.rs::allowed_methods_for_path`](src-tauri/src/core/server/proxy.rs)
  did not know the `/responses` path, so the request fell through to the
  catch-all `_ =>` arm and returned `404 "Not Found"`. The turboquant /
  upstream llama.cpp backends implement only `/v1/chat/completions`; only the
  MLX sidecar serves `/v1/responses` natively (see §4.1), and even that was
  unreachable because the proxy never routed the path. Net effect: every
  Responses-only client (Codex, and any other tool that hard-codes the
  Responses API) was dead on arrival against the Local API server.
- **Decision:** Implement a bidirectional **Responses ↔ Chat Completions**
  translation shim in the proxy rather than shipping a custom Codex config or
  telling users "MLX only".
  1. **Routing.** `/responses` is added to `allowed_methods_for_path`
     (`POST`) and `endpoint_from_path` (`"responses"`, for analytics) in
     [`proxy.rs`](src-tauri/src/core/server/proxy.rs). A dedicated branch in
     `inner_proxy_request` intercepts `POST /responses` *before* the main
     chat-completions match and dispatches to a new self-contained
     `handle_responses_request`, which **returns early** so the shim never
     threads through the chat-completions auto-increase-ctx retry machinery
     (it has its own forwarding).
  2. **Backend split.** `handle_responses_request` resolves the target with
     the same remote-provider → llama → upstream → MLX precedence as
     `/chat/completions`. Backends that serve Responses natively — the **MLX**
     sidecar and **remote providers** (real OpenAI-compatible endpoints) — get
     a byte-for-byte **passthrough** to their `/v1/responses` (reusing
     `build_streaming_response`). The **llama.cpp** turboquant and upstream
     backends are **translated** to `/v1/chat/completions`.
  3. **Pure transforms.** New module
     [`src-tauri/src/core/server/responses_shim.rs`](src-tauri/src/core/server/responses_shim.rs)
     holds the side-effect-free conversions (unit-tested in `tests.rs`):
     - `responses_request_to_chat` — flattens `instructions` → leading system
       message; `input` (string or typed item array) → chat `messages`,
       mapping `function_call` → assistant `tool_calls`, `function_call_output`
       → `role:"tool"` messages, dropping `reasoning` items; flat Responses
       function tools → nested chat `tools`; `max_output_tokens` → `max_tokens`;
       `text.format` (json_schema/json_object) → `response_format`. Sets
       `stream_options.include_usage` on streaming requests so the final usage
       survives.
     - `chat_response_to_responses` — non-streaming chat JSON → a `response`
       object with `output` items (`message` + `function_call`) and mapped
       `usage` (`prompt_tokens`→`input_tokens`, etc.).
     - `ResponsesStreamConverter` — a stateful chat-SSE → Responses-SSE event
       machine emitting the sequence Codex consumes: `response.created`,
       `response.output_item.added` / `response.content_part.added`,
       `response.output_text.delta`, `response.function_call_arguments.delta`,
       the matching `*.done` events, and a terminal `response.completed`
       carrying the full `output` + `usage`. SSE lines are reassembled from a
       byte buffer split on `\n` (not lossy per-chunk string slicing) so
       multibyte tokens spanning network chunks aren't corrupted.
- **Consequences:**
  - **Codex works on local GGUF models.** `POST /v1/responses` against a
    turboquant/upstream llama.cpp session now streams a valid Responses event
    sequence; `configure_codex` is unchanged (its root `model` /
    `model_provider` + `[model_providers.atomic]` block already point Codex at
    `http://127.0.0.1:1337/v1`, `wire_api` left at the only supported value
    `responses`).
  - **No auto-increase-ctx on the Responses path.** The shim forwards on its
    own and does not participate in the `finish_reason=length` /
    context-limit retry that `/chat/completions` enjoys. Codex manages its own
    context window; revisit if Responses clients start hitting silent
    truncation.
  - **Lossy by design for non-text modalities.** Image/file `input` parts and
    Responses-only `reasoning` items are dropped in the llama.cpp translation
    (Chat Completions has no equivalent reasoning-input slot). MLX/remote
    passthrough preserves full fidelity. Built-in Responses tools
    (`web_search`, etc.) are dropped — only `type:"function"` tools translate.
  - **Model-capability caveat.** Codex needs tool-calling + streaming; a small
    GGUF without function-calling support will surface Codex's own error, not
    a shim failure.
  - **Test coverage.** 6 new unit tests in
    [`tests.rs`](src-tauri/src/core/server/tests.rs) pin the request transform
    (string + item-array + tools), the non-streaming response transform (text
    + tool_call), and the streaming converter (text sequence + tool-call
    sequence). Full `core::server` suite: 60 passing.
- **Owner:** team.
- **Links:** §4 *Inference backends*, the 2026-06-01 ADR *Add a "Launch" page …*,
  [Codex config reference](https://developers.openai.com/codex/config-reference),
  files: [`src-tauri/src/core/server/responses_shim.rs`](src-tauri/src/core/server/responses_shim.rs),
  [`src-tauri/src/core/server/proxy.rs`](src-tauri/src/core/server/proxy.rs)
  (`handle_responses_request`, `allowed_methods_for_path`, `endpoint_from_path`),
  [`src-tauri/src/core/server/mod.rs`](src-tauri/src/core/server/mod.rs),
  [`src-tauri/src/core/server/tests.rs`](src-tauri/src/core/server/tests.rs).
