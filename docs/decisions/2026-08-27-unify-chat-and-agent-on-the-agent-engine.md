---
date: 2026-08-27
title: "Unify chat and agent on the agent engine"
---

# 2026-08-27 — Unify chat and agent on the agent engine

- **Context:** Chat and Agent were two parallel worlds on the same routes: a
  TS pipeline (`CustomChatTransport` + AI SDK, native function calling, MCP,
  RAG, assistant sampling) and the Rust agent loop (static tool catalog,
  hard-coded sampling, no assistant awareness, whole-completion output). The
  product decision is one screen and one brain: every message routes through
  the agent loop, with the legacy chat pipeline surviving only as an invisible
  fallback (`resolveMessageExecutionRoute` in `web-app/src/lib/agent-route.ts`:
  foundation-models, missing API keys, audio attachments, dflash, and — until
  their capability gates flip — project and RAG-document threads).
- **Decision:** The backend absorbed chat parity in one pass:
  1. **Assistant** — `AgentTurnRequest.assistant_instructions` (rendered
     frontend-side) lands in a `### assistant` stable-prefix section, rendered
     last so the common prefix keeps sharing KV cache across threads; capped
     at 8 000 chars.
  2. **Sampling** — `sampling` + `sampling_overridden` map onto
     `SamplingOverrides` (clamped) and apply only when the user explicitly
     tuned the assistant; the agent's calibrated 0.2/0.95/40 stays the
     default. Grammar masks logits before sampling, so any temperature stays
     shape-safe.
  3. **Dynamic MCP tools** — `snapshot_catalog` freezes the connected servers'
     tools once per turn into namespaced `mcp.<server-slug>.<tool>` entries
     (cap 64, `exa` excluded — the built-in web tools already call the same
     hosted endpoint). One-line `# mcp` prompt entries (12 000-char budget,
     full schemas via `tool.view`), grammar/schema alternations, and dispatch
     through the `McpBridge` trait (peer cloned under the lock, per-call
     timeout, cancellation). `readOnlyHint` ⇒ `ResourceClass::McpRead`
     (batchable, serialized); everything else ⇒ `ApprovalGated` with
     `Always allow` fingerprints. `auto_approve_mcp` (the migrated chat
     `allowAllMCPPermissions`, default true) bypasses the gate for MCP-origin
     tools only — never for built-in shell/fs.
  4. **Web toggle** — `web_search: bool` (default on) filters `os.web.*` out
     of prompt, grammar, schema and dispatch for the turn.
  5. **Streaming** — the llama.cpp path now streams: reasoning deltas live,
     and `reply.args.text` is recovered incrementally from the constrained
     JSON stream (`reply_stream.rs`), so plain-chat answers stream like the
     old chat pipeline. The parsed completion stays authoritative;
     `AssistantReply` reconciles any scanner drift.
  6. **Usage** — `turn_finished` now carries `usage {tokens_in, tokens_out,
     tps, ttft_ms}` so token counters and the speed indicator work on the
     agent engine.
  7. **Reseed** — `agent_session_reseed` rebuilds the durable transcript from
     the authoritative frontend message list after edit/delete/regenerate (or
     a fallback-engine turn): a prefix match appends and keeps tool
     observations; divergence rebuilds and drops them. `turn_count` stays
     monotonic (spill files key on it); PTY processes are untouched.
- **Alternatives considered:** keeping two engines routed by thread kind
  (rejected: permanent double prompt/tool logic); native OpenAI function
  calling for cloud targets (still deferred — would restructure the
  transcript); trusting `destructiveHint`/`idempotentHint` too (rejected:
  only `readOnlyHint` earns a privilege, and even that is serialized).
- **Consequences:** A changed MCP server set, web toggle, or edited assistant
  costs one KV-prefix re-ingest at the next turn boundary — never within a
  turn. `mcp.` is a reserved tool namespace (pinned by test). The chat
  pipeline remains byte-untouched for fallback traffic except for stripping
  agent-run `tool-*` parts on mixed-engine threads.
