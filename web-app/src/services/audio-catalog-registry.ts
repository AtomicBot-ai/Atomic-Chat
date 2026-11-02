/**
 * Audio catalog registry — remote configuration loader.
 *
 * The speech, music and sound-effect models the Audios studio offers are the
 * `audio` collection of `AtomicBot-ai/atomic-chat-conf/models/catalog.json`,
 * the one model catalog every desktop collection projects from
 * (`unified-model-catalog.ts`): it is fetched, cached and backed offline by
 * the bundled unified snapshot there, not here. `models/audio.json` is only a
 * generated export of that collection; {@link fetchAudioCatalog} reads such a
 * file only when a caller names its URL.
 *
 * The JSON keys stay snake_case so the in-memory shape is the projected
 * collection verbatim; `lib/audio/models.ts` translates once, into the core's
 * load request.
 *
 * Parsing is strict and mirrors the conf repo's `audio-catalog-check.mjs`:
 * every path becomes a download URL and a file under `<data>/audio/models`, so
 * a manifest must not be able to climb out of that folder, every quant carries
 * the size and sha256 the downloader verifies, and every model the immutable
 * revision they were measured at. `controls`, `defaults` and `ranges` are data:
 * nothing in the app knows them by model id. A control this build does not
 * know is dropped, not the model.
 */

import { fetch as fetchTauri } from '@tauri-apps/plugin-http'

import {
  unifiedModelBaseline,
  unifiedModelCollection,
} from './unified-model-catalog'
import {
  AUDIO_MODES,
  type AudioMode,
  type AudioOptions,
  type AudioTask,
} from './audio/types'

/** @deprecated The generated export's URL, for a caller that names it. The studio projects models/catalog.json. */
export const DEFAULT_AUDIO_CATALOG_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/audio.json'

export const AUDIO_CATALOG_URL: string =
  (import.meta.env.VITE_AUDIO_CATALOG_URL as string | undefined) ??
  DEFAULT_AUDIO_CATALOG_URL

/** Highest manifest schema_version this client understands. */
export const SUPPORTED_SCHEMA_VERSION = 1

/** Cache TTL (1 hour) — matches the other registries. */
export const CACHE_TTL_MS = 60 * 60 * 1000

const CACHE_KEY = 'atomic_audio_catalog_cache_v1'
const CACHE_TS_KEY = 'atomic_audio_catalog_cache_ts_v1'

const FETCH_TIMEOUT_MS = 5000

/** The engine every catalog model runs on. */
const AUDIO_CATALOG_ENGINE = 'audio-cpp'

/** The form fields a model takes, in the order the studio lays them out. */
export const AUDIO_CONTROLS = [
  'voice',
  'speed',
  'language',
  'instruct',
  'lyrics',
  'durationSec',
  'bpm',
  'steps',
  'negativePrompt',
  'seed',
] as const
export type AudioControl = (typeof AUDIO_CONTROLS)[number]

export type AudioCatalogQuant = {
  id: string
  label: string
  /** Path in the repository at the model's `revision`. */
  path: string
  /** The file under `<data>/audio/models/`, and what a load names. */
  filename: string
  bytes: number
  sha256: string
  recommended?: boolean
}

/** What a model's form starts from. */
export type AudioCatalogDefaults = {
  durationSec?: number
  seed?: number
  speed?: number
  bpm?: number
}

/** `[min, max]` of a numeric control. */
export type AudioCatalogRanges = {
  durationSec?: [number, number]
}

export type AudioCatalogModel = {
  /** Catalog id; the wire model id is `<id>:<quant id>`. */
  id: string
  name: string
  developer: string
  description: string
  license: string
  /** Text to show with the model wherever it is offered or used, when its license asks for it. */
  attribution: string | null
  mode: AudioMode
  engines: string[]
  /** `LoadAudioModelRequest.family`. */
  family: string
  /** `LoadAudioModelRequest.task`. */
  task: AudioTask
  repo: string
  /** The immutable Hugging Face commit every quant is downloaded from. */
  revision: string
  quants: AudioCatalogQuant[]
  load_options?: AudioOptions
  session_options?: AudioOptions
  default_request_options?: AudioOptions
  /** A built-in voice for a model that cannot speak without one (`LoadAudioModelRequest.defaultVoice`). */
  default_voice: string | null
  controls: AudioControl[]
  defaults: AudioCatalogDefaults
  ranges?: AudioCatalogRanges
}

export type AudioCatalog = {
  schema_version: number
  updated_at: string
  models: AudioCatalogModel[]
}

export type AudioCatalogSource = 'remote' | 'cache' | 'baseline'

