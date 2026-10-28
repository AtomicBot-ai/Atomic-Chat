/**
 * GenieX's curated model list — `atomic-chat-conf/models/geniex-models.json` (openspec change
 * `add-geniex-runtime`, spec `geniex-models`).
 *
 * The list names the models Atomic Chat has checked, of two kinds: a GGUF file in a Hugging Face
 * repository pinned to a commit, with its size and sha256, its projector for vision and the devices
 * it is offered on; and a Qualcomm AI Hub bundle per chip, a zip on Qualcomm's S3 with our own
 * sha256. It also carries the rules for the Hugging Face GGUF models the Hub shows after the curated
 * ones: the quantizations to offer, and the devices each platform may offer for them. It may hold no
 * model at all: the Hub then shows Hugging Face models only, and no bundles.
 *
 * Fetched at runtime, cached in IndexedDB for an hour; the last accepted list is kept when the
 * network fails or main carries a list this client cannot read, and conf's first release is bundled
 * for a first launch without network. Parsing is strict by field and soft by entry, mirroring conf's
 * schema: a model of a kind, a variant of a chip and a device this client does not know are hidden,
 * and so is a model left with nothing — so conf can add a new chip or kind next to the old ones
 * without breaking released apps (spec "Клиент пропускает то, чего не понимает"). A document with a
 * newer `schema_version` is refused whole.
 */

import { invoke } from '@tauri-apps/api/core'
import { fetch as fetchTauri } from '@tauri-apps/plugin-http'

import baselineList from './baseline-models.json'
import { GENIEX_CHIPS, GENIEX_DEVICES, type GeniexChip, type GeniexDevice, type GeniexHubFile } from './types'

export const DEFAULT_GENIEX_MODELS_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/geniex-models.json'

/**
 * Where the list is read from. A dev build may point it elsewhere — a branch of conf, or a local
 * file (`file:///…/atomic-chat-conf/models/geniex-models.json`) while conf is unmerged.
 */
export const GENIEX_MODELS_URL: string =
  (import.meta.env.DEV
    ? (import.meta.env.VITE_GENIEX_MODELS_URL as string | undefined)
    : undefined) ?? DEFAULT_GENIEX_MODELS_URL

/** Highest `schema_version` this client understands. */
export const SUPPORTED_SCHEMA_VERSION = 1

/** Cache TTL (1 hour) — the other conf registries' posture. */
export const CACHE_TTL_MS = 60 * 60 * 1000

const FETCH_TIMEOUT_MS = 10_000

/** The platforms GenieX's SDK ships for, as conf names them. */
export const GENIEX_PLATFORMS = ['win-arm64'] as const
export type GeniexPlatform = (typeof GENIEX_PLATFORMS)[number]

/** Where AI Hub bundles are allowed to come from: Qualcomm's S3, like conf's schema says. */
const BUNDLE_URL = /^https:\/\/qaihub-public-assets\.s3\.us-west-2\.amazonaws\.com\/qai-hub-models\//

export type GeniexFile = GeniexHubFile

export interface GeniexGgufModel {
  kind: 'gguf'
  id: string
  name: string
  description: string
  task: 'chat'
  license: string
  context_length: number
  tools: boolean
  reasoning: boolean
  vision: boolean
  gguf: {
    /** `<org>/<name>` on Hugging Face. */
    repo: string
    /** The commit every file is downloaded from. */
    revision: string
    /** The repository asks for its terms to be accepted: downloads need the person's HF token. */
    gated: boolean
    file: GeniexFile
    /** Present exactly when `vision` is true. */
    mmproj?: GeniexFile
    /** The devices the model is offered on, in conf's order. */
    devices: GeniexDevice[]
    platforms: GeniexPlatform[]
  }
}

export interface GeniexBundleVariant {
  /** Unique across the list: names the download and the folder `<data>/geniex/models/<id>`. */
  id: string
  chip: GeniexChip
  bundle: { url: string; size: number; sha256: string }
  precision: string
  /** Oldest GenieX the bundle loads in, when conf knows it before download. */
  min_runtime_version?: string
}

export interface GeniexBundleModel {
  kind: 'qairt'
  id: string
  name: string
  description: string
  task: 'chat'
  license: string
  context_length: number
  tools: boolean
  reasoning: boolean
  vision: boolean
  variants: GeniexBundleVariant[]
}

export type GeniexModel = GeniexGgufModel | GeniexBundleModel

