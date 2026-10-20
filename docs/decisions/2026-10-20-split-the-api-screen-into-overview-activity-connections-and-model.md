---
date: 2026-10-20
title: "Split the API screen into Overview, Activity, Connections and Engine & model"
---

# 2026-10-20 — Split the API screen into Overview, Activity, Connections and Engine & model

- **Context:** After
  [Configuration and Remote access got their own pages](2026-10-20-give-server-configuration-and-remote-access-their-own-pages.md),
  `/api` still held the header Start/Stop, the connection strip (address,
  status, loaded/decision/embedding models with copyable test commands), the
  request stats, list and inspector. The approved prototype has an Overview
  with a ready strip and a collapsible "Server activity & logs", a
  Connections page (connection details, a request to try), and an Engine &
  model page; the sidebar panel's Engine and Model shortcuts open the latter.
  The user chose to keep the request inspector as its own page.
- **Decision:**
  - **Activity** (`/api/activity`, new sidebar row) is the old dashboard —
    stat tiles, request list, inspector, Refresh and Clear log — under the
    section's title block. Start/Stop is the sidebar panel's alone.
  - **Connections** (`/api/connections`, from the panel) shows the address
    to copy, the server's state, and facts: loaded model, who can reach it
    (this device, the local network, or anywhere through remote access),
    whether it wants a key, and the decision and embedding models it also
    serves with their copy commands (moved from the strip). "Try a request"
    gives cURL and Python examples for the loaded or chosen model, with the
    key header only when the server wants one, and **Send test request**
    makes one real `GET {base}/models` through the Rust `get_local_http`
    with the saved key, reporting status, latency and model count.
  - **Engine & model** (`/api/model`, from the panel's Engine and Model)
    picks the engine first, then one of its downloaded chat models (enabled
    local engines, the sidebar's platform rules, no embedding or missing
    files). Save sets `defaultModelLocalApiServer`; while running, "Apply &
    restart" restarts the server with `ensureModel`, so the new model
    replaces the old one.
  - **Overview** (`/api`) shows the ready strip (what it serves, or a nudge
    to start it) and "Server activity & logs", the latest eight log rows with
    a link to Activity. The agents grid and setup guide come next.
  - `restartLocalApiServer` takes `{ ensureModel }`, and the panel's Restart
    uses it too, so a restart from the sidebar now also restores an online
    tunnel. `useLocalApiServerControl.start` reads port and default model
    from the store at call time: a restart right after a save no longer
    warns about a "different port" or loads the previous model.
- **Consequences:**
  - The connection strip and `ApiPageHeaderActions` are gone; their tests
    moved to `ConnectionDetails` and the Activity page.
  - Requests are still recorded only while a page listens: Activity and
    Overview both subscribe. Always-on recording remains a backend item.
  - The test request is visible in Activity like any client's.
  - Desktop E2E starts and stops the server with
    `startServerFromSidebar` / `stopServerFromSidebar`, reads the inspector on
    Activity and the "Ready" state on Connections.
- **Owner:** team
- **Links:** `web-app/src/routes/api/`,
  `web-app/src/containers/server/`,
  `web-app/src/containers/ServerControlPanel.tsx`,
  `web-app/src/hooks/useLocalApiServerControl.ts`,
  `web-app/src/hooks/useRemoteAccess.ts`,
  `web-app/src/utils/localApiServerControl.ts`,
  `tests/e2e/harness/navigation.ts`
