---
date: 2026-11-02
title: "Open the Audios studio in releases, on the unified catalog's audio collection"
---

# 2026-11-02 — Open the Audios studio in releases, on the unified catalog's audio collection

- **Context:** The studio stayed in dev builds until a core with audio was pinned (2026-10-27, 2026-11-01). Core 0.20.7 is pinned and carries the `audio-cpp` engine; conf's live `backends/audiocpp-manifest.json` names the signed `v0.9.3-abf1872f` build of the Atomic fork for every desktop target but Intel Macs, approved after a passing engine-candidate run. Since conf #45 the audio models are the `audio` collection of `models/catalog.json`; `models/audio.json` is its generated export, which no client may adopt as a new source (2026-11-01 unified catalog record).
- **Decision:** `PlatformFeature.AUDIO_GENERATION` is on for every desktop build, so the Audios page, its Downloads filter, its engine row and its installed-models entries ship. `audio-catalog-registry.ts` projects the `audio` collection through `unified-model-catalog.ts`, sharing that catalog's cache and bundled snapshot; it reads a file only when a caller names its URL, and the separate audio baseline and its generator are gone. A model download resumes only the plan saved for the same repository, commit, path and sha256; any other saved plan or partial is replaced by a new plan.
- **Consequences:** A core older than 0.20.6 keeps showing the "needs a newer app" state rather than an error. An Intel Mac sees the engine card explain that no build fits it. A catalog that moves a quant to another commit downloads the new file instead of finishing the old one. Supersedes the dev-only clauses of [2026-10-27](2026-10-27-lay-out-an-audios-studio-in-dev-builds-only.md) and the dev-only and `models/audio.json` / baseline clauses of [2026-11-01](2026-11-01-run-the-audios-studio-on-the-core-and-the-audio-catalog.md).
- **Owner:** `team`.
- **Links:** `web-app/src/lib/platform/const.ts`, `web-app/src/services/audio-catalog-registry.ts`, `web-app/src/lib/audio/models.ts`, [2026-11-01-unify-model-catalog-and-download-plans.md](2026-11-01-unify-model-catalog-and-download-plans.md), conf `models/catalog.json` and `backends/audiocpp-manifest.json`.
