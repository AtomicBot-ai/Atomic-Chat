import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '@/services/models/types'
import {
  applyHubFilters,
  DEFAULT_HUB_FILTERS,
  filterByFormats,
  formatMemoryBudget,
  hasLikeData,
  HUB_FILTERS_STORAGE_KEY,
  modelDownloadSizeText,
  modelFitsBudget,
  normalizeHubFilters,
  readHubFilters,
  sortModels,
  writeHubFilters,
  type HubFilterState,
} from '../hub-filters'

const GB = 1024 ** 3

const gguf = (
  name: string,
  fileSize: string,
  extra: Partial<CatalogModel> = {}
): CatalogModel => ({
  model_name: name,
  description: '',
  downloads: 0,
  is_mlx: false,
  quants: [
    {
      model_id: `${name}-Q4_K_M`,
      path: `https://huggingface.co/${name}/resolve/main/model.gguf`,
      file_size: fileSize,
    },
  ],
  ...extra,
})

const mlx = (
  name: string,
  fileSize: string,
  extra: Partial<CatalogModel> = {}
): CatalogModel => ({
  model_name: name,
  description: '',
  downloads: 0,
  is_mlx: true,
  library_name: 'mlx',
  safetensors_files: [
    {
      model_id: name,
      path: `https://huggingface.co/${name}/resolve/main/model.safetensors`,
      file_size: fileSize,
    },
  ],
  ...extra,
})

describe('normalizeHubFilters', () => {
  it('returns the defaults for anything that is not an object', () => {
    expect(normalizeHubFilters(null)).toEqual(DEFAULT_HUB_FILTERS)
    expect(normalizeHubFilters('nonsense')).toEqual(DEFAULT_HUB_FILTERS)
    expect(normalizeHubFilters(42)).toEqual(DEFAULT_HUB_FILTERS)
  })

  it('keeps only the first valid format', () => {
    expect(
      normalizeHubFilters({ formats: ['gguf', 'mlx', 'onnx', 7] }).formats
    ).toEqual(['gguf'])
  })

  it('falls back to GGUF when no valid format is selected', () => {
    expect(normalizeHubFilters({ formats: [] }).formats).toEqual(['gguf'])
  })

  it('falls back to defaults for an unknown sort key or non-boolean flag', () => {
    const state = normalizeHubFilters({ sort: 'stars', onlyFitting: 'yes' })
    expect(state.sort).toBe(DEFAULT_HUB_FILTERS.sort)
    expect(state.onlyFitting).toBe(DEFAULT_HUB_FILTERS.onlyFitting)
  })

  it('preserves a fully valid state', () => {
    const state: HubFilterState = {
      formats: ['mlx'],
      sort: 'downloads',
      onlyFitting: false,
    }
    expect(normalizeHubFilters(state)).toEqual(state)
  })
})

