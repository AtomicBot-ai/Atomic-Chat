---
date: 2026-10-22
title: 'Size the media viewer to its preview and give the gallery the rest'
---

# 2026-10-22 — Size the media viewer to its preview and give the gallery the rest

- **Context:** the Images and Video pages split the right pane 3:2: the
  viewer (`flex-[3]`) over the gallery (`flex-[2]`). Inside the viewer the
  frame was contained in a region that filled the viewer, and the toolbar
  (Details, Save as, Use as source, Show in folder, Delete) sat at the bottom
  of the viewer. A preview shorter than the region left a gap between the
  picture and its actions: 203 px for a 16:9 clip in the 1024 × 740 window
  with the sidebar open (QA 2.2.23, finding 04). The gallery still started at
  three fifths of the pane.
- **Decision:** the viewer is a content-sized block: the frame, then the
  toolbar right under it, then the gallery takes the rest of the pane. The
  pages wrap the viewer and the gallery in a size container (the media pane),
  and the frame is the media's aspect at the largest box that fits the
  viewer's width (`cqw`) and a height cap of `60cqh` less the viewer's padding,
  gap and toolbar row (`mediaPreviewFrameStyle` in
  `web-app/src/containers/images/mediaPreview.ts`). The block therefore never
  takes more than the old split gave the viewer: a square or portrait picture
  is as large as before, the gallery keeps at least two fifths of the pane,
  and every pixel a wide picture does not use goes to the gallery. The live
  preview uses the same frame and reserves the toolbar row under it, so the
  gallery does not move when the result replaces it.
- **Consequences:** the gallery's top now follows the open item's shape:
  stepping from a wide picture to a tall one moves it down, by design. A
  viewer rendered outside the pages has no size container, and its cap falls
  back to the viewport's height. The cap counts the toolbar as one control
  row (`--control-height`); a taller toolbar must update the constant. Guarded
  by `ImageViewer.layout.test.tsx` and `VideoGenerationPage.layout.test.tsx`
  (square, portrait and landscape at 1024 × 740 with the sidebar and at
  1280 × 800, Medium and Extra Large, plus the live preview's block).
- **Owner:** team
- **Links:** `web-app/src/containers/images/ImageViewer.tsx`,
  `web-app/src/containers/videos/VideoViewer.tsx`,
  `web-app/src/containers/images/ImageGenerationPage.tsx`,
  `web-app/src/containers/videos/VideoGenerationPage.tsx`,
  `web-app/src/containers/images/ImageGenerationPlaceholder.tsx`.
