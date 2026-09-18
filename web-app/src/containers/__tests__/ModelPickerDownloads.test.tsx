import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EngineManager } from '@janhq/core'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { CatalogModel, ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}))

// A Mac with 8 GB of unified memory: 2.5 GB fits, 6 GB is tight, 12 GB will
// not load. Unmocked, the real store reports no RAM on a test host.
const hardware = vi.hoisted(() => ({
  tier: 'vram_8',
  profile: {
    tier: 'vram_8',
    memoryKind: 'unified',
    budgetMib: 8 * 1024,
    systemRamMib: 8 * 1024,
    vramMib: 0,
    hardCeiling: true,
  } as Record<string, unknown> | null,
  ready: true,
}))

vi.mock('@/hooks/useHardwareTier', () => ({
  useHardwareTier: () => hardware,
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (
    selector: (state: { huggingfaceToken: string }) => unknown
  ) => selector({ huggingfaceToken: '' }),
}))

// The subscription row is desktop-only in production; pin it on so the
// "same routes as the reply gate" assertions do not depend on the test host.
const platform = vi.hoisted(() => ({ chatgptSubscription: true }))

vi.mock('@/lib/platform/const', () => ({
  PlatformFeatures: {
    get chatgptSubscription() {
      return platform.chatgptSubscription
    },
  },
}))

import {
  HuggingFacePicks,
  ModelPickerEmptyState,
  resetModelPickerDownloadsForTest,
} from '../ModelPickerDownloads'

const mocks = {
  searchHuggingFaceCandidates: vi.fn(),
  fetchHuggingFaceRepo: vi.fn(),
  convertHfRepoToCatalogModel: vi.fn(),
  pullModelWithMetadata: vi.fn(),
  abortDownload: vi.fn(() => Promise.resolve()),
}

const GB = 1024 ** 3

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

/** A cloud provider that takes a key, with none pasted yet. */
const unconnectedCloud = () =>
  ({
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
  }) as unknown as ModelProvider

/** The subscription entry, present but not signed into. */
const subscriptionProvider = () =>
  ({
    provider: 'chatgpt',
    active: true,
    models: [],
    settings: [],
  }) as unknown as ModelProvider

/**
 * A transfer part-way through, as the download panel sees it: 10 % of
 * 1.58 GB, moving fast enough that a minute is left.
 */
function seedRunningDownload(id: string) {
  const total = Math.round(1.58 * GB)
  const current = Math.round(0.16 * GB)
  useDownloadStore.setState((state) => ({
    downloads: {
      ...state.downloads,
      [id]: {
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
      } as never,
    },
  }))
}

function renderEmptyState(
  query = '',
  providers: ModelProvider[] = [unconnectedCloud(), subscriptionProvider()]
) {
  useModelProvider.setState({ providers })
  const onConnectCloud = vi.fn()
  const onConnectSubscription = vi.fn()
  const onBrowseHuggingFace = vi.fn()
  const onImportLocal = vi.fn()
  const view = (q: string) => (
    <ModelPickerEmptyState
      query={q}
      onBrowseHuggingFace={onBrowseHuggingFace}
      onConnectCloud={onConnectCloud}
      onConnectSubscription={onConnectSubscription}
      onImportLocal={onImportLocal}
    />
  )
  const result = render(view(query))
  return {
    ...result,
    onConnectCloud,
    onConnectSubscription,
    onBrowseHuggingFace,
    onImportLocal,
    retype: (q: string) => result.rerender(view(q)),
  }
}

const routeRows = () =>
  within(screen.getByTestId('model-picker-routes')).queryAllByTestId(
    /^model-picker-(hugging-face-route|subscription|cloud-key|local-import)$/
  )

