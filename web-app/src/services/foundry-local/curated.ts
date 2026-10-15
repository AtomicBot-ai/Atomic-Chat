/**
 * Foundry Local's curated model list — `atomic-chat-conf/models/foundry-local-models.json`
 * (openspec change `add-foundry-local`, spec `foundry-local-models`).
 *
 * The list names the models Atomic Chat has checked (every file with its size and sha256), the
 * resolve endpoint that turns a variant's Azure ML asset id into a short-lived link to its files,
 * and the Microsoft catalog the Hub shows after the curated models. It may hold no model at all:
 * the Hub then shows the catalog only.
 *
 * Fetched at runtime, cached in IndexedDB for an hour; the last accepted list is kept when the
 * network fails or main carries a list this client cannot read. Parsing is strict by field and soft
 * by entry, mirroring conf's schema: a variant with a source kind, accelerator or device this client
 * does not know is skipped, and so is a model left without variants — so conf can add a new kind
 * of source next to the old ones without breaking released apps. A document with a newer
 * `schema_version` is refused whole.
 */

import { invoke } from '@tauri-apps/api/core'
import { fetch as fetchTauri } from '@tauri-apps/plugin-http'

import {
  FOUNDRY_LOCAL_DEVICES,
  FOUNDRY_LOCAL_EXECUTION_PROVIDERS,
  type FoundryLocalDevice,
  type FoundryLocalExecutionProvider,
} from './types'

export const DEFAULT_FOUNDRY_LOCAL_MODELS_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/foundry-local-models.json'

/**
 * Where the list is read from. A dev build may point it elsewhere — a branch of conf, or a local
 * file (`file:///…/atomic-chat-conf/models/foundry-local-models.json`) while conf is unmerged.
 */
export const FOUNDRY_LOCAL_MODELS_URL: string =
  (import.meta.env.DEV
    ? (import.meta.env.VITE_FOUNDRY_LOCAL_MODELS_URL as string | undefined)
    : undefined) ?? DEFAULT_FOUNDRY_LOCAL_MODELS_URL

/** Highest `schema_version` this client understands. */
export const SUPPORTED_SCHEMA_VERSION = 1

/** Cache TTL (1 hour) — the other conf registries' posture. */
export const CACHE_TTL_MS = 60 * 60 * 1000

const FETCH_TIMEOUT_MS = 10_000

export const FOUNDRY_LOCAL_PLATFORMS = [
  'win-x64',
  'win-arm64',
  'macos-arm64',
  'linux-x64',
  'linux-arm64',
] as const
export type FoundryLocalPlatform = (typeof FOUNDRY_LOCAL_PLATFORMS)[number]

/** Where a variant's files live: an Azure ML registry asset (the only kind this client knows). */
export interface FoundryLocalAzureMlSource {
  kind: 'azureml'
  /** `azureml://registries/<r>/models/<name>/versions/<v>`, version included. */
  asset_id: string
  version: string
  /** Folder inside the asset's container; files are `<container>/<path_prefix>/<path>`. */
  path_prefix: string
}

export interface FoundryLocalFile {
  /** Relative to `path_prefix` in the container and to the variant folder on disk. */
  path: string
  size: number
  sha256: string
}

export interface FoundryLocalVariant {
  id: string
  device: FoundryLocalDevice
  execution_provider: FoundryLocalExecutionProvider
  platforms: FoundryLocalPlatform[]
  source: FoundryLocalAzureMlSource
  files: FoundryLocalFile[]
  /** Only when smaller than the model's (NPU builds are made for 4K). */
  context_length?: number
}

export interface FoundryLocalModel {
  id: string
  name: string
  description: string
  task: 'chat'
  license: string
  context_length: number
  tools: boolean
  reasoning: boolean
  variants: FoundryLocalVariant[]
}

export interface FoundryLocalList {
  schema_version: number
  updated_at: string
  resolver: { url_template: string; regions: string[] }
  catalog: { url: string }
  models: FoundryLocalModel[]
}

