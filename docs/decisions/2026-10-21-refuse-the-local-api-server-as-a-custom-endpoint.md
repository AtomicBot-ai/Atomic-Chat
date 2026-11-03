---
date: 2026-10-21
title: 'Refuse the Local API Server as a custom endpoint'
---

# 2026-10-21 — Refuse the Local API Server as a custom endpoint

- **Context:** Every remote provider is reached through the app's own Local
  API Server proxy. QA added `http://127.0.0.1:1337/v1` as a custom endpoint:
  its model list was the app's own `/v1/models`, so it read Connected, and a
  chat through it stayed on "Working" until stopped, because the proxy sent
  the request back to itself.
- **Decision:** An address whose host is this machine (`localhost`,
  `*.localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`, `::`, IPv4-mapped loopback)
  and whose port is the server's configured port is the server itself
  (`lib/local-api-self-reference.ts`), whatever the path. While the server
  listens on every interface (LAN access), this machine's LAN addresses count
  too. Such an address is refused by the Custom Endpoint dialog with a message
  naming the server's URL, by Connect on the Cloud page and in onboarding, and
  by `checkProviderEndpoint` / `fetchModelsFromProvider`, so a ping of an
  endpoint saved before this says why and a model reload never imports the
  app's own models.
- **Consequences:** The comparison uses the server's configured port, not
  1337, and a server without a fixed port yet (mobile, port 0) matches
  nothing. Another program on the same port of this machine cannot be added,
  but it could not be reached anyway while the server holds that port. The
  proxy's own handling of such a request is a separate, server-side fix.
- **Owner:** team
- **Links:** `web-app/src/lib/local-api-self-reference.ts`,
  `web-app/src/containers/endpoints/EndpointDialog.tsx`,
  `web-app/src/routes/endpoints/index.tsx`,
  `web-app/src/services/providers/tauri.ts`.
