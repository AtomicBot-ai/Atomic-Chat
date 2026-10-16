/**
 * Recommended-models registry — the Hub and onboarding recommendation list.
 *
 * The manifest ships inside the app (`src/registries/recommended-models.json`).
 * Nothing is fetched unless the build sets
 * `VITE_RECOMMENDED_MODELS_REGISTRY_URL` (see `lib/registry-source.ts`); then
 * that URL is tried first, cached for an hour, and the bundled snapshot remains
 * the fallback when it is unreachable, too new, or malformed. Tiers the
 * manifest does not name fall back to {@link RECOMMENDATION_LADDER}.
 *
 * Mirrors the architecture of `provider-registry.ts` and is intentionally
 * isolated from it (separate cache keys, separate URL, separate schema).
 */

import { fetch as fetchTauri } from '@tauri-apps/plugin-http'
import { isHardwareTier, type HardwareTier } from '@/lib/hardware-tier'
import { BASELINE_TIER_RECOMMENDATIONS } from '@/constants/models'
import { REGISTRY_OVERRIDES } from '@/lib/registry-source'
import bundledRegistry from '@/registries/recommended-models.json'

export type RecommendationPlatform = 'macos' | 'windows' | 'linux'

export type Recommendation = {
  model_name: string
  description_key: string
  platforms?: RecommendationPlatform[]
  active?: boolean
  /**
   * Pins which quant to download, matched against the quant token parsed out of
   * the GGUF filename (see `quantLabel`). Omitted = the client picks its house
   * default. Only meaningful for entries the client is expected to download
   * unattended, i.e. the onboarding recommendations.
   */
  quant?: string
  /** Vision models only: pins the multimodal projector quant. */
  mmproj_quant?: string
}

/** The build-time override, or `null` for the bundled snapshot only. */
export const REGISTRY_URL: string | null = REGISTRY_OVERRIDES.recommendedModels

/** Highest manifest schema_version this client understands. */
export const SUPPORTED_SCHEMA_VERSION = 1

/** Cache TTL (1 hour) — matches provider registry. */
export const CACHE_TTL_MS = 60 * 60 * 1000

const CACHE_KEY = 'jan_recommended_models_cache_v1'
const CACHE_TS_KEY = 'jan_recommended_models_cache_ts_v1'

const FETCH_TIMEOUT_MS = 5000

const ALLOWED_PLATFORMS: ReadonlySet<RecommendationPlatform> = new Set([
  'macos',
  'windows',
  'linux',
])

export type RegistryManifest = {
  schema_version: number
  updated_at: string
  recommendations: Recommendation[]
  /**
   * REPLACES `recommendations` on machines classified as low-spec — it does not
   * extend them.
   *
   * Superseded by {@link RegistryManifest.tiers}, which covers the same ground
   * with eleven rungs instead of two. Still parsed and still written to the
   * manifest, because clients shipped before `tiers` existed read it and
   * nothing else; this client ignores it.
   */
  low_spec_recommendations?: Recommendation[]
  /**
   * The one model to offer, per hardware tier — the ladder from ATO-463.
   *
   * Deliberately a sibling key rather than a `schema_version` bump: `fetchManifest`
   * rebuilds the manifest from a fixed key whitelist, so a client built before
   * this key existed simply ignores it and keeps reading `recommendations` /
   * `low_spec_recommendations` unchanged. Bumping the version instead would make
   * every shipped client reject the whole manifest and fall back to its bundled
   * baseline — the opposite of a config change that ships without a release.
   *
   * Unknown tier keys are dropped on parse: the tier vocabulary is a
   * release-time contract (see `HardwareTier`), the contents are not. A tier
   * the manifest omits falls back to {@link BASELINE_TIER_RECOMMENDATIONS}, so
   * a partial `tiers` object is valid and useful.
   */
  tiers?: Partial<Record<HardwareTier, Recommendation[]>>
}

export type RegistrySource = 'remote' | 'cache' | 'bundled'

