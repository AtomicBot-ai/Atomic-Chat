---
date: 2026-10-20
title: "List everything downloaded on a Downloads page"
---

# 2026-10-20 — List everything downloaded on a Downloads page

- **Context:** The Models Hub sidebar's Downloads row opened
  `/hub?installed=true`, the Hub filtered to installed text models. Image and
  video checkpoints, embedding and decision models, the voice model and
  engine builds were only visible on their own settings pages, and nothing
  showed how much room all of it takes. The approved prototype has a
  Downloads page (summary tiles, search, category, a table with Remove) built
  on a fixture that also invents use counts, "last used" dates and cleanup
  suggestions. The app records no usage history, and the user decided that
  v1 shows none of them.
- **Decision:**
  - **`/downloads`** (new route, Models Hub section) lists what the app put
    on this computer, merged by `useInstalledInventory` from the stores that
    own each kind (`lib/installed-inventory.ts`, pure): local model files of
    the llama.cpp providers, MLX, the managed engines' shared store and
    Foundry Local (one row per file, the first provider owning it, as the
    Hub resolves ids; the app's retrieval model left out), image and video
    checkpoints (`installedArtifacts`), catalog embedding and decision models
    (`installed` + catalog bytes), the voice model (one Voice row, not also a
    llama.cpp row), every engine build from `useEngineVersionsStore`, and
    downloads still running (`useDownloadStore`, first, with the panel's
    status and Cancel).
  - Sizes are what is on disk where the source knows it: the engine's
    recorded `sizeBytes` (now declared on `Model`), the present files of a
    checkpoint, catalog bytes for embedding/decision/voice. A shared encoder
    is shown under every checkpoint that needs it but counted once in the
    total. Unknown sizes read "—", never a guess.
  - Summary: total storage, item count, free space on the data drive
    (`modelSetup().diskAvailable()`, "—" where there is no core). Category
    select: All, Local models, Images, Videos, Voice, Engines. No Uses, Last
    used or cleanup suggestions.
  - **Remove** asks first and goes through one adapter
    (`removeInventoryItem`) to each owner's own removal: `deleteLocalModel`,
    the image store's `removeArtifact`, `deleteEmbeddingModel` /
    `deleteDecisionModel` (which switch the core off a running model first),
    `useVoiceModel().remove`, `deleteEngineBuild`. A build the core will not
    remove (`removable: false`) has a disabled Remove and its reason on the
    row; the core's refusals are shown as the Inference engines page shows
    them.
  - The sidebar row points at `/downloads`; `/hub?installed=true` stays a
    Hub filter and now highlights Local models.
- **Consequences:**
  - **Backend gap:** the core's installed builds carry no `size_bytes`, so
    engine builds read "—" and the total says it excludes them. A small
    `atomic-chat-core` change (separate PR, release, pin) would add it; the
    page needs only the field.
  - A decision checkpoint is sized by its download; the GGUF the engine
    converts it into is the core's cache and is not counted. A managed or
    Foundry Local model the engine reports without a size reads "—".
  - The page binds the embedding and decision stores while it is open, as
    their Hub sections do.
  - The page is not a `region` landmark: desktop E2E finds the global
    download panel as the region labelled "Downloads".
- **Owner:** team
- **Links:** `web-app/src/containers/downloads/DownloadsPage.tsx`,
  `web-app/src/hooks/useInstalledInventory.ts`,
  `web-app/src/lib/installed-inventory.ts`,
  `web-app/src/routes/downloads.tsx`,
  `web-app/src/components/left-sidebar/index.tsx`
