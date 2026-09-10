---
date: 2026-08-06
title: "Serve Hub staff picks from a separate manifest and rebuild /hub as a split view"
---

# 2026-08-06 — Serve Hub staff picks from a separate manifest and rebuild /hub as a split view

- **Context:** The Hub's curated block was driven by `atomic-chat-conf/models/recommended.json`,
  whose entries carry only `model_name` and `description_key`. A curated list in the
  LM Studio mould needs a display title, a one-line summary, an icon key, capability
  tags, a per-platform gate and an explicit order. Two ways to get there were open, and
  both had a hard constraint attached:
  - Extending `recommended.json` means either bumping `schema_version`, which every
    shipped client rejects outright in `recommended-models-registry.ts`, or smuggling
    unknown keys past clients whose sanitizer was never asked to tolerate them. Both
    break onboarding on installs that are already in the field, and onboarding is the
    one screen a broken manifest makes unrecoverable.
  - The old Hub also split browsing across two routes: a list at `/hub/` and a detail
    page at `/hub/$modelId`. Comparing two quantizations meant navigating away and back,
    and the list lost its place each time.

- **Decision:** Publish a second manifest, `atomic-chat-conf/models/staff-picks.json`,
  with its own `schema.staff-picks.json`, its own `schema_version: 1`, its own loader
  (`services/staff-picks-registry.ts`) and its own cache keys. `recommended.json`, its
  schema, its loader and `SetupScreen` are untouched, so onboarding on shipped builds
  keeps reading exactly what it reads today. Separately, `/hub/` becomes a split view —
  list on the left, detail panel on the right — with the selection carried in the URL as
  `?model=owner/repo`; `/hub/$modelId` stays as a redirect so existing deep links and the
  `atomic-chat://` handler keep resolving.

