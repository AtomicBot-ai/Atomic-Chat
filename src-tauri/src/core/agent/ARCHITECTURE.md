# Atomic Chat Agent Architecture

Living engineering reference for the autonomous Rust agent in this directory.
Update this document when the agent loop, tool contract, safety policy, or
iteration scope changes. Product-wide decisions still belong in the repository
decision log in `AGENTS.md`.

## Status and scope

The agent backend is isolated from regular Atomic Chat conversations and from
the Vercel AI SDK path. It talks directly to the active local llama.cpp session
over native `/completion`.

Iteration 1 is implemented. Iteration 1b is planned. Memory, tasks, browser
automation, vision, skills, dynamic MCP tools, window control, and filesystem
watchers are deferred.

## Current architecture

### Entry points and transport

- `agent_run_turn` starts a bounded agent turn and streams `AgentEvent` values
  over a Tauri IPC channel.
- `agent_cancel_turn` cancels a run by its caller-provided `run_id`.
- `LlamaServerClient` resolves the active TurboQuant or upstream llama.cpp
  session and calls its `/completion` endpoint directly.
- Every completion uses the static tool grammar, `cache_prompt`, and a stable
  slot id. The local API server on port 1337 is not part of this path.

### Prompt and grammar

- The stable prompt prefix contains the persona, rules, tool catalog,
  capabilities, and instructions.
- Frequent tools expose their complete argument schema in the stable prefix.
- Rare tools currently expose only a one-line catalog entry.
- The variable tail contains the conversation, an optional loop notice, and
  the response marker.
- Tool output is constrained by an array-only GBNF root. One tool call is a
  one-element array; a step may contain up to eight calls at runtime.
- The prompt catalog and grammar tool-name set must remain identical.

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
- Approval hook boundary before approval-gated dispatch.

The current approval hook is `DenyApprovalHook`; therefore every
approval-gated action is denied.

### Current tools

- Shell: `os.shell.run`.
- Filesystem: read, write, edit, trash, list, glob, grep, document read, hash,
  diff, patch, archive list/read/extract.
- Git: status, log, diff, show, blame, branch.
- Processes: list and kill.
- Network: HTTP request, web search, web fetch.
- Clipboard: read.
- Terminals: `reply` and `finish`.

## Known Iteration 1 defects

1. `os.fs.archive.extract` is documented with `dest`, while the implementation
   reads `destination`.
2. `os.shell.run` promises shell syntax but currently performs direct argv
   execution only and has no command guard.
3. Rare tools do not expose a discovery mechanism. The model sees no complete
   schema unless the tool is frequent.
4. Path resolution treats `working_dir` as a default base, not as a security
   boundary. Absolute paths can escape it.
5. Approval-gated tools have no pending-request/resolve protocol; they are
   always denied.

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

- `os.fs.watch`
- `vision.describe`
- Skills and `skill.run_script`
- Dynamic MCP tool registration
- Browser tools
- Window list/focus
- Memory
- Tasks and scheduling

These features require separate architecture decisions because they introduce
long-lived resources, additional inference paths, executable content, or a
dynamic tool grammar.

## Change checklist

When adding or changing a tool:

1. Update the prompt descriptor.
2. Update the grammar name set and GBNF alternative.
3. Assign a resource class.
4. Add the dispatch implementation.
5. Apply shared path, approval, guard, timeout, and cancellation policies.
6. Add focused unit tests.
7. Verify prompt and grammar catalogs remain in lockstep.
8. Record any non-trivial decision in `AGENTS.md`.
