/**
 * Model catalog registry -- loader for the curated Radium model catalog and
 * its pre-built MiniSearch index.
 *
 * The catalog ships inside the app as two gzipped assets in `public/`
 * (`seed-catalog.json.gz` and `seed-catalog.idx.json.gz`), produced and
 * reviewed with `scripts/snapshot-registries.mjs`. Nothing is fetched unless
 * the build sets `VITE_MODEL_CATALOG_URL` / `VITE_MODEL_CATALOG_INDEX_URL`
 * (see `lib/registry-source.ts`); then the shape mirrors
 * `provider-registry.ts`: fetch, cache in IndexedDB for one hour, fall back
 * to the bundled snapshot. The cache holds two independent payloads
 * (catalog + index) with separate keys so each can be refreshed without
 * invalidating the other.
 *
 * Failure-safe by construction: `getCatalogOrFallback()` and
 * `getIndexOrFallback()` never throw — UI code can render unconditionally.
 *
 * The catalog payload is a strict JSON envelope (`{ manifest_version: 1,
 * models: CatalogModel[] }`). Every `models[]` entry is a strict superset of
 * the client-side `CatalogModel` type, so the download pipeline works
 * unchanged.
 */

import { fetch as fetchTauri } from '@tauri-apps/plugin-http'
import { BASELINE_MODEL_CATALOG } from '@/constants/models'
import { REGISTRY_OVERRIDES } from '@/lib/registry-source'
import type { CatalogModel } from '@/services/models/types'

/** Build-time override for the catalog, or `null` for the bundled seed only. */
export const CATALOG_URL: string | null = REGISTRY_OVERRIDES.modelCatalog

/** Build-time override for the index, or `null` for the bundled seed only. */
export const CATALOG_INDEX_URL: string | null =
  REGISTRY_OVERRIDES.modelCatalogIndex

/** Highest manifest schema_version this client understands. */
export const SUPPORTED_SCHEMA_VERSION = 1

/** Pre-built index format version this client understands. */
export const SUPPORTED_INDEX_VERSION = 1

/** Cache TTL (1 hour) — same posture as the sibling registries. */
export const CACHE_TTL_MS = 60 * 60 * 1000

const CATALOG_CACHE_KEY = 'atomic_model_catalog_cache_v1'
const CATALOG_CACHE_TS_KEY = 'atomic_model_catalog_cache_ts_v1'
const INDEX_CACHE_KEY = 'atomic_model_catalog_idx_v1'
const INDEX_CACHE_TS_KEY = 'atomic_model_catalog_idx_ts_v1'
const CACHE_DB_NAME = 'atomic_model_catalog_cache'
const CACHE_DB_VERSION = 1
const CACHE_STORE_NAME = 'snapshots'

// 60 s for the catalog (~13 MB raw, ~3-4 MB gzipped) — covers users on
// slow connections (~300 KB/s in the worst case we have measured). 30 s for the index (~2.4 MB raw, ~1 MB gzipped).
const CATALOG_FETCH_TIMEOUT_MS = 60_000
const INDEX_FETCH_TIMEOUT_MS = 30_000

export type CatalogManifest = {
  manifest_version: number
  schema_version: number
  updated_at: string
  orgs?: string[]
  stats?: Record<string, unknown>
  models: CatalogModel[]
}

export type CatalogIndexPayload = {
  index_version: number
  catalog_updated_at?: string
  catalog_total_models?: number
  // The raw `MiniSearch.toJSON()` snapshot. Kept loose-typed here so that
  // bumping minisearch's internal shape never breaks this loader.
  minisearch: unknown
}

/**
 * Where the manifest came from, in priority order:
 *
 *   - `remote`   — fresh GET against the build's override URL.
 *   - `cache`    — IndexedDB snapshot from a previous successful
 *                  remote fetch (TTL: 1 hour).
 *   - `bundled`  — the gzipped catalog snapshot committed in `public/`.
 *                  The only source in a default build.
 *   - `baseline` — the small hard-coded `BASELINE_MODEL_CATALOG`, used
 *                  only if the bundled asset cannot be read.
 */
export type RegistrySource = 'remote' | 'cache' | 'bundled' | 'baseline'

const SEED_CATALOG_PATH = '/seed-catalog.json.gz'
const SEED_INDEX_PATH = '/seed-catalog.idx.json.gz'

