---
date: 2026-10-06
title: "List PrismML model setups in the download panel, and set a deleted Bonsai up again"
---

# 2026-10-06 — List PrismML model setups in the download panel, and set a deleted Bonsai up again

- **Context:** A PrismML model setup
  ([2026-10-05](2026-10-05-run-bonsai-on-prismml-llamacpp-as-a-third-provider.md))
  runs its downloads in the core, and the core sends the app no download
  events for them. So the setup showed only in its Hub row and in
  `ModelSetupSheet`. With the sheet closed, a multi-gigabyte download was
  missing from the global download panel, and nothing said when it finished or
  failed. A TensorRT-LLM download
  ([2026-10-03](2026-10-03-choose-tensorrt-llm-models-in-the-model-hub.md)) is
  a panel row with Cancel and ends with the ordinary toasts.

  A second problem came from the setup record itself. The core keeps a setup
  record after its model is deleted, and the extension's delete only removes
  the folder. So the sheet still read the old `ready` record and offered
  "New chat" for a model that no longer existed, with no way to start again.
- **Decision:**
  - **Panel rows.** `DownloadManagement` lists the newest setup of each Hub
    file while it runs or waits for `resume` (`setupsUnderWay`). Each row
    sums the bytes of all of the setup's downloads and shows the speed of the
    download running now.
  - **Cancel and Resume.** A running row is cancel-only, like TensorRT-LLM.
    A setup interrupted because the app closed is shown paused, with Resume.
    Both actions go to the core.
  - **Toasts.** `useModelSetupSync` announces a setup that this window saw
    under way when it ends. `ready`, `failed` and `cancelled` get the same
    toasts an ordinary download ends with, and `ready` also gets the OS
    notification while the user is away.
  - **Old `ready` records.** A `ready` setup stands for a model only while
    that model exists (`isStandingReadySetup`). It ends when:
    - the app deleted the model (its tombstone in `deletedModels`); or
    - the providers do not list the model and the setup became ready before
      this window started.

    A setup that became ready since this window started still stands while
    the providers are read again. Once a record no longer stands, the sheet
    plans a new setup.
- **Consequences:**
  - A setup interrupted before the app closed shows up in the panel on the
    next launch, paused, until it is resumed or cancelled.
  - A failed setup shows both a toast and the error in the sheet.
  - The core still keeps every setup record (no retention). A later core
    change could end `ready` records on delete itself, as TensorRT-LLM's
    delete does through the core.
- **Owner:** `team`
- **Links:** `web-app/src/lib/model-setup.ts`, `web-app/src/hooks/useModelSetup.ts`,
  `web-app/src/stores/model-setup-store.ts`, `web-app/src/containers/DownloadManegement.tsx`,
  `web-app/src/containers/hub/ModelSetupSheet.tsx`,
  `web-app/src/containers/__tests__/DownloadManagement.model-setup.test.tsx`.
