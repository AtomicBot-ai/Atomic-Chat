---
date: 2026-10-22
title: "Clean verified download sidecars before reporting success"
---

# 2026-10-22 — Clean verified download sidecars before reporting success

- **Context:** resuming an already completed shard reused its payload while intentionally retaining old `.tmp`, `.url` and `.parts` files. Once the request completed and left the active inventory, those real leftovers appeared as a second unfinished download.
- **Decision:** after every file passes validation, remove only the request's own `.tmp`, `.parts.new`, `.parts` and `.url` before reporting batch success and before the importer writes `model.yml`. Reuse the existing per-path writer guard; check cancellation, regular files, known completed size and matching sidecar source/map identity before deletion. Recheck supplied hashes while that guard is held when leftovers exist. No extra checksum pass is needed on the normal path without sidecars.
- **Failure:** unknown/conflicting metadata, links, invalid completed size, hash mismatch or cancellation preserve recovery files. Cleanup failures must never enter the validation-failure payload deletion branch. A validation failure on a preexisting resumed payload also preserves that user's file and its sidecars. Cleanup uses unlink only, with the source URL removed last; it never removes the model directory or another payload.
- **Inventory:** running and manually paused jobs continue to suppress the same directory's partial inventory row. Successful completion now leaves no owned partials to produce a duplicate row, instead of merely hiding their disk usage.
- **Verification:** native tests exercise owned sidecar cleanup, unchanged neighboring/payload files, wrong size/source/hash, unknown metadata, cancellation, idempotence, and the actual resumed batch success/failure paths. Inventory fixtures include the exact long model id reported by the user. Existing installed leftovers are a one-time, user-authorized cleanup after full completed-file SHA-256 and size comparison against official repository metadata; no model or SD-card payload is deleted.