/**
 * Best-effort read of the bundled seed catalog. Returns `null` if the
 * asset is missing or unreadable (corrupt gzip, schema mismatch, no
 * DecompressionStream).
 * Never throws.
 */
export const getBundledSeedCatalog = async (): Promise<CatalogManifest | null> => {
  if (typeof window === 'undefined') return null
  if (!hasDecompressionStream()) return null
  try {
    const response = await fetch(SEED_CATALOG_PATH, {
      method: 'GET',
      headers: { Accept: 'application/octet-stream' },
    })
    if (!response.ok) return null
    const buf = await response.arrayBuffer()
    if (buf.byteLength < 1024) return null
    const text = await gunzipToText(buf)
    const parsed = JSON.parse(text) as unknown
    if (!isManifestShape(parsed)) return null
    if (parsed.schema_version > SUPPORTED_SCHEMA_VERSION) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Best-effort read of the bundled MiniSearch index snapshot.
 */
export const getBundledSeedIndex = async (): Promise<CatalogIndexPayload | null> => {
  if (typeof window === 'undefined') return null
  if (!hasDecompressionStream()) return null
  try {
    const response = await fetch(SEED_INDEX_PATH, {
      method: 'GET',
      headers: { Accept: 'application/octet-stream' },
    })
    if (!response.ok) return null
    const buf = await response.arrayBuffer()
    if (buf.byteLength < 256) return null
    const text = await gunzipToText(buf)
    const parsed = JSON.parse(text) as unknown
    if (!isIndexShape(parsed)) return null
    if (parsed.index_version > SUPPORTED_INDEX_VERSION) return null
    return parsed
  } catch {
    return null
  }
}

export type CatalogFetchResult = {
  manifest: CatalogManifest
  source: RegistrySource
  fetchedAt: number | null
  manifestUpdatedAt: string | null
  error?: string
}

export type IndexFetchResult = {
  payload: CatalogIndexPayload | null
  source: RegistrySource
  fetchedAt: number | null
  error?: string
}

const baselineManifest = (): CatalogManifest => ({
  manifest_version: 1,
  schema_version: SUPPORTED_SCHEMA_VERSION,
  updated_at: '1970-01-01T00:00:00Z',
  models: BASELINE_MODEL_CATALOG.slice(),
})

const isManifestShape = (value: unknown): value is CatalogManifest => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.schema_version === 'number' &&
    typeof v.updated_at === 'string' &&
    Array.isArray(v.models)
  )
}

const isIndexShape = (value: unknown): value is CatalogIndexPayload => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.index_version === 'number' &&
    v.minisearch !== undefined &&
    v.minisearch !== null
  )
}

type CachedCatalog = { manifest: CatalogManifest; fetchedAt: number }
type CachedIndex = { payload: CatalogIndexPayload; fetchedAt: number }

type CacheEntry = { value: unknown; fetchedAt: number }

let cacheDbPromise: Promise<IDBDatabase | null> | null = null
let catalogMemoryCache: CachedCatalog | null | undefined
let indexMemoryCache: CachedIndex | null | undefined

const removeLegacyLocalStorageCache = (): void => {
  try {
    if (typeof window === 'undefined') return
    const ls = window.localStorage
    ls.removeItem(CATALOG_CACHE_KEY)
    ls.removeItem(CATALOG_CACHE_TS_KEY)
    ls.removeItem(INDEX_CACHE_KEY)
    ls.removeItem(INDEX_CACHE_TS_KEY)
  } catch {
    // localStorage may be unavailable; IndexedDB remains the primary cache.
  }
}

const openCacheDb = (): Promise<IDBDatabase | null> => {
  if (cacheDbPromise) return cacheDbPromise
  cacheDbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    try {
      const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
          db.createObjectStore(CACHE_STORE_NAME)
        }
      }
      request.onsuccess = () => {
        removeLegacyLocalStorageCache()
        resolve(request.result)
      }
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return cacheDbPromise
}

