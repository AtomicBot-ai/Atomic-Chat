---
date: 2026-05-27
title: "Replace `janhq/model-catalog` + Fuse.js with curated `AtomicBot-ai/atomic-chat-model-catalog` and a pre-built MiniSearch index"
---

# 2026-05-27 — Replace `janhq/model-catalog` + Fuse.js with curated `AtomicBot-ai/atomic-chat-model-catalog` and a pre-built MiniSearch index

- **Context:** Hub's "Search models" surface had two compounding problems.
 First, the catalog itself — fetched from `raw.githubusercontent.com/janhq/model-catalog/main/model_catalog_v2.json`
 at startup — had stagnated. The upstream repo no longer received
 curatorial attention: dead Hugging Face links, mixed-quality
 quantizers, no discipline around MLX entries, and a couple of months
 of stale `downloads`/`created_at` snapshots. Second, the client did a
 per-keystroke `new Fuse(filtered, { keys: ['model_name',
 'quants.model_id', 'safetensors_files.model_id'] }).search(query)` over
 the raw JSON ([`web-app/src/routes/hub/index.tsx:213-220`](web-app/src/routes/hub/index.tsx)).
 Fuse's small-corpus scoring degrades past a few thousand entries, the
 keyset ignored organisation / tags / description, and long-tail
 queries (e.g. `qwen3.5 mlx 4bit`) routinely ranked irrelevant quants
 first. The combination meant users with a specific HF repo in mind
 either typed the full slug to win or gave up and pasted the URL into
 the existing fallback. The fallback path
 (`services/models/default.ts :: searchHuggingFaceRepo`) was
 well-engineered but only ever surfaced **one** best match per query,
 so it could not act as a recall safety net.

