---
date: 2026-11-03
title: "Say Connected only after an agent's first request, and launch agents from a script"
---

# 2026-11-03 — Say Connected only after an agent's first request, and launch agents from a script

- **Context:** The integrations audit of 2026-11-03 (X1, X5, M1–M3, L1) found
  that "Connected" meant only that Atomic Chat had spawned a window: on macOS
  `osascript` was not even awaited, a configured ZCode read "Ready" with no app
  installed, and `is_local_url` counted any local URL as ours, whatever its
  port. Connect never checked the agent was still installed, so a removed
  agent opened a terminal saying "command not found". Agents were pointed at a
  16K window their system prompt and tools alone fill. On macOS keys were typed
  into the shell (history), the proxy was dropped, and the guide and Connect
  each opened their own window; Linux missed Ptyxis, kitty, alacritty, wezterm
  and foot, passed `-e` to xfce4-terminal and counted any spawn as success.
- **Decision:**
  - One derived state per agent (`lib/agent-status.ts`): Not installed →
    Installed → Configured (installed too; ZCode shows "App not installed" with
    its download) → Opened (Atomic Chat opened it while the server runs) →
    Connected. The request log carries no client name, so a request is
    credited by what the agent sends: `messages` for Claude Code, `responses`
    for Codex and Muse, `chat/completions` for the rest, with the model the
    agent was opened for (not compared for Claude Code, which asks for its own
    side models); it goes to the matching agent opened most recently before
    it, and a 4xx does not count. The launch store latches it as requests
    arrive, so clearing the log does not take it back.
  - Connect re-detects the install first and offers Install in a toast. Each
    terminal agent has `minContextLength` (Hermes 65536, others 32768); a
    served llama.cpp model with a smaller window is grown along the chat's
    ladder and reloaded (`ensureAgentContextWindow`), and when that cannot work
    (fit sizes it, the model is trained shorter, the load fails — the old
    window is put back) nothing is written and the toast names the minimum.
    An unknown window (MLX, cloud) is left alone.
  - macOS and Linux run a 0700 launcher script that deletes itself, exports
    the proxy, sets the title, prints "agent → endpoint · model" and `exec`s
    the agent. macOS waits for Terminal's window, surfaces `osascript` errors,
    titles the tab and brings an agent's still-busy tab forward on the next
    Connect. Linux tries `$TERMINAL`, `xdg-terminal-exec`, Ptyxis, Console,
    GNOME Terminal, Konsole, Xfce (`-x`), kitty, alacritty, wezterm, foot,
    `x-terminal-emulator`, xterm, through `$SHELL -l -i -c`, and an emulator
    that exits at once with an error is skipped.
  - `detect_configured_agents` takes the server port; a URL counts only on it.
- **Consequences:** Two agents opened back to back on the same endpoint and
  model cannot be told apart (the later one is credited); a User-Agent in the
  inspector events would remove that guess and needs a core change. Connect
  may now reload the served model (seconds to minutes) before an agent opens.
  The app needs Automation permission for Terminal
  (`NSAppleEventsUsageDescription`, `com.apple.security.automation.apple-events`).
- **Owner:** `team`.
- **Links:** `web-app/src/lib/agent-status.ts`,
  `web-app/src/lib/agent-context-window.ts`,
  `web-app/src/hooks/useAgentStatus.ts`,
  `src-tauri/src/core/system/agent_terminal.rs`,
  [Keep connected agents on the model the server serves](2026-11-03-keep-connected-agents-on-the-model-the-server-serves.md)
