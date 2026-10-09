---
date: 2026-10-09
title: "Match file_ids by name, and tell the model documents are attached"
---

# 2026-10-09 — Match file_ids by name, and tell the model documents are attached

- **Context:** The RC 2.2.1 retest (ATO-552 follow-up) had two document answers fail with the index
  intact. (1) Asked to "search the uploaded FINDINGS.md", Gemma 4 E4B called `retrieve` with
  `file_ids: ["FINDINGS.md"]`. The vector store filters on file ids, so the name matched nothing and
  the tool returned `citations: []`, which the model read as "not in the document". The same queries
  without `file_ids` found both facts. (2) In a fresh project chat the model answered that six facts
  were "absent from the project files" without calling any tool, although `retrieve` was offered
  (the retry reused the same prompt prefix and searched fine).
- **Decision:**
  - *file_ids by name:* `retrieve` (rag-extension) and `docs.retrieve` (Agent) resolve every
    `file_ids` entry against the scope's listing — by id, then by file name or path basename,
    ignoring case. Entries that match nothing are named in a `note` and ignored; if none match, the
    filter is dropped and every document is searched, with a `note` saying so. With an incomplete
    listing (rag: none; Agent: a scope failed to list) unmatched entries pass through unchanged. The
    rag tool now lists the scope in parallel with the embedding request, before searching. Tool texts
    say `file_ids` takes ids or file names.
  - *Documents hint:* when the chat pipeline offers `retrieve`, the system prompt gains one sentence:
    documents are attached, search them with `retrieve` before answering, never call something missing
    without searching. For local providers with tools it is folded into the first user message like
    the rest of the system prompt.
- **Consequences:** A file named by the model narrows the search instead of emptying it, and a wrong
  name costs a wider search rather than a false "not found". Two attached files with the same name are
  both searched when that name is given. The hint adds ~40 tokens to every chat turn that offers
  document tools; it is constant, so it does not disturb the prompt cache. Whether a model calls the
  tool stays model-dependent; the hint does not force a call.
- **Owner:** `team`.
- **Links:** Linear ATO-552; `extensions/rag-extension/src/{retrieval,index,tools}.ts`,
  `src-tauri/src/core/agent/tools/docs.rs`, `src-tauri/src/core/agent/prompt.rs`,
  `web-app/src/lib/custom-chat-transport{,-helpers}.ts`.

<!--
Supersedes: none (extends 2026-10-08-cite-documents-by-name-and-retrieve-one-query-per-fact.md)
-->
