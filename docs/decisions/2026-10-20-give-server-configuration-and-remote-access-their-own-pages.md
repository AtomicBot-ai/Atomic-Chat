---
date: 2026-10-20
title: "Give the server's configuration and remote access their own pages"
---

# 2026-10-20 — Give the server's configuration and remote access their own pages

- **Context:** The API screen (`/api`) carried everything about the Local API
  Server: a header with Start/Stop and an "API settings" popover (host, port,
  prefix, key, trusted hosts, timeout, autostart), the connection strip, the
  Remote & LAN cards, the request stats and the inspector. Popover fields
  committed on blur and were greyed out while the server ran.
  `/settings/local-api-server` and `/settings/remote-lan` only redirected to
  `/api`; Remote & LAN had started as a page of its own
  ([2026-09-17](2026-09-17-expose-the-local-api-server-through-a-cloudflare-tunnel-and-on-the-lan.md))
  and moved onto the API screen with the core migration. The approved
  prototype splits the Server section into Overview, Configuration and
  Remote access pages (second iteration of the new design,
  after [the icon rail](2026-10-19-navigate-with-an-icon-rail-and-a-contextual-sidebar.md)
  and [the control scale](2026-10-20-put-every-control-on-a-36-24-40-px-scale.md)).
- **Decision:** Both routes render pages again, listed in the Server sidebar.
  - **Configuration** (`/settings/local-api-server`) edits a draft of the
    same `useLocalApiServer` store (no shape change): host, port, prefix, API
    key (Show/Hide only once there is a key, Generate, Copy), autostart, and
    under "Advanced settings" the proxy timeout and trusted hosts. "Save
    changes" writes the draft; while the server runs the button reads "Apply
    & restart" and, when a setting the server read at start changed, restarts
    it through `restartLocalApiServer` (stop → start without loading a model,
    tunnel restored). Autostart alone saves without a restart. Invalid input
    (port outside 1–65535, prefix not starting with `/`, timeout outside
    0–86400 s) is named and blocks Save. A change made elsewhere, such as a
    key generated on Remote access, flows into an untouched form.
  - **Remote access** (`/settings/remote-lan`) is the existing Remote access
    and Local network cards on `useRemoteAccess` / `useLanAccess`, restyled
    and stacked: the tunnel's full state machine, error lines, no-key dialog,
    QR and copy rows, telemetry and platform gating are unchanged. Unlike the
    prototype the page has no save bar, because its controls already act at
    once (start/stop, autostart, Generate, a typed key kept on blur, the
    "restart to apply" action).
  - `/api` keeps the connection strip, stats, request list and inspector; the
    settings popover and the Remote & LAN cards leave it.
- **Consequences:**
  - The page styles are ported from the prototype into
    `containers/server/ServerPage.css` (element rules in the base layer,
    `sp-*` classes in the components layer, colours from theme tokens, type
    sized from `--font-size-base`), for the remaining Server pages to share.
  - Labels follow the prototype: "Start remote access" / "Start local
    network", states "Connected" / "Stopped", "Local network" for the LAN
    card. Desktop E2E (`remote-access.spec.ts`) reaches the page through
    `openServerPage(browser, 'Remote access')`.
  - The single-purpose field components the popover used (`PortInput`,
    `ApiPrefixInput`, `ProxyTimeoutInput`, `TrustedHostsInput`,
    `ServerHostSwitcher`, `ApiKeyInput`) and the popover itself are removed.
  - Generating a key on Configuration reports `local_api_key_generate` with
    `generate_source: 'server_configuration'`.
  - "Guide me" and the setup wizard are not part of this step.
- **Owner:** team
- **Links:** `web-app/src/containers/server/`,
  `web-app/src/containers/remote-lan/`,
  `web-app/src/routes/settings/local-api-server.tsx`,
  `web-app/src/routes/settings/remote-lan.tsx`,
  `web-app/src/routes/api/index.tsx`
