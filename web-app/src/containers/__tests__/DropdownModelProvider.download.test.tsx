import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import DropdownModelProvider from '../DropdownModelProvider'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { EMBEDDING_MODEL_ID } from '@/constants/models'
import { VOICE_MODEL_ID } from '@/constants/voice'
import type { CatalogModel, ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'
import { resetModelPickerDownloadsForTest } from '../ModelPickerDownloads'

vi.mock('@/hooks/useModelProvider', () => ({ useModelProvider: vi.fn() }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (key === 'common:selectAModel') return 'Select Model'
      if (key === 'common:searchModels') return 'Search models...'
      if (key === 'common:searchModelsHuggingFace')
        return 'Search models on Hugging Face...'
      return vars ? `${key}:${JSON.stringify(vars)}` : key
    },
  }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/hooks/useFavoriteModel', () => ({
  useFavoriteModel: () => ({ favoriteModels: [] }),
}))
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-content">{children}</div>
  ),
}))
vi.mock('../ProvidersAvatar', () => ({
  default: ({ provider }: { provider: ModelProvider }) => (
    <div data-testid={`provider-avatar-${provider.provider}`} />
  ),
}))
vi.mock('../ModelSupportStatus', () => ({ ModelSupportStatus: () => null }))

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const searchHuggingFaceCandidates = vi.fn()

const localProvider = (models: Partial<Model>[] = []): ModelProvider =>
  ({
    provider: 'llamacpp-upstream',
    active: true,
    models,
    settings: [],
  }) as ModelProvider

const cloudProvider = (models: Partial<Model>[] = []): ModelProvider =>
  ({
    provider: 'openai',
    active: true,
    api_key: 'configured',
    models,
    settings: [],
  }) as ModelProvider

const mockProviders = (providers: ModelProvider[]) => {
  const state = {
    providers,
    selectedProvider: '',
    selectedModel: undefined,
    getProviderByName: (name: string) =>
      providers.find((provider) => provider.provider === name),
    selectModelProvider: vi.fn(),
    updateProvider: vi.fn(),
  }
  vi.mocked(useModelProvider).mockImplementation(((selector?: any) =>
    selector ? selector(state) : state) as never)
}

const runningDownload = (id: string) => ({
  id,
  name: id,
  progress: 0.25,
  current: 25,
  total: 100,
  speed: { bytesPerSecond: 1, atBytes: 25, atTime: Date.now() },
})

const hfCandidate = (repo: string): CatalogModel =>
  ({
    model_name: repo,
    developer: repo.split('/')[0],
    description: '',
    downloads: 1,
    is_mlx: false,
  }) as CatalogModel

