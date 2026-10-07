---
date: 2026-10-07
title: "Move installed media engines onto the fork's build with an `-a<rev>` tag"
---

# 2026-10-07 — Move installed media engines onto the fork's build with an `-a<rev>` tag

- **Context:**
  - The client matches an installed media engine on the manifest's `tag_name` alone. The engine-update
    banner (`checkEngineUpdate`) offers an update only when that name changes.
  - The 2026-10-06 fork record mirrored the fork's archives under the bare upstream tag,
    `master-883-137f740`, so that nobody would re-download. That tag is the one leejet's unsigned
    archives already installed under, so the fork's build reached new installs only. Existing users
    would keep:
    - leejet's archives, unsigned and from leejet's CDN;
    - no `vcomp140` or VC++ runtime on Windows;
    - a `win-cuda12-x64` build that does not start without an NVIDIA driver.
- **Decision:**
  - **A rebuild of a tag users already run gets a new name.** It is published as
    `<upstream tag>-a<rev>`, where `<rev>` is the fork commit the archives were built at. This is the
    Atomic-variant suffix that `sdcpp-schema.json` and `stripAtomicTagSuffix` already accept.
  - **The mirror does it.** atomic-chat-conf `mirror-sdcpp.yml` takes `atomic_rev`, and the release and
    the manifest's `tag_name` both carry the suffix.
  - **First use:** `master-883-137f740-a36f1b1a`, the fork's `master-883-137f740` release built at
    `36f1b1a`. Every client with the engine installed sees the banner on its next launch. The update
    installs into a new `<tag>/<backendId>` directory and retires leejet's tree.
  - **A new upstream tag** from the fork needs no suffix: its bare name is already new.
- **Consequences:**
  - **One download per user** of the archive for their backend. For `win-cuda12-x64` that includes the
    `win-cudart-cu12` companion, about 0.9 GB together.
  - **Other version checks keep working.** The suffix keeps the build number readable to
    `supportsDiffusionFamily` and to the core's `checkEngineCompatibility`. The banner's release-notes
    link points at the fork's release of the bare tag.
  - **Fresh probe-failure memory.** Remembered failures are keyed `<tag>/<backendId>`, so each build
    gets a fresh try under the new name.
  - **The bundled baseline has to follow.** `sdcpp-manifest-baseline.ts` must carry the suffixed manifest,
    or an offline first install would fetch the old name.
  - Supersedes the "no `-a<sha>` suffix" clause of
    [2026-10-06 build every engine in an Atomic fork](2026-10-06-build-every-stable-diffusion-cpp-engine-in-an-atomic-fork.md).
    The rest of that record stands.
- **Owner:** `team`.
- **Links:**
  - `web-app/src/stores/image-generation-store.ts` (`checkEngineUpdate`, `updateEngine`)
  - `web-app/src/services/diffusion/install.ts` (`assetUrl`, `stripAtomicTagSuffix`)
  - `web-app/src/services/sdcpp-manifest-baseline.ts`
  - atomic-chat-conf `.github/workflows/mirror-sdcpp.yml` (`atomic_rev`) and `backends/sdcpp-schema.json`
  - AtomicBot-ai/stable-diffusion.cpp release `master-883-137f740`

<!--
Supersedes: 2026-10-06-build-every-stable-diffusion-cpp-engine-in-an-atomic-fork.md (the no-suffix clause only)
-->
