---
date: 2026-10-19
title: "Navigate with an icon rail and a contextual sidebar"
---

# 2026-10-19 — Navigate with an icon rail and a contextual sidebar

- **Context:** One sidebar carried everything: New Chat, Model Hub, Images,
  Video, Cloud, a Plugins group (Connectors, Skills), Integrations, API, New
  Project, projects, chats and a Settings footer. Settings then drew a second
  menu column inside each of its 15 pages, which also listed the local
  engines. The approved interface prototype
  (`AtomicBot-ai/atomic-chat-interface-prototype`, based on v2.2.5) groups the
  app into sections instead. This is the first iteration of moving to it: the
  navigation shell only; the pages keep their current design.
- **Decision:** A 60 px icon rail picks one of four sections — Workspace,
  Server, Models Hub, Settings (Help sits above Settings) — and a single
  floating sidebar shows that section's navigation. A 42 px title bar row runs
  above both on every platform and holds the sidebar toggle (plus "New chat"
  while the Workspace sidebar is collapsed); on macOS the native traffic
  lights are centred in it. Every route maps to a section in
  `lib/navigation.ts`:
  - Workspace: New Chat, Images, Video, Pinned, Projects (+), Recents (+).
  - Server: a Start/Stop/Restart panel on `useLocalApiServerControl` with the
    served engine and model, Overview (`/api`), Integrations (`/launch`),
    HTTPS Proxy, and the integration agents with an installed dot.
  - Models Hub: Downloads (`/hub?installed=true`), Local models, Cloud
    providers, Custom Endpoint (`/cloud?add=custom`), and the local engines
    (formerly Settings' "Model Providers") with Media and Voice.
  - Settings: General, Attachments, Interface, Shortcuts, Hardware, then
    Assistants, MCP connectors and Skills.

  Pinned is the thread's existing `isFavorite` flag (stored with the thread
  and already spared by "Delete all"); a small persisted store
  (`atomic-sidebar-lists`) keeps only the pin order and which groups are
  collapsed. The in-page `SettingsMenu` column is removed from every settings
  page.
- **Consequences:**
  - Downloads and Custom Endpoint are views of the Hub and Cloud pages kept in
    the URL, so the "Installed on this device" filter and the custom-provider
    dialog are now search params. Real Downloads and Endpoint pages are later
    page work.
  - The agent list asks the shell once per session whether each agent is
    installed, through the same helper the Integrations page uses; the
    Integrations page still re-detects on every visit.
  - Every `h-svh` surface inside the shell is the viewport minus the title
    bar (`.app-shell` in `index.css`), so pages needed no edits to fit.
  - Desktop E2E navigates through the rail (`tests/e2e/harness/navigation.ts`)
    rather than by sidebar text, since the rail buttons are icons.
  - Not a return of the 2026-08-13 Settings rework: there is still no
    `/settings` layout route, the provider store and the settings pages are
    unchanged apart from losing the menu column.
- **Owner:** team
- **Links:** `web-app/src/components/left-sidebar/`,
  `web-app/src/lib/navigation.ts`, `web-app/src/hooks/useSidebarLists.ts`,
  `web-app/src/containers/SettingsMenu.tsx`,
  `web-app/src/containers/ServerControlPanel.tsx`,
  [Revert the Settings and Model Providers UI rework](2026-08-13-revert-the-settings-and-model-providers-ui-rework-keep-runtime.md),
  [Keep sidebar interactions off the I/O path](2026-08-07-keep-sidebar-and-model-picker-interactions-off-the-io-path.md)
