/**
 * Diffusion catalog registry — remote configuration loader.
 *
 * The curated list of local image/video generation families lives in
 * `AtomicBot-ai/atomic-chat-conf/models/diffusion.json`. It is fetched at
 * runtime so a new checkpoint or a corrected byte count ships without an app
 * release, cached for an hour, and backed by a generated snapshot
 * ({@link BASELINE_DIFFUSION_CATALOG}) for the offline first launch.
 *
 * Same architecture as `recommended-models-registry.ts`, deliberately isolated
 * from it (own cache keys, own URL, own schema). The JSON keys stay snake_case
 * so the in-memory shape is the manifest verbatim; the camelCase translation
 * happens once, in `lib/diffusion/models.ts::buildLoadRequest`.
 *
 * Parsing is strict: every file name the catalog carries becomes a download
 * URL and an on-disk path, so a malformed or hostile manifest must not be able
 * to smuggle a path segment or a foreign extension through.
 */

import { fetch as fetchTauri } from '@tauri-apps/plugin-http'

import { BASELINE_DIFFUSION_CATALOG } from './diffusion-catalog-baseline'
import type {
  DiffusionFamilyId,
  DiffusionModality,
  DiffusionTextEncoderField,
  ImageWorkflowId,
} from './diffusion/types'

export const DEFAULT_DIFFUSION_CATALOG_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/diffusion.json'

export const DIFFUSION_CATALOG_URL: string =
  (import.meta.env.VITE_DIFFUSION_CATALOG_URL as string | undefined) ??
  DEFAULT_DIFFUSION_CATALOG_URL

/** Highest manifest schema_version this client understands. */
export const SUPPORTED_SCHEMA_VERSION = 1

/** Cache TTL (1 hour) — matches the other registries. */
export const CACHE_TTL_MS = 60 * 60 * 1000

const CACHE_KEY = 'atomic_diffusion_catalog_cache_v1'
const CACHE_TS_KEY = 'atomic_diffusion_catalog_cache_ts_v1'

const FETCH_TIMEOUT_MS = 5000

/** Catalog engine ids (manifest vocabulary; `sdcpp` maps to the `sd-cpp` engine). */
export type DiffusionCatalogEngine = 'sdcpp' | 'diffusers'

/** A side file: VAE or text encoder. */
export type DiffusionCatalogFile = {
  repo: string
  /** Path inside the repo; may carry directories (`split_files/vae/ae.safetensors`). */
  filename: string
  bytes: number
  sha256?: string
  /** Text encoders only: the sd-cli flag the file is passed under. */
  field?: DiffusionTextEncoderField
}

export type DiffusionCatalogQuant = {
  id: string
  label: string
  filename: string
  bytes: number
  sha256?: string
  recommended?: boolean
}

export type DiffusionCatalogFamily = {
  id: DiffusionFamilyId
  name: string
  developer?: string
  description?: string
  license?: string
  gated?: boolean
  modality: DiffusionModality
  engines: DiffusionCatalogEngine[]
  transformer: {
    repo: string
    quants: DiffusionCatalogQuant[]
  }
  vae?: DiffusionCatalogFile
  vae_format?: 'flux2'
  text_encoders: DiffusionCatalogFile[]
  defaults: {
    steps: number
    cfg_scale: number
    guidance?: number
    sampling_method?: string
    flow_shift?: number
    width: number
    height: number
  }
  ranges: {
    steps: [number, number]
    dims: [number, number]
    dim_multiple: number
  }
  capabilities: {
    negative_prompt: boolean
    guidance: boolean
    workflows: ImageWorkflowId[]
  }
}

export type DiffusionCatalog = {
  schema_version: number
  updated_at: string
  families: DiffusionCatalogFamily[]
}

export type DiffusionCatalogSource = 'remote' | 'cache' | 'baseline'

export type DiffusionCatalogFetchResult = {
  catalog: DiffusionCatalog
  source: DiffusionCatalogSource
  fetchedAt: number | null
  error?: string
}

