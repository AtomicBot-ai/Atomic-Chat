---
date: 2026-09-19
title: "Keep document indexes in the data folder"
---

# 2026-09-19 — Keep document indexes in the data folder

- **Context:** `tauri-plugin-vector-db` kept every collection (`attachments_<thread>.db`, `project_<id>.db`) in a fixed directory under the system data dir — `dirs::data_dir()/Atomic Chat/data/db` — computed inside the plugin, which knows nothing of the app's data folder. With the default data folder the two paths coincide, which hid it. With a relocated data folder the indexes stayed on the system disk, did not move with the folder, and survived a factory reset, which deletes `<data folder>/db` (`JAN_DATA_SUBDIRS` already lists `db`). Found while writing the desktop e2e document scenario.
- **Decision:** The app tells the plugin where to keep collections: `tauri_plugin_vector_db::init_in(|app| <data folder>/db)`. On startup the plugin moves files still in the legacy directory into the current one — rename, or copy-and-remove across volumes — and leaves alone any name the current directory already has, since a collection present in both was created after the move and is the one in use. `init()` stays for hosts without a data folder and keeps the legacy place.
- **Consequences:** Indexes move with the data folder (the move copies the whole folder) and go with a factory reset. For the default data folder nothing moves: both paths are the same. A user who relocated the folder earlier gets their collections brought over at the next start; a collection that fails to move stays where it was and is logged, so its documents look unindexed until re-attached. The plugin's tests now run in `make test-rust`, which had skipped this plugin.
- **Owner:** team
- **Links:** `src-tauri/plugins/tauri-plugin-vector-db/src/state.rs`, `src-tauri/plugins/tauri-plugin-vector-db/src/lib.rs`, `src-tauri/src/lib.rs`, `Makefile`, `tests/e2e/desktop/document-attachment.spec.ts`