describe('ModelPickerEmptyState', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
  beforeEach(() => {
    vi.clearAllMocks()
    resetModelPickerDownloadsForTest()
    platform.chatgptSubscription = true
    useDownloadStore.setState({
      downloads: {},
      localDownloadingModels: new Set(),
      resumableDownloads: new Set(),
      pausedDownloads: new Set(),
      resumeParams: {},
    })
    mocks.searchHuggingFaceCandidates.mockResolvedValue([])
    seedServiceHub({
      models: {
        searchHuggingFaceCandidates: mocks.searchHuggingFaceCandidates,
        fetchHuggingFaceRepo: mocks.fetchHuggingFaceRepo,
        convertHfRepoToCatalogModel: mocks.convertHfRepoToCatalogModel,
        pullModelWithMetadata: mocks.pullModelWithMetadata,
        abortDownload: mocks.abortDownload,
      } as unknown as ModelsService,
    })
  })

  it.each([true, false])(
    'labels supported formats in both lists (macOS=%s)',
    async (macos) => {
      vi.stubGlobal('IS_MACOS', macos)
      const repo = 'community/Qwen3-235B-A22B-Instruct-2507'
      mocks.searchHuggingFaceCandidates.mockResolvedValue([
        hfCandidate(repo),
        { ...hfCandidate(repo), is_mlx: true },
      ])
      const { unmount } = renderEmptyState('qwen')
      let rows = await screen.findAllByTestId('model-picker-hugging-face-row')
      expect(rows).toHaveLength(macos ? 2 : 1)
      expect(within(rows[0]).getByText('GGUF')).toBeVisible()
      if (macos) expect(within(rows[1]).getByText('MLX')).toBeVisible()
      unmount()
      render(<HuggingFacePicks query="qwen" localEmpty />)
      rows = await screen.findAllByTestId('model-picker-download-row')
      expect(rows).toHaveLength(macos ? 2 : 1)
      expect(within(rows[0]).getByText('GGUF')).toBeVisible()
      if (macos) expect(within(rows[1]).getByText('MLX')).toBeVisible()
      vi.unstubAllGlobals()
    }
  )

  it('downloads MLX weights and keeps the same repo GGUF row independent', async () => {
    vi.stubGlobal('IS_MACOS', true)
    const repo = 'community/Qwen3-8B'
    mocks.searchHuggingFaceCandidates.mockResolvedValue([
      hfCandidate(repo),
      { ...hfCandidate(repo), is_mlx: true },
    ])
    mocks.fetchHuggingFaceRepo.mockResolvedValue({
      siblings: [
        { rfilename: 'model.safetensors' },
        { rfilename: 'config.json' },
        { rfilename: 'model-Q4_K_M.gguf' },
      ],
    })
    const importModel = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(EngineManager, 'instance').mockReturnValue({
      get: () => ({ import: importModel }),
    } as never)
    renderEmptyState('qwen')
    const rows = await screen.findAllByTestId('model-picker-hugging-face-row')
    fireEvent.click(within(rows[1]).getByRole('button'))
    await waitFor(() =>
      expect(
        within(rows[1]).getByRole('button', { name: 'common:cancelDownload' })
      ).toBeEnabled()
    )
    expect(within(rows[0]).getByRole('button')).toBeEnabled()
    expect(importModel).toHaveBeenCalledWith('Qwen3-8B', {
      modelPath: `https://huggingface.co/${repo}/resolve/main/model.safetensors`,
      files: [
        {
          url: `https://huggingface.co/${repo}/resolve/main/config.json`,
          filename: 'config.json',
        },
      ],
      resume: false,
    })
  })

  it('reports missing MLX weights without disabling the GGUF twin', async () => {
    vi.stubGlobal('IS_MACOS', true)
    const repo = 'community/Qwen3-8B'
    mocks.searchHuggingFaceCandidates.mockResolvedValue([
      hfCandidate(repo),
      { ...hfCandidate(repo), is_mlx: true },
    ])
    mocks.fetchHuggingFaceRepo.mockResolvedValue({
      siblings: [{ rfilename: 'model.gguf' }],
    })
    renderEmptyState('qwen')
    const rows = await screen.findAllByTestId('model-picker-hugging-face-row')
    fireEvent.click(within(rows[1]).getByRole('button'))
    await waitFor(() =>
      expect(within(rows[1]).getByRole('button')).toBeDisabled()
    )
    expect(within(rows[0]).getByRole('button')).toBeEnabled()
  })

  it('offers four explicit ways to get a model, without a miniature catalog', () => {
    const {
      onBrowseHuggingFace,
      onConnectCloud,
      onConnectSubscription,
      onImportLocal,
    } = renderEmptyState()

    const rows = routeRows()
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'model-picker-hugging-face-route',
      'model-picker-subscription',
      'model-picker-cloud-key',
      'model-picker-local-import',
    ])
    expect(screen.queryByTestId('model-picker-recommended')).toBeNull()

    expect(rows[0]).toHaveTextContent('setup:cloudStep.huggingFaceTitle')
    const browse = within(rows[0]).getByRole('button', {
      name: 'setup:cloudStep.huggingFaceTrigger',
    })
    const connect = within(rows[1]).getByRole('button', {
      name: 'setup:cloudStep.subscriptionTrigger',
    })
    const add = within(rows[2]).getByRole('button', {
      name: 'setup:cloudStep.trigger',
    })
    const local = within(rows[3]).getByRole('button', {
      name: 'chat:replyGate.addFolder',
    })

    fireEvent.click(browse)
    fireEvent.click(connect)
    fireEvent.click(add)
    fireEvent.click(local)
    expect(onBrowseHuggingFace).toHaveBeenCalledTimes(1)
    expect(onConnectSubscription).toHaveBeenCalledTimes(1)
    expect(onConnectCloud).toHaveBeenCalledTimes(1)
    expect(onImportLocal).toHaveBeenCalledTimes(1)
  })

  it('shows no duplicate route when search itself is the Hugging Face entry point', () => {
    // No provider takes a key, and the sign-in cannot run on this platform.
    platform.chatgptSubscription = false

    renderEmptyState('', [subscriptionProvider()])

    expect(routeRows().map((row) => row.getAttribute('data-testid'))).toEqual([
      'model-picker-hugging-face-route',
      'model-picker-local-import',
    ])
  })

  it('holds the results card at its reserved height while a search loads, answers and is cleared', async () => {
    mocks.searchHuggingFaceCandidates.mockResolvedValue([
      hfCandidate('unsloth/Qwen3-8B-GGUF'),
      hfCandidate('bartowski/Llama-3-8B-GGUF'),
    ])

    const { retype } = renderEmptyState('qwen')

    // Typing swaps the recommendations for the search; the card that takes
    // their place reserves the rows' height from its first, empty frame.
    expect(screen.queryByTestId('model-picker-recommended')).toBeNull()
    const card = screen.getByTestId('model-picker-hugging-face')
    expect(card).toHaveClass('min-h-[21rem]')
    expect(card).toHaveTextContent('common:modelPicker.searchingHuggingFace')
    expect(screen.getByText('common:modelPicker.huggingFace')).toBeVisible()

    // Results land as the same rows as the recommendations: mark, name, the
    // repo under it, Download.
    await screen.findByText('Qwen3 8B')
    const rows = within(card).getAllByTestId('model-picker-hugging-face-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Qwen3 8B')
    expect(rows[0].querySelector('img')).toHaveAttribute(
      'src',
      expect.stringMatching(/qwen/)
    )
    expect(
      within(rows[0]).getByRole('button', {
        name: 'chat:replyGate.downloadLabel:{"name":"Qwen3 8B"} (GGUF)',
      })
    ).toContainElement(rows[0].querySelector('.tabler-icon-download'))
    expect(card).toHaveClass('min-h-[21rem]')
    expect(card).not.toHaveTextContent(
      'common:modelPicker.searchingHuggingFace'
    )
    expect(screen.queryByTestId('model-picker-routes')).not.toBeInTheDocument()

    // A query too short to ask about, and one nothing answers.
    retype('qw')
    expect(screen.getByTestId('model-picker-hugging-face')).toHaveClass(
      'min-h-[21rem]'
    )
    expect(screen.getByTestId('model-picker-hugging-face')).toHaveTextContent(
      'common:noModelsFoundFor:{"searchValue":"qw"}'
    )
    mocks.searchHuggingFaceCandidates.mockResolvedValue([])
    retype('zzzz')
    await waitFor(() =>
      expect(screen.getByTestId('model-picker-hugging-face')).toHaveTextContent(
        'common:noModelsFoundFor:{"searchValue":"zzzz"}'
      )
    )
    expect(screen.getByTestId('model-picker-hugging-face')).toHaveClass(
      'min-h-[21rem]'
    )

    // Cleared: the four entry points return, not a miniature model catalog.
    retype('')
    expect(screen.queryByTestId('model-picker-hugging-face')).toBeNull()
    expect(screen.getByTestId('model-picker-routes')).toBeInTheDocument()
  })

  it('says so, in the same card, when Hugging Face cannot be reached', async () => {
    mocks.searchHuggingFaceCandidates.mockRejectedValue(
      new Error('Failed to fetch')
    )

    renderEmptyState('qwen')

    const card = screen.getByTestId('model-picker-hugging-face')
    await waitFor(() =>
      expect(card).toHaveTextContent(
        'common:modelPicker.huggingFaceUnavailable'
      )
    )
    expect(card).toHaveClass('min-h-[21rem]')
    expect(card).not.toHaveTextContent(
      'common:modelPicker.searchingHuggingFace'
    )
  })
})
