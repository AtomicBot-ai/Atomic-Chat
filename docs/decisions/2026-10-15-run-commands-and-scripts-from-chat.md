---
date: 2026-10-15
title: "Run terminal commands and scripts from chat"
---

# 2026-10-15 — Run terminal commands and scripts from chat

- **Context:** The chat pipeline (AI SDK, native function calling) had MCP and
  RAG tools only; running anything on the machine lived in the Agent engine,
  which is now hidden (`2026-10-15-hide-agent-mode.md`).
- **Decision:** Two built-in chat tools, offered next to the MCP tools whenever
  the model calls tools and the composer's "+" menu item "Run commands" is on
  (default on, `chatExecEnabled`):
  - `run_command { command, timeout_seconds? }` — `sh -c` on macOS/Linux,
    `cmd.exe /d /s /c` on Windows (one line, passed verbatim);
  - `run_script { language, code, timeout_seconds? }` — `language` is an enum
    of what this machine can run: Python always (a uv-managed CPython 3.12
    through the bundled `uv`, installed on first use), JavaScript/TypeScript
    through the bundled bun (Linux: the user's bun/deno/node), shell and
    PowerShell through the agent's interpreter table
    (`interpreter_invocation`, now shared), Ruby/Perl/PHP/Lua/R when on PATH.
  The Rust side is `core/chat_exec` (`chat_exec_status`, `chat_exec_run`,
  `chat_exec_cancel`). Every call runs in the chat's own folder,
  `<data>/agent-workspace/chat/<thread id>` (with `.tmp`, `.packages` as
  `PIP_TARGET`/`PYTHONPATH`, `.bun`); a command that mentions python/pip gets
  the managed Python first on PATH, so a package it installs is the one
  `run_script` imports. macOS/Linux commands see the login shell's PATH.
  Timeout 120 s by default, at most 600 s (as `os.shell.run`); Stop cancels the
  whole process tree. Each stream keeps its first and last 64 KB and reaches the
  model as at most 16 000 characters, start and end kept.
  **Approval:** the composer's existing approval select. Commands and scripts
  ask unless the thread is on Full access (`resolveExecAutoApprove`) — the
  global "Allow all MCP permissions" switch never covers them, the same rule as
  the agent's own shell. The approval dialog shows the command or the script
  itself and where it will run.
- **Consequences:** The model reads a run as plain text (exit code, stdout,
  stderr); the message keeps a structured `chat-exec` output for the tool row
  (code, output, "Open chat folder"), converted right before
  `convertToModelMessages`. Built-in names win a clash with an MCP tool named
  `run_command`/`run_script` while the tools are offered. macOS and Linux run
  commands with the user's own permissions — the approval is the only gate
  there; Windows uses MXC (`2026-10-15-sandbox-chat-commands-with-mxc-on-windows.md`).
  `.ps1` scripts now run with `-ExecutionPolicy Bypass` on Windows (agent
  skills included): Windows clients default to `Restricted`, under which
  `-File` refuses every script. Deleting a thread (`delete_thread`) stops its
  running calls, waits up to 5 s for them to exit and removes its chat folder;
  a folder that still cannot be removed is logged, not an error.
- **Owner:** `team`
- **Links:** `src-tauri/src/core/chat_exec/` (`forget_thread`),
  `src-tauri/src/core/threads/commands.rs` (`delete_thread`),
  `web-app/src/lib/chat-exec-tools.ts`,
  `web-app/src/lib/mcp-approval.ts`, `web-app/src/lib/custom-chat-transport.ts`,
  `web-app/src/lib/execute-chat-tool-calls.ts`,
  `web-app/src/containers/dialogs/ToolApproval.tsx`.
