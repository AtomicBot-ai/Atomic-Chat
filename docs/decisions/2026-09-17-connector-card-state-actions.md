---
date: 2026-09-17
title: 'Show connector actions according to configuration state'
---

# 2026-09-17 — Show connector actions according to configuration state

- **Context:** Catalog cards showed a “Not set up” pill and disabled switch before configuration, and separated configured switches from their management menus. Danny requested state-specific controls without changing grid heights.
- **Decision:** Use the presence of an installed server configuration to select the anatomy. Unconfigured connectors show their setup/sign-in action; configured connectors show compact status below the byline and a menu plus enable/disable switch at the top-right, including inactive Exa. Reserve the status line and description space across states.
- **Consequences:** OAuth cancellation, unavailable OAuth, setup busy states, error details, and server management retain their existing flows. Card geometry is checked in Chromium at Medium and Extra Large font sizes and desktop widths with the sidebar open. Icon shape stays owned by the separate icon task.
- **Owner:** team.
- **Links:** `web-app/src/containers/connectors/ConnectorCard.tsx`, `web-app/src/containers/connectors/ConnectorCard.layout.test.tsx`.

Supersedes: [2026-09-17-one-anatomy-for-every-connector-card.md](2026-09-17-one-anatomy-for-every-connector-card.md).