export type RegistryFetchResult = {
  recommendations: Recommendation[]
  /** Per-tier lists the manifest carried. Missing tiers fall back to the
   *  bundled ladder at selection time, so this may be partial or empty. */
  tiers: Partial<Record<HardwareTier, Recommendation[]>>
  source: RegistrySource
  fetchedAt: number | null
  manifestUpdatedAt: string | null
  error?: string
}

/**
 * Strip unknown fields and coerce `platforms` to a clean tuple of allowed
 * values. Keeps the in-memory shape small and protects against malformed
 * upstream entries.
 */
/**
 * Quant pins are used to *select a file to download*, so a malformed or hostile
 * manifest must not be able to smuggle a token that matches an unintended file.
 * Restrict hard to the shape real quant labels take (`Q8_0`, `Q4_K_M`, `BF16`).
 */
const QUANT_TOKEN = /^[A-Za-z0-9_]{2,16}$/

const sanitizeQuantToken = (value: unknown): string | undefined =>
  typeof value === 'string' && QUANT_TOKEN.test(value)
    ? value.toUpperCase()
    : undefined

const sanitizeRecommendation = (raw: unknown): Recommendation | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.model_name !== 'string' || r.model_name.length === 0) return null
  if (
    typeof r.description_key !== 'string' ||
    !r.description_key.startsWith('hub:')
  ) {
    return null
  }
  const platforms = Array.isArray(r.platforms)
    ? (r.platforms.filter(
        (p): p is RecommendationPlatform =>
          typeof p === 'string' &&
          ALLOWED_PLATFORMS.has(p as RecommendationPlatform)
      ) as RecommendationPlatform[])
    : undefined
  const active = typeof r.active === 'boolean' ? r.active : undefined
  const quant = sanitizeQuantToken(r.quant)
  const mmprojQuant = sanitizeQuantToken(r.mmproj_quant)
  return {
    model_name: r.model_name,
    description_key: r.description_key,
    ...(platforms && platforms.length > 0 ? { platforms } : {}),
    ...(active === false ? { active: false } : {}),
    ...(quant ? { quant } : {}),
    ...(mmprojQuant ? { mmproj_quant: mmprojQuant } : {}),
  }
}

/**
 * Keep only keys that name a tier this build knows about, and only entries that
 * survive {@link sanitizeRecommendation}. An unrecognised key means the manifest
 * was written for a newer tier vocabulary; dropping it leaves that machine on
 * the bundled ladder, which is a working recommendation rather than none.
 */
const sanitizeTiers = (
  raw: unknown
): Partial<Record<HardwareTier, Recommendation[]>> => {
  if (typeof raw !== 'object' || raw === null) return {}
  const out: Partial<Record<HardwareTier, Recommendation[]>> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isHardwareTier(key) || !Array.isArray(value)) continue
    const entries = value
      .map(sanitizeRecommendation)
      .filter((r): r is Recommendation => r !== null)
    if (entries.length > 0) out[key] = entries
  }
  return out
}

const isManifestShape = (value: unknown): value is RegistryManifest => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.schema_version === 'number' &&
    typeof v.updated_at === 'string' &&
    Array.isArray(v.recommendations)
  )
}

const safeLocalStorage = (): Storage | null => {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    return null
  }
}

export type CachedManifest = {
  manifest: RegistryManifest
  fetchedAt: number
}

export const getCachedManifest = (): CachedManifest | null => {
  const ls = safeLocalStorage()
  if (!ls) return null
  try {
    const raw = ls.getItem(CACHE_KEY)
    const tsRaw = ls.getItem(CACHE_TS_KEY)
    if (!raw || !tsRaw) return null
    const fetchedAt = Number(tsRaw)
    if (!Number.isFinite(fetchedAt)) return null
    const parsed = JSON.parse(raw) as unknown
    if (!isManifestShape(parsed)) return null
    return { manifest: parsed, fetchedAt }
  } catch {
    return null
  }
}

