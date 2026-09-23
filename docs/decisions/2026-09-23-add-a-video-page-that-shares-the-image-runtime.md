---
date: 2026-09-23
title: "Add a Video page that shares the image runtime"
---

# 2026-09-23 — Add a Video page that shares the image runtime

- **Context:** The core's stage 9 generates video through the same resident
  `sd-server` session as images (LTX-2.3 distilled and Wan 2.2 TI2V 5B on
  `POST /sdcpp/v1/vid_gen`), with its own wire types, control routes
  (`/atomic/v1/diffusion/video/*`) and events (`diffusion:video-progress`,
  `diffusion:video-job`), while `diffusion:state` and `diffusion:error` stay
  shared. The app had one runtime store for the engine, the catalog, the
  resident model and its capabilities (`image-generation-store.ts`, 35
  importers, coverage floor 80/70/85/80) and one page that read it. The
  question was whether video gets a second runtime store or a second page on
  the same one.
- **Decision:** One runtime, two pages. The image store gains a modality axis
  in seven places: a `videoCapabilities` slot beside `capabilities` (the two
  are never both set), a `lastErrorModality` so a video checkpoint that
  would not load is the Video page's error, `paths.videosDir`, a `loadModel`
  branch that records the selection in the new `useVideoSetting` store and
  resets the new `useVideoForm` to the family defaults, a `removeArtifact`
  that clears whichever page selected the checkpoint, and a configure that
  carries `videoOutputDir` beside `outputDir` and falls back to both defaults
  when the core cannot create either. The wizard remembers which page opened
  it (`setupModality`), and the model selector, picker and Run control take
  a `modality` so a resident video model is never shown as the Images page's
  model. Jobs are a separate, thin store (`video-generation-store.ts`): one
  clip per Generate, no runs or batches, the same wait-for-terminal with a
  polling fallback, adoption of `status.activeVideoJob`, foreign completed
  jobs landed in the gallery. The gallery store became a factory
  (`media-gallery-store.ts`) with the image store as one instance and the
  video store as another, so paging and selection are one implementation.
- **Consequences:**
  - The load-time knobs (memory, engine override, evicting chat, idle unload,
    keep loaded, setup completion) stay in `useImageSetting`: there is one
    engine and one resident model, so one set of rules. The Video form's
    Advanced fold writes there; only its own fold state, selection and output
    folder live in `useVideoSetting`.
  - "Busy" is either page generating; the core's `JOB_BUSY` is the backstop.
  - Durations are shown in seconds but chosen on the family's frame lattice
    (`k·step+offset` in a range): 1/2/3/5 s become 25/49/73/121 frames for
    LTX (8k+1) and Wan (4k+1) alike, and a leftover count snaps to the
    loaded family on load. The frame rate is the model's own and only shown.
  - Guidance is the cfg slider, hidden for a distilled family that runs at
    cfg 1 without a negative prompt (LTX) and shown for Wan.
  - The Images page hides a model error filed under video, and the Video
    page shows its own job errors first, then a video-filed model error.
  - The image store's tests only gained cases; the image run loop, the
    picker's workflow filter and the image gallery API did not change.
- **Owner:** `team`.
- **Links:**
  - `web-app/src/stores/{image-generation-store,video-generation-store,media-gallery-store,video-gallery-store}.ts`
  - `web-app/src/hooks/{useVideoSetting,useVideoForm,useVideoGeneration,useVideoGallery,useMediaGallery}.ts`
  - `web-app/src/lib/video/{duration,validate,recipe}.ts`
  - `web-app/src/containers/videos/*`
  - Core: `atomic-chat-core/docs/decisions/2026-09-23-generate-video-through-the-resident-diffusion-session.md`
