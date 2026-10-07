/**
 * Embedding catalog registry — remote configuration loader.
 *
 * The embedding models the app offers live in
 * `AtomicBot-ai/atomic-chat-conf/models/embedding.json`. Every one runs on
 * stock llama.cpp (`engine: 'llamacpp-upstream'`, `llama-server --embedding`)
 * from a GGUF, plus a projector for one that reads images or audio, and is
 * served on the Local API Server's `/v1/embeddings` under its catalog `id`.
 * Fetched at runtime, cached for an hour, backed by a generated snapshot
 * ({@link BASELINE_EMBEDDING_CATALOG}) for the offline first launch.
 *
 * Same architecture as `decision-catalog-registry.ts`, isolated from it (own
 * cache keys, URL and schema). Parsing is strict and mirrors the conf repo's
 * `schema.embedding.json` and `embedding-catalog-check.mjs`: every file path
 * becomes a download URL and a path under `<data>/embedding/models/<id>`, so
 * a manifest must not be able to climb out of that folder, and every file
 * carries the size and sha256 the downloader verifies.
 */

import { fetch as fetchTauri } from '@tauri-apps/plugin-http'

import { BASELINE_EMBEDDING_CATALOG } from './embedding-catalog-baseline'

export const DEFAULT_EMBEDDING_CATALOG_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/embedding.json'

export const EMBEDDING_CATALOG_URL: string =
  (import.meta.env.VITE_EMBEDDING_CATALOG_URL as string | undefined) ??
  DEFAULT_EMBEDDING_CATALOG_URL

/** Highest manifest schema_version this client understands. */
export const SUPPORTED_SCHEMA_VERSION = 1

/** Cache TTL (1 hour) — matches the other registries. */
export const CACHE_TTL_MS = 60 * 60 * 1000

const CACHE_KEY = 'atomic_embedding_catalog_cache_v1'
const CACHE_TS_KEY = 'atomic_embedding_catalog_cache_ts_v1'

const FETCH_TIMEOUT_MS = 5000

/** The provider whose builds run embedding models. Also the settings page that manages them. */
export type EmbeddingEngine = 'llamacpp-upstream'

/** `--pooling`, the model's own. */
export const EMBEDDING_POOLINGS = ['mean', 'cls', 'last'] as const
export type EmbeddingPooling = (typeof EMBEDDING_POOLINGS)[number]

/** What one input may hold. Anything beyond text needs the projector. */
export const EMBEDDING_CATALOG_MODALITIES = ['text', 'image', 'audio'] as const
export type EmbeddingCatalogModality =
  (typeof EMBEDDING_CATALOG_MODALITIES)[number]

export type EmbeddingCatalogFile = {
  /** Path inside the repo and inside the model folder; always a `.gguf`. */
  path: string
  bytes: number
  sha256: string
  /** The file passed with `-m`, or the projector passed with `--mmproj`. */
  role: 'model' | 'mmproj'
}

/** Text the model expects in front of each input. The server never adds it. */
export type EmbeddingPrompts = {
  query?: string
  document?: string
}

export type EmbeddingCatalogModel = {
  id: string
  name: string
  description: string
  repo: string
  /** The commit every file is downloaded from. */
  revision: string
  params: string
  /** `multilingual` or a two-letter language code. */
  languages: string
  /** Tokens per input the engine is started with (`-c`, `-b`, `-ub`). */
  context: number
  /** The longest input the model was trained for; never below `context`. */
  max_context: number
  /** Length of the vectors `/v1/embeddings` returns. */
  dims: number
  /** Shorter lengths the vectors can be cut to, largest first, all below `dims`. */
  matryoshka_dims?: number[]
  pooling: EmbeddingPooling
  /** Always holds `text`; `image` / `audio` come with a projector. */
  modalities: EmbeddingCatalogModality[]
  /** `--image-max-tokens`; image models only, at most half of `context`. */
  image_max_tokens?: number
  prompts?: EmbeddingPrompts
  license: string
  default?: boolean
  /** The oldest upstream llama.cpp release that runs it, `b<build>`. */
  min_engine: string
  engine: EmbeddingEngine
  format: 'gguf'
  /** Logo key (`ICON_KEY_LOGOS`). */
  icon: string
  files: EmbeddingCatalogFile[]
}

export type EmbeddingCatalog = {
  schema_version: number
  updated_at: string
  models: EmbeddingCatalogModel[]
}

/** The manifest as published. The bundled baseline is typed with it. */
export type EmbeddingCatalogManifest = EmbeddingCatalog

export type EmbeddingCatalogSource = 'remote' | 'cache' | 'baseline'

