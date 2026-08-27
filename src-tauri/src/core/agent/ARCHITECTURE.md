# Atomic Chat Agent Architecture

Living engineering reference for the autonomous Rust agent in this directory.
Update this document when the agent loop, tool contract, safety policy, or
iteration scope changes. Product-wide decisions still belong in the repository
decision log in `AGENTS.md`.

## Status and scope

The agent backend is isolated from regular Atomic Chat conversations and from
the Vercel AI SDK path. It runs on local llama.cpp, local MLX, and cloud
providers that support tool calling.

Iterations 1 and 1b are implemented. Agent turns also accept bounded local
file and image attachments, the thread assistant's instructions and sampling,
and the user's connected MCP servers as dynamic `mcp.*` tools. Memory, tasks,
browser automation, window control, and filesystem watchers are deferred.

## Current architecture

### Entry points and transport

- `agent_run_turn` starts a bounded agent turn and streams `AgentEvent` values
  over a Tauri IPC channel.
- `agent_cancel_turn` cancels a run by its caller-provided `run_id`.
- `agent_resolve_approval` resolves a pending approval by its generated
  approval id.
- `AgentLlmClient` is the transport seam. The loop needs exactly four things
  from a model — a prompt profile, a context window, one completion, and image
  description — and never branches on which transport provides them.
  `AgentClientCapabilities` tells the loop which constraint artefacts to build.
- `target::resolve_agent_target` picks the transport from the request's
  `provider`, mirroring the conventions of the regular chat path:
  - `llamacpp` / `llamacpp-upstream` → `LlamaServerClient`, calling the active
    session's `/completion` directly with the static tool grammar,
    `cache_prompt`, and a stable slot id. The Local API Server is not involved.
  - `mlx` → `OpenAiCompatibleClient` pointed at the `mlx-server` session port,
    so a fully local run needs no proxy.
  - cloud → `OpenAiCompatibleClient` pointed at the Local API Server, which
    resolves the provider by model id, substitutes its key and custom headers,
    and translates Anthropic `/messages`. No provider credential reaches the
    agent.
  - `foundation-models` and keyless loopback providers are rejected explicitly.
- Image analysis uses a separate, non-streaming `/v1/chat/completions` request
  to the same target. It never uses the grammar-constrained agent slot.
  `has_vision` comes from `mmproj_path` for llama.cpp and from the model
  capabilities in the turn request for every other target.
- Chat transports are non-streaming, pin `AgentModelProfile::Plain` (the server
  applies the model's own chat template, so hand-emitted turn framing would
  double-apply), and take the context window from the turn request because
  there is no portable `/props` equivalent.

### Prompt and grammar

- The prompt is built as `PromptParts { system, tail }`. llama.cpp sends the
  concatenation, byte-identical to the pre-split rendering; chat transports send
  `system` and `tail` as separate system and user messages so provider-side
  prefix caches can key on the stable half.
- The stable prompt prefix contains the persona, rules, tool catalog,
  capabilities, and instructions.
- Frequent tools expose their complete argument schema in the stable prefix.
- Rare tools expose a one-line catalog entry until `tool.view` loads their
  complete descriptor.
- The variable tail contains loaded rare descriptors, the conversation, an
  optional loop notice, and the response marker.
- Tool output is constrained by an array-only GBNF root. One tool call is a
  one-element array; a step may contain up to eight calls at runtime.
- When the turn asks for thinking, the root gains one reasoning prelude ahead of
  the array: the profile's native channel where it has one, a generic
  `<think>...</think>` pair otherwise. The same tags arm llama.cpp's
  reasoning-budget sampler and are sent as `preserved_tokens`, so the three must
  stay identical. The repair completion drops the generic prelude — its budget is
  a tenth of a step's — but keeps a native channel, which is turn framing.
- On OpenAI-compatible transports there is no GBNF. `tool_schema.rs` renders the
  same catalog as a JSON Schema for `response_format`, pinning the array shape
  and the tool-name enum but leaving `args` open — the prompt and
  `authorize_call` already cover argument shape. It is sent only to targets
  known to accept an array-root schema; `supports_array_json_schema` ships with
  an empty cloud arm on purpose, because OpenAI historically requires an object
  root. Where it is absent, the prompt contract and the one-shot repair step
  carry the shape. A target that rejects the schema at runtime degrades once
  per run and continues without it.
- The prompt catalog, grammar tool-name set, and JSON-schema tool-name set must
  remain identical.

### Dynamic MCP tools

- `mcp_tools::snapshot_catalog` freezes the connected servers' tools **once per
  turn** (ATO-271 discipline: peers cloned under the lock, 5s per-server
  listing timeout, failed servers skipped). The set is stable for every step of
  the turn; drift costs one KV-prefix re-ingest at the next turn boundary.
