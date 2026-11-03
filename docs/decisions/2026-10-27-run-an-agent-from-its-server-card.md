---
date: 2026-10-27
title: "Run an agent from its Server card: Install, Configure, Connect"
---

# 2026-10-27 — Run an agent from its Server card: Install, Configure, Connect

- **Context:** Since the new navigation, an agent's card on Server → Overview
  only opened the setup guide, and a configured agent only linked to its
  connection details. Opening the agent itself — the terminal running it, or
  its own app — was left on All integrations' Run, so from the Server pages
  nothing launched any more. Connections listed the configured tools with an
  icon-only button that disconnected at once. Cards followed the catalog order.
- **Decision:**
  - A card's one action walks a chain: **Install** when the agent is missing
    (All integrations' installer) → **Configure** (the setup guide, which opens
    the agent once its tasks finish) → **Connect** (starts the server when it
    is stopped, rewrites the agent's config for the model the server serves,
    and opens the agent — what Run always did) → **Connected**, a link to the
    connection details.
  - "Connected" means Atomic Chat opened the agent during this run of the app
    and the server is still up (`launch-store.launched`). Requests reach the
    server through the core, which does not say which client sent them, so a
    closed terminal still reads as connected until the server stops; Connect
    on Connections opens it again.
  - The install and open code moves out of the All integrations page into
    `lib/integration-agent-run.ts`; `hooks/useAgentActions.ts` wraps it with
    the launch store's busy state for the cards and Connections.
  - Connections gets Connect on every tool row and a worded Disconnect that
    asks first, saying what it will do (Codex: delete Atomic Chat's profile;
    the others: only leave the list).
  - Order (cards and the Server sidebar): Claude Code, Codex, Atomic Agent,
    then by tokens on OpenRouter's coding-app ranking for the month (read
    2026-10-27), then agents OpenRouter does not attribute, then editors.
- **Consequences:**
  - Connect rewrites the agent's config each time, so an agent follows the
    model the server serves now. Re-running it is safe for every configure
    command (each rewrites its own file).
  - A truthful "connected" needs the core to report each request's client
    (its user agent); until then the state is the launch above.
  - The OpenRouter order is a snapshot in `SERVER_AGENT_ORDER`; it does not
    update itself.
- **Owner:** team
- **Links:** `web-app/src/containers/server/ServerAgents.tsx`,
  `web-app/src/containers/server/ConnectedTools.tsx`,
  `web-app/src/containers/server/ServerSetupGuide.tsx`,
  `web-app/src/lib/integration-agent-run.ts`,
  `web-app/src/hooks/useAgentActions.ts`,
  `web-app/src/constants/integrations.ts`,
  https://openrouter.ai/apps/category/coding?period=month
