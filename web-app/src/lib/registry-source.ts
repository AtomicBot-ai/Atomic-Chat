/**
 * Where Radium's curated registries come from.
 *
 * Radium ships every registry it reads — the cloud-provider list, the
 * recommended models, the staff picks, the media providers and the model
 * catalog — as a reviewed snapshot inside the app (`src/registries/` and
 * `public/seed-catalog*.json.gz`). By default nothing is fetched: the app is
 * fully usable offline and no third party can change what it offers.
 *
 * A build may opt into a remote copy of any registry by setting its
 * `VITE_*_URL` variable at build time. That is the only switch. It is read
 * once here, so the policy lives in one place and a reviewer can see every
 * remote source the build can reach.
 *
 * Runtime engines (llama.cpp backends, MLX) are NOT registries and are not
 * governed by this module — they keep their own update channels. See
 * `docs/decisions/2026-10-16-only-runtimes-sync-from-upstream.md`.
 */

/**
 * Normalise an optional override URL.
 *
 * Returns `null` — meaning "bundled snapshot only" — for anything that is not
 * a non-empty absolute http(s) URL. Being strict here means a typo in a build
 * variable degrades to the safe default instead of a broken request.
 */
export function registryOverrideUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  } catch {
    return null
  }
  return value
}

/**
 * The build-time override for each registry, or `null` when the build ships
 * with the bundled snapshot only (the default).
 */
export const REGISTRY_OVERRIDES = {
  providers: registryOverrideUrl(import.meta.env.VITE_PROVIDER_REGISTRY_URL),
  recommendedModels: registryOverrideUrl(
    import.meta.env.VITE_RECOMMENDED_MODELS_REGISTRY_URL
  ),
  staffPicks: registryOverrideUrl(
    import.meta.env.VITE_STAFF_PICKS_REGISTRY_URL
  ),
  media: registryOverrideUrl(import.meta.env.VITE_MEDIA_REGISTRY_URL),
  modelCatalog: registryOverrideUrl(import.meta.env.VITE_MODEL_CATALOG_URL),
  modelCatalogIndex: registryOverrideUrl(
    import.meta.env.VITE_MODEL_CATALOG_INDEX_URL
  ),
} as const

export type RegistryName = keyof typeof REGISTRY_OVERRIDES