/** Mirrors `DiffusionFamilyId`; the union has no runtime form of its own. */
export const DIFFUSION_FAMILY_IDS: readonly DiffusionFamilyId[] = [
  'z-image',
  'flux.2-klein',
  'flux.1',
  'qwen-image',
  'wan2.2-ti2v-5b',
  'ltx-2',
] as const

const MODALITIES: readonly DiffusionModality[] = ['image', 'video']
const ENGINES: readonly DiffusionCatalogEngine[] = ['sdcpp', 'diffusers']
const TEXT_ENCODER_FIELDS: readonly DiffusionTextEncoderField[] = [
  'llm',
  'qwen2vl',
  'clip_l',
  't5xxl',
]
const WORKFLOWS: readonly ImageWorkflowId[] = ['create', 'transform']

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const QUANT_ID_RE = /^[a-z0-9_]+$/
const QUANT_LABEL_RE = /^[A-Z0-9_]+$/
/** A transformer is one flat GGUF: no directories, no other extension. */
export const QUANT_FILENAME_RE = /^[A-Za-z0-9._-]+\.gguf$/
/** Side files may live in a repo subfolder, but never climb out of it. */
export const SIDE_FILENAME_RE = /^[A-Za-z0-9._/-]+\.(gguf|safetensors)$/
const SHA256_RE = /^[0-9a-f]{64}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const isOneOf = <T extends string>(
  value: unknown,
  allowed: readonly T[]
): value is T => typeof value === 'string' && allowed.includes(value as T)

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

const optionalSha256 = (value: unknown): string | undefined =>
  typeof value === 'string' && SHA256_RE.test(value) ? value : undefined

/**
 * A side-file path is safe when every `/`-separated segment is a plain file
 * or folder name: no `..`, no empty segment, no leading slash.
 */
export const isSafeSideFilename = (value: string): boolean =>
  SIDE_FILENAME_RE.test(value) &&
  value.split('/').every((segment) => segment.length > 0 && segment !== '..')

const sanitizeQuant = (raw: unknown): DiffusionCatalogQuant | null => {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || !QUANT_ID_RE.test(raw.id)) return null
  if (typeof raw.label !== 'string' || !QUANT_LABEL_RE.test(raw.label))
    return null
  if (typeof raw.filename !== 'string' || !QUANT_FILENAME_RE.test(raw.filename))
    return null
  if (!isPositiveInt(raw.bytes)) return null
  const sha256 = optionalSha256(raw.sha256)
  return {
    id: raw.id,
    label: raw.label,
    filename: raw.filename,
    bytes: raw.bytes,
    ...(sha256 ? { sha256 } : {}),
    ...(raw.recommended === true ? { recommended: true } : {}),
  }
}

const sanitizeFile = (
  raw: unknown,
  requireField: boolean
): DiffusionCatalogFile | null => {
  if (!isRecord(raw)) return null
  if (typeof raw.repo !== 'string' || !REPO_RE.test(raw.repo)) return null
  if (typeof raw.filename !== 'string' || !isSafeSideFilename(raw.filename))
    return null
  if (!isPositiveInt(raw.bytes)) return null
  const field = isOneOf(raw.field, TEXT_ENCODER_FIELDS) ? raw.field : undefined
  if (requireField && !field) return null
  const sha256 = optionalSha256(raw.sha256)
  return {
    repo: raw.repo,
    filename: raw.filename,
    bytes: raw.bytes,
    ...(sha256 ? { sha256 } : {}),
    ...(field ? { field } : {}),
  }
}