/** conf's first release of the list, for a first launch that cannot reach conf. */
const BASELINE_LIST = {
  schema_version: 1,
  updated_at: '2026-10-15T00:00:00Z',
  resolver: {
    url_template:
      'https://{region}.api.azureml.ms/modelregistry/v1.0/registry/models/nonazureaccount?assetId={asset_id}',
    regions: ['eastus', 'westeurope', 'eastus2', 'westus2', 'southeastasia'],
  },
  catalog: { url: 'https://api.catalog.azureml.ms/asset-gallery/v1.0/models' },
  models: [],
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const ID = /^[a-z0-9][a-z0-9._-]*$/
const PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/
const SHA256 = /^[0-9a-f]{64}$/
const ASSET_ID = /^azureml:\/\/registries\/[A-Za-z0-9_.-]+\/models\/[A-Za-z0-9_.-]+\/versions\/[A-Za-z0-9_.-]+$/

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0
const isSafePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  PATH.test(value) &&
  !value.split('/').some((segment) => segment === '.' || segment === '..')

function parseFile(raw: unknown): FoundryLocalFile | null {
  if (!isObject(raw)) return null
  const { path, size, sha256 } = raw
  if (!isSafePath(path) || !isPositiveInt(size) || typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    return null
  }
  return { path, size, sha256 }
}

function parseSource(raw: unknown): FoundryLocalAzureMlSource | null {
  if (!isObject(raw) || raw.kind !== 'azureml') return null
  const { asset_id, version, path_prefix } = raw
  if (typeof asset_id !== 'string' || !ASSET_ID.test(asset_id)) return null
  if (!isString(version) || !asset_id.endsWith(`/versions/${version}`)) return null
  if (!isSafePath(path_prefix)) return null
  return { kind: 'azureml', asset_id, version, path_prefix }
}

function parseVariant(raw: unknown, modelContext: number): FoundryLocalVariant | null {
  if (!isObject(raw)) return null
  const { id, device, execution_provider, platforms, files, context_length } = raw
  if (typeof id !== 'string' || !ID.test(id)) return null
  if (!FOUNDRY_LOCAL_DEVICES.includes(device as FoundryLocalDevice)) return null
  if (!FOUNDRY_LOCAL_EXECUTION_PROVIDERS.includes(execution_provider as FoundryLocalExecutionProvider)) {
    return null
  }
  const source = parseSource(raw.source)
  if (!source) return null
  // A platform this client does not know is left out; a variant left with none is skipped.
  const known = Array.isArray(platforms)
    ? platforms.filter((platform): platform is FoundryLocalPlatform =>
        FOUNDRY_LOCAL_PLATFORMS.includes(platform as FoundryLocalPlatform)
      )
    : []
  if (known.length === 0) return null
  if (!Array.isArray(files) || files.length === 0) return null
  const parsedFiles = files.map(parseFile)
  // One unusable file makes the variant undownloadable: never half of it.
  if (parsedFiles.some((file) => file === null)) return null
  return {
    id,
    device: device as FoundryLocalDevice,
    execution_provider: execution_provider as FoundryLocalExecutionProvider,
    platforms: [...new Set(known)],
    source,
    files: parsedFiles as FoundryLocalFile[],
    ...(isPositiveInt(context_length) && context_length < modelContext ? { context_length } : {}),
  }
}

function parseModel(raw: unknown): FoundryLocalModel | null {
  if (!isObject(raw)) return null
  const { id, name, description, task, license, context_length, tools, reasoning, variants } = raw
  if (typeof id !== 'string' || !ID.test(id)) return null
  if (!isString(name) || !isString(description) || task !== 'chat' || !isString(license)) return null
  if (!isPositiveInt(context_length) || typeof tools !== 'boolean' || typeof reasoning !== 'boolean') {
    return null
  }
  if (!Array.isArray(variants)) return null
  const parsed = variants
    .map((variant) => parseVariant(variant, context_length))
    .filter((variant): variant is FoundryLocalVariant => variant !== null)
  if (parsed.length === 0) return null
  return { id, name, description, task, license, context_length, tools, reasoning, variants: parsed }
}

/**
 * The list as this client can use it. Throws when the document as a whole cannot be used: a newer
 * `schema_version`, or a resolver or catalog it cannot reach. Entries it does not understand are
 * skipped, never fatal.
 */
export function parseFoundryLocalList(raw: unknown): FoundryLocalList {
  if (!isObject(raw)) throw new Error('The Foundry Local model list is not an object.')
  const { schema_version, updated_at, resolver, catalog, models } = raw
  if (!isPositiveInt(schema_version)) throw new Error('The Foundry Local model list has no schema_version.')
  if (schema_version > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `The Foundry Local model list has schema_version ${schema_version}; this app reads ${SUPPORTED_SCHEMA_VERSION}.`
    )
  }
  if (
    !isObject(resolver) ||
    typeof resolver.url_template !== 'string' ||
    !resolver.url_template.startsWith('https://') ||
    !resolver.url_template.includes('{region}') ||
    !resolver.url_template.includes('{asset_id}') ||
    !Array.isArray(resolver.regions) ||
    resolver.regions.length === 0 ||
    !resolver.regions.every((region) => typeof region === 'string' && /^[a-z0-9]+$/.test(region))
  ) {
    throw new Error('The Foundry Local model list has no usable resolver.')
  }
  if (!isObject(catalog) || typeof catalog.url !== 'string' || !catalog.url.startsWith('https://')) {
    throw new Error('The Foundry Local model list has no usable catalog URL.')
  }
  if (!Array.isArray(models)) throw new Error('The Foundry Local model list has no models array.')
  return {
    schema_version,
    updated_at: typeof updated_at === 'string' ? updated_at : '',
    resolver: { url_template: resolver.url_template, regions: resolver.regions as string[] },
    catalog: { url: catalog.url },
    models: models.map(parseModel).filter((model): model is FoundryLocalModel => model !== null),
  }
}

