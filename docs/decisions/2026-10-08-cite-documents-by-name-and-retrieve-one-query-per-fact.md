---
date: 2026-10-08
title: "Cite documents by name, and retrieve one query per fact"
---

# 2026-10-08 — Cite documents by name, and retrieve one query per fact

- **Context:** Document answers (chat `retrieve` in `extensions/rag-extension`, Agent `docs.retrieve`)
  had two QA findings. ATO-551: the tool result carried only chunk and file UUIDs, so a correct answer cited
  `efeb2156-…` and `af1035b9-…`, with nothing to click and no file name. ATO-552: a question asking for three
  facts ("the two UTC times of the capability-probe timeouts and the MiniLM vector dimension") went out as one
  combined query, embedded once, `top_k` 3 (the setting was also the schema's maximum); the MiniLM-L6 embedding
  blurred the three needs, and the passage with `384` was not among the three hits. A focused query found it.
  `search_mode: auto` also meant ANN, whose scores are distances that ignore the threshold, so results of
  different queries could not be compared.
- **Decision:**
  - *Readable citations:* each hit carries `cite: "[FINDINGS.md §13]"` (file name and 1-based passage, from
    one listing of the scope per call), `source`, `passage`, `text`, `score`, `file_id`, `chunk_file_order`; the
    chunk id is no longer returned. A hit whose file is no longer listed is labelled `removed document` with
    `removed: true`; a failed listing gives `document`. `sources` adds name, path and passage count for the UI.
    The tool descriptions tell the model to copy the `cite` label exactly and never cite ids; the phantom
    `scope` argument wording is gone (scope is injected by the app).
  - *Citation chips:* `web-app/src/lib/doc-citations.ts` collects the message's `retrieve` / `docs.retrieve`
    outputs and links the labels — and, for older answers, raw chunk/file UUIDs that match a stored output —
    to `https://atomic.local/doc-cite?ref=<file_id>:<order>` outside code. MessageItem renders those as a chip
    with a card: file name, passage *n* of *N*, the stored passage, "Open document" / "Show in folder" through
    the opener service, and an error toast when the file moved. When the card opens, chat outputs (which name
    their thread or project) re-list the collection, so a file removed later reads as removed. Unknown labels
    stay text. Everything comes from the persisted tool parts, so links survive navigation and restarts.
  - *One query per fact:* `retrieve` takes `queries` (≤ 5) beside an optional `query` (at least one checked at
    run time, no `anyOf`); `top_k` has a fixed maximum of 10, independent of `retrieval_limit`, whose default
    goes from 3 to 5 (saved settings keep 3; the setting's own maximum is now 10). All queries are embedded in
    one request and searched in linear mode; results merge by chunk with the best score and the queries that
    matched, and each query's best passage is kept before the rest compete for `top_k`. `docs.retrieve` takes
    `queries` the same way (grammar alternation `query | queries`, default `top_k` 5).
  - *Lexical boost:* `search_linear` in `tauri-plugin-vector-db` takes an optional `query_text` (threaded
    through guest-js, the Tauri command, `api::search_collection` and the Agent bridge): score = cosine +
    0.2 × the share of the query's terms in the chunk (lowercase letter or digit runs, `06:48:48` and `3.14`
    kept whole, stopwords and single characters dropped), and a chunk with at least half of the terms is kept
    even below the cosine threshold. Without `query_text` scores and filtering are unchanged.
- **Consequences:** Answers cite `[FINDINGS.md §13]` and the UI shows which passage backs a claim. Exact
  tokens (times, ids, numbers) no longer depend on a 384-dimension embedding alone. Costs: the chat tool
  ignores the `search_mode` setting (always linear, a full scan per query; fine at attachment scale, as for the
  Agent since `2026-08-27-native-agent-rag-tools`); up to five embeddings and searches per call; boosted scores
  can exceed 1. Two attached files with the same name share labels. Agent outputs do not name their
  collection, so their chips use the stored name and path and only learn of a removal when opening fails.
  Extensions type-check against the packed `core/package.tgz`, which needs a rebuild to see `queryText`.
- **Owner:** `team`.
- **Links:** Linear ATO-551, ATO-552; `extensions/rag-extension/src/{tools,retrieval,index}.ts`,
  `src-tauri/plugins/tauri-plugin-vector-db/src/{db,api,commands}.rs`, `src-tauri/src/core/agent/tools/docs.rs`,
  `web-app/src/lib/doc-citations.ts`, `web-app/src/containers/DocCitationChip.tsx`.

<!--
Supersedes: none (extends 2026-08-27-native-agent-rag-tools.md)
-->
