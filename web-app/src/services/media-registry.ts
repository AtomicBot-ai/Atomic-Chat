/**
 * The remote media registry.
 *
 * A structural clone of `provider-registry.ts` — deliberately, so there is one
 * remote-config pattern in this app rather than two differently-shaped ones.
 * See `services/AGENTS.md` §3 and the ADR
 * `docs/decisions/2026-09-10-media-models-and-providers-come-from-atomic-chat-conf.md`.
 *
 * Priority chain, identical to the provider registry:
 *
 *   1. Fresh cache (unless forced)
 *   2. Network fetch (writes a new cache entry on success)
 *   3. Stale cache (after a network failure)
 *   4. The bundled baseline
 *
 * `getMediaProvidersOrFallback()` NEVER THROWS. UI code renders
 * unconditionally and must not wrap it in try/catch for control flow.
 *
 * ## This payload is hostile until proven otherwise
 *
 * The provider registry can add a model. THIS one can add a PROVIDER, which
 * means it can add a URL the app will send prompts to. Every entry is therefore
 * rejected rather than repaired when anything about it is wrong, and three
 * fields are overwritten no matter what the payload says:
 *
 *   - `origin` is forced to `registry`, so a remote entry can never claim to be
 *     `builtin` and make itself undeletable;
 *   - `auth.setting_key` is recomputed from the entry's own id, so a remote
 *     party can never point the app at a credential belonging to something else;
 *   - a bundled baseline provider always wins over a remote entry with the same
 *     id, so the local worker cannot be redirected by a registry commit.
 */

import { BASELINE_MEDIA_PROVIDERS } from '@/constants/mediaProviders'
import { mediaSecretKey } from './media/secrets'
import type {
  MediaProviderAdapterId,
  MediaProviderDescriptor,
  MediaProviderKind,
} from './media/contract'

export const DEFAULT_MEDIA_REGISTRY_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/media/registry.json'

export const MEDIA_REGISTRY_SCHEMA_VERSION = 1

export const CACHE_TTL_MS = 60 * 60 * 1000

const CACHE_KEY = 'atomic_media_registry_cache_v1'
const CACHE_TS_KEY = 'atomic_media_registry_cache_ts_v1'

const FETCH_TIMEOUT_MS = 5000

/** Adapters this build actually has. Anything else cannot be constructed. */
const KNOWN_ADAPTERS: ReadonlySet<string> = new Set<MediaProviderAdapterId>([
  'builtin-engine',
  'atomic-media-worker',
  'comfyui',
  'openai-images',
  'custom-http',
])

const KNOWN_KINDS: ReadonlySet<string> = new Set<MediaProviderKind>([
  'local_engine',
  'local_worker',
  'local_comfy',
  'remote_http',
])

export type MediaRegistryManifest = {
  schema_version: number
  updated_at: string
  providers: MediaProviderDescriptor[]
}

export type MediaRegistryFetchResult = {
  providers: MediaProviderDescriptor[]
  source: 'remote' | 'cache' | 'baseline'
  fetchedAt: number | null
  manifestUpdatedAt: string | null
  error?: string
}

/**
 * A base URL the app is willing to talk to.
 *
 * http and https only. `file:`, `data:` and custom schemes are refused, because
 * a registry commit must not be able to point the app at the local filesystem
 * or a handler registered on the machine.
 */
function isAcceptableUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Accept an entry, or drop it. Never repair it: a half-understood descriptor
 * would configure a provider from fields nobody validated.
 */
function sanitizeEntry(value: unknown): MediaProviderDescriptor | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>

  const id = entry.id
  const adapter = entry.adapter
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof adapter !== 'string' || !KNOWN_ADAPTERS.has(adapter)) return null

  // A base_url is optional (the bundled worker has a default), but a present
  // one must be acceptable. Present-and-wrong is a rejection, not a removal.
  if (entry.base_url !== undefined && !isAcceptableUrl(entry.base_url)) {
    return null
  }

  const kind =
    typeof entry.kind === 'string' && KNOWN_KINDS.has(entry.kind)
      ? (entry.kind as MediaProviderKind)
      : 'remote_http'

  // Narrowed one branch at a time so the literal type survives: comparing an
  // `unknown` through `||` widens back to `string`, which is not assignable to
  // the descriptor's union.
  const rawAuthType = (entry.auth as { type?: unknown } | undefined)?.type
  const auth: MediaProviderDescriptor['auth'] =
    rawAuthType === 'api_key'
      ? // Recomputed from this entry's own id. The registry names WHICH
        // provider needs a key; it never gets to say where the key lives.
        { type: 'api_key', setting_key: mediaSecretKey(id) }
      : rawAuthType === 'bearer'
        ? { type: 'bearer', setting_key: mediaSecretKey(id) }
        : { type: 'none' }

  return {
    id,
    label: typeof entry.label === 'string' && entry.label ? entry.label : id,
    kind,
    adapter: adapter as MediaProviderAdapterId,
    ...(typeof entry.base_url === 'string'
      ? { base_url: entry.base_url }
      : {}),
    auth,
    // A registry entry never arrives switched on. Adding a provider is the
    // user's act; the registry only offers one.
    enabled: false,
    origin: 'registry',
    ...(typeof entry.order === 'number' ? { order: entry.order } : {}),
  }
}

