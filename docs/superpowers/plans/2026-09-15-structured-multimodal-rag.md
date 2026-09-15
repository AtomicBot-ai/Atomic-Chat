# Structured & Multimodal RAG — architecture plan (Phases 1–4)

**Status:** design, awaiting review. No production code changes in this deliverable.
**Scope of this document:** the audit asked for in §21 of the brief (trace, `String` API
inventory, vector-DB migration implications), a detailed implementation plan for
**Phases 1–4 only**, the tests those phases need, and the backward-compatibility argument.
Phases 5–12 appear only as a direction check, so that nothing in 1–4 paints them into a corner.

**Guiding constraint:** this is an extension of the current RAG system, not a replacement.
Every path listed under "Compatibility inventory" must still work, unchanged, at the end of
each phase.

---

## 1. What exists today

### 1.1 Components

| Layer | Path | Role |
| --- | --- | --- |
| Rust parser | `src-tauri/plugins/tauri-plugin-rag/src/parser.rs` (1183 lines) | Every supported format → one `String` |
| Rust parser command | `.../tauri-plugin-rag/src/commands.rs` | `plugin:rag\|parse_document`, panic-guarded |
| Rust vector store | `src-tauri/plugins/tauri-plugin-vector-db/src/db.rs` (642 lines) | SQLite per collection, optional `sqlite-vec` ANN |
| Rust read API | `.../tauri-plugin-vector-db/src/api.rs` | In-process reads for the agent loop (no IPC) |
| TS RAG extension | `extensions/rag-extension/src/index.ts` (573 lines) | Settings, MCP tools, ingest orchestration, query embedding |
| TS vector-DB extension | `extensions/vector-db-extension/src/index.ts` (339 lines) | Collection naming, parse → chunk → embed → insert |
| Contracts | `core/src/browser/extensions/rag.ts`, `.../vector-db.ts` | `RAGExtension`, `VectorDBExtension`, `VectorChunkInput`, `VectorSearchResult` |
| Frontend | `web-app/src/lib/attachmentProcessing.ts`, `web-app/src/services/rag/`, `.../uploads/` | inline-vs-embeddings decision, ingest calls |
| Agent bridge | `src-tauri/src/core/agent/rag_bridge.rs`, `.../tools/docs.rs` | `docs.*` tools reading the same collections from Rust |

### 1.2 Defaults (must remain supported)

`chunkSizeChars 512`, `overlapChars 64`, `retrievalLimit 3`, `retrievalThreshold 0.3`,
`maxFileSizeMB 20`, `searchMode auto`, `parseMode auto` —
`extensions/rag-extension/src/index.ts:19-27` and `extensions/rag-extension/settings.json`.

### 1.3 Collections

`attachments_<threadId>` and `project_<projectId>`
(`extensions/vector-db-extension/src/index.ts:26-32`), one SQLite file each under
`<data_dir>/Radium/data/db/` (`tauri-plugin-vector-db/src/state.rs`).

---

## 2. Trace: one PDF, file selection → answer

**Ingest (embeddings mode, thread scope)**

1. Drop/select → `Attachment { type: 'document', path, fileType, size }`.
2. `processAttachmentsForSend` (`web-app/src/lib/attachmentProcessing.ts:143+`) decides
   `inline` vs `embeddings`. For `auto` it parses first to count tokens:
   `serviceHub.rag().parseDocument(path, fileType)` → `RAGExtension.parseDocument` →
   `plugin:rag|parse_document` → `parser::parse_document` → **`String`**.
3. Embeddings branch → `serviceHub.uploads().ingestFileAttachment(threadId, doc)` →
   `RagExtension.ingestAttachments` (`extensions/rag-extension/src/index.ts:441`), which
   enforces `maxFileSizeMB` and calls
   `VectorDBExtension.ingestFile(threadId, file, { chunkSize: 512, chunkOverlap: 64 })`.
4. `VectorDBExt.ingestFile` (`extensions/vector-db-extension/src/index.ts:265`):
   duplicate check by `name + path` → `ragApi.parseDocument` → **`String`** →
   `vecdb.chunkText(text, 512, 64)` → Rust `db::chunk_text`, a fixed character window
   (`db.rs:617-642`) → `embedTexts(chunks)` against the llamacpp extension →
   `createCollection(threadId, dim)` → `db::create_schema` → `vecdb.createFile` (row in
   `files`, `path` UNIQUE) → `vecdb.insertChunks` → rows in `chunks`
   `(id, text, embedding, file_id, chunk_file_order)`, mirrored into the `chunks_vec`
   vec0 table by `rowid` when `sqlite-vec` loaded (`db.rs:267-329`).

