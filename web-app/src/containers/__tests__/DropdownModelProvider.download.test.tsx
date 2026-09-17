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
import { useNavigate } from '@tanstack/react-router'
import DropdownModelProvider from '../DropdownModelProvider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useRecommendedListDownloads } from '@/hooks/useRecommendedDownloads'
import { resetModelPickerDownloadsForTest } from '../ModelPickerDownloads'
import type { AuthService } from '@/services/auth/types'
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
  useRecommendedListDownloads: vi.fn(),
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
  abortDownload: vi.fn(() => Promise.resolve()),
  chatgptStatus: vi.fn(() => Promise.resolve({ connected: false })),
  navigate: vi.fn(),
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
  sizeLabel: '2.5 GB',
  sizeBytes: 2.5 * GB,
  fit: 'comfortable' as const,
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

/** A cloud provider that takes a key, with none pasted yet. */
const unconnectedCloud = {
  provider: 'openai',
  active: true,
  api_key: '',
  models: [],
  settings: [
    {
      key: 'api-key',
      title: 'API key',
      description: '',
      controller_type: 'input',
      controller_props: { value: '' },
    },
  ],
}

/** The subscription entry, present but not signed into. */
const subscriptionProvider = {
  provider: 'chatgpt',
  active: true,
  models: [],
  settings: [],
}

const GB = 1024 ** 3

/** A transfer part-way through, as the download panel sees it. */
const runningDownload = (id: string) => {
  const total = Math.round(1.58 * GB)
  const current = Math.round(0.16 * GB)
  return {
    id,
    name: id,
    progress: 0.1,
    current,
    total,
    speed: {
      bytesPerSecond: (total - current) / 60,
      atBytes: current,
      atTime: Date.now(),
    },
  } as never
}

