---
date: 2026-10-22
title: "Show the Cloud catalog and a provider's configuration in turn on a narrow page"
---

# 2026-10-22 — Show the Cloud catalog and a provider's configuration in turn on a narrow page

- **Context:** Cloud (`/cloud`) is a two-pane page: the provider catalog
  (`minmax(230px, 290px)`) beside the selected provider's configuration
  ([2026-10-20](2026-10-20-show-hosted-providers-on-cloud-and-own-servers-on-custom-endpoint.md)).
  At the app's minimum window, 1024 px with the sidebar open, the page is
  708 px wide: three columns side by side, "ChatGPT subscription (Codex)"
  cut off in the catalog, and the configuration about 390 px wide, so the
  routing explanation, the API key help and the base URL wrapped into many
  lines (UI audit 2.2.23, finding 03). Collapsing the sidebar fixed it, but
  the page has to work with the sidebar open.
- **Decision:**
  - The page body is a CSS container (`@container/cloud`). At 58em of its
    text or wider — 812 px at Medium, 1015 px at Extra Large — the panes
    stay side by side as before. Narrower, the page shows one pane at a
    time: the catalog fills the page, and picking a provider shows its
    configuration (connection, subscription, models, media models) at the
    page's full width under an "All providers" back control. The breakpoint
    is the page's own width, not the window's, so a collapsed or resized
    sidebar moves it, and it is in em so a larger interface font switches to
    one pane sooner.
  - 58em is the catalog column plus a configuration column of about 35em.
    The catalog column is now `minmax(16.5em, 20.5em)` (231–287 px at
    Medium, as before; wider at larger fonts).
  - The selected provider stays in the URL (`?provider=`). Which pane a
    narrow page shows is component state: a link that names a provider (the
    model picker's gear, the old settings route) opens on its configuration,
    the sidebar's link (no provider) on the catalog. Leaving the guide or
    deleting the selected provider returns to the catalog.
  - On a narrow page, picking a provider moves focus to the back control,
    and the back control returns focus to the selected provider's row (the
    search field when a search hides it). Side by side, focus stays where it
    was.
  - A provider name in the catalog takes up to two lines instead of an
    ellipsis, with the full name on hover.
- **Consequences:** Nothing on the page is fixed to the window size;
  1280 px at Extra Large text is a one-pane layout (the page is 964 px
  there). The hidden pane stays mounted, so the catalog search survives a
  trip to a configuration and back. Measured in
  `CloudPage.layout.test.tsx` at 1024 and 1280 px, Medium and Extra Large,
  light and dark. The first-visit guide is a single column and unchanged.
- **Owner:** team
- **Links:** `web-app/src/routes/cloud/index.tsx`,
  `web-app/src/containers/cloud/CloudProviderBrowser.tsx`,
  `web-app/src/routes/cloud/__tests__/CloudPage.layout.test.tsx`,
  `web-app/src/routes/cloud/__tests__/CloudPage.test.tsx`.
