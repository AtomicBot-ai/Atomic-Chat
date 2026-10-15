---
date: 2026-10-15
title: "Download Bonsai with the app's own downloader, not the core's model setup"
---

# 2026-10-15 — Download Bonsai with the app's own downloader, not the core's model setup

- **Context:** A Bonsai file was the only model the app did not download
  itself. The core's model setup (`/models/setup-plan`, `/model-setups/*`)
  planned it, installed the PrismML build, downloaded the model and projector
  and registered them
  ([2026-10-05](2026-10-05-run-bonsai-on-prismml-llamacpp-as-a-third-provider.md)).
  The app followed the setup records and listed them in the download panel
  ([2026-10-06](2026-10-06-list-prismml-model-setups-in-the-download-panel.md)).
  atomic-chat-core 0.17.0 removes model setup: the core downloads engine
  builds, never model files (core ADR `core-does-not-download-models`,
  OpenSpec change `remove-model-downloads-from-core`).
- **Decision:** The app plans a Bonsai download itself, from what the core
  still reports: the verdict (`POST /models/compatibility`, rules and remote
  header), the Bonsai families (`GET /models/atomic-prism/families`), the
  PrismML catalog (`POST /backends/atomic-prism/catalog`) and the free space
  (`POST /disk/available`) — `planPrismSetup` in `web-app/src/lib/model-setup.ts`.
  `ModelSetupSheet` shows that plan and reads it again before it runs. When
  the file needs a build that is missing or too old, the core installs it
  (`POST /backends/atomic-prism/install`, a cancellable `engine-build-*` row in
  the download panel) and activates it
  (`/engines/atomic-prism/builds/:version/:variant/activate`) before anything
  downloads. The model and projector then download with the app's own
  downloader under `atomic-prism` (`pullModelWithMetadata` with a provider and
  the families' hashes and sizes), so the panel pauses, resumes and cancels
  them like any GGUF. After the download — from the Hub or from a panel resume
  — the core reads the file on disk by `model_id`; a verdict other than
  `compatible` deletes the model and shows the reason
  (`services/model-setup/prism-setup.ts`).
- **Consequences:** `services/model-setup` keeps compatibility, families and
  the PrismML calls; the setup records, `model-setup-store`,
  `model-setup:changed` and the panel's setup rows are gone. Verdicts and
  families live in `stores/model-compatibility-store.ts` and are forgotten on
  every new core generation. The "plan is stale" refusal is gone too: the
  sheet re-plans before it starts, and the install refuses on its own
  (`ENGINE_INSTALL_IN_PROGRESS`, a build the manifest no longer offers). A
  setup that a 0.16 core left half done is not resumed as such: the files'
  `.tmp` partials stay, and the next download of the same model continues
  them when the downloader's sidecars match. The client picks the build from
  the catalog by `min_prism_build` and the core's recommendation; the core's
  plan also matched the release's capabilities, which the catalog does not
  expose. A wrong pick is still stopped by the post-download check and by the
  load gate.
- **Owner:** `team`.
- **Links:** OpenSpec change `remove-model-downloads-from-core` (tasks 3.1–3.6);
  `web-app/src/services/model-setup/prism-setup.ts`,
  `web-app/src/containers/ModelDownloadAction.tsx`,
  `web-app/src/containers/hub/ModelSetupSheet.tsx`.

<!--
Supersedes: 2026-10-06-list-prismml-model-setups-in-the-download-panel.md
Supersedes (in part, the core model setup): 2026-10-05-run-bonsai-on-prismml-llamacpp-as-a-third-provider.md
-->
