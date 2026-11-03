---
date: 2026-10-22
title: 'Name Downloads rows by their model, with the quant apart'
---

# 2026-10-22 — Name Downloads rows by their model, with the quant apart

- **Context:** QA 10 (2.2.23 UI review). A Downloads row for a local model,
  a running model download or an unfinished one was titled with its raw id,
  such as "AtomicChat/NVIDIA-Nemotron-3_5-Lightning-30B-A3B-Q4_K_M". The title
  truncates at its end, so the quant was the first thing cut. Two quants of
  one model could not be told apart without hovering each row.
- **Decision:** The row's title is the model's name, shown once. A user
  nickname or a name the engine gave the model is kept as it is. Otherwise
  the id is read as a name without its owner, format or quant
  (`compactModelDisplayName`). The quant and the repository owner
  (`modelVariantDetails`, as in the model picker) are their own facts on the
  line under the title: "llama.cpp · Q4_K_M · incomplete download ·
  AtomicChat". The line's ellipsis cuts from the end, so the owner goes last.
  The full id on hover and in the confirmation also carries it. A quant or
  owner the name already spells is left out. A task id's provider prefix or
  drafter tag (`mlx/dflash:`) is not read as an owner. The full id is the
  title's tooltip. A small copy button after the title
  shows the id in a tooltip on hover and on keyboard focus, and copies it on
  click. The button is quiet until the row is hovered or has focus, and it
  keeps its slot so the row does not move. Search also matches the id. The
  Remove button's accessible name reads the whole line, owner included. The
  removal dialog and its toasts name the model with its quant and, in
  brackets, its owner. The dialog's description also gives the full id.
  Quants of one model, and one model from two owners, sort by id. Managed and Foundry Local downloads keep the Hub card's name or
  their id, and MLX drafts keep their id: none of these is a Hugging Face
  file name.
- **Consequences:** `InventoryItem` gained `modelId`, `quant` and `owner`.
  Downloads and the model picker now tell variants apart by the same quant
  and owner. Where the line is too narrow, the owner is cut before the kind.
  Sizes and the action column are unchanged. The dialog title now wraps
  anywhere, so a long unbroken name cannot widen the dialog. The copy button
  lives in the name cell because the 3.75rem action column holds one
  button. `DownloadsPage.layout.test.tsx` measures the quant's own text
  range against the box that clips it, for the reported Nemotron id, a
  worst-case long id and an id with an earlier "q4_0" in its name. It also
  checks that two owners' copies of one quant each show their owner. The
  confirmation must hold the longest id without widening. It checks
  1024/1280 px, Medium/Extra Large, light/dark.
- **Owner:** `team`.
- **Links:** `web-app/src/lib/installed-inventory.ts`,
  `web-app/src/containers/downloads/DownloadsPage.tsx`,
  `web-app/src/lib/model-display-name.ts`,
  `web-app/src/containers/downloads/DownloadsPage.layout.test.tsx`,
  `docs/decisions/2026-10-22-give-model-picker-rows-a-second-line-for-quant-owner-and-source.md`
