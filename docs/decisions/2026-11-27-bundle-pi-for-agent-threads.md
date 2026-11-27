---
date: 2026-11-27
title: "Run desktop Agent threads with a bundled pi process"
---

# Run desktop Agent threads with a bundled pi process

Atomic Chat needs an Agent mode that follows the model served by the app. The previous Rust engine and its saved tool transcripts predate the desktop core. Launch also configures an independently installed pi for terminal users.

## Decision

Ship the official standalone pi with desktop installers. Start one RPC child on demand per Agent thread in its selected workspace. Store app-managed profiles and sessions under the configured data folder in `pi-agent/`. Pass the loopback server credential in the child environment. Production profiles reference that variable by name. Keep the Launch configuration independent.

Before a model can run tools, the host must verify that its bundled approval extension loaded. The extension asks for shell commands, writes, edits and reads outside the workspace. Denials, cancellations and loss of the UI block the operation. Full access requires an explicit choice. Keep discovery of workspace extensions and skills disabled. Preserve previously stored chat transcripts and their tool renderers when retiring the Rust engine.

Give pi the enabled skills from Atomic Chat and the tool schemas from the MCP connections available to this thread. The host dispatches each approved call to the named server through its existing authenticated client. Thread-level tool switches and project permissions apply. Refresh the catalog on the next turn and resume the saved session after configuration changes.

Accept a Strata model when it advertises tool calls and the running session reports at least 32,768 context tokens through the public models endpoint. Send standard OpenAI-compatible tool requests through Atomic Core. Other engines retain their own context and reasoning settings.

## Integration checks

- The macOS arm64 v1.6.0 standalone loaded an explicit TypeScript extension in RPC mode. A denied shell tool returned the denial to the model and left its marker file absent. Aborting a pending select settled the run when the extension passed the run signal. Killing the child during another select and reopening the session retained the transcript.
- Editing the provider file left the running model list unchanged. Restart a child with its session file after a model, endpoint, context limit or credential change.
- Both slices of an ad-hoc signed universal binary reported 1.6.0 with the release assets alongside it. Include package metadata in the bundle and retain the native modules for each architecture.
- A loopback llama-server with a 32K context produced a read tool call with both Gemma 4 E4B and Qwen3.5 9B. Both models emitted thinking deltas with `thinkingFormat: "chat-template"` and `chatTemplateKwargs.enable_thinking` mapped to `thinking.enabled`. Treat reasoning controls as model capabilities.
- The macOS RPC process started without its native module directory. Offline grep and find reported missing rg and fd on a minimal PATH. Keep these optional search tools outside the initial tool set.
- The macOS desktop WebDriver scenario selected a workspace, approved a real file write, switched between Chat and Agent, and reopened the saved transcript after restarting Atomic Chat.
- On a Windows x64 host without Git Bash, pi 1.6.0 denied an unapproved write and executed an approved PowerShell command using the bundled extension. Ubuntu WSL ran the Linux x64 archive and verified both denial and approval of bash.

The two macOS release archives total 98.8 MB. Each Windows or Linux archive is approximately 57–62 MB. The shipped installer increase depends on compression and signing.

**Owner** — Atomic Chat team.

This decision supersedes the engine choice in [Unify chat and agent on the agent engine](2026-08-27-unify-chat-and-agent-on-the-agent-engine.md) and the desktop release policy in [Hide agent mode](2026-10-15-hide-agent-mode.md) when the replacement ships. [Upstream release](https://github.com/earendil-works/pi/releases/tag/v1.6.0)
