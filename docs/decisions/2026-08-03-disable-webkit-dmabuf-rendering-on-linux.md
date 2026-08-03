---
date: 2026-08-03
title: "Disable WebKit DMABUF rendering on Linux"
---

# 2026-08-03 — Disable WebKit DMABUF rendering on Linux

- **Context:** On Fedora 42, the AppImage WebKit process can abort while rendering model responses containing emoji or other special characters. The crash occurs in Mesa `libgallium` graphics-thread cleanup rather than in the text or Markdown renderer, matching the WebKitGTK DMABUF failures documented by Tauri.
- **Decision:** Set `WEBKIT_DISABLE_DMABUF_RENDERER=1` on Linux before Tauri creates the webview. Preserve an existing environment value so users can explicitly opt back into DMABUF rendering.
- **Consequences:** Linux uses WebKitGTK's older shared-memory rendering path, avoiding the unstable DMABUF path at the cost of some rendering performance. macOS, Windows, iOS, and Android are unaffected.
- **Owner:** team
- **Links:** [Issue #218](https://github.com/AtomicBot-ai/Atomic-Chat/issues/218), [Tauri Linux graphics guidance](https://v2.tauri.app/develop/debug/linux-graphics/), `src-tauri/src/main.rs`
