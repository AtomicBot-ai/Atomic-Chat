---
date: 2026-10-06
title: "Show PrismML only where it has a build, and say what its engine is for until it is installed"
---

# 2026-10-06 — Show PrismML only where it has a build, and say what its engine is for until it is installed

- **Context:** The PrismML provider
  ([2026-10-05](2026-10-05-run-bonsai-on-prismml-llamacpp-as-a-third-provider.md))
  was listed on every desktop build, including Linux and Windows on Arm. PrismML
  publishes no build for those, so the provider had nothing to run there.

  Its page also confused people. No build ships inside the app, so
  `version_backend` stays `none` until one is installed. The page reads `none`
  as "backends still being configured" and showed an endless "loading".

  The "Allow unverified PrismML builds" toggle had no effect either. The core
  reads its own copy of the setting for the catalog and for the Hub's model
  setup plan, and that copy is only imported before a model load. Without a
  model there is no load, so the toggle never reached the core.

  TensorRT-LLM handles the same kind of problem: its extension decides its own
  visibility from the core
  ([2026-10-01](2026-10-01-ship-tensorrt-llm-on-linux-and-windows-and-let-the-core-hide-it.md)),
  and its page sets the engine up before it shows any settings.
- **Decision:**
  - **Visibility.** `atomic-prism-extension` implements `isHidden()`,
    `refreshVisibility()` and `visibilityKnown()`, the same interface
    TensorRT-LLM uses (`web-app/src/lib/provider-visibility.ts`). The provider is
    hidden when the core's catalog lists no `supported_backends`, meaning
    PrismML has no build for this machine. It stays hidden until the core
    answers, and a failed check keeps the last answer.
  - **Onboarding card.** Until a pack is on disk, the provider page shows
    `PrismEngineSetupCard` (data from the extension's `getEngineStatus()`). It
    says what the engine is for (Bonsai's 1-bit and ternary GGUF files) and offers
    two ways to set it up: install the build the core recommends now (through
    `downloadRecommendedBackend`, with progress in the download panel), or find a
    Bonsai model in the Hub. If no build is offered, the card explains the
    unverified-builds toggle instead.
  - **Version row.** For PrismML, `none` reads "Not installed" instead of a
    spinner.
  - **The toggle.** When `allow_candidate_builds` changes, the extension imports
    the settings into the core right away and then rebuilds the version list.
  - **Logo.** PrismML's mark is drawn at 78% in the provider avatar. The image
    fills its whole canvas, so at full size it reads larger than the other marks.
- **Consequences:**
  - Installers keep bundling the extension everywhere, and the core decides
    where it shows. A machine PrismML later publishes a build for shows the
    provider without an app update.
  - While the core has not answered yet, the provider is missing from the lists
    on every platform, as TensorRT-LLM is.
- **Owner:** `team`
- **Links:** `extensions/atomic-prism-extension/src/index.ts`,
  `web-app/src/containers/atomic-prism/PrismEngineSetupCard.tsx`,
  `web-app/src/routes/settings/providers/$providerName.tsx`,
  `web-app/src/containers/ProvidersAvatar.tsx`.
