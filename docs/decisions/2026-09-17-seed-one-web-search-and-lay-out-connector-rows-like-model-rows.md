---
date: 2026-09-17
title: "Seed one web search on a fresh install, and lay connector rows out like model rows"
---

# 2026-09-17 — Seed one web search on a fresh install, and lay connector rows out like model rows

- **Context:** On a fresh install the composer's Plugins menu listed two
  connectors: Exa, switched on, and Serper, switched off. Both are web
  search; Serper only works behind an API key, and the default template
  shipped it with a `YOUR_SERPER_API_KEY_HERE` placeholder, so as seeded it
  could never be switched on. The product owner's first question on the
  debug build was why a server that is off is there at all. The other off
  defaults (`Jan Browser MCP`, `browsermcp`, `fetch`, `filesystem`,
  `sequential-thinking`) never reach this menu (`BROWSER_SERVER_KEYS` /
  `SYSTEM_SERVER_KEYS`), so Serper was the only off row a fresh install could
  show. The rows themselves were wrong too: a 20 px tile, an 11 px tagline,
  no fixed action slot, and the icon not level with the title/tagline pair —
  nothing like the model rows (`RouteRow`) the rest of the composer uses.
- **Decision:** A fresh install seeds exactly one web search, Exa, switched
  on. Serper is gone from `DEFAULT_MCP_CONFIG_TEMPLATE` and from the connector
  catalog (`MCP_CONNECTORS`), with its locale keys and image asset; a Rust
  test asserts that every server the template ships switched off is one the
  menu hides. Nothing is removed from an existing user's `mcp_config.json`:
  the template is written only when the file does not exist, and the upgrade
  migrations only back-fill `Jan Browser MCP` and re-pin `filesystem`. The
  connector row takes the model rows' anatomy: a 32 px round `bg-secondary`
  mark (a catalog brand tile fills it, a hand-added server shows its
  initial), a `text-sm font-medium` title and a `text-xs text-muted-foreground`
  tagline, each on one truncated line and centred against the mark, a
  `min-h-9` so a row without a second line stays as tall as its neighbours,
  and a fixed 64 px action slot on the right holding the tools button and the
  switch, so the switches of every row line up.
- **Consequences:** A fresh install's menu shows one row: Exa, on. An
  upgrader who never touched the seeded Serper keeps it, now as a plain
  "serper" row (initial, no tagline, off), because the catalog no longer
  brands it; an untouched sentinel entry (`YOUR_SERPER_API_KEY_HERE`,
  `active: false`) is safe to drop in a later `mcp_version` migration, which
  this change deliberately does not add. The globe button's server detection
  (`lib/web-search.ts`) still recognizes a user's own `serper` server, as it
  does `tavily` or `brave-search`, which the app never shipped either. The
  Connectors page no longer offers Serper; the remaining keyed connectors
  (Firecrawl, Perplexity, Zapier, Resend) take over as the tests' secret
  fixtures. Brand tiles are now clipped to a circle instead of a 6 px radius,
  so a mark that reaches its tile's corners needs a look in the app; white
  tiles (Notion, Cloudflare, Airtable) stay white in the dark theme, as on
  the Connectors page. Skills rows are unchanged.
- **Owner:** @danyurkin.
- **Links:** `src-tauri/src/core/mcp/constants.rs`
  (`DEFAULT_MCP_CONFIG_TEMPLATE`), `src-tauri/src/core/mcp/tests.rs`
  (`fresh_default_config_seeds_one_web_search_and_no_off_row`),
  `web-app/src/constants/mcp-connectors.ts`,
  `web-app/src/containers/DropdownPlugins.tsx`,
  `web-app/src/containers/RouteRow.tsx` (the anatomy copied),
  `web-app/src/containers/__tests__/DropdownPlugins.test.tsx`,
  `web-app/src/constants/__tests__/mcp-connectors.test.ts`; builds on
  `2026-09-16-name-connectors-by-what-they-do.md`.
