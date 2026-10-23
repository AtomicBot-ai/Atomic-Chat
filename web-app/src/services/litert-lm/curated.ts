/**
 * LiteRT-LM's curated model list — `atomic-chat-conf/models/litert-lm-models.json` (openspec change
 * `add-litert-lm-runtime`, spec `litert-lm-models`).
 *
 * The list names the models Atomic Chat has checked — each variant's `.litertlm` file in a Hugging
 * Face repository pinned to a commit, with its size and sha256 — and the rules for the Hugging Face
 * models the Hub shows after them: the organisations to list, and the backends each platform may
 * offer for them. It may hold no model at all: the Hub then shows Hugging Face models only.
 *
 * Fetched at runtime, cached in IndexedDB for an hour; the last accepted list is kept when the
 * network fails or main carries a list this client cannot read, and conf's first release is bundled
 * for a first launch without network. Parsing is strict by field and soft by entry, mirroring conf's
 * schema: a variant with a backend, NPU target or platform this client does not know is hidden, and
 * so is a model left without variants — so conf can add a new NPU next to the old ones without
 * breaking released apps (spec "Клиент пропускает то, чего не понимает"). A document with a newer
 * `schema_version` is refused whole.
 */

import { invoke } from '@tauri-apps/api/core'
import { fetch as fetchTauri } from '@tauri-apps/plugin-http'

import baselineList from './baseline-models.json'
import {
  LITERT_LM_BACKENDS,
  LITERT_LM_NPUS,
  type LiteRtLmBackend,
  type LiteRtLmNpu,
} from './types'

export const DEFAULT_LITERT_LM_MODELS_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/litert-lm-models.json'

/**
 * Where the list is read from. A dev build may point it elsewhere — a branch of conf, or a local
 * file (`file:///…/atomic-chat-conf/models/litert-lm-models.json`) while conf is unmerged.
 */
export const LITERT_LM_MODELS_URL: string =
  (import.meta.env.DEV
    ? (import.meta.env.VITE_LITERT_LM_MODELS_URL as string | undefined)
    : undefined) ?? DEFAULT_LITERT_LM_MODELS_URL

/** Highest `schema_version` this client understands. */
export const SUPPORTED_SCHEMA_VERSION = 1

/** Cache TTL (1 hour) — the other conf registries' posture. */
export const CACHE_TTL_MS = 60 * 60 * 1000

const FETCH_TIMEOUT_MS = 10_000

/** The platforms LiteRT-LM's library ships for, as conf names them. */
export const LITERT_LM_PLATFORMS = ['macos-arm64', 'linux-x64', 'linux-arm64', 'win-x64'] as const
export type LiteRtLmPlatform = (typeof LITERT_LM_PLATFORMS)[number]

export interface LiteRtLmFile {
  /** Path inside the repository; the file keeps its name inside the variant folder. */
  path: string
  size: number
  sha256: string
}

export interface LiteRtLmVariant {
  /** Unique across the list: names the download and the folder `<data>/litert-lm/models/<id>`. */
  id: string
  backend: LiteRtLmBackend
  /** Present exactly when `backend` is `npu`. */
  npu?: LiteRtLmNpu
  platforms: LiteRtLmPlatform[]
  /** Oldest LiteRT-LM the file loads in, when conf knows it before download. */
  min_runtime_version?: string
  file: LiteRtLmFile
}

export interface LiteRtLmModel {
  id: string
  name: string
  description: string
  task: 'chat'
  license: string
  /** `<org>/<name>` on Hugging Face. */
  repo: string
  /** The commit every file is downloaded from. */
  revision: string
  /** The repository asks for its terms to be accepted: downloads need the person's HF token. */
  gated: boolean
  context_length: number
  tools: boolean
  reasoning: boolean
  vision: boolean
  variants: LiteRtLmVariant[]
}

