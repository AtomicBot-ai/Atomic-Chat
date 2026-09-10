/**
 * Staff-picks registry — remote configuration loader.
 *
 * Fetches the curated Staff Picks manifest that the Hub shows by default
 * (before the user types a search query) from a public git-hosted JSON file,
 * so rotating the curated list does not require an app release.
 *
 * Deliberately a separate manifest from `recommended-models-registry.ts`:
 * shipped production clients reject a manifest whose `schema_version` exceeds
 * the one they were built against, so `models/recommended.json` is frozen at
 * version 1 with its original entry shape and keeps serving onboarding.
 * Staff picks get their own file, schema, cache keys and version dial.
 *
 * Failure-safe: when the network is unreachable, the schema_version is too
 * high, or the payload is malformed, callers fall back to a locally bundled
 * baseline ({@link BASELINE_STAFF_PICKS}).
 */

import { fetch as fetchTauri } from '@tauri-apps/plugin-http'
import { BASELINE_STAFF_PICKS } from '@/constants/staff-picks'

export type StaffPickPlatform = 'macos' | 'windows' | 'linux'

/**
 * `vision`, `audio`, `reasoning` and `tools` double as the authoritative source
 * of the Hub capability badges for a pick (see `deriveCapabilities`); the rest
 * are descriptive only. Adding a member is a backwards-compatible change:
 * older clients drop what they do not know in {@link sanitizePick}, so the
 * manifest stays on `schema_version` 1.
 */
export type StaffPickCategory =
  | 'general'
  | 'reasoning'
  | 'coding'
  | 'vision'
  | 'audio'
  | 'tools'
  | 'compact'
  | 'multilingual'

export type StaffPickFormat = 'gguf' | 'mlx'

export type StaffPick = {
  model_name: string
  title?: string
  summary?: string
  description_key?: string
  icon?: string
  /**
   * Declared build format. Lets the Hub decide which picks belong on screen
   * before any of them is resolved, so an MLX entry costs no catalog lookup
   * and no Hugging Face round-trip while the GGUF list is showing. Absent
   * means GGUF.
   */
  format?: StaffPickFormat
  categories?: StaffPickCategory[]
  platforms?: StaffPickPlatform[]
  order?: number
  active?: boolean
}

export const DEFAULT_STAFF_PICKS_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/staff-picks.json'

export const STAFF_PICKS_URL: string =
  (import.meta.env.VITE_STAFF_PICKS_REGISTRY_URL as string | undefined) ??
  DEFAULT_STAFF_PICKS_URL

/** Highest manifest schema_version this client understands. */
export const SUPPORTED_SCHEMA_VERSION = 1

/** Cache TTL (1 hour) — matches the sibling registries. */
export const CACHE_TTL_MS = 60 * 60 * 1000

//! Intentionally distinct from `jan_recommended_models_cache_v1`. Sharing a
//! key would let a staff-picks payload poison the manifest that onboarding
//! (and every shipped production client) reads.
const CACHE_KEY = 'atomic_staff_picks_cache_v1'
const CACHE_TS_KEY = 'atomic_staff_picks_cache_ts_v1'

const FETCH_TIMEOUT_MS = 5000

const ALLOWED_PLATFORMS: ReadonlySet<StaffPickPlatform> = new Set([
  'macos',
  'windows',
  'linux',
])

const ALLOWED_CATEGORIES: ReadonlySet<StaffPickCategory> = new Set([
  'general',
  'reasoning',
  'coding',
  'vision',
  'audio',
  'tools',
  'compact',
  'multilingual',
])

export type StaffPicksManifest = {
  schema_version: number
  updated_at: string
  picks: StaffPick[]
}

export type StaffPicksSource = 'remote' | 'cache' | 'baseline'

export type StaffPicksFetchResult = {
  picks: StaffPick[]
  source: StaffPicksSource
  fetchedAt: number | null
  manifestUpdatedAt: string | null
  error?: string
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

/**
 * Strip unknown fields and coerce enum-ish arrays to clean tuples. Keeps the
 * in-memory shape small and protects against malformed upstream entries.
 */
export const sanitizePick = (raw: unknown): StaffPick | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.model_name !== 'string' || r.model_name.length === 0) return null

  const descriptionKey =
    typeof r.description_key === 'string' &&
    r.description_key.startsWith('hub:')
      ? r.description_key
      : undefined

  const platforms = Array.isArray(r.platforms)
    ? (r.platforms.filter(
        (p): p is StaffPickPlatform =>
          typeof p === 'string' &&
          ALLOWED_PLATFORMS.has(p as StaffPickPlatform)
      ) as StaffPickPlatform[])
    : undefined

  const categories = Array.isArray(r.categories)
    ? (r.categories.filter(
        (c): c is StaffPickCategory =>
          typeof c === 'string' &&
          ALLOWED_CATEGORIES.has(c as StaffPickCategory)
      ) as StaffPickCategory[])
    : undefined

  const format =
    r.format === 'gguf' || r.format === 'mlx'
      ? (r.format as StaffPickFormat)
      : undefined

  return {
    model_name: r.model_name,
    ...(optionalString(r.title) ? { title: r.title as string } : {}),
    ...(optionalString(r.summary) ? { summary: r.summary as string } : {}),
    ...(descriptionKey ? { description_key: descriptionKey } : {}),
    ...(optionalString(r.icon) ? { icon: r.icon as string } : {}),
    ...(format ? { format } : {}),
    ...(categories && categories.length > 0 ? { categories } : {}),
    ...(platforms && platforms.length > 0 ? { platforms } : {}),
    ...(typeof r.order === 'number' && Number.isFinite(r.order)
      ? { order: r.order }
      : {}),
    ...(r.active === false ? { active: false } : {}),
  }
}

