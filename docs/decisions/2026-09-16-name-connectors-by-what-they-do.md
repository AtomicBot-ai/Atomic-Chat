---
date: 2026-09-16
title: "Name connectors in the plugins menu by what they do, not by how many tools they have"
---

# 2026-09-16 — Name connectors in the plugins menu by what they do, not by how many tools they have

- **Context:** The composer's Plugins popover listed every connector as
  "Exa / 2 tools", "Serper / 2 tools". A tool count says nothing to someone
  deciding whether to switch a connector on, and an off connector had no
  second line at all, so the menu was a list of brand names. The count still
  matters in two places: a half-off connector ("1 of 2 tools") and the
  measured token cost ("70 tools · ≈18K tokens (1.1% of context)") with its
  heavy warning.
- **Decision:** Every entry in the connector catalog
  (`web-app/src/constants/mcp-connectors.ts`) carries a `taglineKey`
  (`mcp-connectors:taglines.<serverKey>`) of two or three words on what the
  connector does — "Web search", "Google search", "Issues & projects". The
  plugins menu shows the tagline under the name for any server the catalog
  recognizes (by key or URL), on or off. The former count / cost line moves
  to that row's `title` tooltip for catalog connectors; the heavy warning
  joins it there and the amber colour stays. A user-added server the catalog
  does not know keeps the count line as text, exactly as before. "Off for
  this chat" still replaces the second line while the connector is active
  and muted — state outranks description.
- **Consequences:** The tooltip, not muted inline text, holds "k of N tools"
  because the row already signals a half-off connector at a glance: its
  tools button turns amber while any tool is off. A second signal in the
  same row would only add noise, and the tagline stays legible in the narrow
  menu. Cost: the token cost and share are one hover away instead of always
  visible for catalog connectors; the heavy amber colour on the tagline
  keeps the warning visible without the number. Taglines are English-only
  locale keys (other locales fall back), and a catalog test fails if an entry
  lacks a tagline, a tagline exceeds four words, or a tagline has no catalog
  entry. `fetch`, `filesystem`, `sequential-thinking` and the browser MCP
  are not in the catalog and never appear in this menu, so they have no
  tagline; giving them one is a separate catalog decision.
- **Owner:** @danyurkin.
- **Links:** `web-app/src/containers/DropdownPlugins.tsx` (`renderCost`),
  `web-app/src/locales/en/mcp-connectors.json` (`taglines`),
  `web-app/src/containers/__tests__/DropdownPlugins.test.tsx`,
  `web-app/src/constants/__tests__/mcp-connectors.test.ts`.
