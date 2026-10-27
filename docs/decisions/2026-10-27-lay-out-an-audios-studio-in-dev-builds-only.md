---
date: 2026-10-27
title: "Lay out an Audios studio, in dev builds only until there is an audio engine"
---

# 2026-10-27 — Lay out an Audios studio, in dev builds only until there is an audio engine

- **Context:** The prototype adds Audios beside Images and Videos: text to
  speech, text to music and sound effects, in the same studio (mode, model,
  prompt, settings, Advanced, results). Its models, downloads and playback
  are stand-ins. The app has no audio engine: the 2026-10-26 research points
  at a fork and mirror of audio.cpp through conf → core → app, which is
  work of its own.
- **Decision:** The page is built now on the Images / Videos parts
  (`MediaStudioFrame`, `MediaPromptCard`, `MediaModelPickerButton`, the mode
  select, sliders, seed, empty state) at `/audios/`, behind
  `PlatformFeature.AUDIO_GENERATION`, which is on only in dev builds
  (`import.meta.env.DEV`) on desktop. Its models are candidates listed in
  `lib/audio/models.ts`; their Download buttons are off and say the models
  arrive with the audio engine, and Generate is off with `noEngine`. Each
  mode keeps the prototype's settings while the page is open.
- **Consequences:** Releases show nothing new. The engine work replaces the
  candidate list with the catalog's (checking each licence), gives each
  model the settings it really takes, adds the player and gallery the
  prototype shows, and turns the flag on for releases. Until then the
  settings are not stored or sent anywhere.
- **Owner:** `team`.
- **Links:** `web-app/src/containers/audios/`,
  `web-app/src/lib/audio/models.ts`, `web-app/src/lib/platform/const.ts`,
  `web-app/src/containers/images/MediaStudio.tsx`.
