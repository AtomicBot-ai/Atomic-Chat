# Confirm model download cancellation and offer permanent file disposal

Date: 2026-10-20

## Decision

The download-panel X opens a confirmation dialog with keep files, permanently delete files, and go back. Opening or dismissing the dialog does not stop a transfer. Keep preserves the existing cancellation semantics. Explicit deletion waits for the importer to release its files and excludes concurrent retries of that job.

A dedicated native command accepts a provider and model id, never a frontend absolute path. It permanently removes files from one unfinished leaf directory, including already completed shards belonging to that download. It rejects installed model metadata, nested directories, symlinks, unsupported providers and paths outside the supported model roots. The dialog explicitly warns that deleted files cannot be recovered. Unknown files are refused; directory trees are never recursively deleted. Errors restore a paused row and retain recovery parameters.

The initial disposal scope is llama.cpp and Prism leaf downloads. MLX and unresolved-source jobs still offer keep and go back; safe disposal for their nested layouts is deferred. The existing completed-model delete API is unchanged.

## Validation

Regression coverage checks confirmation, go back, keep, successful disposal, failure recovery, import unwind and retry exclusion. Native validation covers traversal, installed model and symlink rejection. Browser geometry covers Korean/English, Medium/Extra Large and light/dark themes. Live app checks use disposable fixtures, never original model payloads.