const searchField = () => screen.getByPlaceholderText('common:searchModels')
const list = () => screen.getByTestId('popover-content')
const hubShortcut = () =>
  screen.queryByRole('button', { name: /common:downloadModel/ })

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
    vi.mocked(useRecommendedListDownloads).mockReturnValue({
      items: [],
      isLoading: false,
    })
    vi.mocked(useNavigate).mockReturnValue(mocks.navigate as never)
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
        abortDownload: mocks.abortDownload,
      } as unknown as ModelsService,
      auth: {
        chatgptStatus: mocks.chatgptStatus,
      } as unknown as AuthService,
    })
    withProviders([emptyUpstream])
  })

  afterEach(() => {
    cleanup()
  })

  it('offers the best fit for this device when nothing is downloaded', () => {
    const lead = recommended()
    vi.mocked(useRecommendedListDownloads).mockReturnValue({
      items: [lead],
      isLoading: false,
    })

    render(<DropdownModelProvider />)

    // The list opens straight away with nothing to pick; instead of a blank
    // panel it shows the reply gate's list: the recommended models under
    // their label, each with its mark and the size beside its fit badge.
    expect(list()).toHaveTextContent('setup:recommend.title')
    const row = screen.getByTestId('model-picker-recommended-lead')
    expect(row.querySelector('img')).toHaveAttribute(
      'src',
      expect.stringMatching(/qwen/)
    )
    const button = within(row).getByRole('button', {
      name: 'chat:replyGate.downloadLabel:{"name":"Qwen3.5 4B"}',
    })
    expect(row).toHaveTextContent('2.5 GB')
    expect(button).toHaveTextContent(/^hub:download$/)

    fireEvent.click(button)

    expect(lead.start).toHaveBeenCalledTimes(1)
    // The other ways to get a model sit under the list, as in the reply
    // gate — and the panel is the download, so no second "Download a model"
    // row under it.
    expect(screen.getByTestId('model-picker-routes')).toBeInTheDocument()
    expect(hubShortcut()).toBeNull()
  })

  it('shows a recommended row as downloading while its download runs', () => {
    vi.mocked(useRecommendedListDownloads).mockReturnValue({
      items: [recommended({ isDownloading: true })],
      isLoading: false,
    })
    useDownloadStore.setState({
      downloads: {
        'AtomicChat/Qwen3_5-4B-Q4_K_M': runningDownload(
          'AtomicChat/Qwen3_5-4B-Q4_K_M'
        ),
      },
    })

    render(<DropdownModelProvider />)

    // The panel's readout replaces the subtitle; cancellation stays in the
    // global download panel so this row keeps Welcome's stable geometry.
    const row = screen.getByTestId('model-picker-recommended-lead')
    expect(row).toHaveTextContent(
      '10% · 0.16 / 1.58 GB · common:downloadPanel.left:{"eta":"1m 00s"}'
    )
    const loading = within(row)
      .getByText('setup:downloading')
      .closest('button')!
    expect(loading).toBeDisabled()
    expect(loading).toHaveTextContent('setup:downloading')
    expect(mocks.abortDownload).not.toHaveBeenCalled()
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
        name: 'chat:replyGate.downloadLabel:{"name":"Qwen3 8B"} (GGUF)',
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
    // Before the first byte the row carries the downloader's status word,
    // and its button has become the panel's Cancel.
    await waitFor(() =>
      expect(list()).toHaveTextContent('common:downloadPanel.preparing')
    )
    // (Found by its name: the repo id under it has made way for the readout.)
    const row = screen
      .getByText('Qwen3 8B')
      .closest('[data-testid="model-picker-hugging-face-row"]') as HTMLElement
    expect(
      within(row).getByRole('button', { name: 'common:cancelDownload' })
    ).toHaveTextContent('common:cancel')
    expect(
      within(row).queryByRole('button', {
        name: 'chat:replyGate.downloadLabel:{"name":"Qwen3 8B"} (GGUF)',
      })
    ).toBeNull()
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
    // The search field and the way into the Hub are still there — the
    // latter as the Hugging Face route row, not a second button under it.
    expect(searchField()).toHaveValue('qwen')
    expect(screen.getByTestId('model-picker-browse-hub')).toBeInTheDocument()
    expect(hubShortcut()).toBeNull()
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

  it('keeps the Hub shortcut, and no download panel, once there is a model to pick', () => {
    withProviders([
      {
        ...emptyUpstream,
        models: [{ id: 'qwen3.gguf', capabilities: ['completion'] }],
      },
    ])

    render(<DropdownModelProvider />)

    expect(list()).toHaveTextContent('qwen3.gguf')
    expect(hubShortcut()).toBeInTheDocument()
    expect(screen.queryByTestId('model-picker-empty')).toBeNull()
    expect(screen.queryByTestId('model-picker-routes')).toBeNull()
  })

  it('leads to the Hub, the cloud gallery and the subscription sign-in from its route rows', async () => {
    withProviders([emptyUpstream, unconnectedCloud, subscriptionProvider])

    render(<DropdownModelProvider />)

    // Browsing carries the typed query into the Hub, as the old shortcut did.
    fireEvent.change(searchField(), { target: { value: 'qwen' } })
    fireEvent.click(
      screen.getByRole('button', { name: 'setup:cloudStep.huggingFaceTrigger' })
    )
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/hub/',
      search: { q: 'qwen' },
    })

    // "Add" opens the same gallery the reply gate and onboarding open.
    fireEvent.click(
      screen.getByRole('button', { name: 'setup:cloudStep.trigger' })
    )
    expect(
      await screen.findByText('setup:cloudStep.galleryTitle')
    ).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    })
    await waitFor(() =>
      expect(screen.queryByText('setup:cloudStep.galleryTitle')).toBeNull()
    )

    // "Connect" lands on the sign-in itself, not on the gallery.
    fireEvent.click(
      screen.getByRole('button', {
        name: 'setup:cloudStep.subscriptionTrigger',
      })
    )
    expect(
      await screen.findByText('setup:cloudStep.subscriptionDescription')
    ).toBeInTheDocument()
    expect(screen.queryByText('setup:cloudStep.galleryTitle')).toBeNull()
  })
})