- Agent-facing names are `mcp.<server-slug>.<tool>` (cap 96 chars, collision
  suffixes); the reverse mapping lives only in the catalog — names are never
  parsed. `mcp.` is a reserved namespace, pinned by test.
- The catalog is capped at 64 tools; the `exa` server is excluded (the built-in
  `os.web.search` / `os.web.fetch` already call the same hosted endpoint). The
  frontend's per-thread `server::tool` disables filter the snapshot.
- Prompt: one-line `# mcp` entries under `### tools` (12 000-char budget);
  `tool.view` loads a full schema into `### loaded-tools` (2 500 chars each).
- Grammar/schema: an `mcp-call` alternation with a generic `json-object` args
  rule — argument shape is validated by the serving MCP server and previewed
  for approval, mirroring the open `args` object on the JSON-schema path.
- Resource classes: `readOnlyHint` ⇒ `McpRead` (batchable, serialized within
  its group — the hint is untrusted); everything else ⇒ `ApprovalGated` with
  `Always allow` fingerprints. `auto_approve_mcp` (the migrated chat
  `allowAllMCPPermissions`, default true) bypasses the gate for MCP-origin
  tools only, never for built-in shell/fs tools.
- Dispatch goes through the `McpBridge` trait (`LiveMcpBridge` in production,
  a scripted bridge in `runner_tests`), with the MCP per-call timeout and the
  run's cancellation token; a dead server yields a structured "do not retry"
  error outcome.

### Per-turn parity inputs

- `assistant_instructions` renders as the final `### assistant` stable-prefix
  section (8 000-char cap) so the common prefix stays byte-identical across
  threads for KV-cache sharing.
- `sampling` + `sampling_overridden` apply the assistant's sampler (clamped)
  only when the user explicitly tuned it; the agent's calibrated defaults
  remain otherwise. Constrained decoding masks logits before sampling, so any
  temperature stays shape-safe.
- `web_search: false` filters `os.web.search` / `os.web.fetch` out of the
  prompt, grammar, schema, and dispatch for the turn.
- `agent_session_reseed` rebuilds the durable transcript from the frontend's
  authoritative message list after history mutations: a prefix match appends
  (tool observations survive), divergence rebuilds (observations drop).
  `turn_count` is monotonic either way; PTY processes are untouched.
- The llama.cpp transport streams: reasoning deltas live, and `reply.args.text`
  is recovered incrementally from the constrained JSON stream
  (`reply_stream.rs`). The parsed completion stays authoritative and
  `AssistantReply` reconciles scanner drift. `turn_finished` carries
  aggregated `usage` (tokens in/out, tps, ttft).

### Loop and execution

The loop is:

1. Build the prompt.
2. Request one grammar-constrained completion.
3. Parse and validate the tool-call array.
4. Run the synchronous loop guard.
5. Execute valid calls according to resource class.
6. Append compressed observations.
7. Continue until `reply`, `finish`, cancellation, breaker, failure, or the
   step limit.

Pure reads may run concurrently. Mutating and stateful classes are serialized.
Approval-gated tools cannot appear in a multi-call batch. A terminal tool is
valid only as the final call and executes after all preceding calls finish.

### Safety controls already present

- Array-only GBNF tool grammar.
- Runtime batch-size and step limits.
- Resource-class validation.
- Repeat, no-progress, and wandering loop detection.
- Per-run cancellation tokens.
- HTTP SSRF validation and DNS/IP checks.
- Archive traversal guards.
- Process and command timeouts.
- A unified authorization preflight for resource class, resolved paths, and
  shell-guard verdicts.
- A run-scoped `ApprovalGate`: `auto_approve=true` allows approval-required
  actions; otherwise it emits a pending request and waits for decision,
  timeout, or cancellation.
- Canonical working-directory confinement with symlink-safe, call-scoped
  approval-mediated escape.
- Turn-scoped staged-attachment roots are trusted for reads only; writes and
  deletion outside the workspace remain approval-gated.
- Shell interpretation routing plus hard-block and approval-required command
  guards.

### Current tools

- Shell: `os.shell.run`.
- Filesystem: read, write, edit, trash, list, glob, grep, document read, hash,
  diff, patch, archive list/read/extract.
- Git: status, log, diff, show, blame, branch.
- Processes: list and kill.
- Network: HTTP request, web search, web fetch.
- Clipboard: read and write.
- Desktop notifications: `os.notify`.
- Vision: `vision.describe` for up to four staged PNG, JPEG, GIF, or WebP
  images when the active llama.cpp session has an `mmproj`.
- Tool discovery: `tool.view`.
- Terminals: `reply` and `finish`.

### Attachment contract

- IPC accepts at most eight attachments. Files provide a local path; images
  provide a matching base64 data URL and image MIME type.
