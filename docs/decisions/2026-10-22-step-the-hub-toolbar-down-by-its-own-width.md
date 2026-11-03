---
date: 2026-10-22
title: 'Step the Hub toolbar down by its own width, search first'
---

# 2026-10-22 — Step the Hub toolbar down by its own width, search first

- **Context:** QA 02 (2.2.23 UI review). At the smallest window (1024 px,
  sidebar open) the Hub's toolbar kept every action at full width: Text,
  Filters with its count, Sort and Import file. Search got what was left,
  about 200 px at Medium and 167 px at Extra Large. Its placeholder,
  "Search for models on Hugging Face...", was cut off mid-word. At Extra
  Large in Russian with the sidebar dragged wide, the row also overflowed
  sideways. The toolbar only wrapped below a fixed 620 px.
- **Decision:** Search is the row's main control. The toolbar steps down by
  the width of its own container, as the local models table does. Wide:
  every action shows its label. Below 63em of the toolbar's font, Filters,
  Sort and Import show their icons only. Their accessible names and tooltips
  still name them, and Filters keeps its count badge. Because the step is in
  em, a larger font size steps sooner. Below 40rem, type and search fill the
  first row and the actions move to a right-aligned row under them, so the
  focus order matches the visual order. While search shares a row with the
  actions it keeps 16rem. Wrapping stays on as a last resort, so a control
  drops to a new row rather than overflow. The placeholder is now "Search
  models…" in every locale. It matches the other categories' "Search image
  models…", and it is true for formats that do not search Hugging Face.
- **Consequences:** At 1024 px search gets about 355 px in both font sizes.
  Medium shows labels from a 914 px page, which is a 1214 px window with the
  default sidebar, so a 1280 px window has them. Extra Large stays on icons
  there. The em step is
  conservative there because the type picker is a fixed 148 px. Users lose
  the Filters, Sort and Import words at the minimum window, and the tooltips
  carry them. The Text category no longer says it searches Hugging Face.
  French "Rechercher des modèles…" is the longest placeholder. It is not
  measured and may be cut at the narrowest layout (sidebar at 40rem in a
  1024 px window). `HubSearchToolbar.layout.test.tsx` sweeps every toolbar
  width from that narrowest layout to 1280 px, in English and Russian, at
  Medium and Extra Large. The whole placeholder must fit, no button may wrap
  or overflow, and search must keep 16rem while it shares a row.
- **Owner:** `team`.
- **Links:** `web-app/src/containers/hub/hub.css`,
  `web-app/src/containers/hub/HubFilters.tsx`,
  `web-app/src/containers/hub/ImportLocalFile.tsx`,
  `web-app/src/containers/hub/HubSearchToolbar.layout.test.tsx`,
  `web-app/src/locales/*/hub.json` (`searchPlaceholder`)