export const isCacheFresh = (cached: CachedManifest | null): boolean => {
  if (!cached) return false
  return Date.now() - cached.fetchedAt < CACHE_TTL_MS
}

const writeCache = (manifest: RegistryManifest, fetchedAt: number): void => {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.setItem(CACHE_KEY, JSON.stringify(manifest))
    ls.setItem(CACHE_TS_KEY, String(fetchedAt))
  } catch (error) {
    console.warn('[recommended-models-registry] Failed to write cache:', error)
  }
}

export const clearRegistryCache = (): void => {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.removeItem(CACHE_KEY)
    ls.removeItem(CACHE_TS_KEY)
  } catch (error) {
    console.warn('[recommended-models-registry] Failed to clear cache:', error)
  }
}

const isTauriRuntime = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return typeof IS_TAURI !== 'undefined' && Boolean(IS_TAURI as any)
  } catch {
    return false
  }
}

const fetchOnce = async (
  fetcher: typeof fetch,
  url: string,
  signal?: AbortSignal
): Promise<unknown> => {
  const response = await fetcher(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!response.ok) {
    throw new Error(
      `Recommended-models fetch failed: ${response.status} ${response.statusText}`
    )
  }
  return (await response.json()) as unknown
}

const fetchManifest = async (
  url: string,
  signal?: AbortSignal
): Promise<RegistryManifest> => {
  let data: unknown
  try {
    data = await fetchOnce(fetch, url, signal)
  } catch (primaryError) {
    if (!isTauriRuntime()) throw primaryError
    console.warn(
      '[recommended-models-registry] standard fetch failed, retrying via Tauri HTTP plugin:',
      primaryError instanceof Error ? primaryError.message : primaryError
    )
    data = await fetchOnce(fetchTauri as typeof fetch, url, signal)
  }

  return parseManifest(data)
}

/**
 * Validate and sanitize a manifest, from the network or the bundle alike, so
 * both pass through exactly the same checks.
 */
export const parseManifest = (data: unknown): RegistryManifest => {
  if (!isManifestShape(data)) {
    throw new Error('Recommended-models payload is not a valid manifest')
  }
  if (data.schema_version > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `Recommended-models schema_version ${data.schema_version} is newer than ` +
        `supported (${SUPPORTED_SCHEMA_VERSION}). Update the application to read it.`
    )
  }

  const recommendations = data.recommendations
    .map(sanitizeRecommendation)
    .filter((r): r is Recommendation => r !== null)

  const tiers = sanitizeTiers(data.tiers)

  // Only carried when non-empty so `writeCache` never persists an empty object
  // that would be indistinguishable from "this manifest has no tier lists".
  return {
    schema_version: data.schema_version,
    updated_at: data.updated_at,
    recommendations,
    ...(Object.keys(tiers).length > 0 ? { tiers } : {}),
  }
}

/** The snapshot shipped with this build. Parsed once; never fetched. */
export const BUNDLED_MANIFEST: RegistryManifest = parseManifest(bundledRegistry)

/** The bundled snapshot as a fetch result. */
export const bundledResult = (error?: string): RegistryFetchResult => ({
  recommendations: BUNDLED_MANIFEST.recommendations.slice(),
  tiers: { ...(BUNDLED_MANIFEST.tiers ?? {}) },
  source: 'bundled',
  fetchedAt: null,
  manifestUpdatedAt: BUNDLED_MANIFEST.updated_at,
  ...(error ? { error } : {}),
})

/**
 * Hard timeout wrapper. Tauri's HTTP plugin does not always honour
 * `AbortSignal`, so we race against a timer to guarantee resolution.
 */
const withHardTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  reason = `Recommended-models fetch timed out after ${timeoutMs}ms`
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reason)), timeoutMs)
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })

export type FetchOptions = {
  /** Bypass cache freshness check and force a network round-trip. */
  force?: boolean
  /** Registry URL; defaults to the build-time override. `null` = bundled only. */
  url?: string | null
  /** Abort the network request after this many ms. Default: 5000. */
  timeoutMs?: number
}

