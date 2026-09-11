/**
 * Pure filtering / sorting / persistence logic for the Hub model list.
 *
 * Kept free of React and of the DOM so the behaviour can be unit-tested
 * without rendering: `HubFilters.tsx` only renders the controls and forwards
 * state changes here.
 */

import {
  estimateFit,
  modelFormat,
  parseFileSizeToBytes,
  pickMedianQuant,
  type ModelFormat,
} from '@/lib/model-card'
import { getMlxTotalFileSize, getTotalDownloadFileSize } from '@/lib/models'
import type { CatalogModel } from '@/services/models/types'

export type HubSortKey =
  | 'recommended'
  | 'likes'
  | 'downloads'
  | 'last-modified'

export const HUB_SORT_KEYS: readonly HubSortKey[] = [
  'recommended',
  'likes',
  'downloads',
  'last-modified',
]

export type HubFilterState = {
  /** The UI keeps exactly one active model format. */
  formats: ModelFormat[]
  sort: HubSortKey
  /** Hide entries that cannot fit the detected memory budget. */
  onlyFitting: boolean
  /** Keep only uncensored / abliterated builds (see `isUncensoredModel`). */
  uncensored: boolean
}

export const DEFAULT_HUB_FILTERS: HubFilterState = {
  formats: ['gguf'],
  sort: 'recommended',
  onlyFitting: true,
  uncensored: false,
}

export const HUB_FILTERS_STORAGE_KEY = 'atomic_hub_filters_v1'

const isFormat = (value: unknown): value is ModelFormat =>
  value === 'gguf' || value === 'mlx'

const isSortKey = (value: unknown): value is HubSortKey =>
  typeof value === 'string' && HUB_SORT_KEYS.includes(value as HubSortKey)

/** Coerce anything (parsed JSON, legacy shape, garbage) into a valid state. */
export function normalizeHubFilters(raw: unknown): HubFilterState {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_HUB_FILTERS }
  const value = raw as Record<string, unknown>

  const selectedFormat = Array.isArray(value.formats)
    ? value.formats.find(isFormat)
    : undefined
  const formats = [selectedFormat ?? DEFAULT_HUB_FILTERS.formats[0]]

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
  }
}

export function serializeHubFilters(state: HubFilterState): string {
  return JSON.stringify({
    formats: state.formats,
    sort: state.sort,
    onlyFitting: state.onlyFitting,
    uncensored: state.uncensored,
  })
}

export function readHubFilters(storage?: Storage | null): HubFilterState {
  const ls = storage ?? safeLocalStorage()
  if (!ls) return { ...DEFAULT_HUB_FILTERS }
  try {
    const raw = ls.getItem(HUB_FILTERS_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_HUB_FILTERS }
    return normalizeHubFilters(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_HUB_FILTERS }
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

const timestamp = (value?: string): number => {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
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
  switch (sort) {
    case 'likes':
      return next.sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0))
    case 'downloads':
      return next.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))
    case 'last-modified':
      return next.sort(
        (a, b) =>
          timestamp(b.last_modified ?? b.created_at) -
          timestamp(a.last_modified ?? a.created_at)
      )
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
}

/** Full pipeline: format, uncensored and optional fit filters, then sort. */
export function applyHubFilters(
  models: readonly CatalogModel[],
  state: HubFilterState,
  options: ApplyHubFiltersOptions = {}
): CatalogModel[] {
  const { budgetBytes = 0, applyFitFilter = true } = options

  let result = filterByFormats(models, state.formats)

  if (state.uncensored) {
    result = result.filter(isUncensoredModel)
  }

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