export interface LiteRtLmList {
  schema_version: number
  updated_at: string
  huggingface: {
    /** Organisations whose `litert-lm`-tagged models the Hub lists after the curated ones. */
    orgs: string[]
    /** Platform → the backends a Hugging Face model may be offered for there; absent: none. */
    backends: Partial<Record<LiteRtLmPlatform, LiteRtLmBackend[]>>
  }
  models: LiteRtLmModel[]
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const ID = /^[a-z0-9][a-z0-9._-]*$/
const FILE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\.litertlm$/
const SHA256 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const ORG = /^[A-Za-z0-9_.-]+$/
const VERSION = /^\d+\.\d+(\.\d+)?$/

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0
const isBackend = (value: unknown): value is LiteRtLmBackend =>
  LITERT_LM_BACKENDS.includes(value as LiteRtLmBackend)
const isPlatform = (value: unknown): value is LiteRtLmPlatform =>
  LITERT_LM_PLATFORMS.includes(value as LiteRtLmPlatform)
const isSafeFile = (value: unknown): value is string =>
  typeof value === 'string' &&
  FILE.test(value) &&
  !value.split('/').some((segment) => segment === '.' || segment === '..')

function parseFile(raw: unknown): LiteRtLmFile | null {
  if (!isObject(raw)) return null
  const { path, size, sha256 } = raw
  if (!isSafeFile(path) || !isPositiveInt(size) || typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    return null
  }
  return { path, size, sha256 }
}

function parseVariant(raw: unknown): LiteRtLmVariant | null {
  if (!isObject(raw)) return null
  const { id, backend, npu, platforms, min_runtime_version } = raw
  if (typeof id !== 'string' || !ID.test(id) || !isBackend(backend)) return null
  // An NPU file is compiled for one generation: without a target this client knows it runs nowhere.
  if (backend === 'npu' ? !LITERT_LM_NPUS.includes(npu as LiteRtLmNpu) : npu !== undefined) return null
  // A platform this client does not know is left out; a variant left with none is hidden.
  const known = Array.isArray(platforms) ? [...new Set(platforms.filter(isPlatform))] : []
  if (known.length === 0) return null
  const file = parseFile(raw.file)
  if (!file) return null
  return {
    id,
    backend,
    ...(backend === 'npu' ? { npu: npu as LiteRtLmNpu } : {}),
    platforms: known,
    ...(typeof min_runtime_version === 'string' && VERSION.test(min_runtime_version)
      ? { min_runtime_version }
      : {}),
    file,
  }
}

function parseModel(raw: unknown): LiteRtLmModel | null {
  if (!isObject(raw)) return null
  const { id, name, description, task, license, repo, revision, gated, context_length } = raw
  const { tools, reasoning, vision, variants } = raw
  if (typeof id !== 'string' || !ID.test(id)) return null
  if (!isString(name) || !isString(description) || task !== 'chat' || !isString(license)) return null
  if (typeof repo !== 'string' || !REPO.test(repo)) return null
  if (typeof revision !== 'string' || !COMMIT.test(revision)) return null
  if (typeof gated !== 'boolean' || !isPositiveInt(context_length)) return null
  if (typeof tools !== 'boolean' || typeof reasoning !== 'boolean' || typeof vision !== 'boolean') {
    return null
  }
  if (!Array.isArray(variants)) return null
  const parsed = variants
    .map(parseVariant)
    .filter((variant): variant is LiteRtLmVariant => variant !== null)
  if (parsed.length === 0) return null
  return {
    id,
    name,
    description,
    task,
    license,
    repo,
    revision,
    gated,
    context_length,
    tools,
    reasoning,
    vision,
    variants: parsed,
  }
}

/** The Hugging Face rules this client can use; unusable ones mean no Hugging Face models, not no list. */
function parseHuggingFace(raw: unknown): LiteRtLmList['huggingface'] {
  if (!isObject(raw) || raw.filter !== 'litert-lm') return { orgs: [], backends: {} }
  const orgs = Array.isArray(raw.orgs)
    ? raw.orgs.filter((org): org is string => typeof org === 'string' && ORG.test(org))
    : []
  const backends: LiteRtLmList['huggingface']['backends'] = {}
  if (isObject(raw.backends)) {
    for (const [platform, list] of Object.entries(raw.backends)) {
      if (isPlatform(platform) && Array.isArray(list)) {
        backends[platform] = [...new Set(list.filter(isBackend))]
      }
    }
  }
  return { orgs: [...new Set(orgs)], backends }
}

/**
 * The list as this client can use it. Throws only when the document as a whole cannot be used: a
 * newer `schema_version` or no models array. Entries it does not understand are skipped.
 */
export function parseLiteRtLmList(raw: unknown): LiteRtLmList {
  if (!isObject(raw)) throw new Error('The LiteRT-LM model list is not an object.')
  const { schema_version, updated_at, models } = raw
  if (!isPositiveInt(schema_version)) throw new Error('The LiteRT-LM model list has no schema_version.')
  if (schema_version > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `The LiteRT-LM model list has schema_version ${schema_version}; this app reads ${SUPPORTED_SCHEMA_VERSION}.`
    )
  }
  if (!Array.isArray(models)) throw new Error('The LiteRT-LM model list has no models array.')
  return {
    schema_version,
    updated_at: typeof updated_at === 'string' ? updated_at : '',
    huggingface: parseHuggingFace(raw.huggingface),
    models: models.map(parseModel).filter((model): model is LiteRtLmModel => model !== null),
  }
}

