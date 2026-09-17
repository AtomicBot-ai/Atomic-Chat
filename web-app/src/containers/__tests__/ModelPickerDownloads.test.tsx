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
import {
  useRecommendedDownloads,
  type RecommendedDownload,
} from '@/hooks/useRecommendedDownloads'
import type { CatalogModel, ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}))

// The recommendation itself is the hook's business (its own tests cover it);
// here it is a fixture so the tests are about what the panel does with it.
vi.mock('@/hooks/useRecommendedDownloads', () => ({
  useRecommendedDownloads: vi.fn(),
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

const recommended = (
  repo: string,
  title: string,
  fileSize: string | undefined,
  overrides: Partial<RecommendedDownload> = {}
): RecommendedDownload => ({
  repo,
  title,
  descriptionKey: 'hub:recEverydayUse',
  model: {} as CatalogModel,
  variant: {
    model_id: `${repo}:Q4_K_M`,
    path: `https://example.test/${title}.gguf`,
    file_size: fileSize as string,
  },
  isDownloading: false,
  start: vi.fn(() => `${repo}:Q4_K_M`),
  ...overrides,
})

const withRecommended = (items: RecommendedDownload[], isLoading = false) =>
  vi.mocked(useRecommendedDownloads).mockReturnValue({ items, isLoading })

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
  const onBrowseHub = vi.fn()
  const onConnectCloud = vi.fn()
  const onConnectSubscription = vi.fn()
  const view = (q: string) => (
    <ModelPickerEmptyState
      query={q}
      onBrowseHub={onBrowseHub}
      onConnectCloud={onConnectCloud}
      onConnectSubscription={onConnectSubscription}
    />
  )
  const result = render(view(query))
  return {
    ...result,
    onBrowseHub,
    onConnectCloud,
    onConnectSubscription,
    retype: (q: string) => result.rerender(view(q)),
  }
}

const recommendedRows = () =>
  within(screen.getByTestId('model-picker-recommended')).getAllByTestId(
    /^model-picker-recommended-/
  )

const routeRows = () =>
  within(screen.getByTestId('model-picker-routes')).getAllByTestId(
    /^model-picker-(browse-hub|subscription|cloud-key)$/
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
    withRecommended([])
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
      await screen.findAllByText(repo)
      let rows = screen.getAllByTestId('model-picker-hugging-face-row')
      expect(rows).toHaveLength(macos ? 2 : 1)
      expect(within(rows[0]).getByText('GGUF')).toBeVisible()
      if (macos) expect(within(rows[1]).getByText('MLX')).toBeVisible()
      unmount()
      render(<HuggingFacePicks query="qwen" localEmpty />)
      await screen.findAllByText(repo)
      rows = screen.getAllByTestId('model-picker-download-row')
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
    await screen.findAllByText(repo)
    const rows = screen.getAllByTestId('model-picker-hugging-face-row')
    fireEvent.click(within(rows[1]).getByRole('button'))
    await waitFor(() =>
      expect(
        within(rows[1]).getByRole('button', { name: 'common:cancelDownload' })
      ).toBeEnabled()
    )
    expect(rows[1]).toHaveTextContent('common:downloadPanel.preparing')
    expect(within(rows[0]).getByRole('button')).toBeEnabled()
    expect(rows[0]).not.toHaveTextContent('common:downloadPanel.preparing')
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
    await screen.findAllByText(repo)
    const rows = screen.getAllByTestId('model-picker-hugging-face-row')
    fireEvent.click(within(rows[1]).getByRole('button'))
    await waitFor(() =>
      expect(rows[1]).toHaveTextContent('common:modelPicker.noMlxFile')
    )
    expect(within(rows[1]).getByRole('button')).toBeDisabled()
    expect(within(rows[0]).getByRole('button')).toBeEnabled()
    expect(rows[0]).not.toHaveTextContent('common:modelPicker.noGgufFile')
  })

  it('lists every recommended model under its label, each with a mark, its fit and its size', () => {
    const lead = recommended(
      'AtomicChat/Qwen3.5-4B-GGUF',
      'Qwen3.5 4B',
      '2.5 GB'
    )
    withRecommended([
      lead,
      recommended('AtomicChat/gemma-4-E4B-it-GGUF', 'Gemma 4 E4B', '6.0 GB'),
      recommended('someone/Big-70B-GGUF', 'Big 70B', '12 GB'),
    ])

    renderEmptyState()

    // The whole list, not the widget's three: the hook is asked for all of it.
    expect(useRecommendedDownloads).toHaveBeenCalledWith(50)
    expect(screen.getByText('setup:recommend.title')).toBeInTheDocument()

    const rows = recommendedRows()
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveAttribute(
      'data-testid',
      'model-picker-recommended-lead'
    )
    expect(rows[0]).toHaveTextContent('Qwen3.5 4B')
    expect(rows[0]).toHaveTextContent('chat:replyGate.recommendedForDevice')
    expect(rows[1]).toHaveTextContent('hub:recEverydayUse')

    // A mark on every row: the family's logo, Hugging Face's for the rest.
    expect(
      rows.map((row) => row.querySelector('img')?.getAttribute('src'))
    ).toEqual([
      expect.stringMatching(/qwen/),
      expect.stringMatching(/google/),
      expect.stringMatching(/huggingface/),
    ])

    // The fit badge beside the name, coloured against this machine's memory
    // and naming the reason for a screen reader.
    expect(
      rows.map((row) =>
        row.querySelector('[data-fit]')?.getAttribute('data-fit')
      )
    ).toEqual(['ok', 'warn', 'no'])
    expect(
      within(rows[0]).getByRole('button', {
        name: 'setup:recommend.fitOk. setup:recommend.whyComfortable:{"size":"2.5 GB","budget":"8 GB","pool":"setup:recommend.pool.unified"}',
      })
    ).toBeInTheDocument()

    // The size on the button; the best fit alone carries the filled one.
    const leadButton = within(rows[0]).getByRole('button', {
      name: 'chat:replyGate.downloadLabel:{"name":"Qwen3.5 4B"}',
    })
    expect(leadButton).toHaveTextContent(
      'common:modelPicker.downloadSize:{"size":"2.5 GB"}'
    )
    expect(leadButton).toHaveAttribute('data-variant', 'default')
    expect(
      within(rows[1]).getByRole('button', {
        name: 'chat:replyGate.downloadLabel:{"name":"Gemma 4 E4B"}',
      })
    ).toHaveAttribute('data-variant', 'secondary')

    fireEvent.click(leadButton)
    expect(lead.start).toHaveBeenCalledTimes(1)
  })

  it('says Download alone, with no fit badge, when the file size is unknown', () => {
    withRecommended([recommended('someone/Mystery-GGUF', 'Mystery', undefined)])

    renderEmptyState()

    const [row] = recommendedRows()
    expect(
      within(row).getByRole('button', {
        name: 'chat:replyGate.downloadLabel:{"name":"Mystery"}',
      })
    ).toHaveTextContent(/^chat:replyGate\.download$/)
    expect(row.querySelector('[data-fit]')).toBeNull()
  })

  it('shows a running download in its row, with the panel readout and a Cancel', () => {
    const lead = recommended(
      'AtomicChat/Qwen3.5-4B-GGUF',
      'Qwen3.5 4B',
      '2.5 GB',
      {
        isDownloading: true,
      }
    )
    withRecommended([lead])
    // Started, nothing received yet: the downloader's own status word.
    act(() =>
      useDownloadStore
        .getState()
        .addLocalDownloadingModel(lead.variant.model_id)
    )

    renderEmptyState()

    const [row] = recommendedRows()
    expect(row).toHaveTextContent('common:downloadPanel.preparing')
    const cancel = within(row).getByRole('button', {
      name: 'common:cancelDownload',
    })
    expect(cancel).toHaveTextContent('common:cancel')
    // No filled button while nothing is on offer.
    expect(cancel).toHaveAttribute('data-variant', 'secondary')
    expect(
      within(row).queryByRole('button', {
        name: 'chat:replyGate.downloadLabel:{"name":"Qwen3.5 4B"}',
      })
    ).toBeNull()

    // Bytes arrive: percent, bytes, time left — the panel's readout.
    act(() => seedRunningDownload(lead.variant.model_id))
    expect(row).toHaveTextContent(
      '10% · 0.16 / 1.58 GB · common:downloadPanel.left:{"eta":"1m 00s"}'
    )

    fireEvent.click(cancel)
    expect(mocks.abortDownload).toHaveBeenCalledWith(lead.variant.model_id)
    expect(
      useDownloadStore.getState().resumableDownloads.has(lead.variant.model_id)
    ).toBe(true)
  })

  it('offers the reply gate routes under the list, in its order and with its words', () => {
    withRecommended([
      recommended('AtomicChat/Qwen3.5-4B-GGUF', 'Qwen3.5 4B', '2.5 GB'),
    ])

    const { onBrowseHub, onConnectCloud, onConnectSubscription } =
      renderEmptyState()

    const rows = routeRows()
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'model-picker-browse-hub',
      'model-picker-subscription',
      'model-picker-cloud-key',
    ])
    // The routes sit under the recommendations, never above them.
    expect(
      screen
        .getByTestId('model-picker-recommended')
        .compareDocumentPosition(screen.getByTestId('model-picker-routes'))
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    expect(rows[0]).toHaveTextContent('setup:cloudStep.huggingFaceTitle')
    expect(rows[0]).toHaveTextContent('setup:cloudStep.huggingFaceHintGguf')
    const browse = within(rows[0]).getByRole('button', {
      name: 'setup:cloudStep.huggingFaceTrigger',
    })
    expect(browse).toHaveTextContent('setup:cloudStep.browse')
    expect(rows[0].querySelector('img')).toHaveAttribute(
      'src',
      expect.stringMatching(/huggingface/)
    )

    expect(rows[1]).toHaveTextContent('setup:cloudStep.subscriptionTitle')
    expect(rows[1]).toHaveTextContent('setup:cloudStep.subscriptionHint')
    const connect = within(rows[1]).getByRole('button', {
      name: 'setup:cloudStep.subscriptionTrigger',
    })
    expect(connect).toHaveTextContent('setup:cloudStep.connect')

    expect(rows[2]).toHaveTextContent('setup:cloudStep.providerTitle')
    expect(rows[2]).toHaveTextContent('setup:cloudStep.providerHint')
    const add = within(rows[2]).getByRole('button', {
      name: 'setup:cloudStep.trigger',
    })
    expect(add).toHaveTextContent('setup:cloudStep.add')

    fireEvent.click(browse)
    fireEvent.click(connect)
    fireEvent.click(add)
    expect(onBrowseHub).toHaveBeenCalledTimes(1)
    expect(onConnectSubscription).toHaveBeenCalledTimes(1)
    expect(onConnectCloud).toHaveBeenCalledTimes(1)
  })

  it('keeps only the Hub route when no cloud route can do anything', () => {
    // No provider takes a key, and the sign-in cannot run on this platform.
    platform.chatgptSubscription = false

    renderEmptyState('', [subscriptionProvider()])

    expect(routeRows().map((row) => row.getAttribute('data-testid'))).toEqual([
      'model-picker-browse-hub',
    ])
    // Nothing recommended and nothing loading: the routes are the offer.
    expect(screen.queryByTestId('model-picker-recommended')).toBeNull()
  })

  it('holds the results card at its reserved height while a search loads, answers and is cleared', async () => {
    withRecommended([
      recommended('AtomicChat/Qwen3.5-4B-GGUF', 'Qwen3.5 4B', '2.5 GB'),
    ])
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
    await screen.findByText('unsloth/Qwen3-8B-GGUF')
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
    ).toHaveTextContent(/^chat:replyGate\.download$/)
    expect(card).toHaveClass('min-h-[21rem]')
    expect(card).not.toHaveTextContent(
      'common:modelPicker.searchingHuggingFace'
    )
    // The routes stay under the results the whole time.
    expect(screen.getByTestId('model-picker-routes')).toBeInTheDocument()

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

    // Cleared: the recommendations are back where they were.
    retype('')
    expect(screen.queryByTestId('model-picker-hugging-face')).toBeNull()
    expect(screen.getByTestId('model-picker-recommended')).toHaveTextContent(
      'Qwen3.5 4B'
    )
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
