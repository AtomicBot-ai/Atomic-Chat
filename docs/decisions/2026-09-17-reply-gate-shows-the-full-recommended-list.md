---
date: 2026-09-17
title: "Show onboarding's full recommended list in the reply gate, marks and sizes included, and seat the folder route among the routes"
---

# 2026-09-17 — Show onboarding's full recommended list in the reply gate, marks and sizes included, and seat the folder route among the routes

- **Context:** The blocked-send widget (`ReplyModelGate`, "Pick a model to
  start chatting") promised the list onboarding shows (2026-09-15) and, at
  the time, kept the promise: the manifest's rung for this tier and up to two
  of its flat recommendations, through `useRecommendedDownloads(limit = 3)`.
  Onboarding then moved on. Its list became the offer plus every one of the
  Hub's GGUF staff picks (2026-09-11), listed by how they fit this machine
  and marked row by row (2026-09-16) — with the note that the gate "does not
  carry the mark yet; that is a follow-up". On a 64 GB M5 Max the drift was
  plain: onboarding listed a dozen models under a "Recommended models" label,
  each with a fit mark and its size; the widget listed three (a 35B, a 4B, a
  9B) under no label, with no mark, a bare "Download", a subtitle wrapping to
  three lines, and, under the routes, a fill-less text link reading "Add a
  folder with models" that nobody saw.
- **Decision:** The widget's recommended block is onboarding's "Recommended
  models" section, row for row. The same label heads it. The offer comes
  first with the filled button; the Hub's GGUF picks follow in the same
  order — what fits, then what is tight, then what will not load, dealt so
  no two neighbours share a publisher — each wearing the same
  `ModelFitIndicator` through `RouteRow`'s `meta` slot, with the same level
  label and sentence. Nothing is dropped for size: a pick that will not load
  is listed with its red mark, as onboarding lists it (a confirm on such a
  Download is the parallel wont-fit-confirm change, at the same
  `item.start()` call site). The Download button carries the size of what it
  fetches — quant plus projector, the figure onboarding prints beside the
  name and judges the fit on — as "Download 4.2 GB", or the verb alone when
  the card states no size. The box scrolls at 40 vh / 22 rem so the routes
  under it stay put. The subtitle is one line: "Your message is saved. Pick
  a model and it will be sent." The folder route is a `RouteRow` among the
  other routes — "Models on this computer / Pick a folder and they're added
  / Add", FolderPlus mark, the button reading "Looking…" and disabled while
  the scanner reads the folder — with the behaviour it had (pick → scan →
  import the lightest runnable → start). The list comes from a new
  `useRecommendedListDownloads` beside `useRecommendedDownloads`: the lead
  from the ladder as before, the picks from `useStaffPicks`, ordered by the
  screen's own `orderRowsByFit` and `interleaveByPublisher`; every
  `RecommendedDownload` now carries `sizeLabel`, `sizeBytes`, `fit` and, for
  a pick, the Hub's `summary`. To share the screen's pickers and copy
  without importing the 2000-line screen — and the registry stores it pulls
  in, which fetch at import — into every consumer of the hook, the pure
  helpers `pickPreferredVariant`, `pickMmprojModel`, `publisherKey`,
  `interleaveByPublisher`, `formatMemoryGb` and `describeRecommendationFit`
  moved verbatim from `SetupScreen.tsx` to `SetupScreenHelpers.ts` and are
  re-exported from the screen, so their importers need no change. The
  manifest's flat tail is no longer a row in the widget, as it is not one on
  onboarding.
- **Consequences:** One list, one order, one mark on both surfaces, and the
  widget can be as long as the manifest without moving its exits. The
  reminder card (`PromptOnboardingModel`, limit 1) and the composer's model
  list (`RecommendedPicks`, limit 3) keep reading the ladder through
  `useRecommendedDownloads`: they agree with the widget on the lead and now
  differ from it after the lead. The picker's record (2026-09-16
  model-selector-download-picks) tied it to the widget's rows, so moving it
  onto `useRecommendedListDownloads` is the obvious follow-up, left out here
  on purpose. A pick whose card has not resolved is left out until it lands,
  then joins at its colour — the widget's existing "only rows that can be
  downloaded" rule, where onboarding keeps placeholders — so on a cold cache
  the list can grow and reorder in the seconds after opening. The ladder
  rows' "would not load" drop and their `fit` are judged on quant plus
  projector now, not on the quant alone: a vision entry whose projector tips
  it over the ceiling is dropped, which is the honest reading. The Download
  button's accessible name stays "Download {{name}}"; the size reaches a
  screen reader through the mark's name ("Fits your memory. 4.2 GB — fits
  your 18 GB of unified memory…"). `ru` and `ja` keep their translations of
  the old subtitle and of "Looking for models…" until retranslated;
  `downloadSize`, `folderTitle` and `folderHint` fall back to English. Each
  mark is one Radix tooltip, as on onboarding.
- **Owner:** @danyurkin.
- **Links:** follows
  [2026-09-15 Ask for a model with the same rows and the same list as onboarding](2026-09-15-ask-for-a-model-with-the-same-rows-and-list-as-onboarding.md),
  [2026-09-11 List the Hub picks under the onboarding offer](2026-09-11-list-the-hub-picks-under-the-onboarding-offer.md) and
  [2026-09-16 Mark each recommended row with its fit](2026-09-16-mark-each-recommended-row-with-its-fit.md);
  [`web-app/src/containers/ReplyModelGate.tsx`](../../web-app/src/containers/ReplyModelGate.tsx),
  [`web-app/src/hooks/useRecommendedDownloads.ts`](../../web-app/src/hooks/useRecommendedDownloads.ts),
  [`web-app/src/containers/SetupScreenHelpers.ts`](../../web-app/src/containers/SetupScreenHelpers.ts),
  [`web-app/src/containers/SetupScreen.tsx`](../../web-app/src/containers/SetupScreen.tsx),
  [`web-app/src/locales/en/chat.json`](../../web-app/src/locales/en/chat.json).
