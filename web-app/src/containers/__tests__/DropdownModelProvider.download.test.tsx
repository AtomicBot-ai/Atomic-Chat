import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest'
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react'
import '@testing-library/jest-dom'
import DropdownModelProvider from '../DropdownModelProvider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useRecommendedDownloads } from '@/hooks/useRecommendedDownloads'
import { resetModelPickerDownloadsForTest } from '../ModelPickerDownloads'
import type { CatalogModel, ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: vi.fn(),
}))

// The component subscribes with selectors, so the mock has to apply them.
const mockModelProvider = (state: Record<string, unknown>) => {
  vi.mocked(useModelProvider).mockImplementation(((selector?: any) =>
    selector ? selector(state) : state) as never)
}

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: vi.fn(() => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  })),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: vi.fn(() => vi.fn()),
}))

vi.mock('@/hooks/useFavoriteModel', () => ({
  useFavoriteModel: vi.fn(() => ({
    favoriteModels: [],
  })),
}))

// The recommendation itself is the hook's business (ReplyModelGate covers
// it); here it is a fixture so the tests are about what the list does with it.
vi.mock('@/hooks/useRecommendedDownloads', () => ({
  useRecommendedDownloads: vi.fn(),
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-trigger">{children}</div>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-content">{children}</div>
  ),
}))

vi.mock('../ProvidersAvatar', () => ({
  default: ({ provider }: { provider: any }) => (
    <div data-testid={`provider-avatar-${provider.provider}`} />
  ),
}))

vi.mock('../ModelSupportStatus', () => ({
  ModelSupportStatus: () => <div data-testid="model-support-status" />,
}))

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const mocks = {
  searchHuggingFaceCandidates: vi.fn(),
  fetchHuggingFaceRepo: vi.fn(),
  convertHfRepoToCatalogModel: vi.fn(),
  pullModelWithMetadata: vi.fn(),
}

/** An engine that is on but has nothing downloaded yet. */
const emptyUpstream = {
  provider: 'llamacpp-upstream',
  active: true,
  api_key: '',
  models: [] as { id: string; capabilities: string[] }[],
  settings: [],
}

const withProviders = (providers: Record<string, unknown>[]) =>
  mockModelProvider({
    providers,
    selectedProvider: '',
    selectedModel: undefined,
    getProviderByName: vi.fn((name: string) =>
      providers.find((p) => p.provider === name)
    ),
    selectModelProvider: vi.fn(),
    getModelBy: vi.fn(),
    updateProvider: vi.fn(),
  })

const recommended = (
  overrides: Partial<{
    isDownloading: boolean
    start: () => string | null
  }> = {}
) => ({
  repo: 'AtomicChat/Qwen3.5-4B-GGUF',
  title: 'Qwen3.5 4B',
  descriptionKey: 'hub:recEverydayUse',
  model: {} as CatalogModel,
  variant: {
    model_id: 'AtomicChat/Qwen3_5-4B-Q4_K_M',
    path: 'https://example.test/q4.gguf',
    file_size: '2.5 GB',
  },
  isDownloading: false,
  start: vi.fn(() => 'AtomicChat/Qwen3_5-4B-Q4_K_M'),
  ...overrides,
})

const hfCandidate = (repoId: string): CatalogModel =>
  ({
    model_name: repoId,
    developer: repoId.split('/')[0],
    downloads: 1000,
    description: '',
    num_quants: 0,
    quants: [],
    num_mmproj: 0,
    mmproj_models: [],
    num_safetensors: 0,
    safetensors_files: [],
    is_mlx: false,
  }) as unknown as CatalogModel

const resolvedRepo: CatalogModel = {
  ...hfCandidate('unsloth/Qwen3-8B-GGUF'),
  quants: [
    {
      model_id: 'unsloth/Qwen3-8B-Q8_0',
      path: 'https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q8_0.gguf',
      file_size: '8.7 GB',
    },
    {
      model_id: 'unsloth/Qwen3-8B-Q4_K_M',
      path: 'https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf',
      file_size: '5.0 GB',
    },
  ],
}

const searchField = () => screen.getByPlaceholderText('common:searchModels')
const list = () => screen.getByTestId('popover-content')