const isManifestShape = (value: unknown): value is StaffPicksManifest => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.schema_version === 'number' &&
    typeof v.updated_at === 'string' &&
    Array.isArray(v.picks)
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

export type CachedStaffPicksManifest = {
  manifest: StaffPicksManifest
  fetchedAt: number
}

export const getCachedManifest = (): CachedStaffPicksManifest | null => {
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

export const isCacheFresh = (
  cached: CachedStaffPicksManifest | null
): boolean => {
  if (!cached) return false
  return Date.now() - cached.fetchedAt < CACHE_TTL_MS
}

const writeCache = (manifest: StaffPicksManifest, fetchedAt: number): void => {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.setItem(CACHE_KEY, JSON.stringify(manifest))
    ls.setItem(CACHE_TS_KEY, String(fetchedAt))
  } catch (error) {
    console.warn('[staff-picks-registry] Failed to write cache:', error)
  }
}

export const clearStaffPicksCache = (): void => {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.removeItem(CACHE_KEY)
    ls.removeItem(CACHE_TS_KEY)
  } catch (error) {
    console.warn('[staff-picks-registry] Failed to clear cache:', error)
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
      `Staff-picks fetch failed: ${response.status} ${response.statusText}`
    )
  }
  return (await response.json()) as unknown
}

const fetchManifest = async (
  url: string,
  signal?: AbortSignal
): Promise<StaffPicksManifest> => {
  let data: unknown
  try {
    data = await fetchOnce(fetch, url, signal)
  } catch (primaryError) {
    if (!isTauriRuntime()) throw primaryError
    console.warn(
      '[staff-picks-registry] standard fetch failed, retrying via Tauri HTTP plugin:',
      primaryError instanceof Error ? primaryError.message : primaryError
    )
    data = await fetchOnce(fetchTauri as typeof fetch, url, signal)
  }

  if (!isManifestShape(data)) {
    throw new Error('Staff-picks payload is not a valid manifest')
  }
  if (data.schema_version > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `Staff-picks schema_version ${data.schema_version} is newer than ` +
        `supported (${SUPPORTED_SCHEMA_VERSION}). Update the application to read it.`
    )
  }

  const picks = data.picks
    .map(sanitizePick)
    .filter((p): p is StaffPick => p !== null)

  return {
    schema_version: data.schema_version,
    updated_at: data.updated_at,
    picks,
  }
}

/**
 * Hard timeout wrapper. Tauri's HTTP plugin does not always honour
 * `AbortSignal`, so we race against a timer to guarantee resolution.
 */
const withHardTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  reason = `Staff-picks fetch timed out after ${timeoutMs}ms`
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
 * Resolve the effective list of staff picks using the priority chain:
 *
 *   1. Fresh cache (when not forcing).
 *   2. Network fetch (writes a new cache entry on success).
 *   3. Stale cache (used after a network failure).
 *   4. Baseline fallback bundled in the app.
 *
 * Always returns a result — never throws — so UI code can render unconditionally.
 */
export const getStaffPicksOrFallback = async (
  options: FetchOptions = {}
): Promise<StaffPicksFetchResult> => {
  const {
    force = false,
    url = STAFF_PICKS_URL,
    timeoutMs = FETCH_TIMEOUT_MS,
  } = options

  const cached = getCachedManifest()
  if (!force && isCacheFresh(cached) && cached) {
    return {
      picks: cached.manifest.picks.slice(),
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
    const manifest = await withHardTimeout(
      fetchManifest(fetchUrl, controller.signal),
      timeoutMs
    )
    const fetchedAt = Date.now()
    writeCache(manifest, fetchedAt)
    console.info(
      `[staff-picks-registry] Loaded ${manifest.picks.length} picks (schema_version=${manifest.schema_version}, updated_at=${manifest.updated_at})`
    )
    return {
      picks: manifest.picks.slice(),
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
        : 'Unknown staff-picks registry error'
    console.warn('[staff-picks-registry] Falling back:', message)
    if (cached) {
      return {
        picks: cached.manifest.picks.slice(),
        source: 'cache',
        fetchedAt: cached.fetchedAt,
        manifestUpdatedAt: cached.manifest.updated_at,
        error: message,
      }
    }
    return {
      picks: BASELINE_STAFF_PICKS.slice(),
      source: 'baseline',
      fetchedAt: null,
      manifestUpdatedAt: null,
      error: message,
    }
  }
}

/** Absent `format` means GGUF: the manifest predates the field. */
export const staffPickFormat = (pick: StaffPick): StaffPickFormat =>
  pick.format ?? 'gguf'

/**
 * Pure helper used by both the store selector and tests.
 *
 * An entry is visible when it is not explicitly disabled, matches the
 * requested build format, and either has no `platforms` field (universal) or
 * lists the current OS. Entries carrying an `order` sort first, ascending; the
 * rest keep manifest order behind them.
 */
export const filterStaffPicksForPlatform = (
  picks: ReadonlyArray<StaffPick>,
  os: StaffPickPlatform,
  format: StaffPickFormat = 'gguf'
): StaffPick[] =>
  picks
    .filter(
      (p) =>
        p.active !== false &&
        staffPickFormat(p) === format &&
        (!p.platforms || p.platforms.includes(os))
    )
    .map((pick, index) => ({ pick, index }))
    .sort((left, right) => {
      const leftOrder = left.pick.order ?? Number.POSITIVE_INFINITY
      const rightOrder = right.pick.order ?? Number.POSITIVE_INFINITY
      if (leftOrder !== rightOrder) return leftOrder - rightOrder
      return left.index - right.index
    })
    .map(({ pick }) => pick)
