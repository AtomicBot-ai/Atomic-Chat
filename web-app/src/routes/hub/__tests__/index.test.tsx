import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel, HuggingFaceRepo } from '@/services/models/types'
import type { ResolvedStaffPick } from '@/hooks/useStaffPicks'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  mediaSupported: false,
  decisionSupported: false,
  search: {} as Record<string, unknown>,
  staffPicks: [] as ResolvedStaffPick[],
  mlxStaffPicks: [] as ResolvedStaffPick[],
  requestedPickFormats: [] as string[],
  sources: [] as CatalogModel[],
  search_: vi.fn(() => [] as CatalogModel[]),
  fetchHuggingFaceRepo: vi.fn(async () => null),
  searchHuggingFaceCandidates: vi.fn(async () => [] as CatalogModel[]),
  listHuggingFaceFeed: vi.fn(async () => ({
    models: [] as CatalogModel[],
    nextCursor: null as string | null,
  })),
}))

const tensorrtHub = vi.hoisted(() => ({
  value: {
    visible: false,
    state: 'unknown',
    blockers: [] as Array<Record<string, unknown>>,
    descriptorId: null as string | null,
  },
}))
const vllmHub = vi.hoisted(() => ({
  value: {
    visible: false,
    state: 'unknown',
    blockers: [] as Array<Record<string, unknown>>,
    descriptorId: null as string | null,
  },
}))
vi.mock('@/hooks/useManagedHubState', () => ({
  useManagedHubState: (engineId: string) =>
    engineId === 'vllm' ? vllmHub.value : tensorrtHub.value,
  useManagedHubStates: () => [
    { engine: { id: 'vllm', label: 'vLLM', i18n: 'vllm' }, hub: vllmHub.value },
    { engine: { id: 'tensorrt-llm', label: 'TensorRT-LLM', i18n: 'tensorrt' }, hub: tensorrtHub.value },
  ],
}))

const tensorrtCurated = vi.hoisted(() => ({
  value: {
    models: [] as CatalogModel[],
    supportedArchitectures: null as string[] | null,
    loading: false,
  },
}))
const vllmCurated = vi.hoisted(() => ({
  value: {
    models: [] as CatalogModel[],
    supportedArchitectures: null as string[] | null,
    loading: false,
  },
}))
vi.mock('@/hooks/useManagedCurated', () => ({
  useManagedCurated: (engineId: string) =>
    engineId === 'vllm' ? vllmCurated.value : tensorrtCurated.value,
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useSearch: () => mocks.search,
  }),
  useNavigate: () => mocks.navigate,
}))

// jsdom reports every element as 0x0, so the real virtualizer would render an
// empty window. Render the whole list instead and let the assertions be about
// Hub behaviour rather than layout measurement.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 72,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        key: index,
        index,
        start: index * 72,
        size: 72,
      })),
    measureElement: () => undefined,
  }),
}))

// Interpolation options ride along in the output so a test can see what a
// string would have carried — the feed heading must carry nothing.
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <header>{children}</header>
  ),
}))

vi.mock('@/containers/hub/ModelDetailPanel', () => ({
  ModelDetailPanel: ({ model }: { model: CatalogModel | null }) => (
    <aside
      data-testid="detail-panel"
      data-quants={model?.quants?.length ?? 0}
    >
      {model ? model.model_name : 'hub:selectModel'}
    </aside>
  ),
}))

vi.mock('@/containers/hub/HubFilters', () => ({
  HubFilters: () => <div data-testid="hub-filters" />,
}))

vi.mock('@/containers/hub/DecisionHub', () => ({
  DecisionHub: ({
    categoryTabs,
    query,
    selectedModelId,
    onSelectModel,
  }: {
    categoryTabs?: React.ReactNode
    query: string
    selectedModelId: string | null
    onSelectModel: (id: string) => void
  }) => (
    <main data-testid="decision-hub">
      {categoryTabs}
      <span>{`decision catalog, query "${query}", open ${selectedModelId}`}</span>
      <button type="button" onClick={() => onSelectModel('laya')}>
        pick laya
      </button>
    </main>
  ),
}))

// The Images / Video catalog has tests of its own; here it only has to show
// what the route handed it, and hand a pick back.
vi.mock('@/containers/hub/MediaHub', () => ({
  MediaHub: ({
    modality,
    categoryTabs,
    query,
    selectedFamilyId,
    onSelectFamily,
  }: {
    modality: string
    categoryTabs?: React.ReactNode
    query: string
    selectedFamilyId: string | null
    onSelectFamily: (id: string) => void
  }) => (
    <main data-testid="media-hub">
      {categoryTabs}
      <span>{`${modality} catalog, query "${query}", open ${selectedFamilyId}`}</span>
      <button type="button" onClick={() => onSelectFamily('flux.1-schnell')}>
        pick flux
      </button>
    </main>
  ),
}))

vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  return {
    ...actual,
    PlatformFeatures: new Proxy(actual.PlatformFeatures, {
      get: (target, key) =>
        key === 'mediaGeneration'
          ? mocks.mediaSupported
          : key === 'localInference'
            ? true
            : target[key as keyof typeof target],
    }),
  }
})

vi.mock('@/hooks/useStaffPicks', () => ({
  useStaffPicks: (_sources: CatalogModel[], format = 'gguf') => {
    mocks.requestedPickFormats.push(format)
    return format === 'mlx' ? mocks.mlxStaffPicks : mocks.staffPicks
  },
}))