- Before the loop starts, inputs are validated and copied into
  `<thread>/agent-attachments/<turn>/` with generated filenames. Individual
  files are capped at 50 MiB and the turn total at 100 MiB.
- The durable user turn contains only a compact attachment manifest with
  absolute staged paths. Original paths, data URLs, and base64 bytes are not
  persisted in the Agent session transcript.
- Documents remain on the existing `os.fs.read_document` parser path. Text and
  source files use `os.fs.read`; archives use the archive tools.
- Image turns are rejected before staging when the active session is not
  vision-capable. `vision.describe` repeats the capability check at execution
  time so a restarted or replaced text-only session produces a structured tool
  error instead of guessed output.

## Test pyramid

The default Rust suite is deterministic and requires neither a model nor
network access:

- Unit tests pin grammar, prompt, parser, resource-class, path-policy,
  shell-guard, approval, and loop-guard behavior.
- `runner_tests.rs` drives the real `run_turn` loop against a scripted local
  `/completion` server. It verifies request fields (`grammar`, `cache_prompt`,
  `slot_id`), prompt-tail transitions, event ordering, batching, approvals,
  cancellation, failures, and terminal reasons.
- The same tests run against `ScriptedChatServer`, an OpenAI-compatible twin
  serving only `POST /v1/chat/completions`. They pin the message split, the
  absence of llama.cpp-only fields, `response_format` presence and its
  degradation paths, system-message stability across steps, reasoning lifting,
  and the error ladder.
- `tools/contract_tests.rs` runs real filesystem, archive, Git, and safe shell
  operations inside an isolated workspace. It also pins traversal, path
  escape, hard-block, denial, cancellation, and output-boundary behavior.

`model_e2e.rs` is a local, ignored acceptance ritual. It starts and stops one
externally supplied TurboQuant `llama-server`, loads one externally supplied
GGUF once, and runs all model scenarios sequentially against slot `0`.
Automatic artifact downloads and mandatory CI execution are intentionally out
of scope.

### Managed model E2E contract

The ignored test requires:

- `ATOMIC_AGENT_E2E_LLAMA_SERVER`: local executable from
  `AtomicBot-ai/atomic-llama-cpp-turboquant`, not vanilla upstream llama.cpp.
- `ATOMIC_AGENT_E2E_MODEL`: the already-downloaded IQ4_XS GGUF for
  `unsloth/Qwen3_5-9B-GGUF-Qwen3_5-9B-IQ4_XS`. A different model is not an
  equivalent acceptance run.
- `ATOMIC_AGENT_E2E_N_GPU_LAYERS`: optional `-ngl` value; defaults to `-1`.
- `ATOMIC_AGENT_E2E_TIMEOUT_SECS`: optional startup and per-scenario timeout;
  defaults to 900 seconds.

The harness chooses a free loopback port and launches the server with one
parallel slot, an 8192-token context, Jinja templates, no Web UI, flash
attention, and TurboQuant `turbo3` K/V cache. It prints `llama-server
--version`, the nearest `version.txt`, and the exact paths before waiting for
`/health`.

Run it from the repository root:

```bash
ATOMIC_AGENT_E2E_LLAMA_SERVER=<turboquant-llama-server> \
ATOMIC_AGENT_E2E_MODEL=<unsloth-Qwen3_5-9B-IQ4_XS.gguf> \
cargo test --manifest-path src-tauri/Cargo.toml -p Atomic-Chat \
  managed_model_agent_scenarios -- --ignored --nocapture --test-threads=1
```

The model must reliably follow array-only GBNF tool calls and the
`tool.view`-before-rare-tool contract. Assertions target parsed tools, events,
side effects, and terminal reasons rather than free-form reply text. On
startup failure, timeout, or agent invariant failure, the harness includes
bounded stdout/stderr tails in the panic and its RAII guard terminates the
child process.

## Iteration 1b contract corrections

1. `os.fs.archive.extract` documents canonical `destination`; the runtime
   temporarily accepts legacy `dest` and normalizes it before dispatch.
2. `os.shell.run` selects direct argv or a platform shell and always passes
   through the command guard.
3. Rare tools expose complete schemas through bounded run-scoped `tool.view`
   state.
4. Path-taking tools use the shared canonical resolver and approval-mediated
   escape policy.
5. Approval-required actions use the pending request/resolve protocol and fail
   closed on timeout or cancellation.

## Iteration 1b decisions

Iteration 1b is limited to:

- Correct existing tool contracts and add focused tool tests.
- Add the backend approval protocol; the UI is deferred.
- Add working-directory path confinement with approval-mediated escape.
- Add shell interpretation detection and a command guard.
- Add `tool.view` and `### loaded-tools` for complete rare-tool schemas.
- Add `os.clipboard.write`.
- Add `os.notify`.

