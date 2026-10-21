---
date: 2026-10-21
title: 'List and remove download leftovers on the Downloads page'
---

# 2026-10-21 — List and remove download leftovers on the Downloads page

- **Context:** The Downloads page merges what each owner records about its
  models. Some disk use had no owner record, so the page could neither show it
  nor free it: MLX models downloaded from the Hub record `size_bytes: 0` in
  `model.yml` (the MLX download is never handed a size) and showed "—"; MLX
  speculative-decoding drafts under `mlx/draft-models/` (and draft repos
  imported into `mlx/models/`) are in no model list; and a download that never
  finished leaves its `.tmp`, `.url`, `.parts` and `.parts.new` sidecars behind.
  In the 2.2.21 QA pass this hid about 4.9 GB of one MLX model, 3.3 GB of
  drafts and 4.3 GB of partial downloads; "Total storage" read 39.6 GB instead
  of about 52 GB.
- **Decision:** The page reads `llamacpp/models`, `mlx/models` and
  `mlx/draft-models` with the data folder's own file commands
  (`web-app/src/lib/downloads-disk.ts`). An MLX model with no recorded size
  gets its folder size, partial files excluded. Each folder with partial files
  becomes a "partial download" row: the whole folder goes only when no
  `model.yml` exists in it and it is not inside an installed model's folder;
  otherwise only the partial files go. Downloads the app is running, paused or
  can resume are not listed, and that is checked again when removal is
  confirmed. Complete drafts are listed; removing one is refused while an MLX
  drafter switch (DFlash / MTP / EAGLE-3) is on. Every removal goes through the
  page's confirmation dialog and `rm`, which refuses paths outside the data
  folder.
- **Consequences:** "Total storage" counts what is really on disk, and users
  can reclaim it without a file manager. A download started outside the app's
  download store (the CLI) is not seen as active, so its partial files could be
  listed; the confirmation names the folder. The proper fix for MLX sizes is in
  `extensions/mlx-extension` (write a real `size_bytes` after download); the
  frontend file commands are marked for deprecation, so the long-term home of
  this scan is the core or a Tauri command returning root, id, paths, bytes and
  whether each is in use.
- **Owner:** `team`
- **Links:** `web-app/src/lib/downloads-disk.ts`,
  `web-app/src/lib/installed-inventory.ts`,
  `web-app/src/hooks/useInstalledInventory.ts`,
  `web-app/src/containers/downloads/DownloadsPage.tsx`.