const sanitizeDefaults = (
  raw: unknown
): DiffusionCatalogFamily['defaults'] | null => {
  if (!isRecord(raw)) return null
  if (!isPositiveInt(raw.steps)) return null
  if (!isFiniteNumber(raw.cfg_scale) || raw.cfg_scale < 0) return null
  if (!isPositiveInt(raw.width) || !isPositiveInt(raw.height)) return null
  const guidance =
    isFiniteNumber(raw.guidance) && raw.guidance >= 0 ? raw.guidance : undefined
  const samplingMethod = optionalString(raw.sampling_method)
  const flowShift = isFiniteNumber(raw.flow_shift) ? raw.flow_shift : undefined
  return {
    steps: raw.steps,
    cfg_scale: raw.cfg_scale,
    ...(guidance !== undefined ? { guidance } : {}),
    ...(samplingMethod ? { sampling_method: samplingMethod } : {}),
    ...(flowShift !== undefined ? { flow_shift: flowShift } : {}),
    width: raw.width,
    height: raw.height,
  }
}

const sanitizeRange = (raw: unknown): [number, number] | null => {
  if (!Array.isArray(raw) || raw.length !== 2) return null
  const [min, max] = raw
  if (!isPositiveInt(min) || !isPositiveInt(max) || min > max) return null
  return [min, max]
}

const sanitizeRanges = (
  raw: unknown
): DiffusionCatalogFamily['ranges'] | null => {
  if (!isRecord(raw)) return null
  const steps = sanitizeRange(raw.steps)
  const dims = sanitizeRange(raw.dims)
  if (!steps || !dims || !isPositiveInt(raw.dim_multiple)) return null
  return { steps, dims, dim_multiple: raw.dim_multiple }
}

const sanitizeCapabilities = (
  raw: unknown
): DiffusionCatalogFamily['capabilities'] | null => {
  if (!isRecord(raw)) return null
  if (typeof raw.negative_prompt !== 'boolean') return null
  if (typeof raw.guidance !== 'boolean') return null
  if (!Array.isArray(raw.workflows)) return null
  const workflows = raw.workflows.filter((w): w is ImageWorkflowId =>
    isOneOf(w, WORKFLOWS)
  )
  return {
    negative_prompt: raw.negative_prompt,
    guidance: raw.guidance,
    workflows,
  }
}

/**
 * Strip unknown keys and reject anything that could not be downloaded or
 * loaded as written. Returns `null` for a family that must be dropped: an
 * unknown id (the plugin keys its argv builder on the id), no valid quant, a
 * malformed VAE or text encoder (the load would fail with a missing file),
 * or malformed defaults/ranges (the form would have nothing to validate against).
 */
export const sanitizeDiffusionFamily = (
  raw: unknown
): DiffusionCatalogFamily | null => {
  if (!isRecord(raw)) return null
  if (!isOneOf(raw.id, DIFFUSION_FAMILY_IDS)) return null
  if (typeof raw.name !== 'string' || raw.name.length === 0) return null
  if (!isOneOf(raw.modality, MODALITIES)) return null
  if (!Array.isArray(raw.engines)) return null
  const engines = raw.engines.filter((e): e is DiffusionCatalogEngine =>
    isOneOf(e, ENGINES)
  )
  if (engines.length === 0) return null

  if (!isRecord(raw.transformer)) return null
  const repo = raw.transformer.repo
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) return null
  if (!Array.isArray(raw.transformer.quants)) return null
  const quants = raw.transformer.quants
    .map(sanitizeQuant)
    .filter((q): q is DiffusionCatalogQuant => q !== null)
  if (quants.length === 0) return null
  const quantIds = new Set<string>()
  for (const quant of quants) {
    if (quantIds.has(quant.id)) return null
    quantIds.add(quant.id)
  }

  let vae: DiffusionCatalogFile | undefined
  if (raw.vae !== undefined) {
    const parsed = sanitizeFile(raw.vae, false)
    if (!parsed) return null
    vae = parsed
  }
  if (raw.vae_format !== undefined && raw.vae_format !== 'flux2') return null

  let textEncoders: DiffusionCatalogFile[] = []
  if (raw.text_encoders !== undefined) {
    if (!Array.isArray(raw.text_encoders)) return null
    textEncoders = []
    for (const entry of raw.text_encoders) {
      const parsed = sanitizeFile(entry, true)
      if (!parsed) return null
      textEncoders.push(parsed)
    }
  }

  const defaults = sanitizeDefaults(raw.defaults)
  const ranges = sanitizeRanges(raw.ranges)
  const capabilities = sanitizeCapabilities(raw.capabilities)
  if (!defaults || !ranges || !capabilities) return null

  const developer = optionalString(raw.developer)
  const description = optionalString(raw.description)
  const license = optionalString(raw.license)

  return {
    id: raw.id,
    name: raw.name,
    ...(developer ? { developer } : {}),
    ...(description ? { description } : {}),
    ...(license ? { license } : {}),
    ...(raw.gated === true ? { gated: true } : {}),
    modality: raw.modality,
    engines,
    transformer: { repo, quants },
    ...(vae ? { vae } : {}),
    ...(raw.vae_format === 'flux2' ? { vae_format: 'flux2' as const } : {}),
    text_encoders: textEncoders,
    defaults,
    ranges,
    capabilities,
  }
}

