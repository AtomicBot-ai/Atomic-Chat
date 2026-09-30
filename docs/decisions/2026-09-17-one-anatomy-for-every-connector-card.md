---
date: 2026-09-17
title: "Give every connector card one anatomy: the action at the top-right, a status + toggle footer on every card"
---

# 2026-09-17 — Give every connector card one anatomy: the action at the top-right, a status + toggle footer on every card

- **Context:** The Connectors grid (`web-app/src/routes/connectors/index.tsx`,
  cards in `web-app/src/containers/connectors/ConnectorCard.tsx`) mixed two
  card shapes. An installed card had its ⋮ menu at the top-right and a footer
  with the status pill and the toggle; a card that was not set up yet had
  nothing at the top-right and, instead of a footer, its Set Up / Sign in
  button alone at the bottom-right, leaving the bottom-left empty. In the
  two-column grid the two shapes sat side by side, so the buttons looked
  misplaced and the status band broke wherever a not-set-up card appeared.
  Danny (2026-09-17): the button "sits in some super-odd place —
  bottom-right — so there is a hole on the left".
- **Decision:** Every card has the same three bands. Header row: the 40 px
  brand tile, the name with its badges and "By X" (or the command/URL of a
  hand-added server), and at the right edge the action cluster — the primary
  action first (Set Up; Sign in; Cancel while a browser sign-in is pending;
  a disabled Sign in for an `oauth-soon` connector), then the ⋮ menu when the
  server is installed. The description in the middle (`flex-1`). A footer row
  on every card, `min-h-8`: the status pill on the left — Connected / Error /
  Inactive for an installed server, a muted "Not set up" for the rest — and
  the toggle on the right, off and disabled until the connector is set up.
  The grid is `auto-rows-fr` and the card `h-full flex flex-col`, so every
  card has the same height and the footers form one band.
- **Consequences:** Nothing dangles bottom-right, and the top-right always
  carries the card's control whatever its state. The disabled toggle on a
  not-set-up card is deliberate: hiding it would reopen the hole, and the
  pill beside it says why it is off. The Set Up / Sign in flows, the busy
  spinner, Cancel-while-signing-in, the error pill and the menu items are
  unchanged. `auto-rows-fr` sizes every row to the tallest card on the page,
  so a card with a shorter description carries a little space between the
  description and the footer; catalog descriptions are one or two lines, so
  that is at most one line. The 40 px tile is the Connectors page's size
  only; the plugins menu keeps `ConnectorIcon`'s 32 px default. New locale
  key `mcp-connectors:statusNotSetUp` (English only; other locales fall
  back). Done in the same change: Linear's tile now ships the logomark from
  linear.app/brand instead of the retired Simple Icons drawing; the tile
  keeps the brand blue background, which the brand page reserves for
  backgrounds.
- **Owner:** @danyurkin.
- **Links:** `web-app/src/containers/connectors/ConnectorCard.tsx`,
  `web-app/src/routes/connectors/index.tsx`,
  `web-app/src/containers/connectors/__tests__/ConnectorCard.test.tsx`,
  `web-app/src/routes/connectors/__tests__/index.test.tsx`,
  `web-app/public/images/connectors/linear.svg` (source:
  https://linear.app/brand).
