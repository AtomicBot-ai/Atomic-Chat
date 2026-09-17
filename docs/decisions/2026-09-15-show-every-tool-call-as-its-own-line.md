---
date: 2026-09-15
title: "Show every tool call as its own line in the message"
---

# 2026-09-15 — Show every tool call as its own line in the message

- **Context:** A turn's tool calls sat three disclosures deep: "Worked for
  12.3s" → "Called 4 tools" → one header per call → its parameters and output.
  With everything collapsed, a finished turn showed a duration and nothing
  about what ran, and each call was titled with a humanized verb ("Read file",
  "Searched: …") that hid the tool the model actually picked — so a failed or
  surprising call could not be diagnosed without opening every level
  (ATO-529, raised against the same pattern in Unsloth Studio).

- **Decision:** The activity block renders its calls directly, one line each
  (`ToolRenderer`): an icon for the tool family, the real tool name in mono
  (`web_search_exa`, `os.fs.read`, an MCP tool's own name), the call's main
  argument (query, path, command, hostnames), and on the right how it ended —
  the first line of the error, "Denied", or a web search's favicons and result
  count. Clicking a line opens only its own parameters and output. The
  humanized title stays as the line's tooltip. There is no "Worked for" or
  "Called N tools" header any more, and the live state is shown once: a running
  call spins on its line, "Thinking…" covers a thinking stream, a Chat answer
  streaming below signals itself, and a "Working…" shimmer fills only the gaps
  between them (for an agent run, every step that produces no text).

- **Consequences:**
  - The run's duration is no longer shown in the message; it stays in the
    message metadata (`activityDurationMs`, `agent_run.duration_ms`).
  - An agent run's loop warnings and its error are always visible lines
    instead of sitting behind an auto-opened disclosure.
  - A long agent run prints one line per call before its answer. If that
    becomes noise, collapse older lines past a threshold rather than
    reintroducing a header around all of them.
  - A generic MCP call with no `path`/`url`/`query`/… parameter now shows its
    first text argument, so the line is never just a name.
  - `ToolHeader` and the `activity.workedFor` / `activity.calledTool(s)`
    strings are gone; `AgentActivity` is still used by `PromptProgress`.

- **Owner:** `team`.
- **Links:** ATO-529;
  `web-app/src/components/ai-elements/tools/tool-renderer.tsx`,
  `web-app/src/components/ai-elements/tools/tool.tsx`,
  `web-app/src/containers/MessageItem.tsx`,
  `web-app/src/lib/tools/presenters/generic.ts`.
