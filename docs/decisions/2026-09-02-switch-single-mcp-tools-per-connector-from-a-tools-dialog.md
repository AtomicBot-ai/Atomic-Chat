---
date: 2026-09-02
title: "Switch single MCP tools per connector from a tools dialog; a connector's per-chat on/off lives there too"
---

# 2026-09-02 — Switch single MCP tools per connector from a tools dialog; a connector's per-chat on/off lives there too

- **Context:** The plugins menu in the composer had one switch per connector
  (start/stop the server) and a plug button that muted the connector for one
  chat. Single tools could not be switched: an earlier cleanup had removed the
  per-tool rows from the menu and added a sweep that deleted any leftover
  `server::tool` keys from `useToolAvailable` on sight. A connector like
  Linear ships ~60 tools, of which a chat typically needs a handful, and the
  only ways to cut the tool block were all-or-nothing. The store also had a
  latent bug: a thread's first per-tool switch started from an empty list
  instead of the defaults it had been running on, silently re-enabling every
  default-off tool.
- **Decision:** Per-tool switches come back, one step deeper than the menu:
  1. `ConnectorToolsDialog` lists a connector's live tools with a switch each,
     a search box, bulk "all on / all off", and the connector's own switch for
     the scope (the same `mutedServers` flag the plug button used to flip).
     It is opened from the connector's card menu on the Connectors page
     (edits the defaults for new chats) and from a settings button on the
     connector's row in the composer's plugins menu (edits this chat; the
     index page edits the defaults). The plug button is gone.
  2. The menu row reads "k of N tools" once single tools are off, so a
     half-off connector is visible without opening the dialog; the settings
     button turns amber for the same reason.
  3. `useToolAvailable` gains bulk setters, dedupes keys, and a thread's first
     switch copies the defaults. Nothing sweeps per-tool keys any more, and
     connecting a server from the plugins menu no longer clears them — a tool
     the user turned off stays off across a restart. The globe (web search)
     keeps clearing its own server's per-tool switches: its intent is
     explicit.
  4. Chat mode re-measures the tool cost when per-tool switches change
     (`use-chat.ts`), the same way it already did for muted connectors.
  5. The system servers from the Rust template (`filesystem`, `fetch`,
     `sequential-thinking`; `SYSTEM_SERVER_KEYS`) are agent-mode tooling:
     the chat transport never sends their tools and the plugins menu never
     lists them. They keep running, and agent runs keep reading them from
     the engine's catalog. This replaces the earlier rule of listing an
     active system server in the menu "rather than hiding what the model is
     paying for" — a chat no longer pays for them at all.
  Agent mode already received `disabled_mcp_tools` from the same store and
  is otherwise untouched; per-chat mute stays a chat-transport concern.
- **Consequences:** The user can trim a heavy connector to the tools a chat
  needs instead of switching it off entirely. A thread that has touched its
  own tool switches no longer follows later default changes (it never did for
  keys it had; now it also keeps the defaults it inherited) — the dialog says
  which scope it edits. Old per-thread entries created by the previous
  behaviour are left as they are.
- **Owner:** @mishaskvortsov
- **Links:** `web-app/src/containers/dialogs/ConnectorToolsDialog.tsx`,
  `web-app/src/containers/DropdownPlugins.tsx`,
  `web-app/src/containers/connectors/ConnectorCard.tsx`,
  `web-app/src/routes/connectors/index.tsx`,
  `web-app/src/hooks/useToolAvailable.ts`,
  `web-app/src/hooks/useMCPServerToggle.ts`, `web-app/src/hooks/use-chat.ts`.
  Extends [2026-09-02-measure-and-surface-mcp-tool-cost-in-chat.md](2026-09-02-measure-and-surface-mcp-tool-cost-in-chat.md).
