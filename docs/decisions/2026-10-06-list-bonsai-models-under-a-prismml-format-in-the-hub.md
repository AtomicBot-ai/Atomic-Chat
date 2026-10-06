---
date: 2026-10-06
title: "List Bonsai models under a PrismML format in the Hub, and install the engine from its row"
---

# 2026-10-06 — List Bonsai models under a PrismML format in the Hub, and install the engine from its row

- **Context:** The previous record
  ([2026-10-06](2026-10-06-show-prismml-where-it-has-a-build-and-onboard-its-engine.md))
  put an onboarding card on the PrismML provider page. Testing it showed three
  problems. First, the card was too wordy. Second, the Version & Backend row
  still offered nothing to click. Third, the page kept flashing: while
  `version_backend` is `none`, it re-read every provider every 3 seconds,
  waiting for a backend to be configured. For PrismML that never happens, since
  `none` simply means no build is installed. The Hub also had no place for the
  models the engine exists for. TensorRT-LLM has its own Hub format
  ([2026-10-03](2026-10-03-choose-tensorrt-llm-models-in-the-model-hub.md)).
- **Decision:**
  - **Provider page.**
    - The card keeps one line ("Needed to run Bonsai models") and a link to
      the Hub's PrismML list.
    - While no build is on disk, the Version & Backend row is a large **Install
      engine** button. It installs the build the core recommends (logic shared
      through `usePrismEngine`).
    - PrismML is left out of the 3-second backend-configuration poll.
  - **The Hub's PrismML format.** It sits next to GGUF, MLX and TensorRT-LLM,
    and is offered wherever the PrismML provider is shown.
    - It lists the Bonsai families of the core's model rules, featured first.
      The list comes from a new core route, `GET /models/atomic-prism/families`,
      which serves the same live, cached or bundled rules as the compatibility
      check.
    - Each offered file is a variant pinned to the family revision, so a
      download goes through the verdict and the setup sheet as before.
    - A search narrows the families by name. There are no staff picks, no
      catalog, and no Hugging Face feed or search under this format.
- **Consequences:**
  - Adding a Bonsai model is a conf change, with no app release. The list
    reaches the app on the core's rules TTL, or on the next core generation.
  - `ModelFormat` gains `atomic-prism`. It names a Hub list, not a file format:
    `modelFormat()` still reads these files as GGUF.
  - The route needs core 0.10.0 or later. An older core answers 404, and the
    list stays empty.
- **Owner:** `team`
- **Links:** `web-app/src/routes/hub/index.tsx`, `web-app/src/hooks/useModelSetup.ts`
  (`usePrismFamilies`, `usePrismHubVisible`), `web-app/src/lib/model-setup.ts`
  (`prismFamilyCard`), `web-app/src/hooks/usePrismEngine.ts`,
  `web-app/src/containers/atomic-prism/PrismEngineSetupCard.tsx`; atomic-chat-core
  `src/server/control/routes/model-setups.ts`, `src/models/compatibility/service.ts`.