vi.mock('@/hooks/useModelSources', () => ({
  useModelSources: (
    selector: (state: {
      sources: CatalogModel[]
      fetchSources: () => void
      loading: boolean
    }) => unknown
  ) =>
    selector({
      sources: mocks.sources,
      fetchSources: vi.fn(),
      loading: false,
    }),
}))

vi.mock('@/hooks/useModelProvider', () => {
  const state = { providers: [], setProviders: vi.fn() }
  const useModelProvider = (selector: (s: typeof state) => unknown) =>
    selector(state)
  useModelProvider.getState = () => state
  return { useModelProvider }
})

vi.mock('@/hooks/useGeneralSetting', () => {
  const state = { huggingfaceToken: '', scanLocalModels: false }
  const useGeneralSetting = (selector: (s: typeof state) => unknown) =>
    selector(state)
  useGeneralSetting.getState = () => state
  return { useGeneralSetting }
})

vi.mock('@/hooks/useHardware', () => ({
  useHardware: (
    selector: (s: {
      hardwareData: {
        total_memory: number
        gpus: unknown[]
        cpu: { arch: string }
      }
    }) => unknown
  ) =>
    selector({
      hardwareData: { total_memory: 64 * 1024, gpus: [], cpu: { arch: '' } },
    }),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
      models: () => ({
        fetchHuggingFaceRepo: mocks.fetchHuggingFaceRepo,
        searchHuggingFaceCandidates: mocks.searchHuggingFaceCandidates,
        listHuggingFaceFeed: mocks.listHuggingFaceFeed,
        convertHfRepoToCatalogModel: (repo: CatalogModel) => repo,
      }),
      providers: () => ({ getProviders: async () => [] }),
      decision: () => ({ isSupported: () => mocks.decisionSupported }),
  }),
}))

vi.mock('@/services/model-search', () => ({
  getModelSearchService: () => ({
    setCatalog: vi.fn(),
    loadSnapshot: () => true,
    rebuild: vi.fn(),
    search: mocks.search_,
  }),
}))

vi.mock('@/stores/model-catalog-store', () => ({
  useModelCatalogStore: (selector: (s: unknown) => unknown) =>
    selector({ catalog: [], index: null }),
}))

import { Route } from '../index'
import { HUB_FILTERS_STORAGE_KEY, serializeHubFilters } from '@/lib/hub-filters'
import { getHubFormat, setHubFormat, setHubSearchQuery } from '../hub-session'
import { resetHuggingFaceFeedForTest } from '@/hooks/useHuggingFaceFeed'
import en from '@/locales/en/hub.json'

const model = (name: string, extra: Partial<CatalogModel> = {}): CatalogModel =>
  ({
    model_name: name,
    developer: name.split('/')[0],
    downloads: 100,
    num_quants: 1,
    quants: [
      { model_id: `${name}-Q4_K_M`, path: 'q4.gguf', file_size: '2.00 GB' },
    ],
    ...extra,
  }) as CatalogModel

const HubPage = () => {
  const Component = (Route as unknown as { component: React.ComponentType })
    .component
  return <Component />
}