export type AudioCatalogFetchResult = {
  catalog: AudioCatalog
  source: AudioCatalogSource
  fetchedAt: number | null
  error?: string
}

const ID_RE = /^[a-z0-9.-]+$/
const QUANT_ID_RE = /^[a-z0-9_]+$/
const FAMILY_RE = /^[a-z0-9_]+$/
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const REVISION_RE = /^[0-9a-f]{40}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const PATH_RE = /^[A-Za-z0-9._/-]+\.gguf$/
const FILENAME_RE = /^[A-Za-z0-9._-]+\.gguf$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

const isPositiveNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

/** `owner/name`, neither of them a `.` or `..` that would walk the download URL elsewhere. */
const isSafeRepo = (value: unknown): value is string =>
  typeof value === 'string' &&
  REPO_RE.test(value) &&
  value.split('/').every((segment) => !/^\.+$/.test(segment))

/** A repository path is safe when every segment is a plain name (no `.`, `..` or empty segment). */
export const isSafeAudioFilePath = (value: string): boolean =>
  PATH_RE.test(value) &&
  value
    .split('/')
    .every(
      (segment) => segment.length > 0 && segment !== '.' && segment !== '..'
    )

const sanitizeQuant = (raw: unknown): AudioCatalogQuant | null => {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || !QUANT_ID_RE.test(raw.id)) return null
  if (!isNonEmptyString(raw.label)) return null
  if (typeof raw.path !== 'string' || !isSafeAudioFilePath(raw.path))
    return null
  if (typeof raw.filename !== 'string' || !FILENAME_RE.test(raw.filename))
    return null
  if (!isPositiveInt(raw.bytes)) return null
  if (typeof raw.sha256 !== 'string' || !SHA256_RE.test(raw.sha256)) return null
  return {
    id: raw.id,
    label: raw.label,
    path: raw.path,
    filename: raw.filename,
    bytes: raw.bytes,
    sha256: raw.sha256,
    ...(raw.recommended === true ? { recommended: true } : {}),
  }
}

/** String, number or boolean values only; `undefined` when absent, `null` when broken. */
const sanitizeOptions = (raw: unknown): AudioOptions | undefined | null => {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) return null
  const options: AudioOptions = {}
  for (const [key, value] of Object.entries(raw)) {
    if (
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      return null
    options[key] = value
  }
  return options
}

const sanitizeDefaults = (raw: unknown): AudioCatalogDefaults | null => {
  if (!isRecord(raw)) return null
  const { durationSec, seed, speed, bpm } = raw
  if (durationSec !== undefined && !isPositiveNumber(durationSec)) return null
  if (
    seed !== undefined &&
    !(typeof seed === 'number' && Number.isInteger(seed) && seed >= 0)
  )
    return null
  if (speed !== undefined && !isPositiveNumber(speed)) return null
  if (bpm !== undefined && !isPositiveInt(bpm)) return null
  return {
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(speed !== undefined ? { speed } : {}),
    ...(bpm !== undefined ? { bpm } : {}),
  }
}

/** `undefined` when absent, `null` when broken. */
const sanitizeRanges = (
  raw: unknown
): AudioCatalogRanges | undefined | null => {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) return null
  const { durationSec } = raw
  if (durationSec === undefined) return {}
  if (
    !Array.isArray(durationSec) ||
    durationSec.length !== 2 ||
    !durationSec.every(isPositiveNumber) ||
    durationSec[0] > durationSec[1]
  )
    return null
  return { durationSec: [durationSec[0], durationSec[1]] }
}

/**
 * Strip unknown keys and reject a model that could not be downloaded or loaded
 * as written: a missing or malformed required field, a quant without its size
 * or hash, a duplicate quant id or file, a task the mode cannot run (speech is
 * `tts`, music and effects are `gen`), or an engine other than audio.cpp.
 */
