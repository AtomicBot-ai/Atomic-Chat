---
date: 2026-10-12
title: "Continue a video from its last frame, browser-extracted and local-first"
---

# 2026-10-12 — Continue a video from its last frame, browser-extracted and local-first

- **Context:** Video models cap around 8–10s. The user wanted "longer video" via generation that starts from the previous clip's last frame, so several short clips chain into one continuous sequence. A follow-up idea — exporting one low-resolution frame per second as a "reference strip" — was also raised. No adapted video model conditions on an arbitrary sequence of reference frames: they accept zero to two conditioning images (first frame, or first+last frame), so a strip would be rejected or collapsed into an artifact-prone collage. The stronger, model-native reference is the first+last frame pair, which Wan already supports.
- **Decision:** Ship "Continue this video" on library video assets. It extracts the clip's last frame in the browser (a detached `<video>` + canvas, the same primitive the thumbnailer uses, no new dependency) and hands the studio a `text_to_video` request whose `init_image` is that frame. The previous clip's `end_image` is dropped, and `seed` is dropped so the next clip is a new generation rather than a repeat. V1 is local-first: the button only acts for the built-in engine, which is the only provider whose video params expose `init_image`; fal/Replicate image-to-video are a parallel follow-up. The last frame is read through `read_file_chunk` paging into a blob URL so the canvas is never tainted and WebView2's large asset-protocol bodies are avoided. First+last-frame conditioning (`end_image` surfaced in the UI) is V2.
- **Consequences:** "Continue" reuses the library→studio re-run handover (`setPendingMediaReRun`) rather than a second submission path. Frame extraction is browser-only; a Rust/ffmpeg fallback is deferred until a codec is found that the browser cannot seek. Multi-frame reference strips are declined outright. Continue for cloud video models is gated off with an honest toast until their image-input fields are verified against each provider's published schema.
- **Owner:** team
- **Links:** `web-app/src/services/media/videoFrames.ts`, `web-app/src/containers/media/videoLastFrame.ts`, `web-app/src/containers/media/AssetDetail.tsx`, `web-app/src/routes/media_.library.tsx`, `web-app/src/services/media/adapters/builtinEngine.ts`
