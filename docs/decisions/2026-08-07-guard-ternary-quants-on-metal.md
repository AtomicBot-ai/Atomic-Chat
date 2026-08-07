---
date: 2026-08-07
title: "Guard ternary quantization types on Metal and report the real cause"
---

# 2026-08-07 — Guard ternary quantization types on Metal and report the real cause

- **Context:** `TQ1_0`/`TQ2_0` (CPU-only ternary quant types) in a GGUF cause a deliberate `ggml_abort` on Metal during warmup because ggml has no Metal matmul kernel for them. The process exits with `SIGABRT`, but our error text blamed a generic "segfault / access violation" and mentioned speculative-decoding (MTP), which was unrelated and sent users to the wrong settings.
- **Decision:**
  - Add a `ModelQuantizationNotSupported` error classification in both `tauri-plugin-llamacpp` and `tauri-plugin-llamacpp-upstream`. When the output contains a GPU-backend `ggml_abort` signature (`Asserting on type N` and/or `not implemented` in a `ggml-*` backend file), produce a message that names the quant type and backend, explicitly states it is a deliberate abort, and does not blame segfaults or MTP.
  - On macOS, read the GGUF tensor-type header before spawning `llama-server` and reject `TQ1_0`/`TQ2_0` models early when GPU layers are > 0 and no `--override-tensor` is set.
- **Consequences:** Users see an actionable message instead of a crash; the pre-flight check avoids a wasted `llama-server` spawn. The guard is intentionally conservative: it blocks only the known CPU-only ternary types on Metal and can be bypassed by setting GPU layers to 0 or by moving the offending tensor to CPU.
- **Owner:** team
- **Links:** ATO-415, `src-tauri/plugins/tauri-plugin-llamacpp/src/error.rs`, `src-tauri/plugins/tauri-plugin-llamacpp/src/gguf/helpers.rs`, `src-tauri/plugins/tauri-plugin-llamacpp/src/commands.rs` (and the upstream equivalents).