const isCatalogShape = (
  value: unknown
): value is { schema_version: number; updated_at: string; families: unknown[] } =>
  isRecord(value) &&
  typeof value.schema_version === 'number' &&
  typeof value.updated_at === 'string' &&
  Array.isArray(value.families)

/**
 * Parse an untrusted payload into a catalog, or throw when it is not one.
 * Families that fail validation are dropped (and logged); a payload that
 * yields no family at all is rejected outright so the caller falls back.
 */
export const parseDiffusionCatalog = (data: unknown): DiffusionCatalog => {
  if (!isCatalogShape(data)) {
    throw new Error('Diffusion catalog payload is not a valid manifest')
  }
  if (data.schema_version > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `Diffusion catalog schema_version ${data.schema_version} is newer than ` +
        `supported (${SUPPORTED_SCHEMA_VERSION}). Update the application to read it.`
    )
  }
  const families: DiffusionCatalogFamily[] = []
  const seen = new Set<string>()
  for (const raw of data.families) {
    const family = sanitizeDiffusionFamily(raw)
    if (!family) {
      const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : '?'
      console.warn(`[diffusion-catalog-registry] Dropping invalid family ${id}`)
      continue
    }
    if (seen.has(family.id)) continue
    seen.add(family.id)
    families.push(family)
  }
  if (families.length === 0) {
    throw new Error('Diffusion catalog carries no usable family')
  }
  return {
    schema_version: data.schema_version,
    updated_at: data.updated_at,
    families,
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

export type CachedDiffusionCatalog = {
  catalog: DiffusionCatalog
  fetchedAt: number
}

export const getCachedDiffusionCatalog = (): CachedDiffusionCatalog | null => {
  const ls = safeLocalStorage()
  if (!ls) return null
  try {
    const raw = ls.getItem(CACHE_KEY)
    const tsRaw = ls.getItem(CACHE_TS_KEY)
    if (!raw || !tsRaw) return null
    const fetchedAt = Number(tsRaw)
    if (!Number.isFinite(fetchedAt)) return null
    // Re-validated on read: the cache is written by this client, but the
    // validation rules can tighten between releases.
    return { catalog: parseDiffusionCatalog(JSON.parse(raw)), fetchedAt }
  } catch {
    return null
  }
}

export const isDiffusionCatalogCacheFresh = (
  cached: CachedDiffusionCatalog | null
): boolean => cached !== null && Date.now() - cached.fetchedAt < CACHE_TTL_MS

const writeCache = (catalog: DiffusionCatalog, fetchedAt: number): void => {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.setItem(CACHE_KEY, JSON.stringify(catalog))
    ls.setItem(CACHE_TS_KEY, String(fetchedAt))
  } catch (error) {
    console.warn('[diffusion-catalog-registry] Failed to write cache:', error)
  }
}

export const clearDiffusionCatalogCache = (): void => {
  const ls = safeLocalStorage()
  if (!ls) return
  try {
    ls.removeItem(CACHE_KEY)
    ls.removeItem(CACHE_TS_KEY)
  } catch (error) {
    console.warn('[diffusion-catalog-registry] Failed to clear cache:', error)
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
      `Diffusion catalog fetch failed: ${response.status} ${response.statusText}`
    )
  }
  return (await response.json()) as unknown
}