export const sanitizeAudioModel = (raw: unknown): AudioCatalogModel | null => {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null
  if (!isNonEmptyString(raw.name)) return null
  if (!isNonEmptyString(raw.developer)) return null
  if (!isNonEmptyString(raw.description)) return null
  if (!isNonEmptyString(raw.license)) return null
  if (raw.attribution !== null && !isNonEmptyString(raw.attribution))
    return null
  const mode = AUDIO_MODES.find((entry) => entry === raw.mode)
  if (!mode) return null
  if (
    !Array.isArray(raw.engines) ||
    !raw.engines.includes(AUDIO_CATALOG_ENGINE)
  )
    return null
  if (typeof raw.family !== 'string' || !FAMILY_RE.test(raw.family)) return null
  const task: AudioTask = mode === 'speech' ? 'tts' : 'gen'
  if (raw.task !== task) return null
  if (!isSafeRepo(raw.repo)) return null
  if (typeof raw.revision !== 'string' || !REVISION_RE.test(raw.revision))
    return null
  if (!Array.isArray(raw.quants) || raw.quants.length === 0) return null

  const quants: AudioCatalogQuant[] = []
  for (const entry of raw.quants) {
    const quant = sanitizeQuant(entry)
    if (!quant) return null
    if (
      quants.some(
        (other) =>
          other.id === quant.id ||
          other.filename === quant.filename ||
          other.path === quant.path
      )
    )
      return null
    quants.push(quant)
  }

  const loadOptions = sanitizeOptions(raw.load_options)
  const sessionOptions = sanitizeOptions(raw.session_options)
  const requestOptions = sanitizeOptions(raw.default_request_options)
  if (
    loadOptions === null ||
    sessionOptions === null ||
    requestOptions === null
  )
    return null
  const defaultVoice = raw.default_voice ?? null
  if (defaultVoice !== null && !isNonEmptyString(defaultVoice)) return null
  if (!Array.isArray(raw.controls)) return null
  const controls = AUDIO_CONTROLS.filter((control) =>
    (raw.controls as unknown[]).includes(control)
  )
  const defaults = sanitizeDefaults(raw.defaults)
  if (!defaults) return null
  const ranges = sanitizeRanges(raw.ranges)
  if (ranges === null) return null

  return {
    id: raw.id,
    name: raw.name,
    developer: raw.developer,
    description: raw.description,
    license: raw.license,
    attribution: raw.attribution,
    mode,
    engines: [AUDIO_CATALOG_ENGINE],
    family: raw.family,
    task,
    repo: raw.repo,
    revision: raw.revision,
    quants,
    ...(loadOptions ? { load_options: loadOptions } : {}),
    ...(sessionOptions ? { session_options: sessionOptions } : {}),
    ...(requestOptions ? { default_request_options: requestOptions } : {}),
    default_voice: defaultVoice,
    controls,
    defaults,
    ...(ranges ? { ranges } : {}),
  }
}

const isCatalogShape = (
  value: unknown
): value is { schema_version: number; updated_at: string; models: unknown[] } =>
  isRecord(value) &&
  typeof value.schema_version === 'number' &&
  typeof value.updated_at === 'string' &&
  Array.isArray(value.models)

/**
 * Parse an untrusted payload into a catalog, or throw when it is not one.
 * Invalid models are dropped (and logged), and so is a repeated id; a payload
 * with no usable model is rejected so the caller falls back.
 */
export const parseAudioCatalog = (data: unknown): AudioCatalog => {
  if (!isCatalogShape(data)) {
    throw new Error('Audio catalog payload is not a valid manifest')
  }
  if (data.schema_version > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `Audio catalog schema_version ${data.schema_version} is newer than ` +
        `supported (${SUPPORTED_SCHEMA_VERSION}). Update the application to read it.`
    )
  }
  const models: AudioCatalogModel[] = []
  const seen = new Set<string>()
  for (const raw of data.models) {
    const model = sanitizeAudioModel(raw)
    if (!model) {
      const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : '?'
      console.warn(`[audio-catalog-registry] Dropping invalid model ${id}`)
      continue
    }
    if (seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  if (models.length === 0) {
    throw new Error('Audio catalog carries no usable model')
  }
  return {
    schema_version: data.schema_version,
    updated_at: data.updated_at,
    models,
  }
}

const safeLocalStorage = (): Storage | null => {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    return null
  }
}

export type CachedAudioCatalog = {
  catalog: AudioCatalog
  fetchedAt: number
}

export const getCachedAudioCatalog = (): CachedAudioCatalog | null => {
  const ls = safeLocalStorage()
  if (!ls) return null
  try {
    const raw = ls.getItem(CACHE_KEY)
    const tsRaw = ls.getItem(CACHE_TS_KEY)
    if (!raw || !tsRaw) return null
    const fetchedAt = Number(tsRaw)
    if (!Number.isFinite(fetchedAt)) return null
    // Re-validated on read: the rules can tighten between releases.
    return { catalog: parseAudioCatalog(JSON.parse(raw)), fetchedAt }
  } catch {
    return null
  }
}

export const isAudioCatalogCacheFresh = (
  cached: CachedAudioCatalog | null
): boolean => cached !== null && Date.now() - cached.fetchedAt < CACHE_TTL_MS

