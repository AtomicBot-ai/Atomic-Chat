---
date: 2026-10-20
title: "Put every control on a 36 / 24 / 40 px scale"
---

# 2026-10-20 — Put every control on a 36 / 24 / 40 px scale

- **Context:** Button sizes drifted per call site: `size="sm"` was 32 px,
  `default` 36 px, `icon-sm` 32 px, and about 25 call sites set their own
  `h-6`/`h-7`/`h-8`/`size-*` on top. Inputs and native selects ranged from 24
  to 36 px. The approved interface prototype (second iteration of the new
  design, after
  [the icon rail](2026-10-19-navigate-with-an-icon-rail-and-a-contextual-sidebar.md))
  puts regular actions, fields and selects on one 36 px height, compact icon
  actions on 24 px and large actions on 40 px.
- **Decision:** Three tokens in `index.css` — `--control-height` (36),
  `--control-height-compact` (24), `--control-height-large` (40). `Button`'s
  `default`, `sm` and `icon-sm` sizes read `--control-height`, so `sm` and
  `icon-sm` grow from 32 to 36 px everywhere, overlays included. Inside
  `.app-shell`, rules outside any CSS layer force the scale by `data-size`
  (and on `input[data-slot=input]`, native `select`, `button[data-mode]`), so
  they beat a call site's own `h-*`/`size-*`, exactly as the prototype does.
  Two departures from the prototype, both fixing its artefacts: icon buttons
  (`icon`, `icon-sm`, `icon-xs`, `icon-lg`) also get the matching width so
  they stay square, and the title bar's sidebar toggle stays 28 px to match
  the new-chat control beside it in the 42 px row. A light-turquoise `import`
  Button variant is added for the Hub's Import and the Server's Start.
- **Consequences:**
  - Sidebar rows (`SidebarMenuButton` carries `data-size`) are 36 px, as in
    the prototype. Chat-message actions, run-settings and image-studio buttons
    that asked for 28/32 px are now 36 px inside the shell.
  - Portalled overlays (dialogs, dropdowns, popovers) sit outside
    `.app-shell`: only the Button variants apply there, not the forced rules.
  - Two icon actions changed variant to stay square and small:
    `ModelDownloadAction`'s download icon is `icon-xs` (24 px) and
    `RouteRow`'s icon-only action is `icon-sm` (36 px).
  - Real-browser layout tests render outside `.app-shell`; the new cases in
    `button.layout.test.tsx` wrap their controls in it to pin the scale.
- **Owner:** team
- **Links:** `web-app/src/index.css`, `web-app/src/components/ui/button.tsx`,
  `web-app/src/components/ui/button.layout.test.tsx`,
  `web-app/src/components/left-sidebar/WindowTitlebar.tsx`
