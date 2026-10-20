---
date: 2026-10-20
title: "Name every Hub row's parameters and hold the place of what loads"
---

# 2026-10-20 — Name every Hub row's parameters and hold the place of what loads

- **Context:** The local models table
  ([its record](2026-10-20-list-hub-models-in-a-table-whose-rows-open-in-place.md))
  had ten columns: Context, Est. RAM (the download size again) and Uncensored
  among them. A row took its parameter count from the name only, so a name
  without one ("Ling 3.0 flash") read "—", while the opened row asked Hugging
  Face itself and replaced the count and the context once it answered. Opening
  a row therefore changed its numbers, and a feed row's sizes and download
  options appeared later and pushed the rest down. With the sort arrow inline
  after the label, "Download size" left its arrow alone on a second line.
- **Decision:** The table has seven columns: Model, Parameters, Format,
  Capabilities, Download size, This device, Engines; the opened row lists the
  same facts. For a name without a count, the rows on screen ask Hugging Face
  (`useHubModelParams`, two at a time, latest ask wins), and the row and its
  opened card show that one answer. What is not known yet — the count, a feed
  row's card with its sizes, fit and download options — shows as a pulsing
  placeholder of its size, and "—" / "Unknown" only once the answer says so.
  Each data column keeps an em minimum, so its heading fits on one line and
  grows with the font size; the column steps are in em of the table's font,
  and a sort arrow stays with its heading's last word.
- **Consequences:**
  - The count is the name's when it has one, Hugging Face's otherwise: the
    opened row no longer prefers Hugging Face's own total over the name.
  - Context, Est. RAM and the uncensored tag are gone from the table and the
    opened row; the uncensored filter stays.
  - Layout tests' `settle()` no longer waits for looping animations, which
    never finish.
- **Owner:** team
- **Links:** `web-app/src/containers/hub/LocalModelTable.tsx`,
  `web-app/src/containers/hub/ModelDetailPanel.tsx`,
  `web-app/src/stores/hub-model-params-store.ts`,
  `web-app/src/containers/hub/hub.css`