describe('/hub route', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    setHubFormat(null)
    vi.clearAllMocks()
    localStorage.clear()
    setHubSearchQuery('')
    mocks.search = {}
    tensorrtHub.value = {
      visible: false,
      state: 'unknown',
      blockers: [],
      descriptorId: null,
    }
    tensorrtCurated.value = { models: [], supportedArchitectures: null, loading: false }
    vllmHub.value = { visible: false, state: 'unknown', blockers: [], descriptorId: null }
    vllmCurated.value = { models: [], supportedArchitectures: null, loading: false }
    mocks.mediaSupported = false
    mocks.decisionSupported = false
    mocks.sources = []
    mocks.staffPicks = [
      {
        pick: { model_name: 'Qwen/Qwen3.5-4B-GGUF', title: 'Qwen3.5 4B' },
        model: model('Qwen/Qwen3.5-4B-GGUF'),
      },
      {
        pick: { model_name: 'google/gemma-4-12b-GGUF', title: 'Gemma 4 12B' },
        model: model('google/gemma-4-12b-GGUF'),
      },
    ]
    mocks.mlxStaffPicks = [
      {
        pick: {
          model_name: 'mlx-community/Qwen3.5-4B-4bit',
          title: 'Qwen3.5 4B (MLX)',
          format: 'mlx',
        },
        model: model('mlx-community/Qwen3.5-4B-4bit', {
          is_mlx: true,
          quants: undefined,
          safetensors_files: [{ rfilename: 'model.safetensors', size: 2e9 }],
        } as Partial<CatalogModel>),
      },
    ]
    mocks.requestedPickFormats = []
    mocks.search_.mockReturnValue([])
    mocks.searchHuggingFaceCandidates.mockImplementation(async () => [])
    mocks.listHuggingFaceFeed.mockImplementation(async () => ({
      models: [],
      nextCursor: null,
    }))
    mocks.fetchHuggingFaceRepo.mockImplementation(async () => null)
    resetHuggingFaceFeedForTest()
  })

  it('drops a feed row from a fitting-only list once its size arrives and is too big', async () => {
    // The list endpoint carries no sizes, so a row cannot fail the fit filter
    // until its card has been fetched; the test host has 64 GB.
    mocks.listHuggingFaceFeed.mockResolvedValueOnce({
      models: [model('bartowski/Kimi-K3-GGUF', { quants: [], num_quants: 0 })],
      nextCursor: null,
    })
    mocks.fetchHuggingFaceRepo.mockImplementation(async (repoId: string) =>
      repoId === 'bartowski/Kimi-K3-GGUF'
        ? (model(repoId, {
            quants: [
              {
                model_id: 'bartowski/Kimi-K3-Q4_K_M',
                path: 'q4.gguf',
                file_size: '500.00 GB',
              },
            ],
          }) as unknown as HuggingFaceRepo)
        : null
    )
    render(<HubPage />)

    await waitFor(() =>
      expect(screen.getByText('Kimi-K3-GGUF')).toBeInTheDocument()
    )
    await waitFor(() =>
      expect(screen.queryByText('Kimi-K3-GGUF')).not.toBeInTheDocument()
    )
    // The picks are still there; only the oversized row went.
    expect(screen.getByText('Qwen3.5 4B')).toBeInTheDocument()
  })

  it('lists the rest of Hugging Face under the picks and asks for the next page at the end', async () => {
    // What the list endpoint gives: names and popularity, no file sizes.
    const feedEntry = (name: string) =>
      model(name, { quants: [], num_quants: 0 })
    mocks.listHuggingFaceFeed
      .mockResolvedValueOnce({
        models: [
          feedEntry('bartowski/Llama-4-8B-GGUF'),
          // Already a pick: listed once, as the pick.
          feedEntry('Qwen/Qwen3.5-4B-GGUF'),
        ],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        models: [feedEntry('unsloth/Mistral-Next-GGUF')],
        nextCursor: null,
      })
    render(<HubPage />)

    await waitFor(() =>
      expect(screen.getByText('Llama-4-8B-GGUF')).toBeInTheDocument()
    )
    expect(mocks.listHuggingFaceFeed).toHaveBeenCalledWith(
      expect.objectContaining({
        format: 'gguf',
        sort: 'trending',
        cursor: null,
      })
    )
    // The picks lead; the feed follows under its own heading.
    const rows = screen.getAllByRole('button').map((b) => b.textContent ?? '')
    expect(rows.findIndex((r) => r.includes('Gemma 4 12B'))).toBeLessThan(
      rows.findIndex((r) => r.includes('Llama-4-8B-GGUF'))
    )
    // Two sections, two headings of the same rank and weight: the feed's is
    // not a caption under the picks, and it carries no sort — that lives in
    // the sort dropdown.
    const headings = screen.getAllByRole('heading', { level: 2 })
    expect(headings.map((heading) => heading.textContent)).toEqual([
      'hub:staffPicks',
      'hub:feedTitle',
    ])
    expect(headings[1].className).toBe(headings[0].className)
    expect(headings[1]).not.toHaveClass('text-xs')
    expect(headings[1].nextElementSibling).toHaveTextContent('Llama-4-8B-GGUF')
    expect(en.feedTitle).toBe('More from Hugging Face')
    expect(screen.getAllByText('Qwen3.5 4B')).toHaveLength(1)

    // jsdom paints every row, so the end of the list is on screen at once:
    // the next page is asked for, and the rows on screen get their sizes.
    await waitFor(() =>
      expect(mocks.listHuggingFaceFeed).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: 'page-2' })
      )
    )
    await waitFor(() =>
      expect(screen.getByText('Mistral-Next-GGUF')).toBeInTheDocument()
    )
    expect(mocks.fetchHuggingFaceRepo).toHaveBeenCalledWith(
      'bartowski/Llama-4-8B-GGUF',
      ''
    )
    expect(mocks.listHuggingFaceFeed).toHaveBeenCalledTimes(2)
  })

  it('opens on staff picks with an empty query', () => {
    render(<HubPage />)

    expect(
      screen.getByRole('heading', { level: 2, name: 'hub:staffPicks' })
    ).toBeInTheDocument()
    expect(screen.queryByText('hub:searchResults')).not.toBeInTheDocument()
    expect(screen.getByText('Qwen3.5 4B')).toBeInTheDocument()
    expect(screen.getByText('Gemma 4 12B')).toBeInTheDocument()
  })

  it('switches to search results once the user types', async () => {
    const user = userEvent.setup()
    mocks.sources = [model('unsloth/Llama-4-8B-GGUF')]
    mocks.search_.mockReturnValue([model('unsloth/Llama-4-8B-GGUF')])
    render(<HubPage />)

    await user.type(
      screen.getByRole('textbox', { name: 'hub:searchPlaceholder' }),
      'llama'
    )

    await waitFor(() =>
      expect(screen.getByText('Llama-4-8B-GGUF')).toBeInTheDocument()
    )
    // Search results are one flat list: no section headings.
    expect(screen.queryByText('hub:searchResults')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()
    expect(mocks.search_).toHaveBeenCalledWith('llama', { limit: 500 })
    expect(screen.queryByText('Qwen3.5 4B')).not.toBeInTheDocument()
  })

  it('keeps the device fit filter active while searching', async () => {
    const user = userEvent.setup()
    const small = model('test/small-GGUF')
    const huge = model('test/huge-GGUF', {
      quants: [
        {
          model_id: 'huge-Q4_K_M.gguf',
          path: 'huge-Q4_K_M.gguf',
          file_size: '80.00 GB',
        },
      ],
    })
    mocks.sources = [small, huge]
    mocks.search_.mockReturnValue([small, huge])
    render(<HubPage />)

    await user.type(
      screen.getByRole('textbox', { name: 'hub:searchPlaceholder' }),
      'test'
    )

    await waitFor(() =>
      expect(screen.getByText('small-GGUF')).toBeInTheDocument()
    )
    expect(screen.queryByText('huge-GGUF')).not.toBeInTheDocument()
  })

  it('returns to staff picks when the query is cleared', async () => {
    const user = userEvent.setup()
    render(<HubPage />)
    const input = screen.getByRole('textbox', { name: 'hub:searchPlaceholder' })

    await user.type(input, 'llama')
    await waitFor(() =>
      expect(screen.queryByText('Qwen3.5 4B')).not.toBeInTheDocument()
    )

    await user.clear(input)

    await waitFor(() =>
      expect(screen.getByText('Qwen3.5 4B')).toBeInTheDocument()
    )
  })

  it('clears the query from the cross in the search box', async () => {
    const user = userEvent.setup()
    render(<HubPage />)
    const input = screen.getByRole('textbox', { name: 'hub:searchPlaceholder' })
    expect(
      screen.queryByRole('button', { name: 'hub:clearSearch' })
    ).not.toBeInTheDocument()

    await user.type(input, 'llama')
    await user.click(screen.getByRole('button', { name: 'hub:clearSearch' }))

    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
    await waitFor(() =>
      expect(screen.getByText('Qwen3.5 4B')).toBeInTheDocument()
    )
  })

  it('offers to clear a search that found nothing', async () => {
    const user = userEvent.setup()
    render(<HubPage />)
    const input = screen.getByRole('textbox', { name: 'hub:searchPlaceholder' })

    await user.type(input, 'zzzz')
    await waitFor(() =>
      expect(screen.getByText('hub:noModels')).toBeInTheDocument()
    )
    // The cross in the search box and the button under the message.
    const clears = screen.getAllByRole('button', { name: 'hub:clearSearch' })
    expect(clears).toHaveLength(2)
    await user.click(clears[1])

    expect(input).toHaveValue('')
    await waitFor(() =>
      expect(screen.getByText('Qwen3.5 4B')).toBeInTheDocument()
    )
  })

  it('writes the picked repo into the URL', async () => {
    const user = userEvent.setup()
    render(<HubPage />)

    await user.click(screen.getByText('Qwen3.5 4B'))

    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/hub/', replace: false })
    )
    const call = mocks.navigate.mock.calls.at(-1)?.[0] as {
      search: (prev: Record<string, unknown>) => Record<string, unknown>
    }
    expect(call.search({})).toEqual({ model: 'Qwen/Qwen3.5-4B-GGUF' })
  })

  it('opens the detail panel straight away for a deep link', () => {
    mocks.search = { model: 'google/gemma-4-12b-GGUF' }
    render(<HubPage />)

    expect(screen.getByTestId('detail-panel')).toHaveTextContent(
      'google/gemma-4-12b-GGUF'
    )
    // A deep link must survive the auto-selection below.
    expect(mocks.navigate).not.toHaveBeenCalledWith(
      expect.objectContaining({ replace: true })
    )
  })

  it('selects the first row on arrival so the panel is never blank', async () => {
    render(<HubPage />)

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalled())
    const call = mocks.navigate.mock.calls[0][0] as {
      replace: boolean
      search: (prev: Record<string, unknown>) => Record<string, unknown>
    }
    // Replaces rather than pushes: arriving at the Hub should not leave a
    // history entry the Back button has to chew through.
    expect(call.replace).toBe(true)
    expect(call.search({})).toEqual({ model: 'Qwen/Qwen3.5-4B-GGUF' })
  })

  it('does not auto-select while the list is still empty', () => {
    mocks.staffPicks = []
    render(<HubPage />)

    expect(screen.getByTestId('detail-panel')).toHaveTextContent(
      'hub:selectModel'
    )
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('asks for GGUF picks by default', () => {
    render(<HubPage />)

    expect(mocks.requestedPickFormats).not.toContain('mlx')
    expect(screen.getByText('Qwen3.5 4B')).toBeInTheDocument()
    expect(screen.queryByText('Qwen3.5 4B (MLX)')).not.toBeInTheDocument()
  })

  it('swaps to the MLX picks when the filter is narrowed to MLX alone', () => {
    // MLX is offered on macOS only; elsewhere a saved MLX filter reads as GGUF.
    vi.stubGlobal('IS_MACOS', true)
    localStorage.setItem(
      HUB_FILTERS_STORAGE_KEY,
      serializeHubFilters({
        formats: ['mlx'],
        sort: 'recommended',
        onlyFitting: false,
        uncensored: false,
      })
    )
    setHubFormat('mlx')

    render(<HubPage />)

    expect(mocks.requestedPickFormats).toContain('mlx')
    expect(screen.getByText('Qwen3.5 4B (MLX)')).toBeInTheDocument()
    expect(screen.queryByText('Qwen3.5 4B')).not.toBeInTheDocument()
  })

  it('opens on GGUF on a new launch even when another format was saved', () => {
    vi.stubGlobal('IS_MACOS', true)
    localStorage.setItem(
      HUB_FILTERS_STORAGE_KEY,
      serializeHubFilters({ formats: ['mlx'], sort: 'recommended', onlyFitting: false, uncensored: false })
    )

    render(<HubPage />)

    expect(screen.getByText('Qwen3.5 4B')).toBeInTheDocument()
    expect(screen.queryByText('Qwen3.5 4B (MLX)')).not.toBeInTheDocument()
  })

  it('opens on the format a provider page links with, keeps it and drops it from the URL', () => {
    // "Find a model" on the MLX provider page: /hub/?engine=mlx, over a saved GGUF filter.
    vi.stubGlobal('IS_MACOS', true)
    mocks.search = { engine: 'mlx' }

    render(<HubPage />)

    expect(mocks.requestedPickFormats).toContain('mlx')
    expect(screen.getByText('Qwen3.5 4B (MLX)')).toBeInTheDocument()
    expect(getHubFormat()).toBe('mlx')
    const cleared = mocks.navigate.mock.calls
      .map(([options]) => options as { search?: (prev: object) => object })
      .filter((options) => typeof options.search === 'function')
      .map((options) => options.search!({ engine: 'mlx' }))
    expect(cleared).toContainEqual(expect.objectContaining({ engine: undefined }))
  })

  it('reads an engine this machine does not offer as GGUF', () => {
    mocks.search = { engine: 'mlx' }

    render(<HubPage />)

    expect(screen.getByText('Qwen3.5 4B')).toBeInTheDocument()
    expect(screen.queryByText('Qwen3.5 4B (MLX)')).not.toBeInTheDocument()
  })

  describe('under the TensorRT-LLM format', () => {
    const selectTensorrt = () => setHubFormat('tensorrt-llm')

    it('shows what blocks the engine instead of models', () => {
      selectTensorrt()
      tensorrtHub.value = {
        visible: true,
        state: 'blocked',
        blockers: [
          {
            code: 'prerequisite-blocked',
            reason: 'driver-too-old',
            message: 'The NVIDIA driver is too old.',
            params: { required: '615.65.02', actual: '580.95.05' },
          },
        ],
        descriptorId: 'tensorrt-llm-1.3.0rc29-r2',
      }

      render(<HubPage />)

      expect(screen.getByText('hub:tensorrt.blocked.title')).toBeInTheDocument()
      expect(screen.getByText('The NVIDIA driver is too old.')).toBeInTheDocument()
      expect(screen.queryByText('Qwen3.5 4B')).not.toBeInTheDocument()
      // Nothing to open: no model is selected for the detail panel.
      expect(screen.getByTestId('detail-panel')).toHaveTextContent('hub:selectModel')
    })

    it('claims nothing until the core has answered', () => {
      selectTensorrt()
      tensorrtHub.value = { ...tensorrtHub.value, visible: true, state: 'unknown' }

      render(<HubPage />)

      expect(screen.getByRole('status')).toHaveTextContent('hub:tensorrt.checking')
      expect(screen.queryByText('hub:tensorrt.blocked.title')).not.toBeInTheDocument()
    })

    const trtEntry = (name: string, architectures: string[]): CatalogModel => ({
      model_name: name,
      developer: name.split('/')[0],
      description: '',
      downloads: 10,
      is_managed: true,
      managed: { architectures, parameters: { BF16: 4e9 } },
    })

    const engineReady = () => {
      tensorrtHub.value = {
        visible: true,
        state: 'ready',
        blockers: [],
        descriptorId: 'tensorrt-llm-1.3.0rc29-r2',
      }
      tensorrtCurated.value = {
        models: [
          {
            model_name: 'nvidia/Qwen3-8B-FP8',
            developer: 'nvidia',
            description: '',
            downloads: 0,
            is_managed: true,
            managed: { curated: true, revision: 'rev-a' },
          },
        ],
        supportedArchitectures: ['Qwen3ForCausalLM'],
        loading: false,
      }
    }

    it('lists the curated models first, then the narrowed safetensors feed, and no staff picks', async () => {
      selectTensorrt()
      engineReady()
      mocks.listHuggingFaceFeed.mockResolvedValueOnce({
        models: [
          trtEntry('nvidia/Qwen3-8B-FP8', ['Qwen3ForCausalLM']),
          trtEntry('someone/Qwen3-4B-FP8', ['Qwen3ForCausalLM']),
          trtEntry('someone/Mamba-7B', ['MambaForCausalLM']),
        ],
        nextCursor: null,
      })

      render(<HubPage />)

      expect(await screen.findByText('Qwen3-4B-FP8')).toBeInTheDocument()
      const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
      expect(headings).toEqual(['hub:tensorrt.curated', 'hub:feedTitle'])
      expect(screen.getAllByText('Qwen3-8B-FP8')).toHaveLength(1)
      expect(screen.queryByText('Mamba-7B')).not.toBeInTheDocument()
      expect(screen.queryByText('Qwen3.5 4B')).not.toBeInTheDocument()
      expect(mocks.listHuggingFaceFeed).toHaveBeenCalledWith(
        expect.objectContaining({ format: 'safetensors' })
      )
    })

    it('shows and opens a repository typed in full even when the prefilter would hide it', async () => {
      selectTensorrt()
      engineReady()
      const user = userEvent.setup()
      mocks.fetchHuggingFaceRepo.mockImplementation(async (repo: string) =>
        repo === 'someone/Mamba-7B'
          ? (trtEntry('someone/Mamba-7B', ['MambaForCausalLM']) as never)
          : null
      )
      mocks.searchHuggingFaceCandidates.mockImplementation(async () => [
        trtEntry('someone/Mamba-7B-v2', ['MambaForCausalLM']),
        trtEntry('someone/Qwen3-14B', ['Qwen3ForCausalLM']),
      ])

      render(<HubPage />)
      await user.type(
        screen.getByRole('textbox', { name: 'hub:searchPlaceholder' }),
        'someone/Mamba-7B'
      )

      await waitFor(() => expect(screen.getByText('Mamba-7B')).toBeInTheDocument(), {
        timeout: 2000,
      })
      expect(screen.getByText('Qwen3-14B')).toBeInTheDocument()
      expect(screen.queryByText('Mamba-7B-v2')).not.toBeInTheDocument()
      expect(mocks.searchHuggingFaceCandidates).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        expect.any(Number),
        'safetensors'
      )
      const opened = mocks.navigate.mock.calls
        .map(([options]) => options as { search?: (prev: object) => { model?: string } })
        .filter((options) => typeof options.search === 'function')
        .map((options) => options.search!({}).model)
      expect(opened).toContain('someone/Mamba-7B')
    })

    it('keeps the format a link names even before the provider is known, and reads it as GGUF meanwhile', () => {
      mocks.search = { engine: 'tensorrt-llm' }

      render(<HubPage />)

      expect(screen.getByText('Qwen3.5 4B')).toBeInTheDocument()
      expect(getHubFormat()).toBe('tensorrt-llm')
    })

    it('stops asking Hugging Face for pages the prefilter keeps emptying', async () => {
      selectTensorrt()
      engineReady()
      let page = 0
      mocks.listHuggingFaceFeed.mockImplementation(async () => {
        page += 1
        return {
          models: [trtEntry(`someone/Mamba-${page}`, ['MambaForCausalLM'])],
          nextCursor: `cursor-${page}`,
        }
      })

      render(<HubPage />)

      expect(await screen.findByText('Qwen3-8B-FP8')).toBeInTheDocument()
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(mocks.listHuggingFaceFeed.mock.calls.length).toBeLessThanOrEqual(4)
      expect(screen.queryByText(/Mamba/)).not.toBeInTheDocument()
    })

    it('asks Hugging Face for nothing while the engine is blocked, uncensored or not', () => {
      localStorage.setItem(
        HUB_FILTERS_STORAGE_KEY,
        serializeHubFilters({
          formats: ['tensorrt-llm'],
          sort: 'recommended',
          onlyFitting: false,
          uncensored: true,
        })
      )
      setHubFormat('tensorrt-llm')
      tensorrtHub.value = {
        visible: true,
        state: 'blocked',
        blockers: [{ code: 'prerequisite-blocked', reason: 'docker-missing', message: 'No Docker.' }],
        descriptorId: null,
      }

      render(<HubPage />)

      expect(screen.getByText('No Docker.')).toBeInTheDocument()
      expect(mocks.listHuggingFaceFeed).not.toHaveBeenCalled()
      expect(mocks.searchHuggingFaceCandidates).not.toHaveBeenCalled()
    })

    it('is GGUF again where the format is not offered', () => {
      selectTensorrt()

      render(<HubPage />)

      expect(screen.getByText('Qwen3.5 4B')).toBeInTheDocument()
      expect(screen.queryByText('hub:tensorrt.checking')).not.toBeInTheDocument()
    })
  })

  describe('under the vLLM format (spec vllm-desktop "vLLM — формат Model Hub по состоянию провайдера")', () => {
    const managedEntry = (name: string, architectures: string[]): CatalogModel => ({
      model_name: name,
      developer: name.split('/')[0],
      description: '',
      downloads: 10,
      is_managed: true,
      managed: { architectures, parameters: { BF16: 4e9 } },
    })
    const vllmReady = () => {
      vllmHub.value = { visible: true, state: 'ready', blockers: [], descriptorId: 'vllm-0.31.0-cu129-r1' }
      vllmCurated.value = {
        models: [
          {
            model_name: 'Qwen/Qwen3-8B-AWQ',
            developer: 'Qwen',
            description: '',
            downloads: 0,
            is_managed: true,
            managed: { curated: true, curatedBy: 'vllm', revision: 'rev-v' },
          },
        ],
        supportedArchitectures: ['Qwen3ForCausalLM'],
        loading: false,
      }
    }
    const trtBlockedByDriver = () => {
      tensorrtHub.value = {
        visible: true,
        state: 'blocked',
        blockers: [
          {
            code: 'MANAGED_PREREQUISITE_BLOCKED',
            reason: 'driver-too-old',
            message: 'TensorRT-LLM needs a newer NVIDIA driver.',
            params: { required: '615', actual: '580' },
          },
        ],
        descriptorId: 'tensorrt-llm-1.3.0rc29-r3',
      }
    }

    it('TensorRT-LLM blocked by the driver: models and verdicts under vLLM, the blocker under TensorRT-LLM', async () => {
      vllmReady()
      trtBlockedByDriver()
      mocks.listHuggingFaceFeed.mockResolvedValue({
        models: [managedEntry('someone/Qwen3-4B-AWQ', ['Qwen3ForCausalLM'])],
        nextCursor: null,
      })
      setHubFormat('vllm')

      const view = render(<HubPage />)

      expect(await screen.findByText('Qwen3-4B-AWQ')).toBeInTheDocument()
      const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
      expect(headings).toEqual(['hub:vllm.curated', 'hub:feedTitle'])
      expect(screen.queryByText('TensorRT-LLM needs a newer NVIDIA driver.')).not.toBeInTheDocument()
      // The row reads as the format shown, not as TensorRT-LLM.
      expect(screen.getAllByText('vllm').length).toBeGreaterThan(0)
      view.unmount()

      setHubFormat('tensorrt-llm')
      render(<HubPage />)

      expect(screen.getByText('hub:tensorrt.blocked.title')).toBeInTheDocument()
      expect(screen.getByText('TensorRT-LLM needs a newer NVIDIA driver.')).toBeInTheDocument()
      expect(screen.queryByText('Qwen3-4B-AWQ')).not.toBeInTheDocument()
    })

    it('an architecture vLLM does not support: that repository is not in the vLLM list', async () => {
      vllmReady()
      mocks.listHuggingFaceFeed.mockResolvedValue({
        models: [
          managedEntry('someone/Qwen3-4B-AWQ', ['Qwen3ForCausalLM']),
          managedEntry('someone/Nemotron-H-8B', ['NemotronHForCausalLM']),
        ],
        nextCursor: null,
      })
      setHubFormat('vllm')

      render(<HubPage />)

      expect(await screen.findByText('Qwen3-4B-AWQ')).toBeInTheDocument()
      expect(screen.queryByText('Nemotron-H-8B')).not.toBeInTheDocument()
      expect(mocks.listHuggingFaceFeed).toHaveBeenCalledWith(
        expect.objectContaining({ format: 'safetensors' })
      )
    })

    it('the vLLM descriptor not published yet: no vLLM format, a vLLM link reads as GGUF, TensorRT-LLM as before', () => {
      // The core hides the provider until conf publishes runtimes/vllm.json (design D15).
      tensorrtHub.value = { visible: true, state: 'ready', blockers: [], descriptorId: 'tensorrt-llm-1.3.0rc29-r3' }
      mocks.search = { engine: 'vllm' }

      render(<HubPage />)

      expect(screen.getByText('Qwen3.5 4B')).toBeInTheDocument()
      expect(screen.queryByText('hub:vllm.checking')).not.toBeInTheDocument()
      expect(screen.queryByText('hub:vllm.curated')).not.toBeInTheDocument()
    })
  })

  it('resolves a deep link the catalog does not carry from Hugging Face', async () => {
    mocks.search = { model: 'tiny-lab/experimental-3b' }
    mocks.fetchHuggingFaceRepo.mockResolvedValue(
      model('tiny-lab/experimental-3b') as never
    )
    render(<HubPage />)

    await waitFor(() =>
      expect(screen.getByTestId('detail-panel')).toHaveTextContent(
        'tiny-lab/experimental-3b'
      )
    )
    expect(mocks.fetchHuggingFaceRepo).toHaveBeenCalledWith(
      'tiny-lab/experimental-3b',
      ''
    )
  })

  it('gives a selected Hugging Face search hit the files it can download', async () => {
    // Hugging Face's search endpoint lists repos without their files, so the
    // hit arrives with no quants; the panel needs the card fetched for it.
    const repo = 'prism-ml/Ternary-Bonsai-2-27B-gguf'
    mocks.search = { q: 'bonsai', model: repo }
    mocks.searchHuggingFaceCandidates.mockImplementation(async () => [
      model(repo, { quants: [], num_quants: 0 }),
    ])
    mocks.fetchHuggingFaceRepo.mockImplementation(async (repoId: string) =>
      repoId === repo ? (model(repo) as unknown as HuggingFaceRepo) : null
    )
    render(<HubPage />)

    await waitFor(() =>
      expect(screen.getByTestId('detail-panel')).toHaveAttribute(
        'data-quants',
        '1'
      )
    )
    expect(screen.getByTestId('detail-panel')).toHaveTextContent(repo)
    expect(mocks.fetchHuggingFaceRepo).toHaveBeenCalledWith(repo, '')
  })

  it('lists and paginates uncensored builds under a stable heading', async () => {
    localStorage.setItem(
      HUB_FILTERS_STORAGE_KEY,
      serializeHubFilters({
        formats: ['gguf'],
        sort: 'recommended',
        onlyFitting: true,
        uncensored: true,
      })
    )
    mocks.sources = [
      model('test/plain-GGUF'),
      model('test/qwen-abliterated-GGUF'),
    ]
    mocks.listHuggingFaceFeed.mockImplementation(async (params) => {
      if (params.search === 'uncensored' && !params.cursor) {
        return {
          models: [model('hf/gemma-uncensored-GGUF')],
          nextCursor: 'uncensored-page-2',
        }
      }
      if (params.cursor === 'uncensored-page-2') {
        return {
          models: [model('hf/qwen-uncensored-page-2-GGUF')],
          nextCursor: null,
        }
      }
      if (params.search === 'abliterated') {
        return {
          models: [model('hf/llama-abliterated-GGUF')],
          nextCursor: null,
        }
      }
      return { models: [], nextCursor: null }
    })
    render(<HubPage />)

    await waitFor(() =>
      expect(screen.getByText('gemma-uncensored-GGUF')).toBeInTheDocument()
    )
    await waitFor(() =>
      expect(
        screen.getByText('qwen-uncensored-page-2-GGUF')
      ).toBeInTheDocument()
    )
    expect(screen.getByText('qwen-abliterated-GGUF')).toBeInTheDocument()
    expect(screen.getByText('llama-abliterated-GGUF')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'hub:uncensored' })).toBeVisible()
    expect(screen.queryByText('plain-GGUF')).not.toBeInTheDocument()
    // The curated picks carry no uncensored builds, so they are not shown.
    expect(screen.queryByText('Qwen3.5 4B')).not.toBeInTheDocument()
    expect(mocks.listHuggingFaceFeed).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'uncensored' })
    )
    expect(mocks.listHuggingFaceFeed).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'abliterated' })
    )
    // The terms ride along out of sight: the search box stays as typed.
    expect(
      screen.getByRole('textbox', { name: 'hub:searchPlaceholder' })
    ).toHaveValue('')
  })

  describe('categories', () => {
    const lastNavigation = () =>
      mocks.navigate.mock.calls.at(-1)?.[0] as {
        search: (prev: Record<string, unknown>) => Record<string, unknown>
        replace?: boolean
      }

    const picker = () => screen.queryByTestId('hub-category-workflow-select')
    const pick = async (category: string) => {
      await userEvent.click(screen.getByTestId('hub-category-workflow-select'))
      await userEvent.click(
        screen.getByTestId(`hub-category-workflow-option-${category}`)
      )
    }

    it('stays the chat catalog without the media engine, whatever the URL says', () => {
      mocks.search = { category: 'image' }
      render(<HubPage />)

      expect(picker()).not.toBeInTheDocument()
      expect(screen.queryByTestId('media-hub')).not.toBeInTheDocument()
      expect(screen.getByText('Qwen3.5 4B')).toBeInTheDocument()
    })

    it('opens on Text, with the picker above the filters', () => {
      mocks.mediaSupported = true
      render(<HubPage />)

      expect(picker()).toHaveAttribute('data-mode', 'chat')
      expect(screen.getByText('Qwen3.5 4B')).toBeInTheDocument()
      expect(screen.queryByTestId('media-hub')).not.toBeInTheDocument()
    })

    it('lists only the types this machine can run, each with what it does', async () => {
      mocks.decisionSupported = true
      render(<HubPage />)

      await userEvent.click(screen.getByTestId('hub-category-workflow-select'))
      const menu = screen.getByTestId('hub-category-workflow-menu')
      expect(menu).toHaveTextContent('hub:categoryChatHint')
      expect(menu).toHaveTextContent('hub:categoryDecisionHint')
      expect(
        screen.queryByTestId('hub-category-workflow-option-image')
      ).not.toBeInTheDocument()
      expect(
        screen.queryByTestId('hub-category-workflow-option-video')
      ).not.toBeInTheDocument()
    })

    it('shows the image catalog the URL names, with its search and selection', () => {
      mocks.mediaSupported = true
      mocks.search = { category: 'image', q: 'flux', model: 'z-image' }
      render(<HubPage />)

      expect(
        screen.getByText('image catalog, query "flux", open z-image')
      ).toBeInTheDocument()
      expect(picker()).toHaveAttribute('data-mode', 'image')
      // The chat feed is not even asked for.
      expect(screen.queryByText('Qwen3.5 4B')).not.toBeInTheDocument()
      expect(mocks.listHuggingFaceFeed.mock.calls).toEqual([])
    })

    it('shows the decision catalog the URL names, with its search and selection', () => {
      mocks.decisionSupported = true
      mocks.search = { category: 'decision', q: 'multi', model: 'laya' }
      render(<HubPage />)

      expect(
        screen.getByText('decision catalog, query "multi", open laya')
      ).toBeInTheDocument()
      expect(picker()).toHaveAttribute('data-mode', 'decision')
      expect(mocks.listHuggingFaceFeed.mock.calls).toEqual([])
    })

    it('stays the chat catalog where decision models cannot run', () => {
      mocks.mediaSupported = true
      mocks.search = { category: 'decision' }
      render(<HubPage />)

      expect(screen.queryByTestId('decision-hub')).not.toBeInTheDocument()
      expect(picker()).toHaveAttribute('data-mode', 'chat')
    })

    it('drops the selection of the old category when switching', async () => {
      mocks.mediaSupported = true
      render(<HubPage />)

      await pick('video')

      const navigation = lastNavigation()
      expect(navigation.replace).toBe(true)
      expect(
        navigation.search({
          q: 'wan',
          model: 'Qwen/Qwen3.5-4B-GGUF',
          repo: 'x',
        })
      ).toEqual({
        q: 'wan',
        category: 'video',
        model: undefined,
        repo: undefined,
      })
    })

    it('leaves Text out of the URL when switching back to it', async () => {
      mocks.mediaSupported = true
      mocks.search = { category: 'video', model: 'wan-2.2-ti2v-5b' }
      render(<HubPage />)

      await pick('chat')

      expect(
        lastNavigation().search({ category: 'video', model: 'wan-2.2-ti2v-5b' })
      ).toEqual({ category: undefined, model: undefined, repo: undefined })
    })

    it('puts a decision model picked in its catalog into the URL', async () => {
      mocks.decisionSupported = true
      mocks.search = { category: 'decision' }
      render(<HubPage />)

      await userEvent.click(screen.getByRole('button', { name: 'pick laya' }))

      const navigation = lastNavigation()
      expect(navigation.replace).toBe(false)
      expect(navigation.search({ category: 'decision' })).toEqual({
        category: 'decision',
        model: 'laya',
      })
    })

    it('puts a family picked in the media catalog into the URL', async () => {
      mocks.mediaSupported = true
      mocks.search = { category: 'image' }
      render(<HubPage />)

      await userEvent.click(screen.getByRole('button', { name: 'pick flux' }))

      const navigation = lastNavigation()
      expect(navigation.replace).toBe(false)
      expect(navigation.search({ category: 'image' })).toEqual({
        category: 'image',
        model: 'flux.1-schnell',
      })
    })
  })
})
