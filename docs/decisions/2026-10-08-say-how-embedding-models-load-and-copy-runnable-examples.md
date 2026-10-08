---
date: 2026-10-08
title: "Say how embedding models load, list llama.cpp ones in the Hub, and copy runnable examples"
---

# 2026-10-08 — Say how embedding models load, list llama.cpp ones in the Hub, and copy runnable examples

- **Context:** QA of 2.1.9 (core 0.11.2, EmbeddingGemma 2) found the embedding UI of ADR
  `2026-10-07-download-embedding-models-in-the-hub-and-serve-them-over-the-api` unclear where it meets the
  API: the card said vectors "can be cut to 512, 256, 128" while `dimensions: 256` is refused (ATO-546); the
  installed MiniLM (`sentence-transformer-mini`, the document-search model) was missing from the Hub, and
  nothing said why it did not start, or what Stop does (ATO-547); "Prompts", "4096 tokens, trained for
  8192" and the API page's unlabelled copy icons were not understood (ATO-548); the copied image example
  sent `data:image/png;base64,...` literally and got a 500 (ATO-544).
- **Decision:**
  - *Matryoshka lengths are the client's:* the Dimensions cell shows `dims` alone; "Shorter vectors" lists
    `matryoshka_dims` with the note that the server returns all values and a client keeps the first ones and
    L2-normalizes them. The conf catalog's descriptions no longer promise cutting (the baseline is
    regenerated from it). The core keeps refusing another `dimensions` (core ADR
    `2026-10-08-embedding-media-errors-are-client-errors`).
  - *Lifecycle in words:* the provider page's section says Start serves one model on `/v1/embeddings` and it
    stays on (idle after a restart, loaded by the next request), Stop turns the service off, and document
    search loads its own model without Start. The row of the model the service is set to says Loaded, Idle
    (loads on the next request), Starting, Failed or Stopped; Start and Stop say the same as tooltips.
    No separate Unload: the core's idle unload stays off (`idle_unload_secs` 0), so Stop is the only way to
    free the memory, and it says so. Nothing starts a downloaded model by itself.
  - *Every embedding model on disk is in the Hub:* the Embedding category lists the llama.cpp models the
    extension flagged as embedding GGUFs under "From your llama.cpp models", between the downloaded and the
    available catalog models, selected as `llamacpp:<id>` (apart from catalog ids). Their panel says what the
    model is (the document-search model by its id), where its file lies, and opens the llama.cpp page.
  - *Prefixes and context:* "Input prefixes" with a note matching the prefixes the model has, an example
    after each (`task: search result | query: Why is the sky blue?`), and for a document prefix with a title
    slot, to put the title in place of `none`. No prefix is shown or sent for a model without one.
    "Configured context" is the catalog `context` Start writes as `ctx_size`, with the model's maximum.
  - *Runnable copies* (`lib/embedding/examples.ts`): "Copy model ID", "Copy text test" (the model's own
    query prefix, `encoding_format: "float"`; the tooltip says the answer is a vector of `dims` numbers) and
    "Copy image test": POSIX shell that reads `$IMAGE` (`IMAGE=photo.jpg`, to be pointed at a PNG or JPEG),
    takes its type from `file --mime-type`, base64-encodes it on one line and streams the body to
    `curl --data-binary @-`, so no shell argument limit applies and no placeholder is sent. No `#` comments
    (zsh does not take them pasted). With an API key set, the tooltips say to replace `YOUR_API_KEY`.
- **Consequences:** What the UI says matches what the API does; the copied commands were run against
  llama.cpp b11463 with EmbeddingGemma 2 (zsh with a JPEG, bash with a PNG, the text test: 768 values
  each). The image command needs `file`, `base64` and `tr` (macOS, Linux); Windows users adapt it, as the
  other examples. The Hub reads `model.yml` of each flagged llama.cpp model once per list change.
- **Owner:** `team`.
- **Links:** Linear ATO-544, ATO-546, ATO-547, ATO-548; `web-app/src/lib/embedding/examples.ts`,
  `web-app/src/containers/api/ApiConnectionStrip.tsx`, `web-app/src/containers/hub/{EmbeddingHub,EmbeddingModelDetailPanel}.tsx`,
  `web-app/src/containers/{EmbeddingModelsSection,EmbeddingModelCard}.tsx`; conf `models/embedding.json`.

<!--
Supersedes: none (extends 2026-10-07-download-embedding-models-in-the-hub-and-serve-them-over-the-api.md)
-->
