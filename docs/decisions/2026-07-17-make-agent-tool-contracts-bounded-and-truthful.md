---
date: 2026-07-17
title: "Make Agent tool contracts bounded and truthful"
---

# 2026-07-17 — Make Agent tool contracts bounded and truthful

- **Context:** The Rust Agent exposed several contracts that diverged from
  execution: process termination accepted unsafe PIDs and arbitrary signals;
  HTTP redirects reused credentials and POST bodies without a whole-request
  deadline or response-size bound; zero-valued limits produced accidental empty
  results; `fs.edit` advertised an unimplemented `replaceAll`; and
  `fs.read_document` was only a text-file alias despite claiming document
  extraction. Buffered append/edit writes could also be observed before their
  contents were flushed under parallel tests.
- **Decision:** Validate `os.proc.kill` before approval, restrict it to positive
  PIDs and four explicit signals, avoid implicit Windows tree termination, and
  sort process listings by PID. Manually follow at most five HTTP redirects,
  re-running SSRF checks at every hop, applying standard POST redirect
  semantics, stripping credentials across origins, sharing one timeout budget,
  and reading at most 2 MB. Treat zero optional limits as "use the default."
  Implement explicit `replaceAll`, flush append writes, and route
  `os.fs.read_document` through the existing `tauri-plugin-rag` parser on a
  blocking worker with bounded output. Correct prompt schemas to describe only
  arguments and guarantees the executors actually implement.
- **Consequences:** Invalid process actions fail before an approval prompt;
  redirected requests cannot silently carry credentials to another origin or
  stream unbounded bodies; file operations are deterministic after return; and
  Agent can extract PDF, DOCX, spreadsheet, presentation, HTML, and text-family
  documents without a new dependency. Document extraction remains non-OCR, and
  HTTP response details now expose whether the 2 MB body cap truncated data.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/tools/proc.rs`](src-tauri/src/core/agent/tools/proc.rs),
  [`src-tauri/src/core/agent/tools/http.rs`](src-tauri/src/core/agent/tools/http.rs),
  [`src-tauri/src/core/agent/tools/fs.rs`](src-tauri/src/core/agent/tools/fs.rs),
  [`src-tauri/plugins/tauri-plugin-rag/src/lib.rs`](src-tauri/plugins/tauri-plugin-rag/src/lib.rs).

---
