---
date: 2026-10-20
title: "Set up the server from Overview with a guide that does the real work"
---

# 2026-10-20 — Set up the server from Overview with a guide that does the real work

- **Context:** After
  [the API screen was split](2026-10-20-split-the-api-screen-into-overview-activity-connections-and-model.md),
  Overview showed only a ready strip and the latest activity. Connecting an
  agent meant finding the Integrations page in the sidebar and its Run
  button. The approved prototype opens Overview with a first-visit guide
  (Agent / Endpoint → review engine and model → preparing → done), lists
  every agent as a card, starts the guide from the sidebar's Start until the
  server is set up, counts connections in the sidebar panel, and lists the
  connected tools on Connections. In the prototype all of it is simulated: a
  timer fills the progress bar and "connected" is a flag.
- **Decision:**
  - **The guide does the real work, in order:** check the engine still has
    the model, save it as the server's model (and a new port for the
    endpoint path), start the server with it — or restart it with
    `ensureModel` when it serves another model or the port changed — then
    write the agent's own config with the same `configure_*` call All
    integrations uses (`lib/integration-agent-setup.ts`, extracted from the
    Launch page). Progress is the steps that finished; a failed step is
    marked, says why, and Retry runs from it. There is no Pause: the steps
    cannot be paused.
  - **Agents are "Configured", never "connected":** a new persisted store,
    `useServerSetup` (`atomic-server-setup`), keeps whether the guide ran to
    the end, whether the first-visit guide was closed, the tools set up
    through Atomic Chat (the guide and All integrations both record them) and
    whether an endpoint was prepared. Nothing tells the app whether a tool
    actually talks to the server, so cards say Configured / Installed / Not
    installed. "Remove" on Connections only forgets the entry; the tool's own
    config is not undone (there is no unconfigure command).
  - **Set up** means the guide finished or the server has already served a
    model (`lastServerModels`), so existing users are not sent through the
    first-visit guide. Until then the sidebar's Start opens the guide.
  - **Overview** shows the guide (first visit, "Guide me", a card's
    Configure, the endpoint shortcut, the sidebar's agent palette) or the
    ready strip, then "Agents & tools" (search, featured Claude Code, Codex,
    Atomic Agent first) and the activity panel. Editors set up by hand open
    their card on All integrations.
  - **Integrations leaves the sidebar** and becomes "All integrations", linked
    from Overview and from the guide when the chosen agent is not installed;
    its install log, custom paths, WSL, editors and Run stay there.
- **Consequences:**
  - The sidebar panel's Connections row counts what was set up; the agent
    palette's dot is green for a configured agent.
  - Desktop E2E profiles seed `atomic-server-setup` as set up, so the
    sidebar's Start starts the server; `server-setup-guide.spec.ts` seeds a
    first visit and walks the guide (written, not yet run).
    `launch-integration.spec.ts` reaches All integrations from Overview.
  - Still not built (backend): telling a configured tool that is actually
    connected from one that is not, and undoing an agent's config.
- **Owner:** team
- **Links:** `web-app/src/containers/server/ServerSetupGuide.tsx`,
  `web-app/src/containers/server/ServerAgents.tsx`,
  `web-app/src/containers/server/ConnectedTools.tsx`,
  `web-app/src/hooks/useServerSetup.ts`,
  `web-app/src/lib/integration-agent-setup.ts`,
  `web-app/src/routes/launch/index.tsx`,
  `tests/e2e/desktop/server-setup-guide.spec.ts`
