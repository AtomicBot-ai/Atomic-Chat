---
date: 2026-10-10
title: 'Let the agent delegate tasks to specialist assistants'
---

# 2026-10-10 — Let the agent delegate tasks to specialist assistants

- **Context:** Agent mode runs one agent per turn with one set of instructions. Users want several focused helpers (for example a network specialist and a computer-care specialist) that a main assistant can hand work to, without every helper's instructions crowding one prompt. The agent architecture listed multi-agent work as deferred.
- **Decision:**
  - **Opt-in specialists.** An assistant marked "Available as a specialist" (`Assistant.specialist`, which needs a description) is offered to agent turns in other threads. The thread's own assistant is the coordinator.
  - **The tool.** The coordinator gets one new tool, `agent.delegate { specialist, task }`. It runs a nested `run_turn` for that specialist:
    - its own stable prefix, with its instructions under `### assistant` and no roster;
    - a fresh in-memory session that sees only `task`;
    - the coordinator's model client, workspace roots, MCP/docs bridges, approval gate and cancellation token;
    - a step cap of 24.
  - **What comes back.** Only the specialist's final answer returns, as the tool observation.
  - **One level only.** Delegation is one level deep: a specialist's turn has `agent.delegate` disabled and no hook.
  - **Runs solo.** The call is a new `ResourceClass::Delegation`. It needs no approval of its own, but it is solo-only, because class groups in a batch execute concurrently. It shares the approval-gated tools' solo salvage.
  - **Off by default.** With no specialists, the tool is removed from the prompt, grammar, JSON schema and dispatch, and no `### specialists` section is rendered. Turns without specialists keep a byte-identical prefix.
- **Consequences:**
  - **Approvals.** A specialist's risky actions reach the user through the same approval gate and cards as the coordinator's. Delegating grants nothing by itself.
  - **Visibility.** The specialist's intermediate tool calls are not shown in the thread. Only the delegate call and its answer are. Streaming a specialist's progress is a follow-up.
  - **Usage.** Specialist token usage is not yet added to the turn's usage totals.
  - **Shared session id.** Specialists reuse the coordinator's session id with a `--<slug>` suffix, so spill files and processes never collide.
  - **Limits.** At most 12 specialists per turn. Names are unique case-insensitively.
- **Owner:** @walladanger.
- **Links:** `src-tauri/src/core/agent/delegation.rs`, `delegation_tests.rs`, `resource_class.rs` (`Delegation`, `runs_solo`); `web-app/src/lib/agent-specialists.ts`; `web-app/src/containers/dialogs/AddEditAssistant.tsx`.
