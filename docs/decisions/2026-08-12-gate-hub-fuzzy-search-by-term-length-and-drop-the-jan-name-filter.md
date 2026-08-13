---
date: 2026-08-12
title: "Gate Hub fuzzy search by term length and drop the Jan name filter"
---

# 2026-08-12 — Gate Hub fuzzy search by term length and drop the Jan name filter

- **Context:** typing `Jan` in the Hub returned 160+ unrelated GGUF repos and
  not a single Jan model. Two independent causes, both pre-dating the current
  Hub rework. (1) `isJanCatalogModel` in `routes/hub/index.tsx` (commit
  `f4d29a4e4`) dropped every catalog hit whose repo name started with `jan`.
  Against the live 2961-model catalog that filter removed exactly four repos —
  `unsloth/Jan-nano-GGUF`, `unsloth/Jan-nano-128k-GGUF` and both
  `unsloth/JanusCoder-*-GGUF` builds, the latter a ByteDance model unrelated to
  Jan. Upstream's own `janhq/*` repos are already excluded one layer earlier
  (`active: false` in the catalog repo's `config/orgs.json`), so the filter's
  only remaining effect was hiding legitimate third-party quants. (2) MiniSearch
  ran with a flat `fuzzy: 0.2`; its edit budget is `round(term.length * 0.2)`,
  so the three-letter term `jan` still admitted distance 1 and matched the
  language codes `ja`, `jpn`, `jav`, `jvn` (plus `dan`, `pan`, `kan`, `ban`) in
  `tags_normalized` / `description`. That produced 271 hits, and because the
  long-tail Hugging Face fallback only fires below five catalog results, the
  noise also suppressed the one path that could still have surfaced a Jan repo.
- **Decision:** delete `isJanCatalogModel` — repo-name blocklisting belongs in
  the catalog's org config, not in the client — and make fuzziness a function of
  term length (`FUZZY_MIN_TERM_LENGTH = 4`, MiniSearch's own documented idiom)
  so terms of three characters or fewer are answered by prefix matching alone.
- **Consequences:** `jan` now returns 6 hits led by both `Jan-nano` builds, and
  typo tolerance survives where it is meaningful (`mistrl` still finds the
  Mistral family). Short queries are exact-prefix only, so a two- or
  three-letter typo no longer self-corrects — an acceptable trade for queries
  that cheap to retype. The gate is a *search* option, not an index-time one:
  `tokenize` / `processTerm` / field boosts are untouched, so no
  `SUPPORTED_INDEX_VERSION` bump and no re-publish of `catalog.idx.json` is
  needed. `scripts/build_index.mjs` in the catalog repo still carries
  `fuzzy: 0.2` in the snapshot's baked-in `searchOptions`; the client overrides
  `searchOptions` on load and per query, so the two do not have to match — but
  anyone reading that file should not take it as the effective policy.
- **Owner:** `team`
- **Links:** `web-app/src/services/model-search.ts`,
  `web-app/src/routes/hub/index.tsx`,
  `web-app/src/services/__tests__/model-search.test.ts`,
  [2026-05-27 — curated catalog + MiniSearch index](2026-05-27-replace-janhq-model-catalog-fuse-js-with-curated-atomicbot-ai.md)