export type EmbeddingCatalogFetchResult = {
  catalog: EmbeddingCatalog
  source: EmbeddingCatalogSource
  fetchedAt: number | null
  error?: string
}

const ID_RE = /^[a-z0-9][a-z0-9.-]*$/
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const REVISION_RE = /^[0-9a-f]{40}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const LANGUAGES_RE = /^(multilingual|[a-z]{2})$/
const MIN_ENGINE_RE = /^b[0-9]+$/
const ICON_RE = /^[a-z0-9][a-z0-9-]*$/
const PATH_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\.gguf$/

/** The schema's floor for `context` and `max_context`. */
const MIN_CONTEXT = 64

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

/**
 * A file path is safe when it is a GGUF and every segment is a plain name (no
 * `.`, `..` or empty segment).
 */
export const isSafeEmbeddingFilePath = (value: string): boolean =>
  PATH_RE.test(value) &&
  value.split('/').every((segment) => segment !== '.' && segment !== '..')

const sanitizeFile = (raw: unknown): EmbeddingCatalogFile | null => {
  if (!isRecord(raw)) return null
  if (typeof raw.path !== 'string' || !isSafeEmbeddingFilePath(raw.path))
    return null
  if (!isPositiveInt(raw.bytes)) return null
  if (typeof raw.sha256 !== 'string' || !SHA256_RE.test(raw.sha256)) return null
  if (raw.role !== 'model' && raw.role !== 'mmproj') return null
  return {
    path: raw.path,
    bytes: raw.bytes,
    sha256: raw.sha256,
    role: raw.role,
  }
}

const sanitizeModalities = (
  raw: unknown
): EmbeddingCatalogModality[] | null => {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const modalities: EmbeddingCatalogModality[] = []
  for (const entry of raw) {
    const modality = EMBEDDING_CATALOG_MODALITIES.find((m) => m === entry)
    if (!modality || modalities.includes(modality)) return null
    modalities.push(modality)
  }
  return modalities.includes('text') ? modalities : null
}

/** Strictly decreasing, every length below `dims`; `undefined` when absent, `null` when broken. */
const sanitizeMatryoshka = (
  raw: unknown,
  dims: number
): number[] | undefined | null => {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length === 0) return null
  for (let i = 0; i < raw.length; i++) {
    const value: unknown = raw[i]
    if (!isPositiveInt(value) || value >= dims) return null
    if (i > 0 && value >= (raw[i - 1] as number)) return null
  }
  return raw as number[]
}

/** At least one non-empty prompt, nothing else; `undefined` when absent, `null` when broken. */
const sanitizePrompts = (raw: unknown): EmbeddingPrompts | undefined | null => {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) return null
  const prompts: EmbeddingPrompts = {}
  for (const [key, value] of Object.entries(raw)) {
    if ((key !== 'query' && key !== 'document') || !isNonEmptyString(value))
      return null
    prompts[key] = value
  }
  return Object.keys(prompts).length > 0 ? prompts : null
}

/**
 * Strip unknown keys and reject a model that could not be downloaded or run as
 * written: a missing or malformed required field, a file without its size or
 * hash, a duplicate path, not exactly one model file, more than one projector,
 * a projector without a modality beyond text (or one such modality without a
 * projector), an image budget past half the context or on a model that reads
 * no images, a `max_context` below `context`, Matryoshka lengths that do not
 * shrink below `dims`, or an engine other than stock llama.cpp.
 */