describe('DropdownModelProvider installed model picker', () => {
  beforeAll(() => {
    global.ResizeObserver = MockResizeObserver
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.stubGlobal('IS_MACOS', false)
    resetModelPickerDownloadsForTest()
    useDownloadStore.setState({
      downloads: {},
      localDownloadingModels: new Set(),
      pausedDownloads: new Set(),
      resumableDownloads: new Set(),
      resumeParams: {},
      downloadOriginByModelId: {},
    })
    searchHuggingFaceCandidates.mockResolvedValue([])
    seedServiceHub({
      models: {
        getActiveModels: vi.fn().mockResolvedValue([]),
        checkMmprojExists: vi.fn().mockResolvedValue(false),
        checkMmprojExistsAndUpdateOffloadMMprojSetting: vi
          .fn()
          .mockResolvedValue(undefined),
        searchHuggingFaceCandidates,
      } as unknown as ModelsService,
    })
    mockProviders([localProvider()])
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps the closed unselected trigger wide and shows the full label', () => {
    render(<DropdownModelProvider />)

    const trigger = document.querySelector(
      '[data-test-id="model-picker-trigger"]'
    ) as HTMLButtonElement
    expect(screen.getByTestId('model-picker-pill-shell')).toHaveClass('w-32')
    expect(trigger).toHaveTextContent('Select Model')
    expect(trigger).not.toHaveTextContent('Select M…')
  })

  it('shows a concise empty state and only one Hugging Face action', () => {
    mockProviders([localProvider(), cloudProvider()])
    render(<DropdownModelProvider />)

    expect(screen.getByTestId('model-picker-empty')).toHaveTextContent(
      'No installed models yet.'
    )
    expect(
      screen.getAllByRole('button', {
        name: 'Download models from Hugging Face',
      })
    ).toHaveLength(1)
    expect(screen.queryByTestId('model-picker-routes')).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('model-picker-subscription')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('model-picker-cloud-key')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('model-picker-local-import')
    ).not.toBeInTheDocument()
  })

  it('lists and filters installed chat models only', () => {
    mockProviders([
      localProvider([
        { id: 'Qwen3-Chat', capabilities: ['completion'] },
        { id: EMBEDDING_MODEL_ID, embedding: true },
        { id: VOICE_MODEL_ID },
        { id: 'Missing-Chat', missing: true },
        { id: 'Image-Only', capabilities: ['image-generation'] },
      ]),
      cloudProvider([{ id: 'Cloud-Only-Model' }]),
      {
        provider: 'stable-diffusion',
        active: true,
        persist: true,
        models: [{ id: 'Flux-Image' }],
        settings: [],
      } as ModelProvider,
    ])
    render(<DropdownModelProvider />)

    expect(screen.getByText('Qwen3 Chat')).toBeInTheDocument()
    expect(screen.queryByText('Cloud Only Model')).not.toBeInTheDocument()
    expect(screen.queryByText('Missing Chat')).not.toBeInTheDocument()
    expect(screen.queryByText('Image Only')).not.toBeInTheDocument()
    expect(screen.queryByText('Flux Image')).not.toBeInTheDocument()
    expect(screen.queryByText(EMBEDDING_MODEL_ID)).not.toBeInTheDocument()
    expect(screen.queryByText(VOICE_MODEL_ID)).not.toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Search models...'), {
      target: { value: 'qwen' },
    })
    expect(screen.getByText('Qwen3 Chat')).toBeInTheDocument()
    expect(searchHuggingFaceCandidates).not.toHaveBeenCalled()
  })

  it('shows only active text-model downloads', () => {
    const ids = [
      'Qwen3-8B-Q4_K_M',
      'diffusion-model-flux_q4',
      'diffusion-backend-metal',
      'llamacpp-backend-metal',
      'mmproj-Qwen3',
      EMBEDDING_MODEL_ID,
      VOICE_MODEL_ID,
    ]
    useDownloadStore.setState({
      downloads: Object.fromEntries(ids.map((id) => [id, runningDownload(id)])),
      localDownloadingModels: new Set(ids),
    })
    render(<DropdownModelProvider />)

    const downloads = screen.getByTestId('model-picker-downloading')
    expect(downloads).toHaveTextContent('Qwen3 8B')
    for (const excluded of ids.slice(1)) {
      expect(downloads).not.toHaveTextContent(excluded)
    }
    expect(within(downloads).getAllByRole('button')).toHaveLength(1)
  })

  it('keeps a no-match search local and leaves the Hugging Face action available', () => {
    mockProviders([localProvider([{ id: 'Qwen3-Chat' }])])
    render(<DropdownModelProvider />)

    fireEvent.change(screen.getByPlaceholderText('Search models...'), {
      target: { value: 'llama' },
    })

    expect(screen.getByTestId('model-picker-empty')).toHaveTextContent(
      'common:noModelsFoundFor:{"searchValue":"llama"}'
    )
    expect(
      screen.getByRole('button', {
        name: 'Download models from Hugging Face',
      })
    ).toBeVisible()
    expect(searchHuggingFaceCandidates).not.toHaveBeenCalled()
  })

  it('enters Hugging Face search only after the footer action is clicked', async () => {
    searchHuggingFaceCandidates.mockResolvedValue([
      hfCandidate('unsloth/Qwen3-8B-GGUF'),
    ])
    render(<DropdownModelProvider />)

    fireEvent.change(screen.getByPlaceholderText('Search models...'), {
      target: { value: 'qwen' },
    })
    expect(searchHuggingFaceCandidates).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Download models from Hugging Face',
      })
    )
    expect(
      screen.queryByRole('button', {
        name: 'Download models from Hugging Face',
      })
    ).not.toBeInTheDocument()

    const input = screen.getByPlaceholderText(
      'Search models on Hugging Face...'
    )
    fireEvent.change(input, { target: { value: 'qwen' } })

    await waitFor(() => expect(searchHuggingFaceCandidates).toHaveBeenCalled())
    expect(await screen.findByText('Qwen3 8B')).toBeInTheDocument()
  })
})
