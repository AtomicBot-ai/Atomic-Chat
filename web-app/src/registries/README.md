# Bundled registries

Radium ships every curated list it shows as a reviewed snapshot in this folder
(and, for the model catalog, `public/seed-catalog.json.gz` plus its search index
`public/seed-catalog.idx.json.gz`). The app reads these files and nothing else
unless a build sets an override URL — see `src/lib/registry-source.ts`.

| File | Read by | Build-time override |
| --- | --- | --- |
| `providers.json` | `services/provider-registry.ts` | `VITE_PROVIDER_REGISTRY_URL` |
| `recommended-models.json` | `services/recommended-models-registry.ts` | `VITE_RECOMMENDED_MODELS_REGISTRY_URL` |
| `staff-picks.json` | `services/staff-picks-registry.ts` | `VITE_STAFF_PICKS_REGISTRY_URL` |
| `media.json` | `services/media-registry.ts` | `VITE_MEDIA_REGISTRY_URL` |
| `public/seed-catalog*.json.gz` | `services/model-catalog-registry.ts` | `VITE_MODEL_CATALOG_URL`, `VITE_MODEL_CATALOG_INDEX_URL` |

## Provenance

The 2026-10-16 snapshots were taken from the last published upstream copies and
reviewed before commit:

- every Hugging Face repository owned by the upstream project was replaced by a
  verified neutral equivalent (the model's own org, unsloth, lmstudio-community
  or mlx-community) or, in the model catalog, dropped — the catalog mirrors
  Hugging Face org listings, and those entries were re-uploads of models other
  orgs already carry;
- `media.json` is empty because upstream never published a media registry; the
  app's media providers are the built-in ones in `constants/mediaProviders.ts`.

## Updating a snapshot

Run the snapshot script against a source you choose, review the diff, commit:

```sh
cd web-app
node scripts/snapshot-registries.mjs staff-picks https://example.org/staff-picks.json
```

The script rewrites or drops upstream-owned entries and refuses to write a file
that still references them. `tests/no-atomic-sources.test.mjs` re-checks the
committed files.
