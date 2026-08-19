/**
 * Recommended-models registry — remote configuration loader.
 *
 * Fetches the recommended-models manifest from a public git-hosted JSON file
 * at runtime so that adding/updating recommendations does not require an app
 * release.
 *
 * Failure-safe: when the network is unreachable, the schema_version is too
 * high, or the payload is malformed, callers fall back to a locally bundled
 * baseline ({@link BASELINE_RECOMMENDED_MODELS}).
 *
 * Mirrors the architecture of `provider-registry.ts` and is intentionally
 * isolated from it (separate cache keys, separate URL, separate schema).
 */

import { fetch as fetchTauri } from '@tauri-apps/plugin-http'
import type { HardwareTier } from '@/lib/hardware-tier'
import {
  BASELINE_LOW_SPEC_RECOMMENDED_MODELS,
  BASELINE_RECOMMENDED_MODELS,
} from '@/constants/models'

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

export const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/recommended.json'

export const REGISTRY_URL: string =
  (import.meta.env.VITE_RECOMMENDED_MODELS_REGISTRY_URL as string | undefined) ??
  DEFAULT_REGISTRY_URL

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
   * extend them. Deliberately a sibling array rather than a per-entry `tier`
   * field: `fetchManifest` rebuilds the manifest from a fixed key whitelist, so
   * a client built before this key existed ignores it and keeps showing
   * `recommendations` unchanged. A per-entry field would instead be stripped by
   * `sanitizeRecommendation`, leaving old clients showing *both* lists — the
   * exact opposite of the intent, and silently. Do NOT bump `schema_version`
   * for this key; that would strand shipped clients on their bundled baseline.
   */
  low_spec_recommendations?: Recommendation[]
}

export type RegistrySource = 'remote' | 'cache' | 'baseline'

export type RegistryFetchResult = {
  recommendations: Recommendation[]
  /** Always an array; empty when the manifest carries no low-spec list. */
  lowSpecRecommendations: Recommendation[]
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
  if (typeof r.description_key !== 'string' || !r.description_key.startsWith('hub:')) {
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

  const lowSpec = Array.isArray(data.low_spec_recommendations)
    ? data.low_spec_recommendations
        .map(sanitizeRecommendation)
        .filter((r): r is Recommendation => r !== null)
    : []

  // Only carried when non-empty so `writeCache` never persists an empty array
  // that would be indistinguishable from "this manifest has no low-spec list".
  return {
    schema_version: data.schema_version,
    updated_at: data.updated_at,
    recommendations,
    ...(lowSpec.length > 0 ? { low_spec_recommendations: lowSpec } : {}),
  }
}

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
  /** Override URL (for tests). */
  url?: string
  /** Abort the network request after this many ms. Default: 5000. */
  timeoutMs?: number
}

/**
 * Resolve the effective list of recommendations using the priority chain:
 *
 *   1. Fresh cache (when not forcing).
 *   2. Network fetch (writes a new cache entry on success).
 *   3. Stale cache (used after a network failure).
 *   4. Baseline fallback bundled in the app.
 *
 * Always returns a result — never throws — so UI code can render unconditionally.
 */
export const getRecommendationsOrFallback = async (
  options: FetchOptions = {}
): Promise<RegistryFetchResult> => {
  const { force = false, url = REGISTRY_URL, timeoutMs = FETCH_TIMEOUT_MS } =
    options

  const cached = getCachedManifest()
  if (!force && isCacheFresh(cached) && cached) {
    return {
      recommendations: cached.manifest.recommendations.slice(),
      lowSpecRecommendations: (
        cached.manifest.low_spec_recommendations ?? []
      ).slice(),
      source: 'cache',
      fetchedAt: cached.fetchedAt,
      manifestUpdatedAt: cached.manifest.updated_at,
    }
  }

  const controller = new AbortController()
  // Cache-bust the GitHub raw CDN when the caller is explicitly forcing a
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
      lowSpecRecommendations: (
        manifest.low_spec_recommendations ?? []
      ).slice(),
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
        lowSpecRecommendations: (
          cached.manifest.low_spec_recommendations ?? []
        ).slice(),
        source: 'cache',
        fetchedAt: cached.fetchedAt,
        manifestUpdatedAt: cached.manifest.updated_at,
        error: message,
      }
    }
    return {
      recommendations: BASELINE_RECOMMENDED_MODELS.slice(),
      lowSpecRecommendations: BASELINE_LOW_SPEC_RECOMMENDED_MODELS.slice(),
      source: 'baseline',
      fetchedAt: null,
      manifestUpdatedAt: null,
      error: message,
    }
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
 * Which list onboarding should show. The low-spec list REPLACES the standard
 * one rather than extending it — a machine that cannot run the standard pair is
 * not helped by being offered them alongside smaller ones.
 *
 * The `lowSpec.length > 0` guard is load-bearing: a cache entry written before
 * the manifest gained its low-spec list carries none, and a low-spec machine
 * must fall back to the standard pair rather than an empty picker.
 */
export const selectRecommendationsForTier = (
  standard: ReadonlyArray<Recommendation>,
  lowSpec: ReadonlyArray<Recommendation>,
  tier: HardwareTier
): Recommendation[] =>
  tier === 'low' && lowSpec.length > 0 ? lowSpec.slice() : standard.slice()
