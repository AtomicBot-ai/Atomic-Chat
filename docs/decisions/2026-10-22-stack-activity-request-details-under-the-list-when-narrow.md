---
date: 2026-10-22
title: "Stack Activity's request details under the list when the page is narrow"
---

# 2026-10-22 — Stack Activity's request details under the list when the page is narrow

- **Context:** UI audit 2.2.23, finding 08. Server → Activity split its panes
  at the window's `lg` breakpoint (1024 px), so at the minimum window with
  the sidebar open the 676 px page gave the request list its 380 px column
  and the inspector 284 px, even with no request to inspect. The search field
  was 186 px of text for "Search model, endpoint, preview or error" (266 px)
  and the inspector's "Completion tokens" figure overflowed its column.
- **Decision:** The placeholder is "Search requests"; what it searches moves
  to the field's `title` (`api:log.searchHint`), and the field gets the
  placeholder as its label. The panes follow the page's own width through
  `useStackedListDetail`, the Skills page's hook: side by side only when the
  list's 380 px and gap, the inspector's padding and 30em of body text fit —
  846 px at Medium, so 1024 px with the sidebar stacks, 1280 px does not, and
  Extra Large stacks at 1280 px too. Stacked, the list takes the full width;
  the inspector exists only while a request is selected and sits under the
  list at the list's height, and a click on a row scrolls it into view
  (`block: 'nearest'`), which at 740 px leaves the list visible above it.
  Side by side is unchanged, empty prompt included.
- **Rejected:** showing the details in place of the list with Back, as Skills
  and Cloud do on a narrow page. Activity's list is live and virtualised, and
  the store selects the first request on arrival: replacing the list would
  drop its scroll position and hide arriving requests while one is read.
- **Consequences:** On a narrow page the details start below the fold until a
  row is clicked; the first request is still auto-selected, so they are there
  to scroll to. The stat tiles keep their window breakpoints. Other locales
  that carried the English placeholder now carry the short one; the hint
  falls back to English outside en and ru.
- **Owner:** `team`.
- **Links:** `web-app/src/routes/api/activity.tsx`,
  `web-app/src/containers/api/ApiRequestList.tsx`,
  `web-app/src/hooks/useStackedListDetail.ts`,
  `web-app/src/routes/api/__tests__/ActivityPage.layout.test.tsx`,
  [Stack the Skills list and instructions when the page is narrow](2026-10-22-stack-the-skills-list-and-instructions-when-the-page-is-narrow.md)