describe('DropdownModelProvider - downloading from the list', () => {
  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetModelPickerDownloadsForTest()
    useDownloadStore.setState({
      downloads: {},
      localDownloadingModels: new Set(),
      resumableDownloads: new Set(),
      downloadOriginByModelId: {},
    })
    mocks.searchHuggingFaceCandidates.mockResolvedValue([])
    mocks.fetchHuggingFaceRepo.mockResolvedValue({ id: 'repo' })
    mocks.convertHfRepoToCatalogModel.mockReturnValue(resolvedRepo)
    mocks.pullModelWithMetadata.mockResolvedValue(undefined)
    vi.mocked(useRecommendedDownloads).mockReturnValue({
      items: [],
      isLoading: false,
    })
    seedServiceHub({
      models: {
        checkMmprojExists: vi.fn().mockResolvedValue(false),
        checkMmprojExistsAndUpdateOffloadMMprojSetting: vi
          .fn()
          .mockResolvedValue(undefined),
        getActiveModels: vi.fn().mockResolvedValue([]),
        searchHuggingFaceCandidates: mocks.searchHuggingFaceCandidates,
        fetchHuggingFaceRepo: mocks.fetchHuggingFaceRepo,
        convertHfRepoToCatalogModel: mocks.convertHfRepoToCatalogModel,
        pullModelWithMetadata: mocks.pullModelWithMetadata,
      } as unknown as ModelsService,
    })
    withProviders([emptyUpstream])
  })

  afterEach(() => {
    cleanup()
  })

  it('offers the best fit for this device when nothing is downloaded', () => {
    const lead = recommended()
    vi.mocked(useRecommendedDownloads).mockReturnValue({
      items: [lead],
      isLoading: false,
    })

    render(<DropdownModelProvider />)

    // The list opens straight away with nothing to pick; instead of a blank
    // panel it shows the same rows the blocked-send widget recommends.
    expect(list()).toHaveTextContent('chat:replyGate.recommendedForDevice')
    const row = screen.getByText('Qwen3.5 4B').closest('[data-testid]')!
    const button = within(row as HTMLElement).getByRole('button', {
      name: 'chat:replyGate.downloadLabel:{"name":"Qwen3.5 4B"}',
    })
    // The verb alone; the size stays off the button.
    expect(button).toHaveTextContent(/^chat:replyGate\.download$/)

    fireEvent.click(button)

    expect(lead.start).toHaveBeenCalledTimes(1)
    // The way into the Hub for browsing is still at the bottom.
    expect(
      screen.getByRole('button', { name: /common:downloadModel/ })
    ).toBeInTheDocument()
  })

  it('shows a recommended row as downloading while its download runs', () => {
    vi.mocked(useRecommendedDownloads).mockReturnValue({
      items: [recommended({ isDownloading: true })],
      isLoading: false,
    })
    useDownloadStore.setState({
      downloads: {
        'AtomicChat/Qwen3_5-4B-Q4_K_M': {
          id: 'AtomicChat/Qwen3_5-4B-Q4_K_M',
          name: 'AtomicChat/Qwen3_5-4B-Q4_K_M',
          progress: 0.42,
          current: 42,
          total: 100,
          speed: { bytesPerSecond: 0, samples: [] } as never,
        },
      },
    })

    render(<DropdownModelProvider />)

    expect(list()).toHaveTextContent(
      'chat:replyGate.downloadingPercent:{"percent":42}'
    )
    expect(
      screen.getByRole('button', {
        name: 'chat:replyGate.downloadLabel:{"name":"Qwen3.5 4B"}',
      })
    ).toBeDisabled()
  })

  it('finds GGUF builds on Hugging Face when the search has no local match', async () => {
    mocks.searchHuggingFaceCandidates.mockResolvedValue([
      hfCandidate('unsloth/Qwen3-8B-GGUF'),
      hfCandidate('bartowski/Qwen3-4B-GGUF'),
    ])

    render(<DropdownModelProvider />)
    fireEvent.change(searchField(), { target: { value: 'qwen' } })

    expect(list()).toHaveTextContent('common:modelPicker.searchingHuggingFace')

    // Rows carry the repo they stand for and a Download button each; the
    // "nothing found" line is gone, because something was.
    await screen.findByText('unsloth/Qwen3-8B-GGUF')
    expect(screen.getByText('bartowski/Qwen3-4B-GGUF')).toBeInTheDocument()
    expect(list()).not.toHaveTextContent('common:noModelsFoundFor')
    expect(list()).not.toHaveTextContent(
      'common:modelPicker.searchingHuggingFace'
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: 'chat:replyGate.downloadLabel:{"name":"Qwen3 8B"}',
      })
    )

    // The download takes the file the Hub would open on (Q4_K_M, not the Q8
    // the repo lists first), and the row reports it is on its way.
    await waitFor(() =>
      expect(mocks.pullModelWithMetadata).toHaveBeenCalledWith(
        'unsloth/Qwen3-8B-Q4_K_M',
        'https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf',
        undefined,
        undefined,
        true,
        false
      )
    )
    expect(useDownloadStore.getState().localDownloadingModels).toContain(
      'unsloth/Qwen3-8B-Q4_K_M'
    )
    await waitFor(() =>
      expect(list()).toHaveTextContent('chat:replyGate.downloading')
    )
    expect(
      screen.getByRole('button', {
        name: 'chat:replyGate.downloadLabel:{"name":"Qwen3 8B"}',
      })
    ).toBeDisabled()
  })

  it('says so when Hugging Face cannot be reached, without giving up the list', async () => {
    mocks.searchHuggingFaceCandidates.mockRejectedValue(
      new Error('Failed to fetch')
    )

    render(<DropdownModelProvider />)
    fireEvent.change(searchField(), { target: { value: 'qwen' } })

    await waitFor(() =>
      expect(list()).toHaveTextContent(
        'common:modelPicker.huggingFaceUnavailable'
      )
    )
    expect(list()).not.toHaveTextContent(
      'common:modelPicker.searchingHuggingFace'
    )
    // The search field and the way into the Hub are still there.
    expect(searchField()).toHaveValue('qwen')
    expect(
      screen.getByRole('button', { name: /common:downloadModel/ })
    ).toBeInTheDocument()
  })

  it('keeps "no models found" for a query neither side can answer', async () => {
    mocks.searchHuggingFaceCandidates.mockResolvedValue([])

    render(<DropdownModelProvider />)
    fireEvent.change(searchField(), { target: { value: 'zzzz' } })

    await waitFor(() =>
      expect(list()).toHaveTextContent(
        'common:noModelsFoundFor:{"searchValue":"zzzz"}'
      )
    )
    expect(list()).not.toHaveTextContent(
      'common:modelPicker.searchingHuggingFace'
    )
  })
})
