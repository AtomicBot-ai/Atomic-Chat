---
date: 2026-09-23
title: "Capture video posters in the webview"
---

# 2026-09-23 — Capture video posters in the webview

- **Context:** The image gallery draws thumbnails the core writes beside each
  PNG. The core cannot decode video: it takes no media dependency (its rule 8),
  and a WebM decoder is a large one. A gallery of clips without a first frame
  is a grid of grey boxes, and the OpenAI `/videos/{id}/content?variant=thumbnail`
  route the core serves needs a poster from somewhere.
- **Decision:** The webview renders the poster. After a clip lands (its own
  job, or a `video-job` from another client), the app loads it in a detached
  `<video muted playsInline preload="auto" crossOrigin="anonymous">` over the
  asset protocol, draws the first frame on a canvas at 256 px on the longer
  side, and sends the PNG as base64 to the core's
  `PUT /diffusion/video/gallery/:id/poster`, which stores `<id>.thumb.png` and
  answers the item with `posterPath`; the gallery store patches the item in
  place. WebKit taints the canvas for that clip (`SecurityError` on
  `toDataURL`), and — measured in the e2e webview on 2026-09-23 — for a
  same-origin blob URL of the same bytes too; only a `data:` URL stays
  origin-clean. So when the asset attempt taints or refuses to load, the
  bytes are read through the paged `read_file_chunk` command, as the Extend
  workflow reads its source, and the frame is drawn from a `data:video/webm`
  URL. Listed clips without a poster (made before posters
  existed, or by an outside client while the app was closed) are backfilled
  two at a time as their tiles come into view (`IntersectionObserver`), and a
  clip whose capture failed is not retried in the session.
- **Consequences:**
  - A poster exists only after the app has seen the clip; the OpenAI facade
    answers 404 for the thumbnail variant until then, and a tile shows a
    neutral mark with the duration in the corner.
  - A capture that never yields a frame is abandoned after 10 s; the clip
    itself is unaffected.
  - The data-URL fallback reads the whole file into memory (and a third
    more as base64) and is capped at 64 MiB; a larger clip that taints the
    canvas keeps no poster.
  - `capturePosterPng` is tested against a scripted `<video>` in jsdom
    (decode, seek, error, taint, timeout); the real decode is exercised by
    the desktop e2e suite.
- **Owner:** `team`.
- **Links:**
  - `web-app/src/lib/video/poster.ts`
  - `web-app/src/stores/video-generation-store.ts` (`makePoster`, the backfill queue)
  - `web-app/src/containers/videos/VideoGalleryTile.tsx`
  - Core: `src/diffusion/video-gallery.ts` (`setPoster`, `MAX_POSTER_BYTES`)
