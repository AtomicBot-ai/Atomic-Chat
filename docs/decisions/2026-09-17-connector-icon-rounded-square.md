---
date: 2026-09-17
title: 'Keep connector logos in rounded-square tiles'
---

# 2026-09-17 — Keep connector logos in rounded-square tiles

- **Context:** The Plugins dropdown adopted the model rows' circular icon slot,
  overriding the shared connector tile's modest radius and clipping Exa's art.
- **Decision:** Keep the existing 32 px row slot but use `rounded-md` on its outer
  clip and inherit the shared `ServerIcon` / `ConnectorIcon` radius. Preserve
  catalog artwork, `object-contain`, and brand backgrounds in both themes.
  Apply the same slot to hand-added connectors; model avatars remain circular.
- **Consequences:** Menu connectors match the catalog tile shape without changing
  row alignment, icon size, actions, or model avatars. Chromium checks both
  clipping layers at 1024/1280 px, Medium/Extra Large fonts, and light/dark themes.
- **Owner:** team.
- **Links:** `web-app/src/containers/DropdownPlugins.tsx`,
  `web-app/src/containers/DropdownPlugins.layout.test.tsx`,
  `web-app/src/containers/__tests__/DropdownPlugins.test.tsx`.

Supersedes the circular connector icon treatment only in
[Seed one web search and lay out connector rows like model rows](2026-09-17-seed-one-web-search-and-lay-out-connector-rows-like-model-rows.md).
