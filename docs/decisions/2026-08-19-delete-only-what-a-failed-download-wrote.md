---
date: 2026-08-19
title: "Delete only what a failed download wrote"
---

# 2026-08-19 — Delete only what a failed download wrote

- **Context:** a field report of models disappearing from disk: a download or
  re-import starts, fails, and the model is gone. Three paths could do it, and
  all three were destructive beyond the file they were downloading.
  1. On a hash/size verification failure, `import()` in both llama.cpp
     extensions called `deleteModelFolder()`, an `fs.rm` of the entire model
     directory. That directory is shared: it holds the mmproj, the DFlash / MTP
     drafts and the sibling shards of a model that may already be installed and
     working. One file failing its check removed all of them.
  2. `download_files` deleted every item's `save_path` — the *finished* file,
     not the `.tmp` partial — whenever its cancel token was cancelled. Pause
     cancels the same token, and so does a newer download claiming the same
     task id, so "cancel" could delete a completed model the user already had,
     and a superseded task could delete the file its successor was writing. The
     same cleanup also removed the successor's registration from
     `cancel_tokens`, leaving that download uncancellable.
  3. Nothing recorded any of it. `tauri_plugin_log::Builder::default()` caps a
     log file at 40 KB with `RotationStrategy::KeepOne`, which does not archive
     — it `remove_file`s `app.log` and starts over. At `Debug`, with `reqwest`
     and `hyper` logging every connection, that budget is minutes, so the
     incident window was gone before anyone could file a report, and the file
     appeared to erase itself with the app still running.
- **Decision:** a failed download removes its own artifacts and nothing else —
  the target file plus its `.tmp` / `.url` partials — and the model directory
  goes only when it is left empty. A cancelled download deletes nothing at all
  (pause/resume is built on the partials), a superseded one is recognised as
  such and keeps its hands off the successor's files and registration. Logging
  is raised to 10 MB × 5 generations (`KeepSome`) with the HTTP crates dropped
  to `warn`, and every destructive filesystem call — the frontend `rm` command,
  the validation cleanup — logs its target before acting.
- **Consequences:** a corrupt download now costs the corrupt file, not the
  model beside it, and a re-download that fails no longer takes the working copy
  with it. Partial `.tmp` / `.url` files from cancelled downloads are kept
  rather than swept, which is what resume needs but does leave litter that
  nothing currently collects — worth a separate cleanup path. The trigger for
  the spontaneous re-download that started this is still unknown; the log
  changes exist so the next occurrence is captured.
- **Owner:** @mishaskvortsov
- **Links:** `extensions/llamacpp-extension/src/index.ts` and
  `extensions/llamacpp-upstream-extension/src/index.ts`
  (`cleanupFailedDownload`), `src-tauri/src/core/downloads/commands.rs`,
  `src-tauri/src/core/downloads/models.rs` (`DownloadTask`),
  `src-tauri/src/core/downloads/helpers.rs`,
  `src-tauri/src/core/filesystem/commands.rs`, `src-tauri/src/lib.rs`.