/**
 * Resolve the effective list of recommendations.
 *
 * Without a registry URL (the default build) this is the bundled snapshot,
 * immediately, with no I/O. With one, the priority chain is:
 *
 *   1. Fresh cache (when not forcing).
 *   2. Network fetch (writes a new cache entry on success).
 *   3. Stale cache (used after a network failure).
 *   4. The bundled snapshot.
 *
 * Always returns a result — never throws — so UI code can render unconditionally.
 */
export const getRecommendationsOrFallback = async (
  options: FetchOptions = {}
): Promise<RegistryFetchResult> => {
  const {
    force = false,
    url = REGISTRY_URL,
    timeoutMs = FETCH_TIMEOUT_MS,
  } = options

  if (!url) return bundledResult()

  const cached = getCachedManifest()
  if (!force && isCacheFresh(cached) && cached) {
    return {
      recommendations: cached.manifest.recommendations.slice(),
      tiers: { ...(cached.manifest.tiers ?? {}) },
      source: 'cache',
      fetchedAt: cached.fetchedAt,
      manifestUpdatedAt: cached.manifest.updated_at,
    }
  }

  const controller = new AbortController()
  // Cache-bust CDN and proxy caches when the caller is explicitly forcing a
  // fetch (e.g. a manual Refresh button).
  const fetchUrl = force
    ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`
    : url
  try {
    console.info(
      `[recommended-models-registry] Fetching ${fetchUrl} (timeout ${timeoutMs}ms)`
    )
    const manifest = await withHardTimeout(
      fetchManifest(fetchUrl, controller.signal),
      timeoutMs
    )
    const fetchedAt = Date.now()
    writeCache(manifest, fetchedAt)
    console.info(
      `[recommended-models-registry] Loaded ${manifest.recommendations.length} recommendations (schema_version=${manifest.schema_version}, updated_at=${manifest.updated_at})`
    )
    return {
      recommendations: manifest.recommendations.slice(),
      tiers: { ...(manifest.tiers ?? {}) },
      source: 'remote',
      fetchedAt,
      manifestUpdatedAt: manifest.updated_at,
    }
  } catch (error) {
    try {
      controller.abort()
    } catch {
      // ignore
    }
    const message =
      error instanceof Error
        ? error.message
        : 'Unknown recommended-models registry error'
    console.warn('[recommended-models-registry] Falling back:', message)
    if (cached) {
      return {
        recommendations: cached.manifest.recommendations.slice(),
        tiers: { ...(cached.manifest.tiers ?? {}) },
        source: 'cache',
        fetchedAt: cached.fetchedAt,
        manifestUpdatedAt: cached.manifest.updated_at,
        error: message,
      }
    }
    return bundledResult(message)
  }
}

/**
 * Pure helper used by both the store selector and tests.
 *
 * `os` is the host operating system. An entry is visible when it is not
 * explicitly disabled and either has no `platforms` field (universal) or
 * lists the current OS.
 */
export const filterRecommendationsForPlatform = (
  recommendations: ReadonlyArray<Recommendation>,
  os: RecommendationPlatform
): Recommendation[] =>
  recommendations.filter(
    (r) => r.active !== false && (!r.platforms || r.platforms.includes(os))
  )

/**
 * The recommendations for one tier, primary first.
 *
 * The manifest wins when it names this tier, so the offer can be changed
 * without a release; otherwise the bundled ladder does, which is a real
 * recommendation rather than an empty picker. A manifest that carries `tiers`
 * but omits *this* tier falls back per-tier, not wholesale — a partial `tiers`
 * object is a legitimate way to override one rung.
 */
export const selectTierRecommendations = (
  tiers: Partial<Record<HardwareTier, Recommendation[]>> | undefined,
  tier: HardwareTier
): Recommendation[] => {
  const fromManifest = tiers?.[tier]
  return (
    fromManifest && fromManifest.length > 0
      ? fromManifest
      : BASELINE_TIER_RECOMMENDATIONS[tier]
  ).slice()
}
