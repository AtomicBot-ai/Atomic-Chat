---
date: 2026-10-05
title: "Run Bonsai on PrismML's llama.cpp as a third provider, set up from the Hub"
---

# 2026-10-05 — Run Bonsai on PrismML's llama.cpp as a third provider, set up from the Hub

- **Context:** PrismML's Bonsai GGUF files use PQ2_0 / PTQ1_0 tensor types that
  neither `llama.cpp` (upstream) nor `llama.cpp turboquant` loads. PrismML
  publishes its own llama.cpp fork
  ([PrismML-Eng/llama.cpp releases](https://github.com/PrismML-Eng/llama.cpp/releases)).
  The core (atomic-chat-core ADRs `2026-10-05-use-prismml-llamacpp-for-desktop-bonsai`
  and `2026-10-05-prismml-provider-compatibility-gate-and-model-setup`) adds the
  provider `atomic-prism`, a per-file compatibility verdict, and one durable
  "model setup" operation that installs the engine, downloads the model and its
  projector, verifies them and registers the model. Before this record, the Hub
  downloaded every GGUF the same way and let the load fail.
- **Decision:** The app adds `atomic-prism` as a third llama.cpp provider, next to
  `llamacpp-upstream` and `llamacpp`, not as a backend of either.
  - The provider is a separate extension, `extensions/atomic-prism-extension/`
    (`@janhq/atomic-prism-extension`), packed into pre-install like the others.
    Its `settings.json` is a byte copy of the core's `atomic-prism.json` schema.
    It has no MTP/DFlash, no split mode and no fork-only cache types.
  - A model belongs to PrismML when its `model.yml` carries
    `atomic_runtime.provider: atomic-prism`. The two other llama.cpp extensions
    leave such models out of `list()`, so a Bonsai file shows up and starts only
    under PrismML.
  - The Hub asks the core for a rules-only verdict per file (no remote header
    read per row). A file that needs PrismML gets a "Requires PrismML" badge,
    and Download opens `ModelSetupSheet`, which shows the core's plan (engine,
    model, projector, sizes, free space, blockers) and starts the setup against
    that plan's digest. A file no engine runs is refused with the core's reason
    or its replacement. Every other file, or a file the core has no verdict on,
    downloads as before; the core's load gate still reads the header.
  - The setup lives in the core, not in the sheet. `useModelSetupSync` (mounted
    in `DataProvider`) lists setups on attach and after each new core
    generation, follows `model-setup:changed` (keeping the highest revision)
    and `download:progress`, and re-reads the providers when a setup reaches
    `ready`. Closing the sheet or the app leaves the setup running; an
    `interrupted` one is resumed from the sheet.
  - Engine updates are offered, never applied unasked. The PrismML extension
    publishes the existing engine update offer from the core's update check,
    which carries the release page (`notes_url`), a one-line note and the size.
    `EngineUpdateBanner` shows the note. A model that needs a newer build than
    the installed one gets the `engine_update_required` hint in the Hub and in
    the sheet; the setup installs that build next to the current one.
  - A PrismML pack cannot be installed from a local file: the core requires the
    manifest's `sha256` for every PrismML archive.
- **Consequences:** Bonsai runs without the user choosing an engine, and the
  other two providers never see PQ2_0 / PTQ1_0 files. Every web-app list of
  local llama.cpp providers now includes `atomic-prism`; a new list must too.
  The Hub row makes one rules-only core call per visible Hugging Face file,
  deduplicated per URL and forgotten when a new core generation attaches.
  PrismML is not part of the startup optimal-backend probe: its engine is
  installed by the model setup, so the probe would spend startup I/O on an
  engine that may not be installed.
- **Owner:** team.
- **Links:** `extensions/atomic-prism-extension/`,
  `extensions/shared/atomicCoreRuntime.ts` (`isPrismModel`),
  `web-app/src/services/model-setup/`, `web-app/src/lib/model-setup.ts`,
  `web-app/src/stores/model-setup-store.ts`, `web-app/src/hooks/useModelSetup.ts`,
  `web-app/src/containers/hub/ModelSetupSheet.tsx`,
  `web-app/src/containers/ModelDownloadAction.tsx`,
  `web-app/src/hooks/useEngineUpdate.ts`,
  `web-app/src/containers/dialogs/EngineUpdateBanner.tsx`; atomic-chat-core
  `docs/contracts.md` (model compatibility and model setup routes).