**Retrieve**

5. Model calls the `retrieve` tool → `DefaultRAGService.callTool` injects
   `thread_id` / `project_id` / `scope` → `RagExtension.retrieve`
   (`extensions/rag-extension/src/index.ts:186`) embeds the query and calls
   `vec.searchCollection(id, emb, topK, threshold, mode, fileIds)`.
6. `db::search_collection` picks ANN or linear (`db.rs:343-373`) and returns
   `{ id, text, score, file_id, chunk_file_order }`.
7. `retrieve` reshapes that into `citations[]` JSON and hands it to the LLM.
8. The agent loop reaches the *same* SQLite files in-process through
   `tauri_plugin_vector_db::api` (forcing linear mode), via `rag_bridge.rs` / `docs.rs`.

**Where structure dies:** step 2/4. Between `parse_document` and `chunk_text`, the document
is a flat `String`; page boundaries, headings, table geometry, figures and captions are
already gone before chunking is even asked to make a decision. Nothing downstream can
recover them, which is why "bigger chunks" is not the fix.

**Two pre-existing landmines found during the trace** (not in scope for 1–4, flagged so we
don't build on top of them):

- `search_ann` returns a **distance** in `score` and ignores `threshold`, while
  `search_linear` returns **cosine similarity** and applies it (`db.rs:375-530`). Any hybrid
  scoring in Phase 11 must normalise this first.
- `ingestFileForProject` **deletes the whole project collection** when a newly computed
  embedding dimension differs from the one it just created
  (`extensions/vector-db-extension/src/index.ts:178-184`). Worth a separate fix; Phase 5's
  migration work must not make it easier to hit.

---

## 3. Every API that currently expects/produces `String`

**Rust**

| Symbol | File | Shape |
| --- | --- | --- |
| `parser::parse_document` | `tauri-plugin-rag/src/parser.rs:255` | `(&str, &str) -> Result<String, RagError>` |
| `parse_pdf`, `parse_text`, `parse_docx`, `parse_csv`, `parse_spreadsheet`, `parse_pptx`, `parse_html`, `read_text_auto` | same file | all `-> Result<String, RagError>` |
| `commands::parse_document` | `tauri-plugin-rag/src/commands.rs:5` | Tauri command → `String` |
| `tauri_plugin_rag::parse_document` (re-export) | `lib.rs:11` | consumed by `src-tauri/src/core/agent/tools/fs.rs:87` and `tools/web.rs:376` (PDF-from-URL) |
| `db::chunk_text` | `tauri-plugin-vector-db/src/db.rs:617` | `(String, usize, usize) -> Vec<String>` |
| `db::MinimalChunkInput.text` | `db.rs:40` | `String` |
| `db::SearchResult.text` | `db.rs:19` | `String` |

**TypeScript**

| Symbol | File |
| --- | --- |
| `parseDocument(filePath, fileType): Promise<string>` | `tauri-plugin-rag/guest-js/index.ts:3` |
| `RAGExtension.parseDocument(path, type): Promise<string>` (abstract) | `core/src/browser/extensions/rag.ts:45` |
| `RagExtension.parseDocument` (impl) | `extensions/rag-extension/src/index.ts:544` |
| `RAGService.parseDocument?` + `DefaultRAGService.parseDocument` | `web-app/src/services/rag/types.ts:18`, `.../default.ts:77` |
| `chunkText(text, size, overlap): Promise<string[]>` | `tauri-plugin-vector-db/guest-js/index.ts:86`, used at `extensions/vector-db-extension/src/index.ts:236` |
| `VectorChunkInput { text, embedding }` | `core/src/browser/extensions/vector-db.ts:9` |
| `VectorSearchResult { id, text, score?, file_id, chunk_file_order }` | `core/.../vector-db.ts:15` |
| `Attachment.inlineContent: string` | frontend inline path, `attachmentProcessing.ts` |

**Rule adopted for all phases:** none of these signatures change. Structured output arrives
as *new, additive* symbols beside them. `parse_document -> String` stays the compatibility
surface for the inline-chat path, the agent's `fs`/`web` tools, and any out-of-tree extension.

---

## 4. Vector-DB schema and migration implications

Current schema (`db::create_schema`, `db.rs:152-189`):

```
files  (id TEXT PK, path TEXT UNIQUE NOT NULL, name, type, size, chunk_count)
chunks (id TEXT PK, text NOT NULL, embedding BLOB NOT NULL, file_id, chunk_file_order)
chunks_vec  -- vec0 virtual table, joined to chunks by rowid, only when sqlite-vec loads
```

Findings that shape the migration design:

1. **There is no schema version marker.** `create_schema` is `CREATE TABLE IF NOT EXISTS`
   only, so an existing collection file silently keeps whatever columns it was born with.
   Before any column is added we need `PRAGMA user_version` (0 = legacy) plus a
   `migrate(conn)` step called from both `open_or_init_conn` write paths and
   `api.rs::open_existing` read paths. `api.rs` must stay read-only for *missing*
   collections (its contract: never create a `.db` file), so migration runs only on a file
   that already exists.
2. **All new chunk metadata must be nullable with no backfill.** Legacy rows keep
   `NULL` page / element ids; retrieval must treat "no provenance" as normal, not as an error.
   `ALTER TABLE ... ADD COLUMN` on SQLite is O(1) and does not rewrite rows, so migrating a
   20-manual project collection is instant.
3. **`chunks_vec` is keyed by `rowid`** and is unaffected by adding columns to `chunks`; the
   ANN join keeps working. Migration must *not* drop/recreate `chunks`, which would
   invalidate every `rowid` and orphan the vec table.
4. **`files.path` is UNIQUE**, which is what makes re-ingest of the same path return the
   existing row. A `content_hash` column (Phase 20 caching) is additive next to it, not a
   replacement for it.
5. **Metadata split (proposed for Phase 5):** a small set of first-class, indexable columns
   on `chunks` — `document_id`, `page`, `section_path`, `element_id`, `element_type`,
   `asset_id` — plus one open `metadata_json TEXT` column for the extensible/domain
   metadata of §15 (`domain`, `manufacturer`, `model`, `engine`, …). Domain vocabulary never
   becomes a column; the generic engine only ever filters `metadata_json` by key/value.
6. **`VectorSearchResult` / `SearchResult` grow optional fields only**, so today's consumers
   (`retrieve`, `get_chunks`, `docs.*`) keep working untouched.
7. **No automatic re-indexing.** Existing collections stay as they are; the structured
   pipeline applies to newly ingested files. Re-indexing an old file is an explicit user
   action (proposed Phase 5, not automatic) — a silent mass re-embed of 20 manuals is
   exactly the "schema migration destroys user collections" outcome the brief forbids.

**None of Phases 1–4 touch the schema.** Phase 4 carries structured metadata in memory and
drops it at the DB boundary, so the first four phases are shippable with zero migration risk;
Phase 5 is where the migration above lands.

---

## 5. Implementation plan — Phase 1

**StructuredDocument schema. No behaviour change, no runtime path touched.**

- New Rust module `src-tauri/plugins/tauri-plugin-rag/src/structured.rs`:
  - `StructuredDocument { schema_version: u32, document_id: String, source_path: String,
    filename: String, mime_type: String, metadata: DocumentMetadata, elements: Vec<DocumentElement> }`
  - `DocumentElement { id, kind: ElementKind, page: Option<u32>, section_path: Vec<String>,
    text: Option<String>, parent_id: Option<String>, related_element_ids: Vec<String>,
    asset_id: Option<String>, bbox: Option<BBox> }`
  - `ElementKind`: `Heading | Paragraph | Table | List | Code | Figure | Diagram | Image |
    Caption` — serialised lowercase, `#[serde(other)]`-tolerant so a newer document.json
    read by an older build degrades instead of failing.
  - `DocumentMetadata { title, author, page_count, producer, created, extra: Map<String, Value> }`
    — `extra` is the generic home for domain metadata (§15). **No automotive field ever
    enters this struct.**
  - `pub const SCHEMA_VERSION: u32 = 1;`
- Mirror types in TS. Proposed home: `core/src/types/structuredDocument.ts`, re-exported
  from `core`, with `export const STRUCTURED_DOCUMENT_SCHEMA_VERSION = 1`.
- Serde field naming: `#[serde(rename_all = "camelCase")]` so the Rust and TS shapes are
  literally the same JSON, and `document.json` on disk (Phase 7) needs no translation layer.

**Deliverable:** types + round-trip tests. Nothing imports them yet.

## 6. Implementation plan — Phase 2

**Structured parser API alongside `parseDocument()`.**

- `parser::parse_document_structured(path, file_type) -> Result<StructuredDocument, RagError>`,
  dispatching over the *same* match arms as `parse_document` so format coverage cannot drift.
- Per-format first cut:
  - text/markdown: headings from ATX/setext, fenced code blocks, paragraphs.
  - CSV / XLSX / XLS / ODS: one `Table` element per sheet (`section_path = [sheet name]`,
    already available from `calamine`).
  - DOCX: reuse the existing XML walk (`parser.rs:321-430`) but emit paragraph / table /
    row / cell elements instead of appending to one `String`.
  - PPTX: one section per slide; `pptx_slide_index` already exists (`parser.rs:778`).
  - HTML: headings + paragraphs + tables.
  - PDF: **single-page-less fallback in this phase** — one `Paragraph` element carrying
    today's extracted text. Real page/layout extraction is Phase 6; pretending otherwise
    here would bake a wrong page number into provenance.
  - Anything else: a one-element document wrapping `parse_document`'s output, so no format
    regresses to "unsupported".
- `structured::flatten(&StructuredDocument) -> String`, defined to reproduce today's
  `parse_document` output. Golden tests assert equality per format.
  **`parse_document` is not re-routed through it in this phase** — the two coexist, and
  re-routing is a later, separately reviewable change gated on the golden tests being green.
- Plumbing: new Tauri command `parse_document_structured`, added to
  `tauri-plugin-rag/build.rs`'s command list and to `permissions/default.toml`
  (`allow-parse-document-structured`; the autogenerated per-command toml is regenerated by
  the build). No capability edits needed — `default.json`, `desktop.json`,
  `log-app-window.json` and `logs-window.json` already grant `rag:default`.
- guest-js `parseDocumentStructured(path, type)`;
  `RAGExtension.parseDocumentStructured?()` added as an **optional, non-abstract** method so
  existing implementations still satisfy the contract.
- New setting `structured_parsing` (checkbox, **default `false`**) in
  `extensions/rag-extension/settings.json`. Nothing in the ingest path reads it until Phase 4.

## 7. Implementation plan — Phase 3

**Page / section provenance.**

- Populate `page` and `section_path` on every element the parser can honestly attribute.
- PDF: promote the existing `pdftotext` form-feed page split
  (`split_pdftotext_pages`, `parser.rs:140`) from a diagnostic into the page segmentation
  source when the binary is present; when it is not, `page` stays `None` rather than being
  guessed. `pdf-extract` 0.7 as used today has no per-page API in our call path — a real
  per-page/layout extractor is a Phase 6 decision (candidates to evaluate then:
  `pdfium-render`, `lopdf`; both are new runtime dependencies and need explicit sign-off
  under AGENTS.md rule 6).
- DOCX: `section_path` from `w:pStyle` heading levels. PPTX: `page` = slide index.
  XLSX: `section_path = [sheet]`. CSV: single table, no page.
- **Element IDs are content-addressed** — `sha256(document_content_hash + ordinal)`, truncated
  — so re-ingesting an unchanged file yields identical element ids. That is what makes the
  Phase 20 hash cache and any future "highlight this element" UI stable across re-ingest.
  `sha2 0.10` is already a workspace dependency (`src-tauri/Cargo.toml:114`) but not yet in
  the rag plugin's own `Cargo.toml`; adding it there is a new crate-level dep — call it out
  in review, no new third-party code enters the tree.
- `DocumentMetadata.page_count` filled where the format knows it.

## 8. Implementation plan — Phase 4

**Semantic chunker.**

- New `src-tauri/plugins/tauri-plugin-rag/src/chunker.rs`:
  `chunk_structured(&StructuredDocument, &ChunkOptions) -> Vec<StructuredChunk>`, where
  `StructuredChunk { text, document_id, element_ids: Vec<String>, page: Option<u32>,
  section_path: Vec<String>, element_type: ElementKind, order: usize }`.
- **Where it lives: Rust, not TypeScript.** The agent loop reads these collections
  in-process (`rag_bridge.rs`); a TS-only chunker would force a second implementation the
  first time the agent ingests anything.
- Boundary rules, in priority order:
  1. A `Table` is never split by character count. A table over `max_chunk_chars` splits by
     **row groups with the header row repeated into each group** — the secondary
     table-specific strategy the brief allows.
  2. `Figure`/`Diagram`/`Image` + its `Caption` + the paragraph that references it stay in
     one chunk, linked by `related_element_ids`.
  3. A heading plus the paragraphs under it, up to the next heading of the same or higher
     level, forms one unit; units are packed up to `target_chunk_chars`.
  4. `Code` and `List` elements stay whole where they fit.
  5. Only a single element that *alone* exceeds `max_chunk_chars` falls back to today's
     character window — so worst-case behaviour equals current behaviour, never worse.
- Options and defaults: `target_chunk_chars 1200`, `max_chunk_chars 2400`, structural
  overlap `0` (the section path and element relationships carry the context that overlap was
  compensating for). New settings `structured_chunk_target_chars` /
  `structured_chunk_max_chars`. **`chunk_size_chars 512` / `overlap_chars 64` keep their
  exact current meaning for the legacy path.**
- Wiring: `VectorDBExt.ingestFile` / `ingestFileForProject` check the `structured_parsing`
  setting. When **on** *and* the format has a structured parser, chunk texts come from
  `chunk_structured`; otherwise the existing `parseDocument` + `chunkText` path runs
  verbatim. When on, per-chunk metadata is produced but **dropped at the DB boundary**
  (Phase 5 stores it), so `chunks` rows and `chunk_file_order` contiguity are unchanged and
  `get_chunks(start_order, end_order)` still works.
- Exposed as `plugin:rag|chunk_structured` (same permission pattern as Phase 2) so the
  TS pipeline and the Rust agent share one implementation.

**End state after Phase 4:** flag off → byte-identical behaviour to today. Flag on →
better chunk boundaries, same storage shape, same retrieval contract.

---

## 9. Tests

**Rust — `tauri-plugin-rag`**

| Test | Asserts |
| --- | --- |
| Serde round-trip per `ElementKind` | Phase 1 schema is stable; unknown kind degrades |
| Rust ↔ TS schema-version parity | `SCHEMA_VERSION` == `STRUCTURED_DOCUMENT_SCHEMA_VERSION` |
| **Golden: `flatten(parse_document_structured(f)) == parse_document(f)`** for every fixture | the regression guarantee for the whole plan |
| DOCX with a table | rows/cells become one `Table`, not tab-soup |
| XLSX workbook | one table per sheet, `section_path == [sheet]` |
| PPTX | slide index → `page` |
| Source-code file | code fences / whole-file element, no heading hallucination |
| PDF with pages | `page` populated when `pdftotext` is present, `None` when absent (both asserted) |
| PDF scanned / mixed | existing `build_pdf_gap_warning` behaviour unchanged |
| Element-id stability | same bytes in → same ids out, across two runs |
| Chunker: oversize table | split by row groups, header repeated, never mid-row |
| Chunker: figure + caption | land in one chunk with both element ids |
| Chunker: heading grouping | heading + its paragraphs together; next heading starts a new chunk |
| Chunker: oversize paragraph | falls back to character window, no data loss |
| **Regression: legacy path** | flag off → `chunk_text(512, 64)` output identical to today |

Fixtures: DOCX/XLSX/PPTX/HTML keep being synthesised in-code (the existing
`write_zip_fixture` helper, `parser.rs:863`). PDFs need real bytes → propose
`src-tauri/plugins/tauri-plugin-rag/tests/fixtures/` holding **small, self-generated** PDFs
(normal, multi-page, table, figure+caption, mixed text/image, scanned). **No customer or
copyrighted manual content enters the repository**; the VW corpus validation of Phase 12 runs
out-of-tree against a local path.

**TypeScript**

- `core`: type-level test that `RAGExtension` without `parseDocumentStructured` still
  compiles (old-extension compatibility).
- `extensions/vector-db-extension`: ingestion works when `parseDocumentStructured` is absent
  (falls back), and when the setting is off (legacy path chosen).
- `web-app`: `attachmentProcessing` inline path still receives a `string`.

**The §19 acceptance test, stated concretely:** given a fixture PDF whose page 27 holds a
diagram with a caption — assert `page == 27`, a figure element exists, a caption element
exists, `related_element_ids` links them, they chunk together, and (from Phase 5 onward) a
retrieval on the caption text returns a chunk carrying `page: 27`.

**Gate:** `make verify` for anything agent-authored; `cargo check` + `cargo clippy` in
`src-tauri/` for focused Rust iteration (AGENTS.md §6.4).

---

## 10. Compatibility inventory — what must still work at every phase boundary

| Surface | Why it is safe in Phases 1–4 |
| --- | --- |
| `parse_document -> String` (Tauri command, Rust re-export, guest-js, core, service) | untouched; new API is additive |
| `agent tools/fs.rs`, `tools/web.rs` PDF-from-URL | call the unchanged `parse_document` |
| Inline chat attachments | still take the `String` path |
| Project attachments & project collections | ingest path unchanged with the flag off |
| Existing vector collections on disk | **no schema change until Phase 5**; no re-index |
| `retrieve` / `list_attachments` / `get_chunks` tools | result shape unchanged |
| Agent `docs.*` tools (`rag_bridge.rs`) | read the same rows through `api.rs`, unchanged |
| Existing embeddings | never recomputed by these phases |
| Thread/project scope + `file_ids` filtering | untouched |
| Settings `512 / 64 / 3 / 0.3 / 20 MB` | defaults unchanged; new settings are new keys |
| Radium UI | no UI changes in Phases 1–4 beyond one new settings checkbox |

---

## 11. Direction check for Phases 5–12 (not in scope, recorded so 1–4 don't block them)

5. Nullable metadata columns + `PRAGMA user_version` migration + opt-in re-index (§4).
6. PDF page/layout extraction — needs a per-page library decision and sign-off.
7. Asset store. Proposed root `<data_folder>/rag/documents/<document_id>/` with
   `document.json` + `assets/`, mirroring the provenance-record pattern the media library
   already uses (see "The media library lives at `<data_folder>/media/`" in
   `docs/decisions/INDEX.md`) rather than inventing a second convention. **Needs confirmation.**
8. Tables as first-class objects: structured representation stored next to a searchable
   textual rendering, both pointing at the same `element_id`.
9. Selective OCR, only for pages the native extractor could not resolve; native text wins
   on merge; OCR text stored in its own field.
10. Visual descriptions from a multimodal model, stored **separately from OCR text** —
    never conflated.
11. Hybrid retrieval (dense + keyword + metadata filter). Prerequisite: normalise the
    ANN-distance vs cosine-similarity mismatch found in §2.
12. VW manual validation, run against a local corpus, out of tree.

---

## 12. Open questions for the reviewer

1. **Asset store location** — `<data_folder>/rag/documents/<id>/` as proposed in §11.7, or
   folded into the existing media library root? (Affects Phase 7, decide before Phase 5 lands
   the `asset_id` column.)
2. **New Rust dependencies** — AGENTS.md rule 6 requires explicit approval. Phase 3 wants
   `sha2` in the rag plugin (already a workspace dep). Phases 6–9 will want a per-page PDF
   library, an image encoder and an OCR engine. Approve per phase, not up front.
3. **Structured chunk defaults** — 1200/2400 chars with `retrievalLimit 3` roughly triples
   retrieved context vs today. Raise the limit only under the structured flag, or leave it to
   the user?
4. **Re-index of existing collections** — confirm opt-in only, never automatic.
5. **Flag lifetime** — how long does `structured_parsing` stay default-off before it becomes
   the default for new ingests?

---

## 13. Sequencing

One PR per phase, each independently revertible:

| PR | Contents | Risk |
| --- | --- | --- |
| 1 | Phase 1 types + tests | none — nothing imports them |
| 2 | Phase 2 structured parsers, `flatten`, command, optional contract method, flag (off) | low — new code path, unreachable by default |
| 3 | Phase 3 provenance + content-addressed ids | low — same |
| 4 | Phase 4 chunker + flagged wiring | medium — first phase that changes what gets embedded, and only with the flag on |

Phase 5 (schema + migration) opens as its own design note before implementation, because it
is the first change that touches user data.