- **Decision:** Stand up a new public repo
 [`AtomicBot-ai/atomic-chat-model-catalog`](https://github.com/AtomicBot-ai/atomic-chat-model-catalog)
 to own the curated catalog and ship a client-side MiniSearch pipeline
 around it.

 1. **Curated catalog repo + scraper.** `config/orgs.json` is a
    JSON-schema-validated whitelist of trusted HF orgs (GGUF
    quantizers `bartowski` / `unsloth` / `mradermacher` / `ubergarm`
    / `lmstudio-community` / `MaziyarPanahi` / `QuantFactory` /
    `ggml-org`, MLX contributors `mlx-community` / `prince-canuma` /
    `apple` / `Goekdeniz-Guelmez`, first-parties `Qwen` / `microsoft`
    / `meta-llama` / `mistralai` / `google` / `deepseek-ai` / `nvidia`
    / `NousResearch` / `allenai` / `cognitivecomputations`, plus
    `AtomicChat` as the in-house track and `TheBloke` / `janhq` as
    archived). `scripts/scrape.py` (uv-managed, Python 3.13) paginates
    `GET /api/models?author={org}&full=true`, follows `Link: rel=next`
    headers, applies a first-pass filter (downloads ≥ threshold,
    GGUF/MLX hint via tags/library/path), fetches per-repo detail with
    `?blobs=true&files_metadata=true`, and emits a `catalog.json`
    whose `models[]` is a strict superset of the client's
    `CatalogModel` interface — every download URL, sha256, mmproj
    sibling, and safetensors entry is preserved verbatim so the
    existing llama.cpp / MLX download pipelines work unchanged.
 2. **Pre-built MiniSearch snapshot.** `scripts/build_index.mjs`
    consumes the scraper output and writes `catalog.idx.json` —
    a JSON-serialised `MiniSearch.toJSON()` instance configured with
    multi-field BM25 (`model_name` ×5, `developer` ×3,
    `tags_normalized` ×2, `description` ×1), fuzzy 0.2, prefix-true,
    AND-combine, plus a custom tokenizer that splits on
    `\s\-_./:,;()[\]<>+` so repo names like `qwen3.5-9b-mlx-4bit`
    index as discrete tokens. The wrapper carries an `index_version`
    so the client refuses snapshots built with a config it does not
    understand.
 3. **Release-based hosting.** `.github/workflows/cron.yml` runs
    every 12 hours plus on `workflow_dispatch` / `repository_dispatch`,
    publishes `catalog.json`, `catalog.idx.json`, `stats.json` to a
    dated GitHub Release, and re-points the `latest` alias release at
    the new artefacts. `.github/workflows/validate.yml` smoke-tests
    every PR against `ggml-org` and validates schemas with
    `ajv-cli@5`.
 4. **Client loader + store.** New
    [`web-app/src/services/model-catalog-registry.ts`](web-app/src/services/model-catalog-registry.ts)
    mirrors the architecture of `provider-registry.ts` and
    `recommended-models-registry.ts`: TTL 1h cache in `localStorage`
    (`atomic_model_catalog_cache_v1` / `atomic_model_catalog_idx_v1`,
    distinct from the sibling registries), tauri-HTTP fallback when
    standard `fetch` fails, baseline `BASELINE_MODEL_CATALOG` in
    [`web-app/src/constants/models.ts`](web-app/src/constants/models.ts)
    for offline first-launch. Companion
    [`web-app/src/stores/model-catalog-store.ts`](web-app/src/stores/model-catalog-store.ts)
    bootstraps in the background on module import and exposes
    `catalog`, `index`, `status`, `source`, `manifestUpdatedAt` to
    React; `getCatalogSync()` / `ensureCatalogLoaded()` cover
    non-React callers.
 5. **Client search service.** New
    [`web-app/src/services/model-search.ts`](web-app/src/services/model-search.ts)
    is the single search API. `loadSnapshot` hydrates the pre-built
    `MiniSearch` payload; `rebuild` is the on-the-fly fallback. The
    ranking pipeline is BM25 × platform-aware `ORG_BOOST` (e.g.
    `mlx-community` is 1.5 on macOS, 0 on Windows / Linux —
    defense-in-depth alongside `useModelSources`' MLX filter) ×
    `log1p(downloads / 100)` × exponential recency decay (180-day
    half-life on `created_at`). Empty queries use the same ranking
    minus the BM25 term, so the Hub default view stays consistent
    with search results.
 6. **Hub integration.**
    [`web-app/src/routes/hub/index.tsx`](web-app/src/routes/hub/index.tsx)
    drops Fuse.js entirely. `searchService.search(...)` runs against
    the catalog snapshot, and a new effect kicks off
    `services/models/default.ts :: searchHuggingFaceCandidates` (a
    new public method returning up to 10 HF candidates as lightweight
    `CatalogModel` entries) whenever the curated set has fewer than
    5 hits for a ≥3-character query. Those candidates are deduped
    against the curated list and appended at the tail of the
    virtualised list, so curated results always rank first while the
    long-tail HF search remains discoverable.
 7. **Compatibility shim.**
    [`web-app/src/hooks/useModelSources.ts`](web-app/src/hooks/useModelSources.ts)
    is now a thin Zustand store that subscribes to
    `useModelCatalogStore`, applies the existing `sanitizeModelId` on
    quants, and drops MLX entries when `!IS_MACOS`. Dozens of existing
    Hub consumers do not need to change. `services/models/default.ts ::
    fetchModelCatalog` proxies to `getCatalogOrFallback()` so callers
    that still reach for the old API keep working.
 8. **Build config.**
    [`web-app/vite.config.ts`](web-app/vite.config.ts) flips the
    compile-time `MODEL_CATALOG_URL` global to the new catalog URL
    (with `VITE_MODEL_CATALOG_URL` / `VITE_MODEL_CATALOG_INDEX_URL`
    env overrides), kept as a transitional alias for one release.
    `fuse.js` is removed from `web-app/package.json`; `minisearch` is
    added (`^7.1.2`).
 9. **Locale + docs.** New `hub:fromHuggingFace*` keys added to
    `web-app/src/locales/en/hub.json`.
    [`web-app/src/services/AGENTS.md`](web-app/src/services/AGENTS.md)
    grows a §3 "Model Catalog Registry" mirroring §§1–2.

- **Consequences:**
 - **Catalog freshness.** A 12-hour cron + manual / external dispatch
   means new community quants (and our own `AtomicChat/*` releases)
   surface in Hub within an hour of merging the corresponding PR
   against the catalog repo — no Atomic Chat release required.
 - **Search quality.** On a 167-entry sanity scrape of `ggml-org`,
   the MiniSearch index builds in 7ms and answers per-query in <1ms.
   Long-tail queries like `qwen3.5 mlx 4bit` rank the
   `mlx-community/Qwen3.5-9B-MLX-4bit` repo first on macOS, the
   GGUF quants first elsewhere — verified by
   `web-app/src/services/__tests__/model-search.test.ts`.
 - **Reach.** The catalog is intentionally a curated whitelist (≈25
   orgs). Models from outside that whitelist remain discoverable via
   the Path B HF fallback, which now returns up to 10 candidates per
   query instead of one. Pasting a `huggingface.co/owner/repo` URL
   still hits the existing exact-id path in
   `default.ts :: fetchHuggingFaceRepo` and renders the model card
   immediately.
 - **Bundle size & startup.** `minisearch` adds ~28 kB gzipped to the
   web bundle; `fuse.js` (~7 kB) is removed. The pre-built index ships
   over the wire (sized roughly 1 MB for a 5k-model catalog), so
   first-launch search is instant once the GitHub Release is reachable.
   Offline first launches fall back to `BASELINE_MODEL_CATALOG` (5
   entries today) so Hub never renders empty.
 - **Backwards compatibility.** No persisted client state changes
   shape. `useModelSources`' public surface (`sources`, `fetchSources`,
   `loading`, `error`) is preserved bit-for-bit. The legacy
   `MODEL_CATALOG_URL` global keeps working through a transitional
   alias in `vite.config.ts`. Drop the alias in a follow-up after one
   release window.
 - **What did NOT change.** `recommended-models-registry` stays on
   `atomic-chat-conf` (its manifest is intentionally hand-curated, not
   scraped). `provider-registry` is untouched. Download / verification
   pipelines (`llamacpp` / `mlx`) consume the exact same `CatalogModel`
   shape they always have.
 - **Test coverage.** Three new vitest suites
   (`model-catalog-registry.test.ts` — 6 cases covering the six
   failure-mode branches; `model-search.test.ts` — 7 cases pinning the
   ranking properties; rewritten `useModelSources.test.ts` — 4 cases
   covering the shim) plus the existing provider / recommended-models
   suites all pass (42 tests).

- **Owner:** team.
- **Links:** [AtomicBot-ai/atomic-chat-model-catalog](https://github.com/AtomicBot-ai/atomic-chat-model-catalog),
 [`web-app/src/services/model-catalog-registry.ts`](web-app/src/services/model-catalog-registry.ts),
 [`web-app/src/services/model-search.ts`](web-app/src/services/model-search.ts),
 [`web-app/src/stores/model-catalog-store.ts`](web-app/src/stores/model-catalog-store.ts),
 [`web-app/src/hooks/useModelSources.ts`](web-app/src/hooks/useModelSources.ts),
 [`web-app/src/services/models/default.ts`](web-app/src/services/models/default.ts),
 [`web-app/src/routes/hub/index.tsx`](web-app/src/routes/hub/index.tsx),
 [`web-app/src/constants/models.ts`](web-app/src/constants/models.ts),
 [`web-app/src/services/AGENTS.md`](web-app/src/services/AGENTS.md) §3,
 [MiniSearch](https://github.com/lucaong/minisearch).
