---
date: 2026-09-16
title: "Structural provenance on chunks, document metadata on files; RAG assets get their own root"
---

# 2026-09-16 — Structural provenance on `chunks`, document metadata on `files`; RAG assets get their own root

- **Context:** the structured-RAG plan
  ([`docs/superpowers/plans/2026-09-15-structured-multimodal-rag.md`](../superpowers/plans/2026-09-15-structured-multimodal-rag.md))
  left five questions for its reviewer. They were resolved on 2026-09-16; three of them fix
  the storage shape Phase 5 will migrate to, and the answers need to be on record before any
  column is added to a user's collection.

- **Decision:**
  1. **Re-indexing an existing collection is opt-in, never automatic.**
  2. **Per-chunk columns carry structural provenance** (`document_id`, `page`,
     `section_path`, `element_id`, `element_type`, `asset_id`); **per-document metadata —
     the extensible `domain` / `manufacturer` / `model` vocabulary — lives in one nullable
     `metadata_json` on `files`.** A metadata filter resolves to a set of `files.id` and is
     passed to `search_collection` through its existing `file_ids` argument, so no new
     predicate enters the sqlite-vec query.
  3. **RAG assets live at `<data_folder>/rag/documents/<document_id>/`** (`document.json` +
     `assets/`), separate from the media library. `asset_id` is opaque and resolved to a
     path by one helper; absolute paths are never persisted.
  4. **The two defects the ingestion trace surfaced are fixed as their own PRs, ahead of the
     phased work**: `ingestFileForProject` deleting an entire project collection on an
     embedding-dimension mismatch (data loss, reachable today by switching embedding model)
     goes first; the ANN-distance vs cosine-similarity score mismatch lands before Phase 5.
  5. **`retrieve` citations carry `filename`, `page`, `section`, `element_type`** — not
     `document_id` / `element_id` / `chunk_id` / `asset_id`, which stay in the API return for
     the UI but out of the model-visible payload.

- **Consequences:** document metadata is stored once instead of per chunk, so correcting it
  is one `UPDATE` rather than a rewrite of every chunk in a manual, at the cost of a join in
  metadata-filtered search; reusing `file_ids` means the filter rides an already-tested path.
  Keeping the asset store out of the media library keeps regenerable cache out of a
  user-browsable library and keeps deletion semantics separate, at the cost of a second
  on-disk convention to document. Fixing the project-collection deletion first means one
  small PR lands before any of the phased work. Watch for: the model-visible citation shape
  is a prompt-behaviour change the first time provenance appears, and metadata filtering
  inherits whatever `file_ids` filtering already does on the ANN path.

- **Owner:** `team`.

- **Links:** plan §4.5, §12, §13 —
  [`docs/superpowers/plans/2026-09-15-structured-multimodal-rag.md`](../superpowers/plans/2026-09-15-structured-multimodal-rag.md);
  prior record —
  [`2026-09-15-add-a-structureddocument-ir-beside-parsedocument-not-instead.md`](2026-09-15-add-a-structureddocument-ir-beside-parsedocument-not-instead.md);
  `src-tauri/plugins/tauri-plugin-vector-db/src/db.rs`,
  `extensions/vector-db-extension/src/index.ts`.