export interface GeniexList {
  schema_version: number
  updated_at: string
  huggingface: {
    /** The GGUF quantizations the Hub offers from a Hugging Face repository (`Q4_0`, …). */
    quantizations: string[]
    /** Platform → the devices a Hugging Face model may be offered on there; absent: none. */
    backends: Partial<Record<GeniexPlatform, GeniexDevice[]>>
  }
  models: GeniexModel[]
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const ID = /^[a-z0-9][a-z0-9._-]*$/
const GGUF = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\.gguf$/
const SHA256 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const VERSION = /^\d+\.\d+(\.\d+)?$/
const QUANTIZATION = /^[A-Za-z0-9_]+$/

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0
const isDevice = (value: unknown): value is GeniexDevice => GENIEX_DEVICES.includes(value as GeniexDevice)
const isChip = (value: unknown): value is GeniexChip => GENIEX_CHIPS.includes(value as GeniexChip)
const isPlatform = (value: unknown): value is GeniexPlatform =>
  GENIEX_PLATFORMS.includes(value as GeniexPlatform)
const isSafeGguf = (value: unknown): value is string =>
  typeof value === 'string' &&
  GGUF.test(value) &&
  !value.split('/').some((segment) => segment === '.' || segment === '..')

function parseGgufFile(raw: unknown): GeniexFile | null {
  if (!isObject(raw)) return null
  const { path, size, sha256 } = raw
  if (!isSafeGguf(path) || !isPositiveInt(size) || typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    return null
  }
  return { path, size, sha256 }
}

/** The fields every model carries, whatever its kind; `null` for a malformed one. */
function parseCommon(raw: Json) {
  const { id, name, description, task, license, context_length, tools, reasoning, vision } = raw
  if (typeof id !== 'string' || !ID.test(id)) return null
  if (!isString(name) || !isString(description) || task !== 'chat' || !isString(license)) return null
  if (!isPositiveInt(context_length)) return null
  if (typeof tools !== 'boolean' || typeof reasoning !== 'boolean' || typeof vision !== 'boolean') {
    return null
  }
  return { id, name, description, task, license, context_length, tools, reasoning, vision }
}

function parseGgufModel(raw: Json): GeniexGgufModel | null {
  const common = parseCommon(raw)
  if (!common) return null
  const { repo, revision, gated, devices, platforms } = raw
  if (typeof repo !== 'string' || !REPO.test(repo)) return null
  if (typeof revision !== 'string' || !COMMIT.test(revision)) return null
  if (typeof gated !== 'boolean') return null
  const file = parseGgufFile(raw.file)
  if (!file) return null
  const mmproj = raw.mmproj === undefined ? undefined : parseGgufFile(raw.mmproj)
  if (mmproj === null) return null
  // A vision model needs its projector: without one the file is a text model mislabelled.
  if (common.vision && !mmproj) return null
  // A device or platform this client does not know is left out; a model left with none is hidden.
  const knownDevices = Array.isArray(devices) ? [...new Set(devices.filter(isDevice))] : []
  const knownPlatforms = Array.isArray(platforms) ? [...new Set(platforms.filter(isPlatform))] : []
  if (knownDevices.length === 0 || knownPlatforms.length === 0) return null
  return {
    kind: 'gguf',
    ...common,
    gguf: {
      repo,
      revision,
      gated,
      file,
      ...(mmproj ? { mmproj } : {}),
      devices: knownDevices,
      platforms: knownPlatforms,
    },
  }
}

function parseVariant(raw: unknown): GeniexBundleVariant | null {
  if (!isObject(raw)) return null
  const { id, chip, bundle, precision, min_runtime_version } = raw
  if (typeof id !== 'string' || !ID.test(id)) return null
  // A bundle is compiled for one chip: one this client does not know runs nowhere it knows.
  if (!isChip(chip)) return null
  if (!isObject(bundle)) return null
  const { url, size, sha256 } = bundle
  if (typeof url !== 'string' || !BUNDLE_URL.test(url)) return null
  if (!isPositiveInt(size) || typeof sha256 !== 'string' || !SHA256.test(sha256)) return null
  if (!isString(precision)) return null
  return {
    id,
    chip,
    bundle: { url, size, sha256 },
    precision,
    ...(typeof min_runtime_version === 'string' && VERSION.test(min_runtime_version)
      ? { min_runtime_version }
      : {}),
  }
}

function parseBundleModel(raw: Json): GeniexBundleModel | null {
  const common = parseCommon(raw)
  if (!common) return null
  if (!Array.isArray(raw.variants)) return null
  const variants = raw.variants
    .map(parseVariant)
    .filter((variant): variant is GeniexBundleVariant => variant !== null)
  if (variants.length === 0) return null
  return { kind: 'qairt', ...common, variants }
}

function parseModel(raw: unknown): GeniexModel | null {
  if (!isObject(raw)) return null
  // A kind this client does not know is hidden, not the list (spec "Клиент пропускает то, чего не понимает").
  if (raw.kind === 'gguf') return parseGgufModel(raw)
  if (raw.kind === 'qairt') return parseBundleModel(raw)
  return null
}

/** The Hugging Face rules this client can use; unusable ones mean no Hugging Face models, not no list. */
function parseHuggingFace(raw: unknown): GeniexList['huggingface'] {
  if (!isObject(raw)) return { quantizations: [], backends: {} }
  const quantizations = Array.isArray(raw.quantizations)
    ? [...new Set(raw.quantizations.filter((q): q is string => typeof q === 'string' && QUANTIZATION.test(q)))]
    : []
  const backends: GeniexList['huggingface']['backends'] = {}
  if (isObject(raw.backends)) {
    for (const [platform, list] of Object.entries(raw.backends)) {
      if (isPlatform(platform) && Array.isArray(list)) {
        backends[platform] = [...new Set(list.filter(isDevice))]
      }
    }
  }
  return { quantizations, backends }
}

/**
 * The list as this client can use it. Throws only when the document as a whole cannot be used: a
 * newer `schema_version` or no models array. Entries it does not understand are skipped.
 */
export function parseGeniexList(raw: unknown): GeniexList {
  if (!isObject(raw)) throw new Error('The GenieX model list is not an object.')
  const { schema_version, updated_at, models } = raw
  if (!isPositiveInt(schema_version)) throw new Error('The GenieX model list has no schema_version.')
  if (schema_version > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `The GenieX model list has schema_version ${schema_version}; this app reads ${SUPPORTED_SCHEMA_VERSION}.`
    )
  }
  if (!Array.isArray(models)) throw new Error('The GenieX model list has no models array.')
  return {
    schema_version,
    updated_at: typeof updated_at === 'string' ? updated_at : '',
    huggingface: parseHuggingFace(raw.huggingface),
    models: models.map(parseModel).filter((model): model is GeniexModel => model !== null),
  }
}