const writeCache = (catalog: AudioCatalog, fetchedAt: number): void => {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.setItem(CACHE_KEY, JSON.stringify(catalog))
    ls.setItem(CACHE_TS_KEY, String(fetchedAt))
  } catch (error) {
    console.warn('[audio-catalog-registry] Failed to write cache:', error)
  }
}

export const clearAudioCatalogCache = (): void => {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.removeItem(CACHE_KEY)
    ls.removeItem(CACHE_TS_KEY)
  } catch (error) {
    console.warn('[audio-catalog-registry] Failed to clear cache:', error)
  }
}

const isTauriRuntime = (): boolean => {
  try {
    return typeof IS_TAURI !== 'undefined' && Boolean(IS_TAURI)
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
      `Audio catalog fetch failed: ${response.status} ${response.statusText}`
    )
  }
  return (await response.json()) as unknown
}

const fetchCatalog = async (
  url: string,
  signal?: AbortSignal
): Promise<AudioCatalog> => {
  let data: unknown
  try {
    data = await fetchOnce(fetch, url, signal)
  } catch (primaryError) {
    if (!isTauriRuntime()) throw primaryError
    console.warn(
      '[audio-catalog-registry] standard fetch failed, retrying via Tauri HTTP plugin:',
      primaryError instanceof Error ? primaryError.message : primaryError
    )
    data = await fetchOnce(fetchTauri as typeof fetch, url, signal)
  }
  return parseAudioCatalog(data)
}

/** Tauri's HTTP plugin does not always honour `AbortSignal`; a timer guarantees resolution. */
const withHardTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`Audio catalog fetch timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
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

export type AudioCatalogFetchOptions = {
  /** Bypass the cache freshness check and force a network round-trip. */
  force?: boolean
  /** Override URL (for tests). */
  url?: string
  /** Abort the network request after this many ms. Default: 5000. */
  timeoutMs?: number
}

/** The `audio` collection of the bundled unified snapshot, re-validated. */
export const getBaselineAudioCatalog = (): AudioCatalog =>
  parseAudioCatalog(unifiedModelBaseline('audio'))

/**
 * Resolve the catalog: the unified catalog's `audio` collection, which brings
 * its own cache and offline snapshot. With `url`, that file instead: fresh
 * cache (unless forced), then the network (cached on success), then a stale
 * cache, then the bundled snapshot. Never throws for a file; a unified
 * collection this build cannot parse throws.
 */
export const fetchAudioCatalog = async (
  options: AudioCatalogFetchOptions = {}
): Promise<AudioCatalogFetchResult> => {
  if (options.url === undefined) {
    const result = await unifiedModelCollection('audio', options.force)
    return {
      catalog: parseAudioCatalog(result.data),
      source: result.source,
      fetchedAt: result.fetchedAt,
      ...(result.error ? { error: result.error } : {}),
    }
  }

  const {
    force = false,
    url = AUDIO_CATALOG_URL,
    timeoutMs = FETCH_TIMEOUT_MS,
  } = options

  const cached = getCachedAudioCatalog()
  if (!force && isAudioCatalogCacheFresh(cached) && cached) {
    return {
      catalog: cached.catalog,
      source: 'cache',
      fetchedAt: cached.fetchedAt,
    }
  }

  const controller = new AbortController()
  const fetchUrl = force
    ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`
    : url
  try {
    const catalog = await withHardTimeout(
      fetchCatalog(fetchUrl, controller.signal),
      timeoutMs
    )
    const fetchedAt = Date.now()
    writeCache(catalog, fetchedAt)
    return { catalog, source: 'remote', fetchedAt }
  } catch (error) {
    controller.abort()
    const message = error instanceof Error ? error.message : String(error)
    console.info(`[audio-catalog-registry] Using a local copy: ${message}`)
    if (cached) {
      return {
        catalog: cached.catalog,
        source: 'cache',
        fetchedAt: cached.fetchedAt,
        error: message,
      }
    }
    return {
      catalog: getBaselineAudioCatalog(),
      source: 'baseline',
      fetchedAt: null,
      error: message,
    }
  }
}

export const findAudioModel = (
  catalog: AudioCatalog,
  id: string
): AudioCatalogModel | undefined =>
  catalog.models.find((model) => model.id === id)

/** The mode's models in catalog order: the first is the mode's default. */
export const audioModelsOf = (
  catalog: AudioCatalog,
  mode: AudioMode
): AudioCatalogModel[] => catalog.models.filter((model) => model.mode === mode)

/** The quant the studio downloads and runs: the recommended one, else the first. */
export const recommendedAudioQuant = (
  model: AudioCatalogModel
): AudioCatalogQuant =>
  model.quants.find((quant) => quant.recommended) ?? model.quants[0]
