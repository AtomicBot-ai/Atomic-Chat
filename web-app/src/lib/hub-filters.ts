/**
 * Pure filtering / sorting / persistence logic for the Hub model list.
 *
 * Kept free of React and of the DOM so the behaviour can be unit-tested
 * without rendering: `HubFilters.tsx` only renders the controls and forwards
 * state changes here.
 */

import {
  CAPABILITIES,
  deriveCapabilities,
  estimateFit,
  modelFormat,
  parseFileSizeToBytes,
  pickMedianQuant,
  type CapabilityKey,
  type ModelFormat,
} from '@/lib/model-card'
import {
  extractModelName,
  getMlxTotalFileSize,
  getTotalDownloadFileSize,
} from '@/lib/models'
import type { CatalogModel } from '@/services/models/types'
import type { StaffPickCategory } from '@/services/staff-picks-registry'

/**
 * Every sort offers both directions (the user, 2026-09-14: "Least download vs
 * most downloaded. Smallest file first or largest file size first etc."). The
 * original keys keep their meaning - `downloads` is still most downloaded - so
 * a stored choice from an older build still reads the same.
 */
export type HubSortKey =
  | 'recommended'
  | 'downloads'
  | 'downloads-asc'
  | 'likes'
  | 'likes-asc'
  | 'last-modified'
  | 'last-modified-asc'
  | 'size-asc'
  | 'size-desc'
  | 'name-asc'
  | 'name-desc'

export const HUB_SORT_KEYS: readonly HubSortKey[] = [
  'recommended',
  'downloads',
  'downloads-asc',
  'likes',
  'likes-asc',
  'last-modified',
  'last-modified-asc',
  'size-asc',
  'size-desc',
  'name-asc',
  'name-desc',
]

/** Sorts that only make sense when the list carries like counts. */
export const LIKE_SORT_KEYS: readonly HubSortKey[] = ['likes', 'likes-asc']

export type HubFilterState = {
  /** The UI keeps exactly one active model format. */
  formats: ModelFormat[]
  sort: HubSortKey
  /** Hide entries that cannot fit the detected memory budget. */
  onlyFitting: boolean
  /** Keep only uncensored / abliterated builds (see `isUncensoredModel`). */
  uncensored: boolean
  /** Keep only models that have every one of these capabilities. */
  capabilities: CapabilityKey[]
}

export const DEFAULT_HUB_FILTERS: HubFilterState = {
  formats: ['gguf'],
  sort: 'recommended',
  onlyFitting: true,
  uncensored: false,
  capabilities: [],
}

export const HUB_FILTERS_STORAGE_KEY = 'atomic_hub_filters_v1'

const isFormat = (value: unknown): value is ModelFormat =>
  value === 'gguf' || value === 'mlx'

const isSortKey = (value: unknown): value is HubSortKey =>
  typeof value === 'string' && HUB_SORT_KEYS.includes(value as HubSortKey)

const isCapabilityKey = (value: unknown): value is CapabilityKey =>
  CAPABILITIES.some((cap) => cap.key === value)

/** Coerce anything (parsed JSON, legacy shape, garbage) into a valid state. */
export function normalizeHubFilters(raw: unknown): HubFilterState {
  if (typeof raw !== 'object' || raw === null)
    return { ...DEFAULT_HUB_FILTERS, capabilities: [] }
  const value = raw as Record<string, unknown>

  const selectedFormat = Array.isArray(value.formats)
    ? value.formats.find(isFormat)
    : undefined
  const formats = [selectedFormat ?? DEFAULT_HUB_FILTERS.formats[0]]

  const capabilities = Array.isArray(value.capabilities)
    ? [...new Set(value.capabilities.filter(isCapabilityKey))]
    : []

  return {
    formats,
    sort: isSortKey(value.sort) ? value.sort : DEFAULT_HUB_FILTERS.sort,
    onlyFitting:
      typeof value.onlyFitting === 'boolean'
        ? value.onlyFitting
        : DEFAULT_HUB_FILTERS.onlyFitting,
    uncensored:
      typeof value.uncensored === 'boolean'
        ? value.uncensored
        : DEFAULT_HUB_FILTERS.uncensored,
    capabilities,
  }
}

