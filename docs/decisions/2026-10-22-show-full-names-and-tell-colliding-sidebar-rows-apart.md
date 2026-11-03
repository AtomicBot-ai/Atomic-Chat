---
date: 2026-10-22
title: "Show full names in the sidebar, and tell colliding rows apart by their last activity"
---

# 2026-10-22 — Show full names in the sidebar, and tell colliding rows apart by their last activity

- **Context:** UI audit of v2.2.23 (finding 06). Recents showed two
  "generate a blank…" and two "build me a html…" rows: chat titles are cut to
  what the sidebar's width shows, nothing showed the rest, and a tooltip alone
  could not tell apart two chats with the same full title. Project names had
  the same problem.
- **Decision:**
  - Chat rows (Pinned, a project's chats, Recents) and project rows open a
    tooltip with the full name and "Last activity: <date, time>" on hover
    (after 500 ms) and on keyboard focus, but only when the row actually cuts
    its name short (its `[data-row-name]` element overflows) or the name
    collides.
  - A name collides when its first 16 characters, compared without search
    highlight tags, case or repeated spaces, match another chat's (across all
    the sidebar's chat lists) or another project's. 16 characters is about
    what the narrowest sidebar (14rem, Extra Large text, actions reserved)
    shows. Colliding rows carry a short stamp of their last activity after
    the name on the same line: the time today, the day this year, the numeric
    date before that, formatted by `Intl` in the app's language. A project's
    last activity is its newest chat, or the project's own update.
  - A fixed prefix rather than measuring each row's visible text: no layout
    reads per row on every resize or font change, and at a wider sidebar it
    errs toward showing the stamp, which costs a few characters of the name
    on those rows only.
- **Consequences:**
  - Rows keep one height; rows with unique names look as before.
  - Two chats last active in the same minute still look alike; untitled
    chats ("New Thread") all collide and all carry the stamp.
  - The project page's chat cards are unchanged.
- **Owner:** team
- **Links:** `web-app/src/lib/sidebar-row-names.ts`,
  `web-app/src/components/left-sidebar/NavRowName.tsx`,
  `web-app/src/containers/ThreadList.tsx`,
  `web-app/src/components/left-sidebar/NavProjects.tsx`,
  `web-app/src/components/left-sidebar/LeftSidebar.titles.layout.test.tsx`,
  [Fold the sidebar over the page when the window is narrow](2026-10-22-fold-the-sidebar-over-the-page-when-the-window-is-narrow.md)
