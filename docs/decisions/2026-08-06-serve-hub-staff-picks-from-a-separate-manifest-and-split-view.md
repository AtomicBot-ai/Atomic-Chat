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
    key ahead of the client that bundles it degrades instead of breaking.
  - Long-tail Hugging Face search results draw a neutral Hugging Face mark rather than a
    letter or a remote org avatar. No avatar requests are made while scrolling.
  - README rendering drops every image node, markdown- and HTML-authored alike. Model
    cards plastered with CI shields and hero banners now read as text, at the cost of
    losing the occasional genuinely informative diagram.
  - The fit filter ("only picks that fit this device") is on by default in staff-picks
    mode and deliberately disabled during search: a search is an explicit request for a
    named model, and hiding it because it is too large would look like a missing model.
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
