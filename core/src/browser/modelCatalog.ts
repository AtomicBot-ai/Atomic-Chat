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
type CatalogStatus = {
  source: 'remote' | 'cache' | 'baseline'
  fetchedAt: number | null
  error?: string
}
type CatalogState = {
  current?: AtomicModelCatalog
  pending?: Promise<AtomicModelCatalog>
  acceptedAt: number
  status: CatalogStatus
}
const sources = new Map<string, CatalogState>()
let configuredSource = ATOMIC_MODEL_CATALOG_URL
export interface AtomicCatalogLoadOptions {
  url?: string
  fetch?: typeof fetch
  force?: boolean
}

/** Keep planners and collection adapters on the app's selected metadata source. */
export function configureAtomicModelCatalogSource(url?: string): void {
  configuredSource = url || ATOMIC_MODEL_CATALOG_URL
}
function sourceKey(url: string): string {
  return url === ATOMIC_MODEL_CATALOG_URL ? KEY : `${KEY}:${encodeURIComponent(url)}`
}
function stateFor(url: string): CatalogState {
  let state = sources.get(url)
  if (!state) {
    state = { acceptedAt: 0, status: { source: 'baseline', fetchedAt: null } }
    sources.set(url, state)
    try {
      const saved = JSON.parse(localStorage.getItem(sourceKey(url)) ?? 'null')
      // Older caches have no source identity and could contain a developer override.
      if (saved?.url === url) {
        state.current = parseAtomicModelCatalog(saved.catalog)
        state.acceptedAt = saved.at
        state.status = { source: 'cache', fetchedAt: saved.at }
      }
    } catch {
      /* Storage is optional; malformed data never replaces the bundled snapshot. */
    }
  }
  return state
}

/** A complete bundled snapshot, never an independently maintained collection. */
export function atomicModelCatalogBaseline(): AtomicModelCatalog {
  return parseAtomicModelCatalog(baseline)
}

/** Planning uses the same source and accepted snapshot as collection adapters. */
export function atomicModelCatalogSnapshot(
  options: Pick<AtomicCatalogLoadOptions, 'url'> = {}
): AtomicModelCatalog {
  return stateFor(options.url ?? configuredSource).current ?? atomicModelCatalogBaseline()
}

/** One pending read per source; stale complete snapshots remain valid fallbacks. */
export async function loadAtomicModelCatalog(
  options: AtomicCatalogLoadOptions = {}
): Promise<AtomicModelCatalog> {
  const url = options.url ?? configuredSource
  const state = stateFor(url)
  if (state.pending) return state.pending
  if (!options.force && state.current && Date.now() - state.acceptedAt < TTL) {
    state.status = { source: 'cache', fetchedAt: state.acceptedAt }
    return state.current
  }
  state.pending = (async () => {
    try {
      const response = await (options.fetch ?? fetch)(url, {
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) throw new Error(`Model catalog returned HTTP ${response.status}`)
      state.current = parseAtomicModelCatalog(await response.json())
      state.acceptedAt = Date.now()
      state.status = { source: 'remote', fetchedAt: state.acceptedAt }
      try {
        if (sources.get(url) === state) {
          localStorage.setItem(
            sourceKey(url),
            JSON.stringify({ url, at: state.acceptedAt, catalog: state.current })
          )
        }
      } catch {
        /* Quota does not invalidate a verified catalog. */
      }
    } catch (error) {
      console.warn('[atomic-model-catalog] using cached or bundled catalog:', error)
      state.current ??= atomicModelCatalogBaseline()
      state.status = {
        source: state.acceptedAt ? 'cache' : 'baseline',
        fetchedAt: state.acceptedAt || null,
        error: String(error),
      }
    }
    return state.current
  })()
  try {
    return await state.pending
  } finally {
    state.pending = undefined
  }
}

/** Collection adapters share the origin of the complete document. */
export function atomicModelCatalogStatus(
  options: Pick<AtomicCatalogLoadOptions, 'url'> = {}
): CatalogStatus {
  return { ...stateFor(options.url ?? configuredSource).status }
}

/** Refresh only the selected source; another catalog's cache remains isolated. */
export function clearAtomicModelCatalogCache(
  options: Pick<AtomicCatalogLoadOptions, 'url'> = {}
): void {
  const url = options.url ?? configuredSource
  sources.delete(url)
  try {
    localStorage.removeItem(sourceKey(url))
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
