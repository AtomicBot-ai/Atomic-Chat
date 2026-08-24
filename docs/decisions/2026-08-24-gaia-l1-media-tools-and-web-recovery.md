---
date: 2026-08-24
title: "GAIA L1: media tools, PDF-from-URL, and web recovery fallbacks"
---

# 2026-08-24 — GAIA L1: media tools, PDF-from-URL, and web recovery fallbacks

- **Context:** Pushing the Rust agent's GAIA Level 1 score exposed missing
  modalities and browsing dead-ends. GAIA L1 includes audio (mp3) and YouTube
  tasks, PDFs linked from web pages, and Wikipedia point-in-time questions, and
  top open agents recover dead links via archive.org. This record covers the
  new runtime dependencies and network backends these features introduce (per
  AGENTS.md §6 rules 6 and 8).
- **Decision:**
  - **New agent tools** `os.media.transcribe` and `os.media.youtube`
    (`src-tauri/src/core/agent/tools/media.rs`), classified `PureRead`. They
    shell out to host CLIs — **whisper/whisper-cli, yt-dlp, ffmpeg** — and
    degrade gracefully with a one-line "not installed" error naming the binary
    and an install hint when a CLI is absent. `os.media.youtube` validates the
    URL **host** (not a substring) against an allowlist of youtube.com/youtu.be
    hosts before shelling out, so it cannot become an SSRF primitive, and
    isolates each call in a per-invocation subdirectory so concurrent or
    repeated calls never read each other's output.
  - **PDF-from-URL**: `os.web.fetch` on a PDF (content-type `application/pdf`
    or a `%PDF-` body) downloads the bytes into `.agent/downloads/` and routes
    them through the existing `tauri_plugin_rag::parse_document`, raising the
    body cap to 25 MB for PDF responses only (journal PDFs exceed 2 MB); HTML
    stays at 2 MB.
  - **Wayback fallback**: when a direct fetch fails, `os.web.fetch` consults
    `archive.org/wayback/available` for the closest snapshot — but only after
    confirming the original URL is a public http(s) target with the same SSRF
    validator the fetch guard uses, so a guard-rejected private/loopback URL is
    never exfiltrated to a third party.
  - **New runtime dependency** `pdftotext` (poppler), used by
    `tauri-plugin-rag`'s PDF parser **only** when the in-process extractor
    yields under 50 non-whitespace characters (a scanned/image PDF), to produce
    a neutral per-page coverage note. It is never invoked for normal text PDFs.
    The coverage note is deliberately free of agent tool names and absolute
    paths because `parse_document` is shared with the RAG embedding and
    inline-chat attachment paths.
  - **Serper option**: `os.web.search` tries serper.dev first **only** when
    `AGENT_SERPER_KEY`/`GAIA_SERPER_KEY` is set. This does not supersede
    [2026-07-24 — Use hosted Exa as the Agent's primary web backend](2026-07-24-use-hosted-exa-as-the-agent-s-primary-web-backend.md):
    the keyless default is byte-identical (Exa first, DuckDuckGo fallback); the
    Serper path exists for benchmark runs where a Google-class engine measurably
    helps, and is inert without a key.
- **Consequences:** L1's audio/YouTube/web-PDF/point-in-time task categories
  become answerable. All new network calls stay behind the SSRF-guarded HTTP
  path or a host allowlist; all CLI dependencies are optional with clear
  degradation. Files land under the workspace `.agent/` dot-directory.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/tools/media.rs`](src-tauri/src/core/agent/tools/media.rs),
  [`src-tauri/src/core/agent/tools/web.rs`](src-tauri/src/core/agent/tools/web.rs),
  [`src-tauri/plugins/tauri-plugin-rag/src/parser.rs`](src-tauri/plugins/tauri-plugin-rag/src/parser.rs),
  [`src-tauri/resources/agent-skills/wikipedia/SKILL.md`](src-tauri/resources/agent-skills/wikipedia/SKILL.md).
