/**
 * Provider Registry — the cloud-provider catalog.
 *
 * The catalog ships inside the app (`src/registries/providers.json`), merged
 * with the hand-written {@link BASELINE_PROVIDERS}. Nothing is fetched unless
 * the build sets `VITE_PROVIDER_REGISTRY_URL` (see `lib/registry-source.ts`);
 * then that URL is tried first, cached for an hour, and the bundled snapshot
 * remains the fallback when it is unreachable, too new, or malformed.
 *
 * API keys are never read from the registry — the `api_key` field is always
 * coerced to "" on load, bundled or remote.
 *
 * Designed to be importable from both React components (via the Zustand store
 * in `@/stores/provider-registry-store`) and non-React code (e.g. the Tauri
 * providers service).
 */

import { fetch as fetchTauri } from '@tauri-apps/plugin-http'
import { BASELINE_PROVIDERS } from '@/constants/providers'
import { REGISTRY_OVERRIDES } from '@/lib/registry-source'
import bundledRegistry from '@/registries/providers.json'

/**
 * The build-time override, or `null` for the bundled snapshot only.
 *
 * When set, the standard `fetch` is tried first and `fetchTauri` second: a
 * CORS-enabled static host resolves fastest through the WebView, and the Rust
 * client gets through proxies that intercept WebView traffic.
 */
export const REGISTRY_URL: string | null = REGISTRY_OVERRIDES.providers

/** Highest registry schema_version this client understands. */
export const SUPPORTED_SCHEMA_VERSION = 1

/** Cache TTL (1 hour). */
export const CACHE_TTL_MS = 60 * 60 * 1000

const CACHE_KEY = 'jan_provider_registry_cache_v1'
const CACHE_TS_KEY = 'jan_provider_registry_cache_ts_v1'

const FETCH_TIMEOUT_MS = 5000

export type RegistryManifest = {
  schema_version: number
  updated_at: string
  providers: ModelProvider[]
}

export type RegistrySource = 'remote' | 'cache' | 'bundled'

export type RegistryFetchResult = {
  providers: ModelProvider[]
  source: RegistrySource
  fetchedAt: number | null
  manifestUpdatedAt: string | null
  error?: string
}

/**
 * Strip fields the registry MUST NOT influence (notably API keys).
 * Even if a malicious commit slips a non-empty value in, it is wiped here.
 */
const sanitizeProvider = (p: ModelProvider): ModelProvider => ({
  ...p,
  api_key: '',
})

const isManifest = (value: unknown): value is RegistryManifest => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.schema_version === 'number' &&
    typeof v.updated_at === 'string' &&
    Array.isArray(v.providers)
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
    if (!isManifest(parsed)) return null
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
    console.warn('[provider-registry] Failed to write cache:', error)
  }
}

export const clearRegistryCache = (): void => {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.removeItem(CACHE_KEY)
    ls.removeItem(CACHE_TS_KEY)
  } catch (error) {
    console.warn('[provider-registry] Failed to clear cache:', error)
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
      `Registry fetch failed: ${response.status} ${response.statusText}`
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
    // Primary path: standard fetch. GitHub raw is CORS-enabled and the
    // browser/WebView resolves it reliably across macOS, Windows, and Linux.
    data = await fetchOnce(fetch, url, signal)
  } catch (primaryError) {
    if (!isTauriRuntime()) throw primaryError
    console.warn(
      '[provider-registry] standard fetch failed, retrying via Tauri HTTP plugin:',
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
  if (!isManifest(data)) {
    throw new Error('Registry payload is not a valid manifest')
  }
  if (data.schema_version > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `Registry schema_version ${data.schema_version} is newer than supported ` +
        `(${SUPPORTED_SCHEMA_VERSION}). Update the application to read it.`
    )
  }
  return {
    schema_version: data.schema_version,
    updated_at: data.updated_at,
    providers: data.providers.map(sanitizeProvider),
  }
}

/** The snapshot shipped with this build. Parsed once; never fetched. */
export const BUNDLED_MANIFEST: RegistryManifest = parseManifest(bundledRegistry)

/** The bundled snapshot as a fetch result, merged with the baseline. */
export const bundledResult = (error?: string): RegistryFetchResult => ({
  providers: mergeWithBaseline(BUNDLED_MANIFEST.providers),
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
  reason = `Registry fetch timed out after ${timeoutMs}ms`
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

export const mergeWithBaseline = (
  remote: ModelProvider[]
): ModelProvider[] => {
  const remoteIds = new Set(remote.map((p) => p.provider))
  const baselineExtras = BASELINE_PROVIDERS.filter(
    (p) => !remoteIds.has(p.provider)
  )
  return [...remote, ...baselineExtras]
}

export type FetchOptions = {
  /** Bypass cache freshness check and force a network round-trip. */
  force?: boolean
  /** Registry URL; defaults to the build-time override. `null` = bundled only. */
  url?: string | null
  /** Abort the network request after this many ms. Default: 5000. */
  timeoutMs?: number
}

/**
 * Resolve the effective list of providers.
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
export const getProvidersOrFallback = async (
  options: FetchOptions = {}
): Promise<RegistryFetchResult> => {
  const { force = false, url = REGISTRY_URL, timeoutMs = FETCH_TIMEOUT_MS } =
    options

  if (!url) return bundledResult()

  const cached = getCachedManifest()
  if (!force && isCacheFresh(cached) && cached) {
    return {
      providers: mergeWithBaseline(cached.manifest.providers),
      source: 'cache',
      fetchedAt: cached.fetchedAt,
      manifestUpdatedAt: cached.manifest.updated_at,
    }
  }

  const controller = new AbortController()
  // When the caller is explicitly forcing a fetch (e.g. the manual Refresh
  // button), append a cache-busting timestamp to bypass CDN, proxy and
  // browser caches that can hold the previous payload for a few minutes.
  const fetchUrl = force
    ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`
    : url
  try {
    console.info(
      `[provider-registry] Fetching ${fetchUrl} (timeout ${timeoutMs}ms)`
    )
    const manifest = await withHardTimeout(
      fetchManifest(fetchUrl, controller.signal),
      timeoutMs
    )
    const fetchedAt = Date.now()
    writeCache(manifest, fetchedAt)
    console.info(
      `[provider-registry] Loaded ${manifest.providers.length} providers (schema_version=${manifest.schema_version}, updated_at=${manifest.updated_at})`
    )
    return {
      providers: mergeWithBaseline(manifest.providers),
      source: 'remote',
      fetchedAt,
      manifestUpdatedAt: manifest.updated_at,
    }
  } catch (error) {
    // Best-effort cancel of the underlying request when the timeout wins
    // (Tauri's plugin may ignore the signal but standard fetch honours it).
    try {
      controller.abort()
    } catch {
      // ignore
    }
    const message =
      error instanceof Error ? error.message : 'Unknown registry error'
    console.warn('[provider-registry] Falling back:', message)
    if (cached) {
      return {
        providers: mergeWithBaseline(cached.manifest.providers),
        source: 'cache',
        fetchedAt: cached.fetchedAt,
        manifestUpdatedAt: cached.manifest.updated_at,
        error: message,
      }
    }
    return bundledResult(message)
  }
}
