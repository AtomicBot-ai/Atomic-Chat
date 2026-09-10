---
date: 2026-08-27
title: "Give the agent native RAG tools over the existing vector collections"
---

# 2026-08-27 — Give the agent native RAG tools over the existing vector collections

- **Context:** Unifying chat and agent left two thread classes on the chat
  fallback because the Rust loop had no retrieval at all: document threads
  (embeddings in `tauri-plugin-vector-db` collections `attachments_<threadId>`)
  and project threads (`project_<projectId>`). Flipping those routes without
  retrieval would have made indexed documents invisible to the model. The
  embedding model (`sentence-transformer-mini`, dim 384) is downloaded,
  started, and stopped by the TS extension layer; the plugin's search has two
  modes with incompatible score semantics (linear = cosine similarity, ANN =
  distance, threshold ignored).
- **Decision:** Add three built-in tools — `docs.list`, `docs.retrieve`,
  `docs.chunks` — behind a `DocsBridge` trait. The plugin grows a public
  read-only `api` module (fresh connection per call, never creates a missing
  collection file, 5s busy timeout). Collection names stay TS-truth and arrive
  verbatim in `AgentTurnRequest.rag`; Rust validates the charset only.
  Embedding lifecycle stays TS-owned: the frontend pre-warms the model, and
  `LiveDocsBridge` merely finds a running `is_embedding` llama.cpp session and
  POSTs `/v1/embeddings` — no session yields a structured "do not retry"
  error. Search is forced-linear so thread and project scopes merge on
  comparable cosine scores; calls without an explicit `scope` search every
  configured scope (thread always, project when present). Turns without `rag`
  disable the tools via `disabled_tools`, keeping the stable prefix
  byte-identical to pre-RAG turns; turns with `rag` add a `### documents`
  variable-tail note listing the indexed file names.
- **Consequences:** Project and document threads can run on the agent engine
  (the route gates die in part C of the rollout), and project threads gain
  something chat never had — one query over both the thread's and the
  project's documents. Costs: linear scan instead of ANN (fine at attachment
  scale; revisit if collections grow), one KV re-ingest when a thread gains or
  loses `rag`, and a hard dependency on the frontend pre-warm for the first
  retrieve. A dimension mismatch (index built by a different embedding model)
  surfaces as a structured "re-index; do not retry" error rather than silent
  bad scores.
- **Owner:** team.
- **Links:** `src-tauri/plugins/tauri-plugin-vector-db/src/api.rs`,
  `src-tauri/src/core/agent/rag_bridge.rs`,
  `src-tauri/src/core/agent/tools/docs.rs`,
  `src-tauri/src/core/agent/ARCHITECTURE.md` ("Document-index tools"),
  2026-08-27-unify-chat-and-agent-on-the-agent-engine.md.