function isManifest(value: unknown): value is MediaRegistryManifest {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.schema_version === 'number' &&
    Array.isArray(candidate.providers)
  )
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export type CachedMediaManifest = {
  manifest: MediaRegistryManifest
  fetchedAt: number
}

export function getCachedMediaManifest(): CachedMediaManifest | null {
  const store = safeLocalStorage()
  if (!store) return null
  try {
    const raw = store.getItem(CACHE_KEY)
    const ts = store.getItem(CACHE_TS_KEY)
    if (!raw || !ts) return null
    const manifest = JSON.parse(raw) as unknown
    if (!isManifest(manifest)) return null
    return { manifest, fetchedAt: Number(ts) }
  } catch {
    return null
  }
}

export function isMediaCacheFresh(cached: CachedMediaManifest | null): boolean {
  if (!cached) return false
  return Date.now() - cached.fetchedAt < CACHE_TTL_MS
}

function writeCache(manifest: MediaRegistryManifest, fetchedAt: number): void {
  const store = safeLocalStorage()
  if (!store) return
  try {
    store.setItem(CACHE_KEY, JSON.stringify(manifest))
    store.setItem(CACHE_TS_KEY, String(fetchedAt))
  } catch {
    // A full or disabled quota must not break loading.
  }
}

export function clearMediaRegistryCache(): void {
  const store = safeLocalStorage()
  if (!store) return
  try {
    store.removeItem(CACHE_KEY)
    store.removeItem(CACHE_TS_KEY)
  } catch {
    // Nothing to do.
  }
}

/**
 * Baseline wins. A bundled provider is part of this build and its address is
 * not the registry's to change.
 */
function mergeWithBaseline(
  remote: MediaProviderDescriptor[]
): MediaProviderDescriptor[] {
  const bundled = BASELINE_MEDIA_PROVIDERS.map((provider) => ({ ...provider }))
  const bundledIds = new Set(bundled.map((provider) => provider.id))
  return [
    ...bundled,
    ...remote.filter((provider) => !bundledIds.has(provider.id)),
  ]
}

function baselineResult(error?: string): MediaRegistryFetchResult {
  return {
    providers: BASELINE_MEDIA_PROVIDERS.map((provider) => ({ ...provider })),
    source: 'baseline',
    fetchedAt: null,
    manifestUpdatedAt: null,
    ...(error ? { error } : {}),
  }
}

async function fetchManifest(
  url: string,
  signal?: AbortSignal
): Promise<MediaRegistryManifest> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!response.ok) {
    throw new Error(
      `Media registry fetch failed: ${response.status} ${response.statusText}`
    )
  }
  const data = (await response.json()) as unknown
  if (!isManifest(data)) {
    throw new Error('Media registry payload is malformed.')
  }
  // Refused outright, not partially parsed: a newer schema may mean anything.
  if (data.schema_version > MEDIA_REGISTRY_SCHEMA_VERSION) {
    throw new Error(
      `Media registry schema_version ${data.schema_version} is newer than this build supports.`
    )
  }
  return data
}

export type MediaFetchOptions = {
  force?: boolean
  url?: string
  timeoutMs?: number
}

export async function getMediaProvidersOrFallback(
  options: MediaFetchOptions = {}
): Promise<MediaRegistryFetchResult> {
  const {
    force = false,
    url = DEFAULT_MEDIA_REGISTRY_URL,
    timeoutMs = FETCH_TIMEOUT_MS,
  } = options

  const cached = getCachedMediaManifest()
  if (!force && isMediaCacheFresh(cached) && cached) {
    return {
      providers: mergeWithBaseline(
        cached.manifest.providers
          .map(sanitizeEntry)
          .filter((entry): entry is MediaProviderDescriptor => entry !== null)
      ),
      source: 'cache',
      fetchedAt: cached.fetchedAt,
      manifestUpdatedAt: cached.manifest.updated_at,
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const manifest = await fetchManifest(url, controller.signal)
    const fetchedAt = Date.now()
    writeCache(manifest, fetchedAt)

    return {
      providers: mergeWithBaseline(
        manifest.providers
          .map(sanitizeEntry)
          .filter((entry): entry is MediaProviderDescriptor => entry !== null)
      ),
      source: 'remote',
      fetchedAt,
      manifestUpdatedAt: manifest.updated_at,
    }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    console.warn('[media-registry] falling back:', detail)

    // A stale cache is better than nothing: it is a list the user has already
    // seen, and the error field lets an explicit Refresh surface a toast.
    if (cached) {
      return {
        providers: mergeWithBaseline(
          cached.manifest.providers
            .map(sanitizeEntry)
            .filter((entry): entry is MediaProviderDescriptor => entry !== null)
        ),
        source: 'cache',
        fetchedAt: cached.fetchedAt,
        manifestUpdatedAt: cached.manifest.updated_at,
        error: detail,
      }
    }

    return baselineResult(detail)
  } finally {
    clearTimeout(timer)
  }
}