/** conf's first release of the list (a byte copy of it), for a first launch that cannot reach conf. */
const BASELINE_LIST: unknown = baselineList

// ── Cache ────────────────────────────────────────────────────────────────────

/** Where the last accepted document is kept: the raw JSON and when it was fetched. */
export interface GeniexListCache {
  read(): Promise<{ value: unknown; fetchedAt: number } | null>
  write(value: unknown, fetchedAt: number): Promise<void>
}

const CACHE_DB_NAME = 'atomic_geniex_models_cache'
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
export const indexedDbListCache: GeniexListCache = {
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
    if (!response.ok) throw new Error(`GenieX model list: ${response.status} ${response.statusText}`)
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
    const timer = setTimeout(() => reject(new Error(`GenieX model list: no answer in ${ms} ms`)), ms)
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

export interface GeniexListResult {
  /** `null` only if not even the bundled baseline parses, which a test pins. */
  list: GeniexList | null
  source: 'remote' | 'cache' | 'baseline'
  fetchedAt: number | null
  /** Why the network answer was not used, when it was not. */
  error?: string
}

export interface GeniexListOptions {
  force?: boolean
  url?: string
  cache?: GeniexListCache
  fetchJson?: (url: string) => Promise<unknown>
}

/**
 * The list: a fresh cache (unless forced), else the network (cached when it parses), else the last
 * accepted list, else conf's first release bundled here. Never throws.
 */
export async function fetchGeniexList(options: GeniexListOptions = {}): Promise<GeniexListResult> {
  const cache = options.cache ?? indexedDbListCache
  const fetchJson = options.fetchJson ?? fetchJsonFrom
  const cached = await cache.read()
  const accepted = (() => {
    if (!cached) return null
    try {
      return parseGeniexList(cached.value)
    } catch {
      return null
    }
  })()
  if (!options.force && cached && accepted && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { list: accepted, source: 'cache', fetchedAt: cached.fetchedAt }
  }
  try {
    const raw = await withTimeout(fetchJson(options.url ?? GENIEX_MODELS_URL), FETCH_TIMEOUT_MS)
    const list = parseGeniexList(raw)
    const fetchedAt = Date.now()
    await cache.write(raw, fetchedAt)
    return { list, source: 'remote', fetchedAt }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (accepted && cached) return { list: accepted, source: 'cache', fetchedAt: cached.fetchedAt, error: message }
    return { list: parseGeniexList(BASELINE_LIST), source: 'baseline', fetchedAt: null, error: message }
  }
}