describe('hub filter persistence', () => {
  beforeEach(() => {
    window.localStorage.removeItem(HUB_FILTERS_STORAGE_KEY)
  })

  it('round-trips through localStorage', () => {
    const state: HubFilterState = {
      formats: ['mlx'],
      sort: 'last-modified',
      onlyFitting: false,
    }
    writeHubFilters(state)
    expect(readHubFilters()).toEqual(state)
  })

  it('returns defaults when nothing was stored', () => {
    expect(readHubFilters()).toEqual(DEFAULT_HUB_FILTERS)
  })

  it('returns defaults when the stored value is corrupt', () => {
    window.localStorage.setItem(HUB_FILTERS_STORAGE_KEY, '{not json')
    expect(readHubFilters()).toEqual(DEFAULT_HUB_FILTERS)
  })

  it('repairs a partially valid stored value', () => {
    window.localStorage.setItem(
      HUB_FILTERS_STORAGE_KEY,
      JSON.stringify({ formats: ['mlx', 'bogus'], sort: 'nope' })
    )
    expect(readHubFilters()).toEqual({
      formats: ['mlx'],
      sort: DEFAULT_HUB_FILTERS.sort,
      onlyFitting: DEFAULT_HUB_FILTERS.onlyFitting,
    })
  })

  it('treats a browser that denies storage access as no storage', () => {
    // Safari private browsing throws on touching localStorage at all, so the
    // guard has to hold before any getItem/setItem call.
    const denied = vi
      .spyOn(window, 'localStorage', 'get')
      .mockImplementation(() => {
        throw new Error('storage disabled')
      })

    expect(readHubFilters()).toEqual(DEFAULT_HUB_FILTERS)
    expect(() =>
      writeHubFilters({ formats: ['gguf'], sort: 'likes', onlyFitting: false })
    ).not.toThrow()

    denied.mockRestore()
    expect(window.localStorage.getItem(HUB_FILTERS_STORAGE_KEY)).toBeNull()
  })

  it('survives a storage that throws on write', () => {
    const throwingStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
    } as unknown as Storage
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(() =>
      writeHubFilters(DEFAULT_HUB_FILTERS, throwingStorage)
    ).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('filterByFormats', () => {
  const models = [gguf('a/gguf-one', '1 GB'), mlx('a/mlx-one', '1 GB')]

  it('keeps only GGUF entries', () => {
    expect(filterByFormats(models, ['gguf']).map((m) => m.model_name)).toEqual([
      'a/gguf-one',
    ])
  })

  it('keeps only MLX entries', () => {
    expect(filterByFormats(models, ['mlx']).map((m) => m.model_name)).toEqual([
      'a/mlx-one',
    ])
  })

  it('keeps everything when both formats are selected', () => {
    expect(filterByFormats(models, ['gguf', 'mlx'])).toHaveLength(2)
  })

  it('treats an empty selection as no filter rather than an empty list', () => {
    expect(filterByFormats(models, [])).toHaveLength(2)
  })

  it('recognizes MLX declared only through library_name', () => {
    const byLibrary: CatalogModel = {
      model_name: 'a/library-mlx',
      description: '',
      downloads: 0,
      library_name: 'MLX',
    }
    expect(filterByFormats([byLibrary], ['mlx'])).toHaveLength(1)
  })
})

describe('modelDownloadSizeText and modelFitsBudget', () => {
  const multiQuant = (name: string, sizes: string[]): CatalogModel => ({
    ...gguf(name, sizes[0]),
    quants: sizes.map((file_size, index) => ({
      model_id: `${name}-q${index}`,
      path: `https://huggingface.co/${name}/resolve/main/q${index}.gguf`,
      file_size,
    })),
  })

  it('quotes the median quant, not the smallest one', () => {
    expect(
      modelDownloadSizeText(multiQuant('a/spread', ['2 GB', '6 GB', '30 GB']))
    ).toBe('6.0 GB')
  })

  it('judges the fit on the median quant', () => {
    // The 2 GB rounding would sail through a 8 GB budget; the median does not.
    const model = multiQuant('a/spread', ['2 GB', '20 GB', '30 GB'])
    expect(modelFitsBudget(model, 8 * GB)).toBe(false)
    expect(modelFitsBudget(model, 32 * GB)).toBe(true)
  })

  it('sums the mmproj companion into the GGUF download size', () => {
    const withMmproj = gguf('a/vision', '4.0 GB', {
      mmproj_models: [
        {
          model_id: 'mmproj-f16',
          path: 'https://example.com/mmproj.gguf',
          file_size: '1.0 GB',
        },
      ],
    })
    expect(modelDownloadSizeText(withMmproj)).toBe('5.0 GB')
  })

  it('sums every safetensors shard for MLX', () => {
    const sharded = mlx('a/sharded', '3.0 GB')
    sharded.safetensors_files = [
      ...(sharded.safetensors_files ?? []),
      {
        model_id: 'a/sharded-2',
        path: 'https://example.com/model-2.safetensors',
        file_size: '2.0 GB',
      },
    ]
    expect(modelDownloadSizeText(sharded)).toBe('5.0 GB')
  })

  it('keeps models that fit and rejects the ones that do not', () => {
    expect(modelFitsBudget(gguf('a/small', '4 GB'), 20 * GB)).toBe(true)
    expect(modelFitsBudget(gguf('a/tight', '18 GB'), 20 * GB)).toBe(true)
    expect(modelFitsBudget(gguf('a/huge', '64 GB'), 20 * GB)).toBe(false)
  })

  it('keeps everything when the memory budget is unknown', () => {
    expect(modelFitsBudget(gguf('a/huge', '640 GB'), 0)).toBe(true)
  })

  it('keeps entries whose size cannot be parsed', () => {
    expect(modelFitsBudget(gguf('a/unknown', 'who knows'), 20 * GB)).toBe(true)
  })
})

describe('sortModels', () => {
  const models = [
    gguf('a/mid', '1 GB', {
      downloads: 50,
      likes: 3,
      last_modified: '2026-02-01T00:00:00Z',
    }),
    gguf('a/top', '1 GB', {
      downloads: 500,
      likes: 1,
      last_modified: '2026-01-01T00:00:00Z',
    }),
    gguf('a/fresh', '1 GB', {
      downloads: 5,
      likes: 9,
      last_modified: '2026-03-01T00:00:00Z',
    }),
  ]

  it('leaves relevance order untouched for the recommended sort', () => {
    expect(sortModels(models, 'recommended').map((m) => m.model_name)).toEqual([
      'a/mid',
      'a/top',
      'a/fresh',
    ])
  })

  it('sorts by downloads descending', () => {
    expect(sortModels(models, 'downloads').map((m) => m.model_name)).toEqual([
      'a/top',
      'a/mid',
      'a/fresh',
    ])
  })

  it('sorts by likes descending', () => {
    expect(sortModels(models, 'likes').map((m) => m.model_name)).toEqual([
      'a/fresh',
      'a/mid',
      'a/top',
    ])
  })

  it('sorts by last modified descending and falls back to created_at', () => {
    const withCreatedAt = [
      ...models,
      gguf('a/created-only', '1 GB', { created_at: '2026-04-01T00:00:00Z' }),
    ]
    expect(
      sortModels(withCreatedAt, 'last-modified').map((m) => m.model_name)
    ).toEqual(['a/created-only', 'a/fresh', 'a/mid', 'a/top'])
  })

  it('sinks entries with a missing or unparseable date to the bottom', () => {
    // Date.parse returns NaN for garbage, and a NaN comparator result would
    // leave the whole order undefined rather than just those two entries.
    const withBadDates = [
      gguf('a/garbage', '1 GB', { last_modified: 'last tuesday' }),
      gguf('a/undated', '1 GB'),
      ...models,
    ]
    expect(
      sortModels(withBadDates, 'last-modified').map((m) => m.model_name)
    ).toEqual(['a/fresh', 'a/mid', 'a/top', 'a/garbage', 'a/undated'])
  })

  it('does not mutate the input array', () => {
    const input = [...models]
    sortModels(input, 'downloads')
    expect(input.map((m) => m.model_name)).toEqual([
      'a/mid',
      'a/top',
      'a/fresh',
    ])
  })
})

describe('hasLikeData', () => {
  it('is false when nothing carries likes', () => {
    expect(hasLikeData([gguf('a/one', '1 GB')])).toBe(false)
    expect(hasLikeData([gguf('a/one', '1 GB', { likes: 0 })])).toBe(false)
  })

  it('is true as soon as one entry has likes', () => {
    expect(
      hasLikeData([gguf('a/one', '1 GB'), gguf('a/two', '1 GB', { likes: 2 })])
    ).toBe(true)
  })
})

describe('applyHubFilters', () => {
  const models = [
    gguf('a/small', '4 GB', { downloads: 10 }),
    gguf('a/huge', '64 GB', { downloads: 999 }),
    mlx('a/mlx', '6 GB', { downloads: 100 }),
  ]

  it('applies format filter, fit filter and sort together', () => {
    const result = applyHubFilters(
      models,
      { formats: ['gguf'], sort: 'downloads', onlyFitting: true },
      { budgetBytes: 20 * GB }
    )
    expect(result.map((m) => m.model_name)).toEqual(['a/small'])
  })

  it('skips the fit filter when the caller opts out', () => {
    const result = applyHubFilters(
      models,
      { formats: ['gguf'], sort: 'downloads', onlyFitting: true },
      { budgetBytes: 20 * GB, applyFitFilter: false }
    )
    expect(result.map((m) => m.model_name)).toEqual(['a/huge', 'a/small'])
  })

  it('skips the fit filter when the budget is unknown', () => {
    const result = applyHubFilters(models, {
      formats: ['gguf', 'mlx'],
      sort: 'recommended',
      onlyFitting: true,
    })
    expect(result).toHaveLength(3)
  })

  it('skips the fit filter when the user turned it off', () => {
    const result = applyHubFilters(
      models,
      { formats: ['gguf'], sort: 'recommended', onlyFitting: false },
      { budgetBytes: 20 * GB }
    )
    expect(result.map((m) => m.model_name)).toEqual(['a/small', 'a/huge'])
  })
})

describe('formatMemoryBudget', () => {
  it('renders gigabytes with two decimals', () => {
    expect(formatMemoryBudget(20 * GB)).toBe('20.00 GB')
  })

  it('returns undefined for an unknown budget', () => {
    expect(formatMemoryBudget(0)).toBeUndefined()
    expect(formatMemoryBudget(-1)).toBeUndefined()
  })
})
