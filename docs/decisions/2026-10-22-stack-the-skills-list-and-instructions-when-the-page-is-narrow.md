---
date: 2026-10-22
title: "Stack the Skills list and instructions when the page is narrow"
---

# 2026-10-22 — Stack the Skills list and instructions when the page is narrow

- **Context:** UI audit 2.2.23, finding 11. At the app's minimum window
  (1024 px) with the sidebar open, the Skills page is 708 px wide. The list
  took its 360 px column and left the instructions about 290 px of text, so
  the chat-sized markdown headings (h1 at 1.875× the base size) and inline
  code wrapped heavily, the apple-calendar table scrolled sideways, and list
  descriptions stayed clamped in the narrow column.
- **Decision:** Decide the layout from the page's own measured width, not the
  window. `useStackedListDetail` (ResizeObserver, measured before paint)
  stacks the page when the list's 360 px plus the detail's 58 px of padding
  and a 36em reading line of the page's body text would not fit. That is
  922 px at Medium, so 1024 px with the sidebar open stacks and 1280 px does
  not; Extra Large stacks at 1280 px too. Stacked, the list fills the page;
  opening a skill shows its instructions full-width under a header with Back,
  the skill's name, its enable switch and its actions menu. Focus moves to
  Back on open and back to the row on Back. The detail appears only once the
  opened skill has loaded, so the previous skill's text never stands in. A
  skill just written or uploaded opens in its detail; deleting the opened
  skill returns to the list with focus on the neighbouring row (or the list).
  The hook measures again on resize and when the interface font size
  (`--font-size-base` on `<html>`) changes. The
  instructions use a compact prose scale (`.markdown.is-compact`: h1 = xl,
  h2 = lg, h3 = base) and inline code breaks anywhere, so a long flag breaks
  inside its code rather than widening a table cell. Wide tables keep
  streamdown's own horizontal scroller.
- **Rejected:** a CSS container query alone — both views would stay in the
  DOM, doubling the switch and menu for assistive tech and the jsdom tests. A
  draggable, persisted divider — with list/detail below the breakpoint the
  instructions always get 36em, so it would add stored state for little gain;
  it can be added later on the same geometry.
- **Consequences:** Selecting a skill at narrow widths takes a click back to
  return to the list. Stacked, the detail line can reach about 60em just under the breakpoint.
  Chat markdown is unchanged; only the Skills pane opts into `is-compact`.
- **Owner:** `team`.
- **Links:** `web-app/src/routes/skills/index.tsx`,
  `web-app/src/hooks/useStackedListDetail.ts`, `web-app/src/styles/markdown.css`,
  `web-app/src/routes/skills/__tests__/SkillsPage.layout.test.tsx`
