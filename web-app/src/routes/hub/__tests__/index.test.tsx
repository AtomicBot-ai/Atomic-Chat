import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '@/services/models/types'
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
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute:
    () =>
    (options: Record<string, unknown>) => ({
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

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <header>{children}</header>
  ),
}))

vi.mock('@/containers/hub/ModelDetailPanel', () => ({
  ModelDetailPanel: ({ model }: { model: CatalogModel | null }) => (
    <aside data-testid="detail-panel">
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
import {
  HUB_FILTERS_STORAGE_KEY,
  serializeHubFilters,
} from '@/lib/hub-filters'
import { setHubSearchQuery } from '../hub-session'

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
  })

  it('opens on staff picks with an empty query', () => {
    render(<HubPage />)

    expect(screen.queryByText('hub:staffPicks')).not.toBeInTheDocument()
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
    expect(screen.queryByText('hub:searchResults')).not.toBeInTheDocument()
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
})
