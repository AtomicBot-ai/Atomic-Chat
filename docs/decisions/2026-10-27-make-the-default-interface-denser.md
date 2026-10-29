---
date: 2026-10-27
title: "Make the default interface denser, and show every clickable thing as one"
---

# 2026-10-27 — Make the default interface denser, and show every clickable thing as one

- **Context:** Design review of the new navigation: the default type read
  about a fifth too large and rows about a third too airy; Custom Endpoint and
  Inference engines put their content at different distances from the left
  edge (20 vs 16 px, and Custom Endpoint nested a bordered Models card inside
  the endpoint's card); a colliding chat name's date crowded the name in a
  default-width sidebar; the dialog's close icon took clicks only on its own
  16 px; and a bare `<button>` such as the composer's model picker kept the
  arrow cursor, because Tailwind 4 no longer gives buttons the pointer.
- **Decision:**
  - Type: Medium, the default `--font-size-base`, is 13 px instead of 16.
    The scale is Small 12 / Medium 13 / Large 16 / Extra Large 20. The stored
    interface settings move to version 1, which maps each saved size to the
    option that now carries its label (14→12, 15/16→13, 18→16, 20→20).
  - Vertical space: controls are 28 / 24 / 32 px instead of
    [36 / 24 / 40](2026-10-20-put-every-control-on-a-36-24-40-px-scale.md)
    (Button, Input and sidebar rows read the tokens in overlays too); the
    page header is `--page-header-height` (48 px instead of 60, every
    `calc(100% - header)` reads it); sidebar group labels are 28 px; settings
    cards pad 16 × 14 px and their rows 12 px instead of 20 and 16.
  - Left inset: every Models page puts its content on the header's 16 px
    gutter, and the cards inside a card unfold on its surface on the same
    16 px inset, as the engine settings already did.
  - The date beside a colliding sidebar name shows only once the sidebar is
    widened past about 19rem (a `@container/sidebar` query); the row's tooltip
    always carries it.
  - Everything clickable shows the pointer: a base-layer rule covers buttons,
    the ARIA widget roles, selects, summaries and toggling inputs unless they
    are disabled; a `cursor-*` utility still wins.
  - A control drawn at its icon's own size, with no padding of its own, gets
    `hit-area-15`: an invisible `::after` that takes clicks 15% of its size
    beyond each edge, at most 4 px. Dialog and sheet close icons and the
    sidebar's row and group actions carry it.
- **Consequences:**
  - Users who had chosen Small, Large or Extra Large keep their label at the
    new scale; Extra Large stays 20 px, so the layout checks at it still hold.
  - `hit-area-15` is opt-in: a global selector also caught text buttons (CSS
    cannot see a text node) and reached past scroll containers' edges. The
    layout helper `expectNoHorizontalOverflow` discounts an `::after` hit
    area's reach on the control itself, never on its container.
  - Hard-coded `text-[10px]`/`text-[11px]` labels and dropdown, dialog and
    chat-bubble paddings are unchanged.
- **Owner:** team
- **Links:** `web-app/src/index.css`, `web-app/src/hooks/useInterfaceSettings.ts`,
  `web-app/src/components/ui/{button,input,sidebar,dialog,sheet}.tsx`,
  `web-app/src/containers/{HeaderPage,Card}.tsx`,
  `web-app/src/containers/endpoints/EndpointCard.tsx`,
  `web-app/src/components/left-sidebar/NavRowName.tsx`,
  `web-app/src/components/ui/button.layout.test.tsx`

<!--
Supersedes: 2026-10-20-put-every-control-on-a-36-24-40-px-scale.md (heights only)
-->
