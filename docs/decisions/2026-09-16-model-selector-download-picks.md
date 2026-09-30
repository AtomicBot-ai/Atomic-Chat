---
date: 2026-09-16
title: "Let the composer's model list download: recommendations when empty, Hugging Face under the search"
---

# 2026-09-16 — Let the composer's model list download: recommendations when empty, Hugging Face under the search

- **Context:** The composer's model selector (`DropdownModelProvider`) opens
  on its list when nothing is selected. With no model downloaded the list was
  blank, and typing a query ended in `No models found for "qwen"` — a dead
  end, because the only way out was the small "Download a model" row at the
  bottom that leaves for the Hub. The blocked-send widget (2026-09-15) and the
  reminder card (2026-09-16) already recommend the manifest's best fit for the
  device through `useRecommendedDownloads`; the selector, the surface a user
  with nothing actually opens, did not.
- **Decision:** Two additions to the list, both in a new
  `ModelPickerDownloads` container, in the list's own compact row shape (name,
  one line, a button that says only "Download" — no sizes). (1) With nothing
  to pick and nothing typed, the list shows `useRecommendedDownloads()` under a
  "Best fit for your device" header, with the widget's downloading hint and
  its 8 s give-up. (2) For a query of three or more characters, Hugging Face's
  GGUF repos are listed under the local matches — one
  `searchHuggingFaceCandidates` request per query settled for 300 ms, stale
  answers dropped, MLX repos left out. A row resolves its file only when
  clicked: `fetchHuggingFaceRepo` → `convertHfRepoToCatalogModel` →
  `pickDownloadQuant` with the device's memory budget, the same rule the
  Hub's download panel opens on, then `pullModelWithMetadata` with the repo's
  preferred projector. Resolved cards and started variants are cached at
  module level so a reopened panel still shows the row as downloading.
  `searchHuggingFaceCandidates` now rethrows instead of returning `[]` on a
  failed request, so the list can say "Couldn't reach Hugging Face" rather
  than "No models found"; the Hub already caught the rejection. The bottom
  "Download a model" row stays as the way into the Hub for browsing. Nothing
  auto-selects the finished download; the existing start-up effect picks the
  first local model only when preload is on, as before.
- **Consequences:** An empty selector leads somewhere, and a search can end
  in a download instead of a wall. One request per settled query plus one per
  clicked row, never per keystroke or per result — anonymous Hugging Face
  requests are rate-limited per IP, which is why file sizes are not shown on
  search rows (they would cost a request each). A row whose repo turns out to
  ship no GGUF file says so and disables; a lookup that fails offline toasts
  and can be retried. In the Hub's uncensored filter, which fans out two
  queries, one failed query now drops both result sets instead of one.
- **Owner:** @danyurkin.
- **Links:** follows
  [2026-09-15 Ask for a model with the same rows and the same list as onboarding](2026-09-15-ask-for-a-model-with-the-same-rows-and-list-as-onboarding.md),
  [2026-09-16 Offer the manifest's recommendation on the reminder card too](2026-09-16-offer-the-manifest-recommendation-on-the-reminder-card-too.md),
  [`web-app/src/containers/ModelPickerDownloads.tsx`](../../web-app/src/containers/ModelPickerDownloads.tsx),
  [`web-app/src/containers/DropdownModelProvider.tsx`](../../web-app/src/containers/DropdownModelProvider.tsx),
  [`web-app/src/services/models/default.ts`](../../web-app/src/services/models/default.ts).