export const sanitizeEmbeddingModel = (
  raw: unknown
): EmbeddingCatalogModel | null => {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null
  if (!isNonEmptyString(raw.name)) return null
  if (!isNonEmptyString(raw.description)) return null
  if (typeof raw.repo !== 'string' || !REPO_RE.test(raw.repo)) return null
  if (typeof raw.revision !== 'string' || !REVISION_RE.test(raw.revision))
    return null
  if (!isNonEmptyString(raw.params)) return null
  if (typeof raw.languages !== 'string' || !LANGUAGES_RE.test(raw.languages))
    return null
  if (!isPositiveInt(raw.context) || raw.context < MIN_CONTEXT) return null
  if (!isPositiveInt(raw.max_context) || raw.max_context < raw.context)
    return null
  if (!isPositiveInt(raw.dims)) return null
  const pooling = EMBEDDING_POOLINGS.find((p) => p === raw.pooling)
  if (!pooling) return null
  const modalities = sanitizeModalities(raw.modalities)
  if (!modalities) return null
  if (!isNonEmptyString(raw.license)) return null
  if (typeof raw.min_engine !== 'string' || !MIN_ENGINE_RE.test(raw.min_engine))
    return null
  if (raw.engine !== 'llamacpp-upstream' || raw.format !== 'gguf') return null
  if (typeof raw.icon !== 'string' || !ICON_RE.test(raw.icon)) return null
  if (!Array.isArray(raw.files)) return null

  const files: EmbeddingCatalogFile[] = []
  const paths = new Set<string>()
  for (const entry of raw.files) {
    const file = sanitizeFile(entry)
    if (!file || paths.has(file.path)) return null
    paths.add(file.path)
    files.push(file)
  }
  const models = files.filter((file) => file.role === 'model')
  const projectors = files.filter((file) => file.role === 'mmproj')
  if (models.length !== 1 || projectors.length > 1) return null
  // A projector exactly when the model reads more than text.
  const multimodal = modalities.some((modality) => modality !== 'text')
  if (multimodal !== (projectors.length === 1)) return null

  let imageMaxTokens: number | undefined
  if (raw.image_max_tokens !== undefined) {
    if (!isPositiveInt(raw.image_max_tokens)) return null
    // llama-server caps an image at half the batch; a larger budget is cut.
    if (!modalities.includes('image') || raw.image_max_tokens * 2 > raw.context)
      return null
    imageMaxTokens = raw.image_max_tokens
  }
  const matryoshka = sanitizeMatryoshka(raw.matryoshka_dims, raw.dims)
  if (matryoshka === null) return null
  const prompts = sanitizePrompts(raw.prompts)
  if (prompts === null) return null

  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    repo: raw.repo,
    revision: raw.revision,
    params: raw.params,
    languages: raw.languages,
    context: raw.context,
    max_context: raw.max_context,
    dims: raw.dims,
    ...(matryoshka ? { matryoshka_dims: matryoshka } : {}),
    pooling,
    modalities,
    ...(imageMaxTokens ? { image_max_tokens: imageMaxTokens } : {}),
    ...(prompts ? { prompts } : {}),
    license: raw.license,
    ...(raw.default === true ? { default: true } : {}),
    min_engine: raw.min_engine,
    engine: 'llamacpp-upstream',
    format: 'gguf',
    icon: raw.icon,
    files,
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
 * Invalid models are dropped (and logged), and so is a second default; a
 * payload with no usable model is rejected so the caller falls back.
 */
export const parseEmbeddingCatalog = (data: unknown): EmbeddingCatalog => {
  if (!isCatalogShape(data)) {
    throw new Error('Embedding catalog payload is not a valid manifest')
  }
  if (data.schema_version > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `Embedding catalog schema_version ${data.schema_version} is newer than ` +
        `supported (${SUPPORTED_SCHEMA_VERSION}). Update the application to read it.`
    )
  }
  const models: EmbeddingCatalogModel[] = []
  const seen = new Set<string>()
  let hasDefault = false
  for (const raw of data.models) {
    const model = sanitizeEmbeddingModel(raw)
    if (!model) {
      const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : '?'
      console.warn(`[embedding-catalog-registry] Dropping invalid model ${id}`)
      continue
    }
    if (seen.has(model.id)) continue
    seen.add(model.id)
    if (model.default) {
      // At most one: the first one listed keeps it.
      if (hasDefault) delete model.default
      hasDefault = true
    }
    models.push(model)
  }
  if (models.length === 0) {
    throw new Error('Embedding catalog carries no usable model')
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

export type CachedEmbeddingCatalog = {
  catalog: EmbeddingCatalog
  fetchedAt: number
}

export const getCachedEmbeddingCatalog = (): CachedEmbeddingCatalog | null => {
  const ls = safeLocalStorage()
  if (!ls) return null
  try {
    const raw = ls.getItem(CACHE_KEY)
    const tsRaw = ls.getItem(CACHE_TS_KEY)
    if (!raw || !tsRaw) return null
    const fetchedAt = Number(tsRaw)
    if (!Number.isFinite(fetchedAt)) return null
    // Re-validated on read: the rules can tighten between releases.
    return { catalog: parseEmbeddingCatalog(JSON.parse(raw)), fetchedAt }
  } catch {
    return null
  }
}

export const isEmbeddingCatalogCacheFresh = (
  cached: CachedEmbeddingCatalog | null
): boolean => cached !== null && Date.now() - cached.fetchedAt < CACHE_TTL_MS

const writeCache = (catalog: EmbeddingCatalog, fetchedAt: number): void => {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.setItem(CACHE_KEY, JSON.stringify(catalog))
    ls.setItem(CACHE_TS_KEY, String(fetchedAt))
  } catch (error) {
    console.warn('[embedding-catalog-registry] Failed to write cache:', error)
  }
}

export const clearEmbeddingCatalogCache = (): void => {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.removeItem(CACHE_KEY)
    ls.removeItem(CACHE_TS_KEY)
  } catch (error) {
    console.warn('[embedding-catalog-registry] Failed to clear cache:', error)
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
      `Embedding catalog fetch failed: ${response.status} ${response.statusText}`
    )
  }
  return (await response.json()) as unknown
}

