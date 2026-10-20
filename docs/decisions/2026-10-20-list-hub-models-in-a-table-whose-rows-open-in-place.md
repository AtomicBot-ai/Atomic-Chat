---
date: 2026-10-20
title: "List Hub models in a table whose rows open in place"
---

# 2026-10-20 — List Hub models in a table whose rows open in place

- **Context:** The Hub was a two-column page: a list of model rows on the
  left, a detail panel with download options and the repo's README on the
  right, the first row selected on arrival. The approved interface prototype
  replaces it, in every category, with one toolbar row (model type, search,
  Filters, Sort, Import) and a full-width list whose rows open in place; text
  models become a sortable table. The prototype ran on fixtures and lost
  what the app added since v2.2.5: section headings, Foundry Local rows,
  SGLang, the `installed` link from the sidebar. It also persisted the engine
  filter, guessed RAM as size ÷ 0.7, rendered every row behind a virtualizer
  it never used, and faked the file import.
- **Decision:**
  - **Text models** are a table (`LocalModelTable`): Model, Parameters,
    Format, Context, Capabilities, Download size, Est. RAM, This device,
    Uncensored, Engines, each sortable where it is a value, unknown values
    last either way; columns give way to the table's own width (container
    queries at 1100 / 900 / 700 / 520 px). Sections — Recommended, More from
    Hugging Face, an engine's curated list, PrismML's Bonsai families, the
    Foundry curated list and Microsoft's catalog, Uncensored — are heading
    rows; a column sort makes one list and drops them.
  - **This device** is the download card's own verdict: `estimateFit` of the
    representative download against the memory budget, drawn as `FitBadge`.
    **Est. RAM** is that same size — the weights the device is judged by —
    not a second estimate above it. A managed engine's checkpoint and a
    Foundry Local model are left to the engine's check in the card.
  - **One row is open at a time**, in place of its summary, with its facts,
    heart, source and download options (`ModelDetailPanel`,
    `FoundryLocalDownloadOptions`, `ManagedDownloadOptions` as before).
    Nothing opens on arrival; a deep link still opens its row, first when the
    list does not carry it. Closing replaces the history entry.
  - **The README is gone**; its place is a link to the source: the Hugging
    Face repo, or for Foundry Local the catalog the model came from (it has
    no page of its own). Images, Video, Decision, Embedding and the new Voice
    category move to the same rows that open in place, without auto-open.
  - **Filters** holds the engine (`HUB_ENGINES`, `sglang` and `foundry-local`
    included), the format (vLLM, SGLang, TensorRT-LLM and Foundry Local stay
    formats of their own), and Show only: liked, uncensored, installed,
    fitting. The engine, like the format, lasts one launch
    (`hub-session.ts`); hearts persist in `atomic-model-likes`, the Liked
    filter does not.
  - **Paging** follows an `IntersectionObserver` on the rows, not a
    virtualizer: the rows on screen get their cards, and the next page is
    asked for while the end of the list is in view, decided after the last
    page was counted (the managed formats still stop after three empty
    pages). A search still asks Hugging Face from three characters on.
  - **Import file** uses the engine pages' imports: a `.gguf` opens the
    llama.cpp import with the file chosen, an MLX folder (macOS) the MLX
    import, anything else is refused with what can be imported.
  - **Voice** is a category wherever voice input runs
    (`PlatformFeature.VOICE_INPUT` and `voice().isSupported()`), media engine
    or not; it lists the dictation model with the settings card.
- **Consequences:**
  - Every row is in the DOM. Feed pages are 50 rows and only rows on screen
    fetch cards, so a long scroll costs DOM, not requests; a very long list
    is the thing to watch.
  - `ModelListRow` and `HubReadme` are gone. `ImportVisionModelDialog` and
    `ImportMlxModelDialog` can be opened with a path already chosen.
  - Desktop E2E opens the fixture's row only while it is closed: a click on
    an open row now closes it.
- **Owner:** team
- **Links:** `web-app/src/routes/hub/index.tsx`,
  `web-app/src/containers/hub/LocalModelTable.tsx`,
  `web-app/src/containers/hub/ModelDetailPanel.tsx`,
  `web-app/src/containers/hub/HubFilters.tsx`,
  `web-app/src/containers/hub/ImportLocalFile.tsx`,
  `web-app/src/containers/hub/VoiceHub.tsx`,
  `web-app/src/lib/hub-model-facts.ts`, `web-app/src/lib/hub-model-engines.ts`,
  `web-app/src/hooks/useModelLikes.ts`,
  `tests/e2e/desktop/hub-download.spec.ts`

<!--
Supersedes: 2026-08-06-serve-hub-staff-picks-from-a-separate-manifest-and-split-view.md
(the split view only; the staff-picks manifest stands)
-->