// ── Cache ────────────────────────────────────────────────────────────────────

/** Where the last accepted document is kept: the raw JSON and when it was fetched. */
export interface FoundryLocalListCache {
  read(): Promise<{ value: unknown; fetchedAt: number } | null>
  write(value: unknown, fetchedAt: number): Promise<void>
}

const CACHE_DB_NAME = 'atomic_foundry_local_models_cache'
const CACHE_STORE = 'snapshots'
const CACHE_KEY = 'list'

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    try {
      const request = indexedDB.open(CACHE_DB_NAME, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(CACHE_STORE)) {
          request.result.createObjectStore(CACHE_STORE)
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

/** IndexedDB, best effort: a cache that cannot be read or written is no cache. */
export const indexedDbListCache: FoundryLocalListCache = {
  read: async () => {
    const db = await openDb()
    if (!db) return null
    return new Promise((resolve) => {
      try {
        const request = db.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).get(CACHE_KEY)
        request.onsuccess = () => {
          const entry = request.result as { value: unknown; fetchedAt: number } | undefined
          resolve(entry && Number.isFinite(entry.fetchedAt) ? entry : null)
        }
        request.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  },
  write: async (value, fetchedAt) => {
    const db = await openDb()
    if (!db) return
    await new Promise<void>((resolve) => {
      try {
        const transaction = db.transaction(CACHE_STORE, 'readwrite')
        transaction.objectStore(CACHE_STORE).put({ value, fetchedAt }, CACHE_KEY)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => resolve()
        transaction.onabort = () => resolve()
      } catch {
        resolve()
      }
    })
  },
}

// ── Fetch ────────────────────────────────────────────────────────────────────

/** The document at `url`: a dev build's `file://` through the app's file command, else HTTP. */
async function fetchJsonFrom(url: string): Promise<unknown> {
  if (url.startsWith('file://')) {
    // `file:///C:/…` has the pathname `/C:/…`; a Windows path starts at the drive letter.
    const path = decodeURIComponent(new URL(url).pathname).replace(/^\/([A-Za-z]:\/)/, '$1')
    return JSON.parse(await invoke<string>('read_file_sync', { args: [path] }))
  }
  const get = async (fetcher: typeof fetch) => {
    const response = await fetcher(url, { method: 'GET', headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`Foundry Local model list: ${response.status} ${response.statusText}`)
    return (await response.json()) as unknown
  }
  try {
    return await get(fetch)
  } catch (error) {
    // The webview's fetch can be refused (CORS, a proxy); the Tauri HTTP plugin is not.
    if (typeof IS_TAURI === 'undefined' || !IS_TAURI) throw error
    return get(fetchTauri as typeof fetch)
  }
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Foundry Local model list: no answer in ${ms} ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })

export interface FoundryLocalListResult {
  /** `null` only if not even the bundled baseline parses, which a test pins. */
  list: FoundryLocalList | null
  source: 'remote' | 'cache' | 'baseline'
  fetchedAt: number | null
  /** Why the network answer was not used, when it was not. */
  error?: string
}

export interface FoundryLocalListOptions {
  force?: boolean
  url?: string
  cache?: FoundryLocalListCache
  fetchJson?: (url: string) => Promise<unknown>
}

/**
 * The list: a fresh cache (unless forced), else the network (cached when it parses), else the last
 * accepted list, else conf's first release bundled here. Never throws.
 */
export async function fetchFoundryLocalList(
  options: FoundryLocalListOptions = {}
): Promise<FoundryLocalListResult> {
  const cache = options.cache ?? indexedDbListCache
  const fetchJson = options.fetchJson ?? fetchJsonFrom
  const cached = await cache.read()
  const accepted = (() => {
    if (!cached) return null
    try {
      return parseFoundryLocalList(cached.value)
    } catch {
      return null
    }
  })()
  if (!options.force && cached && accepted && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { list: accepted, source: 'cache', fetchedAt: cached.fetchedAt }
  }
  try {
    const raw = await withTimeout(fetchJson(options.url ?? FOUNDRY_LOCAL_MODELS_URL), FETCH_TIMEOUT_MS)
    const list = parseFoundryLocalList(raw)
    const fetchedAt = Date.now()
    await cache.write(raw, fetchedAt)
    return { list, source: 'remote', fetchedAt }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (accepted && cached) return { list: accepted, source: 'cache', fetchedAt: cached.fetchedAt, error: message }
    return { list: parseFoundryLocalList(BASELINE_LIST), source: 'baseline', fetchedAt: null, error: message }
  }
}