const readCacheEntry = async (key: string): Promise<CacheEntry | null> => {
  const db = await openCacheDb()
  if (!db) return null
  return await new Promise((resolve) => {
    try {
      const request = db
        .transaction(CACHE_STORE_NAME, 'readonly')
        .objectStore(CACHE_STORE_NAME)
        .get(key)
      request.onsuccess = () => {
        const entry = request.result as CacheEntry | undefined
        resolve(entry && Number.isFinite(entry.fetchedAt) ? entry : null)
      }
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

const writeCacheEntry = async (
  key: string,
  entry: CacheEntry
): Promise<boolean> => {
  const db = await openCacheDb()
  if (!db) return false
  return await new Promise((resolve) => {
    try {
      const transaction = db.transaction(CACHE_STORE_NAME, 'readwrite')
      transaction.objectStore(CACHE_STORE_NAME).put(entry, key)
      transaction.oncomplete = () => resolve(true)
      transaction.onerror = () => resolve(false)
      transaction.onabort = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

export const getCachedCatalog = async (): Promise<CachedCatalog | null> => {
  if (catalogMemoryCache !== undefined) return catalogMemoryCache
  const entry = await readCacheEntry(CATALOG_CACHE_KEY)
  if (!entry || !isManifestShape(entry.value)) {
    catalogMemoryCache = null
    return null
  }
  catalogMemoryCache = {
    manifest: entry.value,
    fetchedAt: entry.fetchedAt,
  }
  return catalogMemoryCache
}

export const getCachedIndex = async (): Promise<CachedIndex | null> => {
  if (indexMemoryCache !== undefined) return indexMemoryCache
  const entry = await readCacheEntry(INDEX_CACHE_KEY)
  if (
    !entry ||
    !isIndexShape(entry.value) ||
    entry.value.index_version > SUPPORTED_INDEX_VERSION
  ) {
    indexMemoryCache = null
    return null
  }
  indexMemoryCache = {
    payload: entry.value,
    fetchedAt: entry.fetchedAt,
  }
  return indexMemoryCache
}

export const isCacheFresh = (cached: { fetchedAt: number } | null): boolean => {
  if (!cached) return false
  return Date.now() - cached.fetchedAt < CACHE_TTL_MS
}

const writeCatalogCache = (
  manifest: CatalogManifest,
  fetchedAt: number
): Promise<void> => {
  catalogMemoryCache = { manifest, fetchedAt }
  return writeCacheEntry(CATALOG_CACHE_KEY, {
    value: manifest,
    fetchedAt,
  }).then((written) => {
    if (!written) {
      console.warn('[model-catalog-registry] Failed to write catalog cache')
    }
  })
}

const writeIndexCache = async (
  payload: CatalogIndexPayload,
  fetchedAt: number
): Promise<void> => {
  indexMemoryCache = { payload, fetchedAt }
  const written = await writeCacheEntry(INDEX_CACHE_KEY, {
    value: payload,
    fetchedAt,
  })
  if (!written) {
    console.warn('[model-catalog-registry] Failed to write index cache')
  }
}

export const clearCatalogCache = async (): Promise<void> => {
  catalogMemoryCache = null
  indexMemoryCache = null
  const db = await openCacheDb()
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const transaction = db.transaction(CACHE_STORE_NAME, 'readwrite')
        transaction.objectStore(CACHE_STORE_NAME).clear()
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => resolve()
        transaction.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
  }

  removeLegacyLocalStorageCache()
}

const isTauriRuntime = (): boolean => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return typeof IS_TAURI !== 'undefined' && Boolean(IS_TAURI as any)
  } catch {
    return false
  }
}

const hasDecompressionStream = (): boolean => {
  return (
    typeof (globalThis as { DecompressionStream?: unknown })
      .DecompressionStream === 'function'
  )
}

const gunzipToText = async (buf: ArrayBuffer): Promise<string> => {
  // `DecompressionStream` is a native browser API available in WKWebView
  // (Safari 16.4+), WebView2 (Chromium 80+) and WebKitGTK 2.42+, i.e. every
  // platform Tauri 2 supports. We pipe the gzipped bytes through it and
  // collect the result as UTF-8 text.
  const Decompressor = (
    globalThis as unknown as {
      DecompressionStream: new (
        format: 'gzip' | 'deflate'
      ) => GenericTransformStream
    }
  ).DecompressionStream
  const stream = new Blob([buf]).stream().pipeThrough(new Decompressor('gzip'))
  return await new Response(stream).text()
}

const fetchJsonRaw = async (
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
      `Catalog fetch failed: ${response.status} ${response.statusText} (${url})`
    )
  }
  return (await response.json()) as unknown
}

const fetchJsonGzip = async (
  fetcher: typeof fetch,
  gzipUrl: string,
  signal?: AbortSignal
): Promise<unknown> => {
  const response = await fetcher(gzipUrl, {
    method: 'GET',
    headers: { Accept: 'application/octet-stream' },
    signal,
  })
  if (!response.ok) {
    throw new Error(
      `Catalog gzip fetch failed: ${response.status} ${response.statusText} (${gzipUrl})`
    )
  }
  const buf = await response.arrayBuffer()
  const text = await gunzipToText(buf)
  return JSON.parse(text) as unknown
}

/**
 * Fetch a JSON artefact, preferring the gzipped variant for ~10x smaller
 * transfer when both exist. Tries `${url}.gz` first; on 404 / network /
 * decompression error falls back to the plain `${url}`.
 *
 * Transport priority (mirrors `recommended-models-registry.ts`):
 *
 *   1. Standard `window.fetch` — works against `raw.githubusercontent.com`
 *      because that host emits permissive CORS headers and serves files
 *      directly with no signed redirect.
 *   2. `@tauri-apps/plugin-http` — fallback for the rare case the
 *      primary path fails (e.g. an enterprise proxy strips CORS or a
 *      future URL flip lands on a redirecting endpoint again). The
 *      plugin uses the native Rust HTTP client and ignores browser
 *      CORS, but in practice it has occasionally hung when used as
 *      the primary transport for large gzipped payloads, so it stays
 *      strictly secondary here.
 */
const fetchJson = async <T>(
  url: string,
  validate: (value: unknown) => value is T,
  signal?: AbortSignal,
  label = 'catalog'
): Promise<T> => {
  const attempt = async (transport: typeof fetch): Promise<unknown> => {
    if (hasDecompressionStream()) {
      const [path, query] = url.split('?', 2)
      const gzipUrl = `${path}.gz${query ? `?${query}` : ''}`
      try {
        return await fetchJsonGzip(transport, gzipUrl, signal)
      } catch (gzipError) {
        console.info(
          `[model-catalog-registry] gzip variant unavailable for ${label}, falling back to plain JSON:`,
          gzipError instanceof Error ? gzipError.message : gzipError
        )
        return await fetchJsonRaw(transport, url, signal)
      }
    }
    return await fetchJsonRaw(transport, url, signal)
  }

  let data: unknown
  try {
    data = await attempt(fetch)
  } catch (primaryError) {
    if (!isTauriRuntime()) throw primaryError
    console.warn(
      `[model-catalog-registry] window.fetch failed for ${label}, retrying via Tauri HTTP plugin:`,
      primaryError instanceof Error ? primaryError.message : primaryError
    )
    data = await attempt(fetchTauri as typeof fetch)
  }
  if (!validate(data)) {
    throw new Error(`Catalog payload at ${url} is not a valid ${label}`)
  }
  return data
}

const withHardTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  reason = `Catalog fetch timed out after ${timeoutMs}ms`
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
  /** Abort the network request after this many ms. */
  timeoutMs?: number
}

/** The bundled seed, or the hard-coded baseline if it cannot be read. */
export const bundledCatalogResult = async (
  error?: string
): Promise<CatalogFetchResult> => {
  const seed = await getBundledSeedCatalog()
  if (seed) {
    return {
      manifest: seed,
      source: 'bundled',
      fetchedAt: null,
      manifestUpdatedAt: seed.updated_at,
      ...(error ? { error } : {}),
    }
  }
  return {
    manifest: baselineManifest(),
    source: 'baseline',
    fetchedAt: null,
    manifestUpdatedAt: null,
    ...(error ? { error } : {}),
  }
}

/** The bundled index, or `null` (the search service then indexes itself). */
export const bundledIndexResult = async (
  error?: string
): Promise<IndexFetchResult> => {
  const seed = await getBundledSeedIndex()
  return {
    payload: seed,
    source: seed ? 'bundled' : 'baseline',
    fetchedAt: null,
    ...(error ? { error } : {}),
  }
}

/**
 * Resolve the catalog manifest.
 *
 * Without a registry URL (the default build) this is the bundled seed, read
 * from the app's own assets. With one, the priority chain is:
 *
 *   1. Fresh cache (when not forcing).
 *   2. Network fetch (writes a new cache entry on success).
 *   3. Stale cache (used after a network failure).
 *   4. The bundled seed, then the hard-coded baseline.
 *
 * Always returns a result — never throws.
 */
export const getCatalogOrFallback = async (
  options: FetchOptions = {}
): Promise<CatalogFetchResult> => {
  const {
    force = false,
    url = CATALOG_URL,
    timeoutMs = CATALOG_FETCH_TIMEOUT_MS,
  } = options

  if (!url) return bundledCatalogResult()

  const cached = await getCachedCatalog()
  if (!force && isCacheFresh(cached) && cached) {
    return {
      manifest: cached.manifest,
      source: 'cache',
      fetchedAt: cached.fetchedAt,
      manifestUpdatedAt: cached.manifest.updated_at,
    }
  }

  const controller = new AbortController()
  const fetchUrl = force
    ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`
    : url
  try {
    console.info(
      `[model-catalog-registry] Fetching catalog ${fetchUrl} (timeout ${timeoutMs}ms)`
    )
    const manifest = await withHardTimeout(
      fetchJson<CatalogManifest>(
        fetchUrl,
        isManifestShape,
        controller.signal,
        'catalog'
      ),
      timeoutMs
    )
    if (manifest.schema_version > SUPPORTED_SCHEMA_VERSION) {
      throw new Error(
        `Catalog schema_version ${manifest.schema_version} is newer than supported ` +
          `(${SUPPORTED_SCHEMA_VERSION}). Update Radium to read it.`
      )
    }
    const fetchedAt = Date.now()
    await writeCatalogCache(manifest, fetchedAt)
    console.info(
      `[model-catalog-registry] Loaded ${manifest.models.length} models ` +
        `(schema_version=${manifest.schema_version}, updated_at=${manifest.updated_at})`
    )
    return {
      manifest,
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
      error instanceof Error ? error.message : 'Unknown catalog error'
    console.warn('[model-catalog-registry] Falling back:', message)
    if (cached) {
      return {
        manifest: cached.manifest,
        source: 'cache',
        fetchedAt: cached.fetchedAt,
        manifestUpdatedAt: cached.manifest.updated_at,
        error: message,
      }
    }
    return bundledCatalogResult(message)
  }
}

/**
 * Resolve the pre-built MiniSearch index payload. Same shape as the
 * catalog: bundled only without a URL; otherwise fresh cache → network →
 * stale cache → bundled seed → null (the search service falls back to
 * indexing on the fly).
 */
export const getIndexOrFallback = async (
  options: FetchOptions = {}
): Promise<IndexFetchResult> => {
  const {
    force = false,
    url = CATALOG_INDEX_URL,
    timeoutMs = INDEX_FETCH_TIMEOUT_MS,
  } = options

  if (!url) return bundledIndexResult()

  const cached = await getCachedIndex()
  if (!force && isCacheFresh(cached) && cached) {
    return {
      payload: cached.payload,
      source: 'cache',
      fetchedAt: cached.fetchedAt,
    }
  }

  const controller = new AbortController()
  const fetchUrl = force
    ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`
    : url
  try {
    console.info(
      `[model-catalog-registry] Fetching index ${fetchUrl} (timeout ${timeoutMs}ms)`
    )
    const payload = await withHardTimeout(
      fetchJson<CatalogIndexPayload>(
        fetchUrl,
        isIndexShape,
        controller.signal,
        'index'
      ),
      timeoutMs
    )
    if (payload.index_version > SUPPORTED_INDEX_VERSION) {
      throw new Error(
        `Index version ${payload.index_version} is newer than supported ` +
          `(${SUPPORTED_INDEX_VERSION}). Falling back to on-the-fly indexing.`
      )
    }
    const fetchedAt = Date.now()
    await writeIndexCache(payload, fetchedAt)
    return { payload, source: 'remote', fetchedAt }
  } catch (error) {
    try {
      controller.abort()
    } catch {
      // ignore
    }
    const message =
      error instanceof Error ? error.message : 'Unknown index error'
    console.warn(
      '[model-catalog-registry] Index fetch failed, will rebuild client-side if needed:',
      message
    )
    if (cached) {
      return {
        payload: cached.payload,
        source: 'cache',
        fetchedAt: cached.fetchedAt,
        error: message,
      }
    }
    return bundledIndexResult(message)
  }
}