Everything else remains deferred.

### Approval protocol

The design follows the useful core of `atomic-agent` without porting its
frontend-specific routers:

- Dangerous tools submit a structured pending approval request.
- A separate Tauri command resolves the request by approval id.
- Requests have cancellation and timeout behavior.
- Read-only tools continue without approval.
- Each agent run constructs an `ApprovalGate` with a global `auto_approve`
  flag. When `auto_approve` is true, every approval-required action is allowed
  without creating a pending request.
- `auto_approve` defaults to false and is supplied explicitly by the caller;
  it is not inferred from tool arguments or previous decisions.
- With no UI resolver connected, approval-required actions fail closed.
- Iteration 1b does not add persistent per-tool or per-path “always allow”
  rules.
- Resource classes continue to govern batching; approval policy governs
  whether an individual dangerous action may execute.

An approval request must include, at minimum, run id, approval id, tool name,
reason, argument preview, and affected resources. Secrets must not be included
in previews.

### Path confinement

`working_dir` becomes the default trusted root:

- Relative paths resolve beneath the canonical working directory.
- Existing targets are canonicalized before containment checks.
- Non-existent write targets validate their nearest existing ancestor and
  normalized remaining components.
- Symlink traversal must not bypass containment.
- A path outside the trusted root produces an approval request rather than an
  unconditional denial.
- Approval authorizes only the specific operation and resolved path in that
  request; it does not permanently enlarge the trusted root.

All filesystem, archive, git, shell `cwd`, and other path-taking tools must use
one shared resolver.

### Shell guard

`os.shell.run` keeps structured `cmd` plus `args`, but gains two execution
paths:

- Direct process execution when shell interpretation is unnecessary.
- Platform shell execution when metacharacters, built-ins, environment
  expansion, or a pre-joined command line require it.

Before either path starts, a guard evaluates the effective command and returns
one of:

- `allow`
- `approval_required`
- `block`

Hard-block rules take precedence over auto-approval. The guard must inspect a
tokenized view of the complete command even when execution uses a shell.

### Rare tools

Rare tools remain compact one-line entries in the stable prefix.

- `tool.view { name }` loads the full descriptor for a rare tool.
- Loaded descriptors render under `### loaded-tools` in the variable tail.
- Loaded tools are bounded by an LRU count and a token/character budget.
- Loading a descriptor must not mutate the stable prefix.
- Calling `tool.view` for a frequent, unknown, or already-loaded tool returns
  a deterministic result.
- Automatic expansion after an invalid-arguments error may be added only if it
  remains bounded and testable.

### Clipboard and notifications

- `os.clipboard.write` writes explicit text supplied by the model.
- `os.notify` emits a local desktop notification with bounded title and body.
- Both tools must expose runtime capability flags and return a clear
  unsupported result when unavailable.
- They are serialized stateful actions. They are not approval-gated by default,
  matching the `atomic-agent` contract; policy can tighten this later.

## Deferred work

- Streaming on chat transports (mlx, cloud). The llama.cpp path streams via
  `complete_streaming`; the OpenAI-compatible client still consumes whole
  completions — SSE parsing there is the natural next step.
- Native OpenAI `tools` / `tool_calls`. The text JSON-array contract is shared
  by every transport; switching cloud targets to native function calling would
  restructure the transcript into `messages[]` with tool roles.
- Context recovery on cloud targets. MLX reuses the `auto_increase_ctx` ladder
  through `SessionReloadHook`; a cloud target has nothing to reload, so
  `ContextOverflow` surfaces as a `StepError { category: "context" }`. Halving
  the conversation cap and retrying is a possible future refinement.
- `os.fs.watch`
- Browser tools
- Window list/focus
- Memory
- Tasks and scheduling

These features require separate architecture decisions because they introduce
long-lived resources, additional inference paths, executable content, or a
dynamic tool grammar.

(`vision.describe`, skills, and `skill.run_script` have since shipped. The
observation-compression policy this document once described is superseded by
the spill policy — see
`docs/decisions/2026-08-24-spill-oversized-observations-instead-of-compressing-them.md`.)

## Change checklist

When adding or changing a tool:

1. Update the prompt descriptor.
2. Update the grammar name set and GBNF alternative.
3. Update the JSON-schema tool-name set (`tool_schema.rs`) used by
   OpenAI-compatible transports; its lockstep tests fail otherwise.
4. Assign a resource class.
5. Add the dispatch implementation.
6. Apply shared path, approval, guard, timeout, and cancellation policies.
7. Add focused unit tests.
8. Verify the prompt, grammar, and JSON-schema catalogs remain in lockstep.
9. Record any non-trivial decision in `AGENTS.md`.
