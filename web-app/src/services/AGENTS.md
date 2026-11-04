# Remote Registries — Agent Notes

Provider configuration and local model catalogs have separate contracts. Provider rules below are unchanged. Managed desktop models use one catalog; generated Hub discovery remains a separate active search feed.

# 1. Provider Registry

> **Scope**: this section applies when editing files that participate in the
> remote provider-registry feature:
>
> - [provider-registry.ts](./provider-registry.ts) — the network loader.
> - [providers/tauri.ts](./providers/tauri.ts) — desktop providers service.
> - [providers/default.ts](./providers/default.ts) / [providers/types.ts](./providers/types.ts).
> - [../stores/provider-registry-store.ts](../stores/provider-registry-store.ts) — Zustand wrapper.
> - [../constants/providers.ts](../constants/providers.ts) — bundled baseline (Azure + `openAIProviderSettings`).
>
> It does **not** apply to unrelated services in this folder (extensions, MCP,
> hardware, etc.). For those, follow the rules in their own AGENTS.md, if any,
> or the project root guidance.

## Why this exists

Most cloud providers (OpenAI, Anthropic, OpenRouter, Mistral, Groq, xAI,
Gemini, MiniMax, Hugging Face, NVIDIA, …) are no longer hard-coded in the
TypeScript source. They live in a public Git registry,
[AtomicBot-ai/atomic-chat-conf](https://github.com/AtomicBot-ai/atomic-chat-conf),
under `providers/registry.json`. The desktop client fetches that file at
startup, caches it for one hour, and falls back to a small bundled baseline
when the network is unreachable. Adding a new provider or model now means
opening a Pull Request against the registry repo — no app release required.

## Data flow

```mermaid
flowchart LR
    subgraph confRepo [AtomicBot-ai/atomic-chat-conf]
        regJson[providers/registry.json]
        schemaJson[providers/schema.json]
        ciAction[.github/workflows/validate.yml]
    end
    rawCdn["raw.githubusercontent.com"]
    regJson -->|"published on merge"| rawCdn

    subgraph janClient [Atomic-Chat web-app]
        loader[services/provider-registry.ts]
        store[stores/provider-registry-store.ts]
        tauriSvc[services/providers/tauri.ts]
        baseline[constants/providers.ts azure baseline]
        ui[Settings to Providers Refresh button]
        consumers[5 React consumers via isKnownProvider]
    end

    rawCdn -->|"fetchTauri TTL 1h"| loader
    loader -->|"merge with baseline + sanitize"| store
    store --> tauriSvc
    store --> consumers
    baseline -.fallback.-> store
    ui -->|"refresh true"| loader
```

## Where things live

| Concern                                  | File                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Remote manifest                          | `AtomicBot-ai/atomic-chat-conf/providers/registry.json`                                             |
| JSON Schema for the manifest             | `AtomicBot-ai/atomic-chat-conf/providers/schema.json`                                               |
| Loader (fetch, cache, sanitize, fallback)| [provider-registry.ts](./provider-registry.ts)                                                      |
| Zustand store + auto-bootstrap           | [../stores/provider-registry-store.ts](../stores/provider-registry-store.ts)                        |
| Sync helper for non-React code           | `getRegistryProvidersSync()` in the same store                                                      |
| Bundled baseline (Azure + custom-form)   | [../constants/providers.ts](../constants/providers.ts) (`BASELINE_PROVIDERS`, `openAIProviderSettings`) |
| Desktop providers service                | [providers/tauri.ts](./providers/tauri.ts) — uses `ensureRegistryLoaded()`                          |
| UI refresh button + last-updated label   | [../routes/settings/providers/index.tsx](../routes/settings/providers/index.tsx)                    |
| Locale strings (`provider:registry.*`)   | `../locales/*/providers.json` (13 locales)                                                          |
| Loader tests                             | [./__tests__/provider-registry.test.ts](./__tests__/provider-registry.test.ts)                      |

### Consumer files migrated to `isKnownProvider`

These files used to import `predefinedProviders` to test "is this provider
system-defined?". They now ask the registry store via `isKnownProvider(name)`:

- [../routes/settings/providers/$providerName.tsx](../routes/settings/providers/$providerName.tsx)
- [../containers/DropdownModelProvider.tsx](../containers/DropdownModelProvider.tsx)
- [../containers/dialogs/DeleteProvider.tsx](../containers/dialogs/DeleteProvider.tsx)
- [../lib/onboarding.ts](../lib/onboarding.ts) — shared by the home route and
  the startup backend coordinator

## Schema versioning

The manifest carries `schema_version`. The client embeds
`SUPPORTED_SCHEMA_VERSION` in `provider-registry.ts`. Rules:

- **Bump `SUPPORTED_SCHEMA_VERSION` _before_ shipping a manifest with a
  higher version.** Otherwise old clients reject the new manifest and stay on
  the cached/baseline copy.
- Adding a new provider or a new model is **not** a schema change.
- Adding/removing required fields, changing field types, or renaming fields
  on `provider`/`model`/`providerSetting` IS a schema change — bump it.
- Always update `providers/schema.json` in the registry repo when you change
  the shape, and re-run `ajv validate` locally.

## Cache rules

- TTL: `CACHE_TTL_MS = 60 * 60 * 1000` (1 hour).
- Keys in `localStorage`:
  - `jan_provider_registry_cache_v1` — JSON-stringified manifest.
  - `jan_provider_registry_cache_ts_v1` — number, `Date.now()` at write time.
- `clearRegistryCache()` wipes both keys; tests use it for isolation.
- The Refresh button in Settings → Providers calls `refresh({ force: true })`,
  which bypasses freshness and writes a new cache entry on success.
- A stale cache (`isCacheFresh === false`) is still used as **fallback** if
  the network attempt fails. Only when there is no cache at all do we fall
  through to `BASELINE_PROVIDERS`.

## Failure modes (and what to render)

| Trigger                                | Source returned | UI behavior                                                  |
| -------------------------------------- | --------------- | ------------------------------------------------------------ |
| Fresh cache present, no force          | `cache`         | Silent — same providers shown.                               |
| Fetch succeeds                         | `remote`        | Silent. Cache and store are updated.                         |
| Fetch fails, stale cache exists        | `cache`         | Silent. `error` field is set so explicit Refresh shows toast.|
| Fetch fails, no cache                  | `baseline`      | Silent (Azure-only catalog). User can add custom providers.  |
| `schema_version` exceeds support       | `baseline`      | Silent. Encourage update via separate UX (future work).      |
| Manifest payload malformed             | `baseline`      | Silent. Logged via `console.warn`.                           |
| Tauri fetch unavailable (web/test env) | uses `globalThis.fetch` | Same outcomes as above.                              |

`getProvidersOrFallback()` is documented as **never throwing** — UI code must
not wrap it in `try/catch` for control flow.

## How to add a provider

### For non-developers (preferred path)

1. Open `providers/registry.json` in `AtomicBot-ai/atomic-chat-conf` on GitHub.
2. Click **Edit**, append a new entry, bump `updated_at`, open a PR.
3. CI (`ajv validate` + the integrity script) must be green before merge.
4. After merge, every Jan client picks up the change within an hour, or
   immediately on Settings → Providers → **Refresh catalog**.

### For developers (only when shape changes)

1. Update [./provider-registry.ts](./provider-registry.ts):
   - Bump `SUPPORTED_SCHEMA_VERSION` if breaking.
   - Add new field handling in `sanitizeProvider` / `isManifest`.
2. Update `providers/schema.json` in the registry repo.
3. Ship the client first (so deployed clients can read the new shape).
4. Then publish the registry change.

## Do NOT

- **Do not** restore the old `predefinedProviders` array. Use
  `useProviderRegistryStore` (React) or `getRegistryProvidersSync()` /
  `ensureRegistryLoaded()` (non-React).
- **Do not** put `api_key` values in the manifest. The loader strips them on
  every fetch (`sanitizeProvider`), but committing one is still a security
  incident — rotate the key immediately.
- **Do not** delete `azure` or `openAIProviderSettings` from
  `BASELINE_PROVIDERS`. Azure cannot live in the shared registry (its
  `base_url` is per-customer), and `openAIProviderSettings` is the form
  template the "Add Provider" dialog clones for custom providers.
- **Do not** call `getProvidersOrFallback()` from render-critical code paths
  on every render. Use the store (`useProviderRegistryStore(s => s.providers)`)
  so a single fetch backs every component.
- **Do not** edit `registry.json` inside `Atomic-Chat`. It does not exist
  here. The single source of truth is the `atomic-chat-conf` repo.
- **Do not** widen the cache TTL beyond 24h without coordinating with
  release/communications — users expect changes within an hour.

## Tests

Run only the relevant suites while iterating:

```bash
npx vitest run src/services/__tests__/provider-registry.test.ts
npx vitest run src/routes/settings/providers/__tests__/index.test.tsx
npx vitest run src/containers/__tests__/DropdownModelProvider.displayName.test.tsx
```

The full root suite is expected to pass. Do not normalize or document a
permanently red baseline: fix a regression where it belongs, or quarantine it
explicitly with an owner and a follow-up reference.

# 2. Unified model catalog

- Edit only `atomic-chat-conf/models/catalog.json` for desktop model sources, full HF commits, file selection, recommendations, tiers and staff picks. Its schema is `models/schema.catalog.json`.
- `unified-model-catalog.ts` and `core/src/browser/modelCatalog.ts` load one complete document with a one-hour TTL, one whole-document cache (`atomic_unified_model_catalog_v1`) and a generated bundled fallback. Collection services project the existing UI types from it.
- The old `models/recommended.json`, `staff-picks.json`, `diffusion.json`, `embedding.json`, `decision.json`, `litert-lm-models.json`, `geniex-models.json`, `foundry-local-models.json` and `atomic-prism-models.json` and `audio.json` are **deprecated generated compatibility exports**. Never edit them independently or add them as new desktop sources.
- Preserve `atomic-chat-model-catalog` as the active wide Hub discovery feed, including its MiniSearch index, IndexedDB cache and bundled seed. It is generated search data, not a replacement for managed recommendation pins. Never narrow discovery to the managed subset.
- Run `node .github/scripts/export-model-catalog.mjs` in conf after canonical edits. Its `--baseline` option generates client snapshots; `--check` verifies semantic equality offline. Run `make validate` in conf.
- Keep legacy export URLs, fields and `schema_version` intact. Their schemas carry the deprecation annotation; adding a field to strict old data payloads can break released clients. Remove exports only through a separate decision explicitly ending support for every consumer.
- The core's Prism compatibility reader still consumes its generated export. Mobile catalogs and immutable engine/runtime descriptors retain their supported contracts.
- Do not edit the generated `core/src/browser/modelCatalogBaseline.json` by hand. Preserve external model and variant IDs, model paths and old caches.
- HF loading resolves a commit, reads metadata for every selected file, checks compatibility/space, persists a complete versioned plan, then transfers. Resume uses that saved plan; it must not reselect files from main or a refreshed catalog. Persist no credentials. Refuse old unfinished jobs without a recorded commit/plan and keep their partials.
- Use existing stores (`model-catalog-store`, `recommended-models-registry-store`, `staff-picks-store`, `useModelSources`) for UI projections. Do not introduce another source of model truth, another search library, or a second store that rewrites the whole catalog.
- Search keeps MiniSearch ranking, platform boosts and long-tail HF fallback. Preserve its index version gate and nonthrowing `getCatalogOrFallback` / `getIndexOrFallback` interfaces. Managed cards resolve their explicit revisions without overriding discovery by repository name.
- Regression checks: `core/src/browser/modelDownloads.test.ts`, `services/__tests__/unified-model-catalog.test.ts`, collection registry suites and `services/__tests__/model-search.test.ts`. Run root `make verify` before finishing.

Legacy export details and the established discovery/search contracts are retained in [legacy-model-registry-contracts.md](legacy-model-registry-contracts.md). They do not authorize direct edits of generated exports.
