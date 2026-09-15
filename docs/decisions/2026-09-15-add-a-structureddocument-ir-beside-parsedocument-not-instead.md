---
date: 2026-09-15
title: "Add a StructuredDocument IR beside parse_document, not instead of it"
---

# 2026-09-15 — Add a StructuredDocument IR beside `parse_document`, not instead of it

- **Context:** ingestion reduces every supported format to one `String`
  (`tauri-plugin-rag/src/parser.rs`) before a fixed 512/64 character window splits it
  (`tauri-plugin-vector-db/src/db.rs::chunk_text`). Page boundaries, headings, table
  geometry, figures and captions are gone before chunking gets to make any decision, so
  retrieval cannot answer "where did this come from" and cannot keep a wiring diagram
  attached to the text that explains it. That `String` is also the contract for the inline
  chat path, the agent's `fs`/`web` tools and any out-of-tree extension.

- **Decision:** introduce a versioned `StructuredDocument` intermediate representation
  (document → metadata → elements with page, section path and relationships) and a
  `parse_document_structured` API **alongside** the existing `parse_document -> String`,
  which keeps its signature and output. The structured pipeline — structured parsers,
  provenance, semantic chunker — ships behind a `structured_parsing` setting that defaults
  to off, one phase per PR. Chunk-metadata storage and the vector-DB migration are
  deliberately excluded from those first phases, so nothing touches user collections until
  a migration guarded by `PRAGMA user_version` (additive nullable columns, no row rewrite,
  no automatic re-index) is designed and reviewed on its own. Domain vocabulary
  (automotive and otherwise) stays out of the generic types and lives in an open metadata
  map.

- **Consequences:** existing attachments, collections, embeddings, RAG tools, agent
  `docs.*` tools and supported formats keep working unchanged, and each phase is
  independently revertible; the cost is two parser paths to maintain until golden tests
  prove `flatten(structured) == parse_document` per format, plus a feature flag whose
  default flip needs its own decision. Watch for: the ANN path returning distance in
  `score` while linear returns cosine similarity (blocks hybrid scoring until normalised),
  and `ingestFileForProject` deleting a whole project collection on an embedding-dimension
  mismatch — both pre-existing, both must be resolved before the storage phases.

- **Owner:** `team`.

- **Links:** plan —
  [`docs/superpowers/plans/2026-09-15-structured-multimodal-rag.md`](../superpowers/plans/2026-09-15-structured-multimodal-rag.md);
  `src-tauri/plugins/tauri-plugin-rag/src/parser.rs`,
  `src-tauri/plugins/tauri-plugin-vector-db/src/db.rs`,
  `extensions/rag-extension/src/index.ts`,
  `extensions/vector-db-extension/src/index.ts`,
  `core/src/browser/extensions/rag.ts`.