- **Consequences:**
  - The list is labelled **Recommended** in the UI while the manifest, the loader
    and the i18n keys keep the `staff-picks` name. The user-facing word follows the
    product; the identifiers follow the published file, which cannot be renamed
    without breaking the clients that fetch it. `staffPicks` and `staffPickBadge`
    are set from each locale's existing `recTitle` translation so the two labels
    cannot drift apart.
  - The device filter ("only include recommended models that fit on this device")
    lives inside the sort menu, below a separator, with the detected device and
    memory budget as a caption — the same placement LM Studio uses. Selecting it
    does not close the menu, so the effect on the list is visible while the
    control is still under the cursor. It is hidden entirely during search.
  - Arriving at `/hub/` with no `?model=` selects the first row and replaces the
    history entry, so the panel is never blank on entry and Back still leaves the
    Hub. A deep link is never overridden: the auto-selection only runs while the
    URL names no model.
  - Two curated lists now exist. Onboarding reads `recommended.json`; the Hub reads
    `staff-picks.json`. A model that should appear in both has to be added to both.
    `external-contracts.test.ts` asserts the separation — that `recommended.json` entries
    still carry exactly `model_name` and `description_key`, and that neither `SetupScreen`
    nor the recommended loader mentions staff picks — so the split cannot erode silently.
  - Staff-pick art is bundled, not fetched: the manifest stores an icon key that
    `lib/model-logo.ts` resolves against shipped assets. A key the client does not know
    falls back to the model-family logo and then to a letter, so publishing a new icon
    key ahead of the client that bundles it degrades instead of breaking. Curating a
    model from a lab we ship no mark for therefore means adding the asset in the same
    change; the marks come from the same `@lobehub/icons-static-svg` set the existing
    ones do, and an org with no icon there (`prism-ml`) uses its Hugging Face avatar,
    downloaded once into `public/`.
  - The curated order groups by model family — Qwen, then Gemma, then LFM, then
    everything else — rather than ranking models against each other. A capability
    ranking would need a defensible measure we do not have, and would churn with every
    release; families are a stable, explainable shelf order, and the manifest's `order`
    field is where it is expressed, so re-curating it needs no client release.
  - A model that ships both builds gets **two manifest entries**, distinguished by a
    declared `format` (`gguf` | `mlx`), and the Hub resolves only the entries matching
    the current format filter: GGUF by default, MLX once the filter is narrowed to MLX
    alone. The alternative — one entry per model, format inferred after resolution —
    would list every model twice in the default view and would double the Hugging Face
    round-trips on first open, because a pick's format is only knowable once it has been
    fetched. Declaring it keeps the off-screen half of the list free. Absent `format`
    means GGUF, so a manifest written before the field keeps working.
  - Long-tail Hugging Face search results draw a neutral Hugging Face mark rather than a
    letter or a remote org avatar. No avatar requests are made while scrolling.
  - README rendering drops every image node, markdown- and HTML-authored alike. Model
    cards plastered with CI shields and hero banners now read as text, at the cost of
    losing the occasional genuinely informative diagram.
  - The fit filter ("only picks that fit this device") is on by default in staff-picks
    mode and deliberately disabled during search: a search is an explicit request for a
    named model, and hiding it because it is too large would look like a missing model.
  - A repo's quoted size, and therefore its fit verdict, comes from the *median* sized
    quant (`pickMedianQuant`), not the smallest. An IQ1/IQ2 rounding is a curiosity
    almost nobody runs, so quoting it understated every row and let the device filter
    promise a fit the user would not get from the quant they actually download. Large
    repos consequently read heavier than before and some drop out of the filtered list.
  - A quant published as `-00001-of-000NN` shards is folded into a single variant
    quoted at the size of the whole set. Per-file quants turned
    `unsloth/DeepSeek-V4-Flash-GGUF` into 49 entries whose header shards weigh 5 MB, so
    the Hub offered a 128 GB variant as a 5 MB "Good fit" with a `00001` badge. Both
    sources need it: the Hugging Face converter groups repository files
    (`groupGgufShards`), and `model-catalog-store` folds catalog entries on read
    (`mergeShardedQuants`) — 443 of the ~3000 published entries are sharded. Folding on
    read rather than in the artefact keeps existing caches valid. The download still
    starts at the first shard: assembling a shard set is a backend capability the
    llama.cpp extension does not have yet.
  - The download panel opens on the same median quant whenever the repo ships neither
    `iq4_xs` nor `q4_k_m` (`pickDownloadQuant`), and steps down to the largest variant
    that fits when the pick is out of the device's reach. Falling back to catalog order
    opened cards such as Bonsai 27B on an F16 dump the device could never run, and
    contradicted the size the list row had just quoted.
  - The download panel's verdict is the existing compatibility badge ("Good fit" /
    "Should run" / "Too large", `FIT_BADGE_CLASS`) rather than a claim about full GPU
    offload, which we cannot substantiate: the memory budget is a whole-device figure
    and says nothing about how many layers a backend will actually place on the GPU.
  - `staff-picks-registry.ts` and `lib/hub-filters.ts` are under the critical-flow
    coverage floor, so their branches cannot quietly rot.
  - `HubModelCard.tsx` lost its last caller with the split view and was removed.

- **Owner:** `team`
- **Links:**
  - `web-app/src/services/staff-picks-registry.ts`, `web-app/src/stores/staff-picks-store.ts`,
    `web-app/src/hooks/useStaffPicks.ts`, `web-app/src/constants/staff-picks.ts`
  - `web-app/src/lib/hub-filters.ts`, `web-app/src/containers/hub/`
  - `web-app/src/routes/hub/index.tsx`, `web-app/src/routes/hub/$modelId.tsx`
  - `atomic-chat-conf`: `models/staff-picks.json`, `models/schema.staff-picks.json`,
    `.github/workflows/validate.yml`
  - Prior art for the frozen manifest:
    [Replace `janhq/model-catalog` + Fuse.js with curated `AtomicBot-ai/atomic-chat-model-catalog`](2026-05-27-replace-janhq-model-catalog-fuse-js-with-curated-atomicbot-ai.md)