export function serializeHubFilters(state: HubFilterState): string {
  return JSON.stringify({
    formats: state.formats,
    sort: state.sort,
    onlyFitting: state.onlyFitting,
    uncensored: state.uncensored,
    capabilities: state.capabilities,
  })
}

export function readHubFilters(storage?: Storage | null): HubFilterState {
  const ls = storage ?? safeLocalStorage()
  if (!ls) return normalizeHubFilters(null)
  try {
    const raw = ls.getItem(HUB_FILTERS_STORAGE_KEY)
    if (!raw) return normalizeHubFilters(null)
    return normalizeHubFilters(JSON.parse(raw))
  } catch {
    return normalizeHubFilters(null)
  }
}

export function writeHubFilters(
  state: HubFilterState,
  storage?: Storage | null
): void {
  const ls = storage ?? safeLocalStorage()
  if (!ls) return
  try {
    ls.setItem(HUB_FILTERS_STORAGE_KEY, serializeHubFilters(state))
  } catch (error) {
    console.warn('[hub-filters] Failed to persist filter state:', error)
  }
}

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * Download size of the entry as shown on its row: the whole safetensors set
 * for MLX, the median quant plus its mmproj companion for GGUF.
 */
export function modelDownloadSizeText(
  model: CatalogModel
): string | undefined {
  return model.is_mlx
    ? getMlxTotalFileSize(model)
    : getTotalDownloadFileSize(model, pickMedianQuant(model.quants))
}

/** Download size in bytes, or undefined when the entry does not say. */
export function modelDownloadSizeBytes(model: CatalogModel): number | undefined {
  const bytes = parseFileSizeToBytes(modelDownloadSizeText(model))
  return bytes !== undefined && bytes > 0 ? bytes : undefined
}

/**
 * Does this model fit the memory budget? A zero/unknown budget means the
 * hardware probe has not resolved yet — never hide anything in that case.
 */
export function modelFitsBudget(
  model: CatalogModel,
  budgetBytes: number
): boolean {
  if (!budgetBytes) return true
  const sizeBytes = parseFileSizeToBytes(modelDownloadSizeText(model))
  return estimateFit(sizeBytes, budgetBytes) !== 'no'
}

export function filterByFormats(
  models: readonly CatalogModel[],
  formats: readonly ModelFormat[]
): CatalogModel[] {
  // An empty selection is a UI dead end (nothing could ever match), so treat
  // it the same as "everything selected".
  if (formats.length === 0) return [...models]
  const allowed = new Set(formats)
  return models.filter((model) => allowed.has(modelFormat(model)))
}

/** Where a model's hand-checked capability list comes from, if it has one. */
export type CuratedCategoriesFor = (
  model: CatalogModel
) => readonly StaffPickCategory[] | undefined

/**
 * Keep models that have every selected capability, judged exactly like the
 * badges on the model page: a recommended model's curated categories win, and
 * anything else is read off its catalog entry.
 */
export function filterByCapabilities(
  models: readonly CatalogModel[],
  wanted: readonly CapabilityKey[],
  curatedFor?: CuratedCategoriesFor
): CatalogModel[] {
  if (wanted.length === 0) return [...models]
  return models.filter((model) => {
    const has = new Set(
      deriveCapabilities(model, curatedFor?.(model)).map((cap) => cap.key)
    )
    return wanted.every((key) => has.has(key))
  })
}

