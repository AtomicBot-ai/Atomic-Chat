---
date: 2026-08-11
title: "Own the settings chrome in a layout route and highlight the clicked provider optimistically"
---

# 2026-08-11 — Own the settings chrome in a layout route and highlight the clicked provider optimistically

- **Context:** Clicking a provider in Settings → Model Providers felt slow: the row's
  selected background arrived together with the page, well after the click. Two
  causes, both structural rather than I/O:
  - Every one of the 13 `/settings/*` pages rendered its own copy of the shared
    chrome — the `h-svh` frame, `HeaderPage` and `SettingsMenu`. The sidebar was
    therefore a child of the page body, including
    `routes/settings/providers/$providerName.tsx`, a ~3000-line component with 30
    pieces of state and 9 effects. Navigating between two providers re-rendered
    that whole tree, and moving between two different settings pages unmounted and
    remounted the menu outright.
  - The selected row was derived from `useMatches()`, i.e. from the *committed*
    route. TanStack Router runs navigation inside `React.startTransition`
    (`Transitioner.js` wires `router.startTransition` to it), so React renders the
    new tree off-screen and commits it atomically. Nothing at all paints between
    the click and that commit — the click had no feedback for as long as the
    provider page took to render.

- **Decision:** Move the shared chrome into a `/settings` layout route
  (`routes/settings/route.tsx`), which owns the frame, the single `HeaderPage` and
  `SettingsMenu`, and renders pages through `Outlet`. Pages pass their header
  content up through `SettingsPageHeader`, a portal into a slot the layout owns.
  Independently, `SettingsMenu` records the clicked provider in local state — an
  urgent update outside the router's transition — and prefers it over the route
  match, so the highlight paints on the next frame.

- **Consequences:**
  - Provider switching commits less work: the sidebar is no longer part of the
    page subtree, it survives navigation between settings pages, and page-local
    state churn (the provider screen writes settings on several effects) can no
    longer re-render it.
  - The highlight is decoupled from route commit. The optimistic value is cleared
    whenever the resolved provider param changes, so navigating away by any other
    route (the menu's `Link`s, deep links) drops it. Clicking two providers in
    quick succession can show the first for one commit before the second lands;
    that matches what the router itself does and is not worth extra machinery.
  - `SettingsPageHeader` renders an inline `HeaderPage` when no layout is above it
    (`undefined` context). This keeps every page unit-testable in isolation, which
    is how the existing route tests render them.
  - There is now exactly one `HeaderPage`, and therefore one `DownloadManagement`,
    across Settings instead of one per page.
  - Assertions about the sidebar moved out of the individual page tests and into
    `routes/settings/__tests__/route.test.tsx`, which pins both invariants the
    layout exists for: a single `SettingsMenu`, and a page header that lands in the
    shared header rather than the content pane.
  - Not addressed here: `$providerName.tsx` is still one very large component, so
    the page body itself is still the slowest part of the transition. Splitting it
    into lazily-loaded sections is the obvious follow-up.

- **Owner:** `team`
- **Links:**
  - `web-app/src/routes/settings/route.tsx`,
    `web-app/src/containers/SettingsPageHeader.tsx`,
    `web-app/src/containers/SettingsMenu.tsx`
  - Tests: `web-app/src/routes/settings/__tests__/route.test.tsx`,
    `web-app/src/containers/__tests__/SettingsMenu.test.tsx`
  - Earlier pass over the same symptom, from the I/O side:
    [Keep sidebar and model-picker interactions off the I/O path](2026-08-07-keep-sidebar-and-model-picker-interactions-off-the-io-path.md)
