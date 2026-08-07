---
date: 2026-08-07
title: "Take Recommended capability badges from the staff-picks manifest"
---

# 2026-08-07 — Take Recommended capability badges from the staff-picks manifest

- **Context:** Hugging Face exposes no "capabilities" field, so `deriveCapabilities`
  inferred the Vision / Tool Use / Reasoning / Audio badges from whatever the catalog
  entry happened to carry: `num_mmproj`, the `tools` flag, and keyword matches against
  the repo id, description and `library_name`. On long-tail search hits that is the only
  signal there is. On the curated Recommended list it was wrong in both directions.
  It missed capabilities nothing in the repo id advertises — Qwen3.5/Qwen3.6 and
  Ministral 3 ship vision encoders, Gemma 4 E2B/E4B/12B and Nemotron 3 Nano Omni take
  audio input, Gemma 4 and Laguna do function calling and thinking — and it invented
  ones from prose, badging Phi 4 as a reasoning model because its summary says
  "advanced reasoning" when it emits no reasoning traces at all. The manifest already
  carried a hand-written `categories` array per pick, but nothing read it for badges,
  and it had itself drifted: it had no `audio` member, and several entries disagreed
  with their own model cards.

- **Decision:** For a Recommended pick, the manifest is the badge. `deriveCapabilities`
  takes an optional second argument — the pick's `categories` — and when it is present,
  `vision`, `audio`, `reasoning` and `tools` are the complete answer; the heuristic is
  not consulted at all. Search results, which have no curated metadata, keep the
  heuristic and stay explicitly best-effort. All 76 entries (38 GGUF/MLX pairs) were
  re-checked against the model card of the exact repo, and `audio` was added to the
  category enum in `schema.staff-picks.json`, to `StaffPickCategory` and to the
  sanitizer's allow-list.

- **Consequences:**
  - **A curated pick with no capability category shows no badges.** Passing an *empty*
    result is the point: `['general']` on Phi 4 means "we looked, there is nothing to
    badge", and the heuristic must not second-guess it. Only an *absent* `categories`
    field falls back to inference, so a pick published before this change keeps its
    badges.
  - The badges describe the **base model's** capabilities, limited to the four we have
    badges for, not what each backend currently executes. A GGUF vision pick needs its
    mmproj and audio input is not wired in llama.cpp at all, so a badge is a statement
    about the model, not a runtime guarantee. The alternative — badge only what the
    active backend can serve — would make the same row change badges when the user
    switches provider, and would hide the reason to pick the model in the first place.
  - Both builds of a model carry identical capabilities, and a test asserts it:
    `BASELINE_STAFF_PICKS` must not let a GGUF pick and its MLX twin promise different
    things. The exception the manifest still allows is a conversion that genuinely omits
    a multimodal part; that has to be stated per entry, not left to drift.
  - Re-badging Recommended is now a manifest edit, not a release: `categories` is
    remote-configured, so a mistake is fixable in `atomic-chat-conf` alone. The cost is
    that a wrong `categories` value now shows up verbatim instead of being papered over
    by inference, which is why the manifest is the thing under review.
  - Adding `audio` is backwards-compatible and `schema_version` stays 1. Older clients
    drop unknown categories in `sanitizePick`, so they lose the Audio badge and nothing
    else. The bundled `BASELINE_STAFF_PICKS` mirrors the manifest field for field, so
    first launch and offline show the same badges as a fetched manifest.
  - `categories` now serves two purposes — presentation pills and the authoritative
    capability set — so the descriptive members (`general`, `coding`, `compact`,
    `multilingual`) and the capability members are documented as different kinds of
    entry in the schema and the type.
  - Badges live in one place: the detail panel's **Capabilities** field. The list row
    used to draw the first two of them, which with four curated capabilities (Gemma 4
    E2B) meant a row that silently dropped half the answer and a second, differently
    truncated copy of the same data next to the size and download count. The row keeps
    size, downloads and format; capabilities are read where they are complete.

- **Owner:** `team`
- **Links:**
  - `web-app/src/lib/model-card.ts`, `web-app/src/containers/hub/ModelListRow.tsx`,
    `web-app/src/containers/hub/ModelDetailPanel.tsx`
  - `web-app/src/services/staff-picks-registry.ts`, `web-app/src/constants/staff-picks.ts`
  - `web-app/src/lib/__tests__/model-card.test.ts`,
    `web-app/src/services/__tests__/staff-picks-registry.test.ts`
  - `atomic-chat-conf`: `models/staff-picks.json`, `models/schema.staff-picks.json`
  - Builds on:
    [Serve Hub staff picks from a separate manifest and rebuild /hub as a split view](2026-08-06-serve-hub-staff-picks-from-a-separate-manifest-and-split-view.md)
