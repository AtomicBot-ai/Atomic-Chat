# Idempotent unfinished-download deletion

A persisted download row can remain after its local directory has disappeared. Previously the validator treated a missing ancestor or leaf as an error, so explicit deletion retained the stale paused row. An empty directory left by interrupted deletion likewise failed the partial-artifact check.

After validating provider and relative path, require the configured data root to be accessible (a disconnected drive is not successful deletion), then inspect existing ancestors without following symbolic links. A missing directory means there is nothing left to delete; return success so the caller can clear persisted recovery state. An empty validated leaf can also be removed. Nonempty folders still require known unfinished GGUF artifacts, and installed models, links, nested directories and unknown files remain refused. Do not search other model roots or delete external files to satisfy a stale row.

Display and log the original error when deletion actually fails, in addition to retaining the paused row and its retry information. This affects cancellation and file-disposal behavior, not inference or download scheduling.

Regression tests cover missing directories, repeat deletion, empty leaves, completed-file protection, linked ancestors, failure details and dialog overflow. Tests delete only temporary fixtures. No live user-download deletion is used as validation.
