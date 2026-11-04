/** Shared browser/extension loader. Only catalog.json is fetched and cached. */
import baseline from './modelCatalogBaseline.json'
import {
  ATOMIC_MODEL_CATALOG_URL,
  parseAtomicModelCatalog,
  projectAtomicModelCollection,
  type AtomicModelCatalog,
} from './catalogProtocol'

const KEY = 'atomic_unified_model_catalog_v1'
const TTL = 60 * 60 * 1000
let current: AtomicModelCatalog | undefined
let pending: Promise<AtomicModelCatalog> | undefined
let acceptedAt = 0
let status: { source: 'remote' | 'cache' | 'baseline'; fetchedAt: number | null; error?: string } =
  { source: 'baseline', fetchedAt: null }
export interface AtomicCatalogLoadOptions {
  url?: string
  fetch?: typeof fetch
  force?: boolean
}

/** A complete bundled snapshot, never an independently maintained collection. */
export function atomicModelCatalogBaseline(): AtomicModelCatalog {
  return parseAtomicModelCatalog(baseline)
}

/** Planning uses the catalog already shown to the user, including another extension's cached copy. */
export function atomicModelCatalogSnapshot(): AtomicModelCatalog {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { catalog?: unknown } | null
    if (saved?.catalog) return parseAtomicModelCatalog(saved.catalog)
  } catch {
    /* A malformed cache never replaces the bundled snapshot. */
  }
  return current ?? atomicModelCatalogBaseline()
}

/** One read shared by all collection adapters; stale complete snapshots remain valid fallbacks. */
export async function loadAtomicModelCatalog(
  options: AtomicCatalogLoadOptions = {}
): Promise<AtomicModelCatalog> {
  if (!options.force && current && Date.now() - acceptedAt < TTL) {
    status = { source: 'cache', fetchedAt: acceptedAt }
    return current
  }
  if (!options.force && pending) return pending
  pending = (async () => {
    if (!current) {
      try {
        const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as {
          at: number
          catalog: unknown
        } | null
        if (saved) {
          current = parseAtomicModelCatalog(saved.catalog)
          acceptedAt = saved.at
          status = { source: 'cache', fetchedAt: saved.at }
        }
      } catch {
        /* Storage is optional; the bundled complete snapshot remains available. */
      }
    }
    if (!options.force && current && Date.now() - acceptedAt < TTL) return current
    try {
      const response = await (options.fetch ?? fetch)(options.url ?? ATOMIC_MODEL_CATALOG_URL, {
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) throw new Error(`Model catalog returned HTTP ${response.status}`)
      current = parseAtomicModelCatalog(await response.json())
      acceptedAt = Date.now()
      status = { source: 'remote', fetchedAt: acceptedAt }
      try {
        localStorage.setItem(KEY, JSON.stringify({ at: acceptedAt, catalog: current }))
      } catch {
        /* Quota does not invalidate a verified catalog. */
      }
    } catch (error) {
      console.warn('[atomic-model-catalog] using cached or bundled catalog:', error)
      current ??= atomicModelCatalogBaseline()
      status = {
        source: acceptedAt ? 'cache' : 'baseline',
        fetchedAt: acceptedAt || null,
        error: String(error),
      }
    }
    return current
  })()
  try {
    return await pending
  } finally {
    pending = undefined
  }
}

/** Collection adapters share the origin of the complete document. */
export function atomicModelCatalogStatus(): typeof status {
  return { ...status }
}

/** Explicit refresh clears only the new cache, preserving older clients' stored data. */
export function clearAtomicModelCatalogCache(): void {
  current = undefined
  acceptedAt = 0
  status = { source: 'baseline', fetchedAt: null }
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* Storage may be unavailable. */
  }
}

/** Existing UI interfaces consume an in-memory projection, never another remote catalog. */
export async function loadAtomicModelCollection(
  name: string,
  options: AtomicCatalogLoadOptions = {}
): Promise<unknown> {
  return projectAtomicModelCollection(await loadAtomicModelCatalog(options), name)
}
