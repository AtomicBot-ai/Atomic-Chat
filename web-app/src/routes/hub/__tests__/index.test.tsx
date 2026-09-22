import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel, HuggingFaceRepo } from '@/services/models/types'
import type { ResolvedStaffPick } from '@/hooks/useStaffPicks'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
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
      hardwareData: { total_memory: number; gpus: unknown[] }
    }) => unknown
  ) => selector({ hardwareData: { total_memory: 64 * 1024, gpus: [] } }),
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
import { setHubSearchQuery } from '../hub-session'
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
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setHubSearchQuery('')
    mocks.search = {}
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
    localStorage.setItem(
      HUB_FILTERS_STORAGE_KEY,
      serializeHubFilters({
        formats: ['mlx'],
        sort: 'recommended',
        onlyFitting: false,
        uncensored: false,
      })
    )

    render(<HubPage />)

    expect(mocks.requestedPickFormats).toContain('mlx')
    expect(screen.getByText('Qwen3.5 4B (MLX)')).toBeInTheDocument()
    expect(screen.queryByText('Qwen3.5 4B')).not.toBeInTheDocument()
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
})