const fetchCatalog = async (
  url: string,
  signal?: AbortSignal
): Promise<DiffusionCatalog> => {
  let data: unknown
  try {
    data = await fetchOnce(fetch, url, signal)
  } catch (primaryError) {
    if (!isTauriRuntime()) throw primaryError
    console.warn(
      '[diffusion-catalog-registry] standard fetch failed, retrying via Tauri HTTP plugin:',
      primaryError instanceof Error ? primaryError.message : primaryError
    )
    data = await fetchOnce(fetchTauri as typeof fetch, url, signal)
  }
  return parseDiffusionCatalog(data)
}

/**
 * Hard timeout wrapper. Tauri's HTTP plugin does not always honour
 * `AbortSignal`, so we race against a timer to guarantee resolution.
 */
const withHardTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`Diffusion catalog fetch timed out after ${timeoutMs}ms`)
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

export type DiffusionCatalogFetchOptions = {
  /** Bypass cache freshness check and force a network round-trip. */
  force?: boolean
  /** Override URL (for tests). */
  url?: string
  /** Abort the network request after this many ms. Default: 5000. */
  timeoutMs?: number
}

/** The bundled snapshot, re-validated so a stale generator cannot ship junk. */
export const getBaselineDiffusionCatalog = (): DiffusionCatalog =>
  parseDiffusionCatalog(BASELINE_DIFFUSION_CATALOG)

/**
 * Resolve the catalog using the priority chain:
 *
 *   1. Fresh cache (when not forcing).
 *   2. Network fetch (writes a new cache entry on success).
 *   3. Stale cache (used after a network failure).
 *   4. Baseline snapshot bundled in the app.
 *
 * Always returns a result — never throws — so UI code can render unconditionally.
 */
export const fetchDiffusionCatalog = async (
  options: DiffusionCatalogFetchOptions = {}
): Promise<DiffusionCatalogFetchResult> => {
  const {
    force = false,
    url = DIFFUSION_CATALOG_URL,
    timeoutMs = FETCH_TIMEOUT_MS,
  } = options

  const cached = getCachedDiffusionCatalog()
  if (!force && isDiffusionCatalogCacheFresh(cached) && cached) {
    return { catalog: cached.catalog, source: 'cache', fetchedAt: cached.fetchedAt }
  }

  const controller = new AbortController()
  const fetchUrl = force
    ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`
    : url
  try {
    console.info(
      `[diffusion-catalog-registry] Fetching ${fetchUrl} (timeout ${timeoutMs}ms)`
    )
    const catalog = await withHardTimeout(
      fetchCatalog(fetchUrl, controller.signal),
      timeoutMs
    )
    const fetchedAt = Date.now()
    writeCache(catalog, fetchedAt)
    console.info(
      `[diffusion-catalog-registry] Loaded ${catalog.families.length} families (schema_version=${catalog.schema_version}, updated_at=${catalog.updated_at})`
    )
    return { catalog, source: 'remote', fetchedAt }
  } catch (error) {
    try {
      controller.abort()
    } catch {
      // ignore
    }
    const message =
      error instanceof Error ? error.message : 'Unknown diffusion catalog error'
    console.warn('[diffusion-catalog-registry] Falling back:', message)
    if (cached) {
      return {
        catalog: cached.catalog,
        source: 'cache',
        fetchedAt: cached.fetchedAt,
        error: message,
      }
    }
    return {
      catalog: getBaselineDiffusionCatalog(),
      source: 'baseline',
      fetchedAt: null,
      error: message,
    }
  }
}

export const findFamily = (
  catalog: DiffusionCatalog,
  id: string
): DiffusionCatalogFamily | undefined =>
  catalog.families.find((family) => family.id === id)

export const findQuant = (
  family: DiffusionCatalogFamily,
  quantId: string
): DiffusionCatalogQuant | undefined =>
  family.transformer.quants.find((quant) => quant.id === quantId)