const fetchCatalog = async (
  url: string,
  signal?: AbortSignal
): Promise<EmbeddingCatalog> => {
  let data: unknown
  try {
    data = await fetchOnce(fetch, url, signal)
  } catch (primaryError) {
    if (!isTauriRuntime()) throw primaryError
    console.warn(
      '[embedding-catalog-registry] standard fetch failed, retrying via Tauri HTTP plugin:',
      primaryError instanceof Error ? primaryError.message : primaryError
    )
    data = await fetchOnce(fetchTauri as typeof fetch, url, signal)
  }
  return parseEmbeddingCatalog(data)
}

/** Tauri's HTTP plugin does not always honour `AbortSignal`; a timer guarantees resolution. */
const withHardTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`Embedding catalog fetch timed out after ${timeoutMs}ms`)
        ),
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

export type EmbeddingCatalogFetchOptions = {
  /** Bypass the cache freshness check and force a network round-trip. */
  force?: boolean
  /** Override URL (for tests). */
  url?: string
  /** Abort the network request after this many ms. Default: 5000. */
  timeoutMs?: number
}

/** The bundled snapshot, re-validated so a stale generator cannot ship junk. */
export const getBaselineEmbeddingCatalog = (): EmbeddingCatalog =>
  parseEmbeddingCatalog(BASELINE_EMBEDDING_CATALOG)

/**
 * Resolve the catalog: fresh cache (unless forced), then the network (cached
 * on success), then a stale cache, then the bundled snapshot. Never throws.
 */
export const fetchEmbeddingCatalog = async (
  options: EmbeddingCatalogFetchOptions = {}
): Promise<EmbeddingCatalogFetchResult> => {
  const {
    force = false,
    url = EMBEDDING_CATALOG_URL,
    timeoutMs = FETCH_TIMEOUT_MS,
  } = options

  const cached = getCachedEmbeddingCatalog()
  if (!force && isEmbeddingCatalogCacheFresh(cached) && cached) {
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
    try {
      controller.abort()
    } catch {
      // ignore
    }
    const message =
      error instanceof Error ? error.message : 'Unknown embedding catalog error'
    console.warn('[embedding-catalog-registry] Falling back:', message)
    if (cached) {
      return {
        catalog: cached.catalog,
        source: 'cache',
        fetchedAt: cached.fetchedAt,
        error: message,
      }
    }
    return {
      catalog: getBaselineEmbeddingCatalog(),
      source: 'baseline',
      fetchedAt: null,
      error: message,
    }
  }
}

/** Where a model's file is downloaded from: the pinned revision, never a branch. */
export const embeddingFileUrl = (
  model: EmbeddingCatalogModel,
  file: EmbeddingCatalogFile
): string =>
  `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.path}`

/** The model's `-m` file. */
export const embeddingModelFile = (
  model: EmbeddingCatalogModel
): EmbeddingCatalogFile =>
  model.files.find((file) => file.role === 'model') ?? model.files[0]!

/** The model's projector (`--mmproj`); `undefined` for a text-only model. */
export const embeddingProjectorFile = (
  model: EmbeddingCatalogModel
): EmbeddingCatalogFile | undefined =>
  model.files.find((file) => file.role === 'mmproj')

/** Bytes of the model's files on disk: the GGUF and its projector. */
export const embeddingDiskBytes = (model: EmbeddingCatalogModel): number =>
  model.files.reduce((sum, file) => sum + file.bytes, 0)

/** `embeddinggemma-300M-Q8_0.gguf` → `Q8_0`: what the model downloads as. */
export const embeddingQuantLabel = (model: EmbeddingCatalogModel): string => {
  const match = /[-_.]((?:I?Q\d+(?:_[A-Z0-9]+)*)|BF16|F16|F32)\.gguf$/i.exec(
    embeddingModelFile(model).path
  )
  return match ? match[1].toUpperCase() : 'GGUF'
}

/** Whether one input may hold more than text (an image or a recording). */
export const isMultimodalEmbeddingModel = (
  model: Pick<EmbeddingCatalogModel, 'modalities'>
): boolean => model.modalities.some((modality) => modality !== 'text')
