---
date: 2026-10-08
title: "Stop closes the local stream's connection in Rust"
---

# 2026-10-08 — Stop closes the local stream's connection in Rust

- **Context:** Every local chat stream (llama.cpp, Prism, MLX, managed engines) goes through the Tauri
  command `stream_local_http`, which reads the engine's SSE response with reqwest and relays it over
  an IPC channel. Stop aborted only the JavaScript side: `createLocalStreamingFetch` and the
  extensions' `handleStreamingResponse` ended their own stream, but nothing told Rust. Its read loop
  ended only at end of body, the 30-minute idle budget or a failed channel send — and a channel send
  never fails while the webview lives. The connection stayed open, llama-server never saw a disconnect,
  and with one slot (`--parallel 1`) the next message queued behind the abandoned answer. RC 2.2.0 QA:
  Stop after ~28 of 300 planet names, then "Reply with exactly RECOVERED." waited ~104 s while task 18
  generated to n_gen 2567 and finished on its own (ATO-550).
- **Decision:** `stream_local_http` takes an optional `request_id` and registers a `CancellationToken`
  under it for its lifetime; a new command `cancel_local_stream(request_id)` cancels it. The request and
  every chunk read race that token, and a cancel returns `Request aborted`, dropping the response — the
  socket closes, which is how llama-server and mlx-vlm learn to stop generating. A cancel that overtakes
  its stream's start is kept for the stream to pick up; one never claimed is dropped after 60 s. The
  web-app fetch and the four extensions pass a fresh `crypto.randomUUID()` and call
  `cancel_local_stream` once on abort, and the fetch also when its reader cancels — never after the
  stream has ended.
- **Consequences:** Stop frees the engine's slot within a chunk, and the log says
  `[stream] cancelled by the client; closing the connection`. An app build without the command (an
  extension newer than the shell) ignores the failed cancel and behaves as before. The command is
  registered on desktop and mobile alike.
- **Owner:** team
- **Links:** `src-tauri/src/core/http.rs`, `src-tauri/src/lib.rs`, `web-app/src/lib/model-factory.ts`,
  `extensions/{llamacpp,llamacpp-upstream,atomic-prism,mlx}-extension/src/index.ts`; Linear ATO-550,
  ATO-522.