const timestamp = (value?: string): number => {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const displayName = (model: CatalogModel): string =>
  extractModelName(model.model_name) || model.model_name

const nameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

/**
 * Sort by a value some entries lack. Entries without it always go last, in
 * either direction: "smallest first" should not open with the unknown sizes.
 */
function sortByKnown(
  models: CatalogModel[],
  value: (model: CatalogModel) => number | undefined,
  direction: 'asc' | 'desc'
): CatalogModel[] {
  return models.sort((a, b) => {
    const va = value(a)
    const vb = value(b)
    if (va === undefined && vb === undefined) return 0
    if (va === undefined) return 1
    if (vb === undefined) return -1
    return direction === 'asc' ? va - vb : vb - va
  })
}

/**
 * Sort a list of models.
 *
 * `recommended` keeps the incoming order, which is the relevance ranking
 * already produced by `model-search.ts` (or the curated `order` for staff
 * picks) — re-sorting it here would throw that work away.
 */
export function sortModels(
  models: readonly CatalogModel[],
  sort: HubSortKey
): CatalogModel[] {
  const next = [...models]
  const dated = (model: CatalogModel) =>
    timestamp(model.last_modified ?? model.created_at) || undefined
  switch (sort) {
    case 'likes':
      return next.sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0))
    case 'likes-asc':
      return next.sort((a, b) => (a.likes ?? 0) - (b.likes ?? 0))
    case 'downloads':
      return next.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))
    case 'downloads-asc':
      return next.sort((a, b) => (a.downloads ?? 0) - (b.downloads ?? 0))
    case 'last-modified':
      return sortByKnown(next, dated, 'desc')
    case 'last-modified-asc':
      return sortByKnown(next, dated, 'asc')
    case 'size-asc':
      return sortByKnown(next, modelDownloadSizeBytes, 'asc')
    case 'size-desc':
      return sortByKnown(next, modelDownloadSizeBytes, 'desc')
    case 'name-asc':
      return next.sort((a, b) => nameCollator.compare(displayName(a), displayName(b)))
    case 'name-desc':
      return next.sort((a, b) => nameCollator.compare(displayName(b), displayName(a)))
    case 'recommended':
    default:
      return next
  }
}

/**
 * Words Hugging Face repos use for builds with the refusals trained or ablated
 * out. Both are needed: abliterated repos rarely also say "uncensored".
 */
export const UNCENSORED_TERMS = ['uncensored', 'abliterated'] as const

const UNCENSORED_PATTERN = new RegExp(UNCENSORED_TERMS.join('|'), 'i')

/** Judged on the repo id, the one place these builds reliably say so. */
export function isUncensoredModel(model: CatalogModel): boolean {
  return UNCENSORED_PATTERN.test(model.model_name)
}

/**
 * Hugging Face queries for the long-tail fallback. With the uncensored filter
 * on, each term is appended to the user's query out of sight, one request per
 * term — so even an empty search box finds uncensored builds.
 */
export function huggingFaceQueries(
  query: string,
  uncensored: boolean
): string[] {
  const trimmed = query.trim()
  if (!uncensored) return trimmed ? [trimmed] : []
  // HF matches every word, so stacking a second term would only narrow it.
  if (UNCENSORED_PATTERN.test(trimmed)) return [trimmed]
  return UNCENSORED_TERMS.map((term) => `${trimmed} ${term}`.trim())
}

/** Are there any like counts at all? Drives whether the sort option shows. */
export function hasLikeData(models: readonly CatalogModel[]): boolean {
  return models.some((model) => (model.likes ?? 0) > 0)
}

export type ApplyHubFiltersOptions = {
  /** Memory budget in bytes; 0 disables the fit filter. */
  budgetBytes?: number
  /** Allows callers without reliable size data to bypass the fit filter. */
  applyFitFilter?: boolean
  /** Hand-checked capabilities for recommended models (staff picks). */
  curatedCategories?: CuratedCategoriesFor
}

/** Full pipeline: format, uncensored, capability and fit filters, then sort. */
export function applyHubFilters(
  models: readonly CatalogModel[],
  state: HubFilterState,
  options: ApplyHubFiltersOptions = {}
): CatalogModel[] {
  const { budgetBytes = 0, applyFitFilter = true, curatedCategories } = options

  let result = filterByFormats(models, state.formats)

  if (state.uncensored) {
    result = result.filter(isUncensoredModel)
  }

  result = filterByCapabilities(result, state.capabilities, curatedCategories)

  if (applyFitFilter && state.onlyFitting && budgetBytes > 0) {
    result = result.filter((model) => modelFitsBudget(model, budgetBytes))
  }

  return sortModels(result, state.sort)
}

/** Human-readable memory budget for the "based on this device" hint. */
export function formatMemoryBudget(budgetBytes: number): string | undefined {
  if (!budgetBytes || budgetBytes <= 0) return undefined
  return `${(budgetBytes / 1024 ** 3).toFixed(2)} GB`
}