/** conf's first release of the list (a byte copy of it), for a first launch that cannot reach conf. */
const BASELINE_LIST: unknown = baselineList

// ── Cache ────────────────────────────────────────────────────────────────────

/** Where the last accepted document is kept: the raw JSON and when it was fetched. */
export interface LiteRtLmListCache {
  read(): Promise<{ value: unknown; fetchedAt: number } | null>
  write(value: unknown, fetchedAt: number): Promise<void>
}

const CACHE_DB_NAME = 'atomic_litert_lm_models_cache'
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
export const indexedDbListCache: LiteRtLmListCache = {
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
    if (!response.ok) throw new Error(`LiteRT-LM model list: ${response.status} ${response.statusText}`)
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
    const timer = setTimeout(() => reject(new Error(`LiteRT-LM model list: no answer in ${ms} ms`)), ms)
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

export interface LiteRtLmListResult {
  /** `null` only if not even the bundled baseline parses, which a test pins. */
  list: LiteRtLmList | null
  source: 'remote' | 'cache' | 'baseline'
  fetchedAt: number | null
  /** Why the network answer was not used, when it was not. */
  error?: string
}

export interface LiteRtLmListOptions {
  force?: boolean
  url?: string
  cache?: LiteRtLmListCache
  fetchJson?: (url: string) => Promise<unknown>
}

/**
 * The list: a fresh cache (unless forced), else the network (cached when it parses), else the last
 * accepted list, else conf's first release bundled here. Never throws.
 */
export async function fetchLiteRtLmList(
  options: LiteRtLmListOptions = {}
): Promise<LiteRtLmListResult> {
  const cache = options.cache ?? indexedDbListCache
  const fetchJson = options.fetchJson ?? fetchJsonFrom
  const cached = await cache.read()
  const accepted = (() => {
    if (!cached) return null
    try {
      return parseLiteRtLmList(cached.value)
    } catch {
      return null
    }
  })()
  if (!options.force && cached && accepted && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { list: accepted, source: 'cache', fetchedAt: cached.fetchedAt }
  }
  try {
    const raw = await withTimeout(fetchJson(options.url ?? LITERT_LM_MODELS_URL), FETCH_TIMEOUT_MS)
    const list = parseLiteRtLmList(raw)
    const fetchedAt = Date.now()
    await cache.write(raw, fetchedAt)
    return { list, source: 'remote', fetchedAt }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (accepted && cached) return { list: accepted, source: 'cache', fetchedAt: cached.fetchedAt, error: message }
    return { list: parseLiteRtLmList(BASELINE_LIST), source: 'baseline', fetchedAt: null, error: message }
  }
}
