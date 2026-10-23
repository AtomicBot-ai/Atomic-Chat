---
date: 2026-10-22
title: "Fold the sidebar over the page when the window is narrow, and bound its width"
---

# 2026-10-22 — Fold the sidebar over the page when the window is narrow, and bound its width

- **Context:** UI audit of v2.2.23 (finding 05). At the app's minimum window,
  1024 × 740, the 60 px rail and the 240 px contextual sidebar left the page
  724 px, and pages with more than one pane (Hub rows that open in place,
  Activity's list and detail, Images and Video, a chat with its run settings)
  were cramped unless the user folded the sidebar by hand. The sidebar could
  be dragged up to 40rem with no regard for the window, the drag handle had
  no keyboard access, and a click on it folded the sidebar.
- **Decision:** The page keeps at least 768 px beside the docked sidebar
  (`MIN_PAGE_WIDTH` in `lib/navigation.ts`, Tailwind's `md`, the width the
  multi-pane pages still lay out at). `SidebarProvider` takes `minInsetWidth`
  and `insetOffset` (the rail) and:
  - docks the sidebar at `min(saved width, window − rail − 768 px)`, so it
    narrows before it squeezes the page;
  - below rail + 14rem minimum + 768 px (a 1052 px window) stops docking
    (`compact`): the sidebar starts folded and the toggle, ⌘/Ctrl+B and the
    rail open it over the page, which does not move. Escape, a press on the
    page, or picking a page in it closes it;
  - never writes either of these to the saved state: `useLeftPanel.open` and
    `width` stay the user's preference, and widening the window brings back
    the sidebar they left. The overlay's own open state is not persisted.

  The drag handle is a focusable `role="separator"` with `aria-valuenow`,
  `-min` and `-max`; arrow keys move 16 px (Shift: 64), Home and End go to the
  bounds, a double-click resets to 15rem, and dragging well past the minimum
  still folds the sidebar. The width stays within 14rem and
  `min(40rem, window − rail − 768 px)`. A single click no longer toggles the
  sidebar, since it is half of the double-click. The shortcut has one owner:
  `KeyboardShortcutsProvider` calls the sidebar's `toggleSidebar`, and the
  shadcn provider's own ⌘/Ctrl+B listener is gone (two listeners would fold
  the overlay twice).
- **Consequences:**
  - At the default 1200 px window nothing changes: the sidebar docks, and can
    grow to 372 px. Users who keep the window at its 1024 px minimum now open
    the app with the sidebar folded and the page at 964 px.
  - "1024 px with the sidebar open" in `docs/ui-layout-rules.md` now means the
    overlay; the shell layout test opens it there.
  - Code that needs to know whether the sidebar takes room asks
    `useSidebarDocked()` (open, docked, not the mobile sheet), not
    `useLeftPanel.open`, which is only the preference. The composer model
    pill folds on it.
  - A panel folded off-canvas (docked or compact) renders its header and
    content `inert`, so its rows leave the tab order; the resize handle stays
    live to drag it back out. When the panel folds with focus inside, focus
    goes to the title bar's toggle.
  - While the overlay is open the page is its own stacking context
    (`isolate` on `SidebarInset`), so a page's z-50 layer such as the
    composer's "/" menu stays under the overlay. Only then: a press on the
    page closes the overlay first, so a full-window layer the page opens
    (image lightbox) is never trapped under the shell.
- **Owner:** team
- **Links:** `web-app/src/components/ui/sidebar.tsx`,
  `web-app/src/components/left-sidebar/index.tsx`,
  `web-app/src/routes/__root.tsx`, `web-app/src/providers/KeyboardShortcuts.tsx`,
  `web-app/src/components/left-sidebar/LeftSidebar.compact.layout.test.tsx`,
  [Navigate with an icon rail and a contextual sidebar](2026-10-19-navigate-with-an-icon-rail-and-a-contextual-sidebar.md)
