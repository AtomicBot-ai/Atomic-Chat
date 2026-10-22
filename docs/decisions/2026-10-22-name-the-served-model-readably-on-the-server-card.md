---
date: 2026-10-22
title: "Name the served model readably on the Server card"
---

# 2026-10-22 — Name the served model readably on the Server card

- **Context:** UI audit 2.2.23, finding 07. The Server sidebar card (Start,
  Engine, Model, Connections) is on every Server page. Its Model row put the
  raw id beside the label in a 100 px slot, so
  `AtomicChat/Muse-Glimmer-30B-AD-IQ4_XS` read "AtomicChat/Mus…": the owner
  survived and the model and its quantization, which identify it, were cut.
- **Decision:** The Model row is two lines. The label line holds "Model" and,
  on its right, the quantization as a small mono badge; the readable name has
  the next line to itself, at the row's full width, and truncates at its end
  only when still too long. The name and quant come from the composer's
  helpers (`compactModelDisplayName`, `modelVariantDetails`): the user's
  nickname if the model has one, else the id without owner, format and
  quant ("Muse Glimmer 30B AD"); the quant is left out when the id names none
  or the name already reads it. The full id, which clients pass as `model`,
  is the row's `title` (hover, and the link's accessible description).
  `useServedModel` returns `name` and `quant` beside `engine` and `model`.
- **Rejected:** a copy button in the row — the row is a link to Engine &
  model, a button inside it would be nested interactive content, and the
  narrow text column has no room for a separate one; Connections shows the
  loaded id and puts it in Try a request's copyable examples. A Radix
  tooltip for focus — the codebase shows full ids with `title`, and a
  zero-delay tooltip on every pass over the sidebar is noise.
- **Consequences:** The card is one line taller while a model is set or not
  (the row keeps its two lines with "Not selected"), so it does not jump when
  the server starts. The owner is not shown on the card; two models that
  differ only by owner read alike there and differ in the tooltip. The
  Overview strip still shows the raw id.
- **Owner:** `team`.
- **Links:** `web-app/src/containers/ServerControlPanel.tsx`,
  `web-app/src/containers/ServerControlPanel.css`,
  `web-app/src/containers/server/useServedModel.ts`,
  `web-app/src/containers/ServerControlPanel.layout.test.tsx`,
  [Give model picker rows a second line for quant, owner and source](2026-10-22-give-model-picker-rows-a-second-line-for-quant-owner-and-source.md)
