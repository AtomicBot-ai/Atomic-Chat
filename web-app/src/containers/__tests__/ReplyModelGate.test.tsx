import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import {
  EMBEDDING_MODEL_ID,
  ONBOARDING_REMINDER_MODEL_HF_REPO,
} from '@/constants/models'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useModelProvider } from '@/hooks/useModelProvider'
import { seedServiceHub } from '@/test/service-hub'
import type { HardwareProfile } from '@/lib/hardware-tier'
import type { CatalogModel } from '@/services/models/types'

const mocks = vi.hoisted(() => ({
  switchToModel: vi.fn(() => Promise.resolve()),
  navigate: vi.fn(),
  capture: vi.fn(),
  pullModelWithMetadata: vi.fn(),
  abortDownload: vi.fn(() => Promise.resolve()),
  fetchHuggingFaceRepo: vi.fn(),
  convertHfRepoToCatalogModel: vi.fn(),
  chatgptSubscriptionAvailable: true,
}))

const sourcesMock = vi.hoisted(() => ({
  sources: [] as CatalogModel[],
  // What the manifest resolves to for this machine, lead first — the real
  // hook is covered in its own tests, and its store fetches at import time.
  recommended: [] as Array<{
    rec: { modelName: string; descriptionKey: string; quant?: string }
    model: CatalogModel | null
  }>,
  // The Hub's curated picks as `useStaffPicks` resolves them — the rows
  // onboarding lists under its offer. Mocked for the same reason.
  staffPicks: [] as Array<{
    pick: {
      model_name: string
      title?: string
      summary?: string
      icon?: string
      format?: 'gguf' | 'mlx'
    }
    model: CatalogModel | null
  }>,
}))

vi.mock('@/hooks/useResolvedRecommendedModels', () => ({
  useResolvedRecommendedModels: () => sourcesMock.recommended,
}))

// The fit copy comes from SetupScreen, whose imports reach this store; the
// stub keeps its import-time background fetch out of the tests.
vi.mock('@/stores/recommended-models-registry-store', () => ({
  useRecommendedModelsRegistryStore: {
    getState: () => ({ refresh: () => Promise.resolve() }),
  },
}))

vi.mock('@/hooks/useStaffPicks', () => ({
  useStaffPicks: () => sourcesMock.staffPicks,
}))

const folderMocks = vi.hoisted(() => ({
  pickScanFolder: vi.fn(),
  scanLocalModels: vi.fn(),
  importScannedModel: vi.fn(),
}))

vi.mock('@/hooks/useLocalScanFolder', () => ({
  useLocalScanFolder: () => ({ pickScanFolder: folderMocks.pickScanFolder }),
}))

vi.mock('@/services/models/localScan', () => ({
  scanLocalModels: folderMocks.scanLocalModels,
  collectImportedModelPaths: () => [],
}))

vi.mock('@/lib/scanned-model-import', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/scanned-model-import')
  >('@/lib/scanned-model-import')
  return { ...actual, importScannedModel: folderMocks.importScannedModel }
})

vi.mock('@/utils/switchModel', () => ({
  switchToModel: mocks.switchToModel,
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

// The catalog the recommendations resolve against. Anything not in here is
// fetched from Hugging Face through the mocked service hub below.
vi.mock('@/hooks/useModelSources', () => ({
  useModelSources: () => ({
    sources: sourcesMock.sources,
    loading: false,
    error: null,
    fetchSources: vi.fn(),
  }),
}))

vi.mock('posthog-js', () => ({
  default: { capture: mocks.capture },
}))

// Keys render as keys, so the assertions below name what a row is rather
// than how it is worded — except the copy tests, which flip `english` on and
// read `setup:` keys back as the words the user sees.
const locale = vi.hoisted(() => ({ english: false }))

vi.mock('@/i18n/react-i18next-compat', async () => {
  const en = (await import('@/locales/en/setup.json')).default
  const english = (key: string) => {
    const [ns, path] = key.split(':')
    if (ns !== 'setup' || !path) return undefined
    const hit = path
      .split('.')
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        en
      )
    return typeof hit === 'string' ? hit : undefined
  }
  const t = (key: string, vars?: Record<string, unknown>) => {
    const words = locale.english ? english(key) : undefined
    return words ?? (vars ? `${key}:${JSON.stringify(vars)}` : key)
  }
  return { useTranslation: () => ({ t }) }
})

// Unmocked, the real store reports no RAM and no GPU on a test host. Mutable
// so a test can measure the machine: `profile` is what the fit is judged on.
const hardwareMock = vi.hoisted(() => ({
  tier: 'vram_8' as string,
  profile: null as HardwareProfile | null,
  ready: true,
}))
vi.mock('@/hooks/useHardwareTier', () => ({
  useHardwareTier: () => hardwareMock,
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (
    selector: (state: { huggingfaceToken: string }) => unknown
  ) => selector({ huggingfaceToken: '' }),
}))

// The subscription button is desktop-only in production; pin it on so the
// "offered in every branch" assertions do not depend on the test platform.
vi.mock('@/lib/platform/const', () => ({
  PlatformFeatures: {
    get chatgptSubscription() {
      return mocks.chatgptSubscriptionAvailable
    },
  },
}))

import { ReplyModelGate } from '../ReplyModelGate'

const catalogModel: CatalogModel = {
  model_name: ONBOARDING_REMINDER_MODEL_HF_REPO,
  developer: 'AtomicChat',
  downloads: 0,
  quants: [
    {
      model_id: 'AtomicChat/Qwen3.5-4B-Q4_K_M',
      path: 'https://example.test/Qwen3.5-4B-Q4_K_M.gguf',
      file_size: '2.5 GB',
    },
  ],
} as CatalogModel

const model = (id: string) => ({ id }) as Model

const GB = 1024 ** 3

/** An 18 GiB Mac: Metal refuses anything past 0.85 of the pool. */
const unifiedMac: HardwareProfile = {
  tier: 'unified_16',
  memoryKind: 'unified',
  budgetMib: 18 * 1024,
  systemRamMib: 18 * 1024,
  vramMib: 0,
  hardCeiling: true,
}

/**
 * A Hub staff pick as `useStaffPicks` resolves it: the manifest entry plus
 * the catalog card, with one quant.
 */
const staffPick = (
  repo: string,
  card: { title: string; size: string; summary?: string; icon?: string }
) => {
  const [developer, name] = repo.split('/')
  const stem = name.replace(/-GGUF$/, '')
  return {
    pick: {
      model_name: repo,
      title: card.title,
      summary: card.summary,
      icon: card.icon,
      format: 'gguf' as const,
    },
    model: {
      model_name: repo,
      developer,
      downloads: 0,
      quants: [
        {
          model_id: `${developer}/${stem}-Q4_K_M`,
          path: `https://example.test/${stem}-Q4_K_M.gguf`,
          file_size: card.size,
        },
      ],
      mmproj_models: [],
    } as CatalogModel,
  }
}

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
      },
    },
  }))
}

/** The rows of the recommended list, top to bottom, whatever their kind. */
const recommendedRows = () =>
  within(screen.getByTestId('reply-gate-recommended')).getAllByTestId(
    /^reply-gate-recommended-/
  )

const localProvider = (models: Model[]) =>
  ({
    provider: 'llamacpp-upstream',
    active: true,
    models,
    settings: [],
  }) as ModelProvider

const cloudProvider = () =>
  ({
    provider: 'openai',
    active: true,
    api_key: 'sk-test',
    models: [model('gpt-a')],
    settings: [
      {
        key: 'api-key',
        title: 'API key',
        description: '',
        controller_type: 'input',
        controller_props: { value: 'sk-test' },
      },
    ],
  }) as ModelProvider

/** A provider list with nothing usable, so the widget takes the empty branch. */
const unconnectedCloud = () =>
  ({ ...cloudProvider(), api_key: '', models: [] }) as ModelProvider

/** The subscription entry, present but not signed into. */
const subscriptionProvider = () =>
  ({
    provider: 'chatgpt',
    active: true,
    models: [],
    settings: [],
  }) as ModelProvider

function renderGate(providers: ModelProvider[]) {
  useModelProvider.setState({ providers })
  const onResolved = vi.fn()
  const onDismissed = vi.fn()
  const onOpenChange = vi.fn()
  const result = render(
    <ReplyModelGate
      open
      onOpenChange={onOpenChange}
      onResolved={onResolved}
      onDismissed={onDismissed}
    />
  )
  return { ...result, onResolved, onDismissed, onOpenChange }
}

const capturedEvent = (name: string) =>
  mocks.capture.mock.calls.find(([event]) => event === name)?.[1]

const capturedEvents = (name: string) =>
  mocks.capture.mock.calls
    .filter(([event]) => event === name)
    .map(([, props]) => props)

describe('ReplyModelGate', () => {
  beforeAll(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useDownloadStore.setState({
      downloads: {},
      localDownloadingModels: new Set(),
      resumableDownloads: new Set(),
      pausedDownloads: new Set(),
      resumeParams: {},
    })
    mocks.chatgptSubscriptionAvailable = true
    hardwareMock.tier = 'vram_8'
    hardwareMock.profile = null
    sourcesMock.staffPicks = []
    sourcesMock.sources = [catalogModel]
    sourcesMock.recommended = [
      {
        rec: {
          modelName: catalogModel.model_name,
          descriptionKey: 'hub:recEverydayUse',
        },
        model: catalogModel,
      },
    ]
    mocks.fetchHuggingFaceRepo.mockResolvedValue({ id: 'repo' })
    mocks.convertHfRepoToCatalogModel.mockReturnValue(catalogModel)
    seedServiceHub({
      models: {
        fetchHuggingFaceRepo: mocks.fetchHuggingFaceRepo,
        convertHfRepoToCatalogModel: mocks.convertHfRepoToCatalogModel,
        pullModelWithMetadata: mocks.pullModelWithMetadata,
        abortDownload: mocks.abortDownload,
      } as never,
    })
  })

  it('starts the only model on the device without asking', async () => {
    const { onResolved } = renderGate([localProvider([model('only-one')])])

    await waitFor(() =>
      expect(mocks.switchToModel).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: 'only-one',
          providerName: 'llamacpp-upstream',
        })
      )
    )
    expect(onResolved).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'auto_start', branch: 'auto_start' })
    )
    // Selected up front so the composer reflects the choice immediately.
    expect(useModelProvider.getState().selectedModel?.id).toBe('only-one')
  })

  it('starts the most compact of several models instead of listing them', async () => {
    const { onResolved } = renderGate([
      localProvider([model('Qwen3.5-9B-Q4_K_M'), model('LFM2.5-1.2B-Q4_K_M')]),
    ])

    await waitFor(() =>
      expect(mocks.switchToModel).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: 'LFM2.5-1.2B-Q4_K_M' })
      )
    )
    expect(
      screen.getByText(/chat:replyGate\.startingTitle.*1\.2B/)
    ).toBeInTheDocument()
    expect(onResolved).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'auto_start', branch: 'auto_start' })
    )
  })

  it('recommends a download when the device has nothing', async () => {
    const { onResolved } = renderGate([unconnectedCloud()])

    // The best fit leads; the bundled "other options" follow it as rows.
    const lead = await screen.findByTestId('reply-gate-recommended-lead')
    fireEvent.click(within(lead).getByRole('button'))

    expect(mocks.pullModelWithMetadata).toHaveBeenCalledWith(
      'AtomicChat/Qwen3.5-4B-Q4_K_M',
      'https://example.test/Qwen3.5-4B-Q4_K_M.gguf',
      undefined,
      '',
      true,
      false
    )
    expect(onResolved).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'download', branch: 'none' })
    )
    expect(capturedEvent('reply_model_gate_outcome')).toMatchObject({
      outcome: 'download',
      branch: 'none',
    })
  })

  it('offers the folder as a row like the other routes, with a visible Add', async () => {
    // It was a bare text link under the routes: no fill, no title, and
    // wording nobody read as "point the app at my models".
    renderGate([unconnectedCloud()])

    const routes = await screen.findByTestId('reply-gate-routes')
    const row = within(routes).getByTestId('reply-gate-add-folder')
    expect(row).toHaveTextContent('chat:replyGate.folderTitle')
    expect(row).toHaveTextContent('chat:replyGate.folderHint')
    const button = within(row).getByRole('button', {
      name: 'chat:replyGate.addFolder',
    })
    expect(button).toBeVisible()
    expect(button).toHaveTextContent('setup:cloudStep.add')
  })

  it('lets the empty-handed point the scanner at their own folder', async () => {
    // A third of onboarding exits are imports of models other apps left on
    // disk. The scanner only knows those apps' default stores; the folder the
    // user actually keeps weights in was reachable only from Settings.
    folderMocks.pickScanFolder.mockResolvedValue('/Volumes/models')
    let finishScan: (found: unknown[]) => void = () => {}
    folderMocks.scanLocalModels.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishScan = resolve
        })
    )
    folderMocks.importScannedModel.mockResolvedValue({
      providerName: 'llamacpp-upstream',
      modelId: 'small',
    })
    mocks.switchToModel.mockResolvedValue(undefined)
    const { onResolved } = renderGate([unconnectedCloud()])

    const row = await screen.findByTestId('reply-gate-add-folder')
    const button = within(row).getByRole('button', {
      name: 'chat:replyGate.addFolder',
    })
    fireEvent.click(button)

    // While the scanner reads the folder the button says so and takes no
    // second click.
    await waitFor(() =>
      expect(button).toHaveTextContent('chat:replyGate.folderScanning')
    )
    expect(button).toBeDisabled()

    await act(async () => {
      finishScan([
        {
          id: 'big',
          displayName: 'big.gguf',
          path: '/Volumes/models/big.gguf',
          format: 'gguf',
          source: 'local',
          runnable: true,
          sizeBytes: 9e9,
        },
        {
          id: 'small',
          displayName: 'small.gguf',
          path: '/Volumes/models/small.gguf',
          format: 'gguf',
          source: 'local',
          runnable: true,
          sizeBytes: 1e9,
        },
      ])
    })

    // Scanned where the user pointed, and the lightest model found was the
    // one imported and started — the rule onboarding applies.
    await waitFor(() =>
      expect(folderMocks.importScannedModel).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'small' }),
        expect.anything()
      )
    )
    expect(folderMocks.scanLocalModels).toHaveBeenCalledWith(
      expect.objectContaining({ extraRoots: ['/Volumes/models'] })
    )
    await waitFor(() =>
      expect(mocks.switchToModel).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: 'small' })
      )
    )
    expect(onResolved).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'folder', branch: 'none' })
    )
  })

  it('says so, and resolves nothing, when the folder holds no model', async () => {
    folderMocks.pickScanFolder.mockResolvedValue('/Volumes/empty')
    folderMocks.scanLocalModels.mockResolvedValue([])
    const { onResolved } = renderGate([unconnectedCloud()])

    const row = await screen.findByTestId('reply-gate-add-folder')
    const button = within(row).getByRole('button', {
      name: 'chat:replyGate.addFolder',
    })
    fireEvent.click(button)

    await waitFor(() => expect(folderMocks.scanLocalModels).toHaveBeenCalled())
    // The widget stays open on its empty branch, and the button is back to
    // its idle label so the user can try another folder.
    await waitFor(() => expect(button).toHaveTextContent('setup:cloudStep.add'))
    expect(button).toBeEnabled()
    expect(screen.getByText('chat:replyGate.emptyTitle')).toBeInTheDocument()
    expect(folderMocks.importScannedModel).not.toHaveBeenCalled()
    expect(onResolved).not.toHaveBeenCalled()
  })

  it('offers both cloud routes even to a user who already has local models', async () => {
    renderGate([
      localProvider([model('a'), model('b')]),
      unconnectedCloud(),
      subscriptionProvider(),
    ])

    expect(
      await screen.findByRole('button', { name: 'setup:cloudStep.trigger' })
    ).toBeVisible()
    expect(
      screen.getByRole('button', {
        name: 'setup:cloudStep.subscriptionTrigger',
      })
    ).toBeVisible()
    // The rest of Hugging Face is a route too, in every branch.
    expect(
      screen.getByRole('button', { name: 'setup:cloudStep.huggingFaceTrigger' })
    ).toBeVisible()
  })

  it('leaves for the Hub as its own outcome, keeping the message in the composer', async () => {
    const { onDismissed, onResolved, onOpenChange } = renderGate([
      unconnectedCloud(),
    ])

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'setup:cloudStep.huggingFaceTrigger',
      })
    )

    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/hub/' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    // Nothing is on its way, so the queued send is dropped like a dismissal —
    // but the record says where the user went.
    expect(onDismissed).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'hub', branch: 'none' })
    )
    expect(onResolved).not.toHaveBeenCalled()
    expect(capturedEvent('reply_model_gate_outcome')).toMatchObject({
      outcome: 'hub',
    })
  })

  it('names the list the way onboarding does', async () => {
    renderGate([unconnectedCloud()])

    const block = await screen.findByTestId('reply-gate-recommended')
    expect(within(block).getByText('setup:recommend.title')).toBeVisible()
  })

  describe('the recommended list', () => {
    // The Hub's picks in manifest order: a family's sizes together, the
    // largest first — the order that on an 18 GiB Mac would head the list
    // with a model that does not load on it.
    const nemotron = staffPick(
      'AtomicChat/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF',
      { title: 'Nemotron 3.5 Lightning', size: '19.7 GB', icon: 'nvidia' }
    )
    const qwen9b = staffPick('AtomicChat/Qwen3.5-9B-GGUF', {
      title: 'Qwen3.5 9B',
      size: '5.2 GB',
      summary: 'The 9B for longer answers.',
      icon: 'qwen',
    })
    const gemma12b = staffPick('AtomicChat/gemma-4-12B-it-GGUF', {
      title: 'Gemma 4 12B',
      size: '7.3 GB',
      summary: 'Mid-size Gemma 4 with vision.',
      icon: 'gemma',
    })
    const gemma26b = staffPick('AtomicChat/gemma-4-26B-it-GGUF', {
      title: 'Gemma 4 26B',
      size: '14.0 GB',
      icon: 'gemma',
    })

    /** A manifest row that is not a Hub pick: onboarding never lists it. */
    const manifestTail: CatalogModel = {
      ...catalogModel,
      model_name: 'LiquidAI/LFM2.5-2.6B-GGUF',
      quants: [
        {
          model_id: 'LiquidAI/LFM2.5-2.6B-Q4_K_M',
          path: 'https://example.test/LFM2.5-2.6B-Q4_K_M.gguf',
          file_size: '1.5 GB',
        },
      ],
    } as CatalogModel

    beforeEach(() => {
      sourcesMock.recommended = [
        {
          rec: {
            modelName: catalogModel.model_name,
            descriptionKey: 'hub:recEverydayUse',
          },
          model: catalogModel,
        },
        {
          rec: {
            modelName: manifestTail.model_name,
            descriptionKey: 'hub:recCompact',
          },
          model: manifestTail,
        },
      ]
      sourcesMock.staffPicks = [nemotron, qwen9b, gemma12b, gemma26b]
    })

    it('lists every Hub pick under the lead, by fit, publishers dealt', async () => {
      // Three rows from the manifest's tail is not the list onboarding
      // shows. The same rows in the same order: the offer, then the Hub's
      // picks — what fits, then what is tight, then what will not load —
      // with no two neighbours from one publisher.
      hardwareMock.profile = unifiedMac
      renderGate([unconnectedCloud()])

      const lead = await screen.findByTestId('reply-gate-recommended-lead')
      expect(lead).toHaveTextContent('Qwen3.5 4B')
      expect(lead).toHaveTextContent('chat:replyGate.recommendedForDevice')
      const rows = recommendedRows()
      expect(rows).toHaveLength(5)
      expect(
        screen.getAllByTestId('reply-gate-recommended-other')
      ).toHaveLength(4)
      // Gemma before the second Qwen, although the manifest lists Qwen first:
      // the lead is a Qwen. Then the tight 26B, then the one that will not load.
      expect(rows[1]).toHaveTextContent('Gemma 4 12B')
      expect(rows[2]).toHaveTextContent('Qwen3.5 9B')
      expect(rows[3]).toHaveTextContent('Gemma 4 26B')
      expect(rows[4]).toHaveTextContent('Nemotron 3.5 Lightning')
      // A pick's line is the Hub's own summary; the manifest's tail is not a
      // row here any more than it is on onboarding.
      expect(rows[1]).toHaveTextContent('Mid-size Gemma 4 with vision.')
      expect(screen.queryByText('LFM2.5 2.6B')).toBeNull()

      fireEvent.click(
        within(rows[1]).getByRole('button', {
          name: 'chat:replyGate.downloadLabel:{"name":"Gemma 4 12B"}',
        })
      )
      expect(mocks.pullModelWithMetadata).toHaveBeenCalledWith(
        'AtomicChat/gemma-4-12B-it-Q4_K_M',
        'https://example.test/gemma-4-12B-it-Q4_K_M.gguf',
        undefined,
        '',
        true,
        false
      )
    })

    it('marks each row with how it fits this machine, and says why on the mark', async () => {
      hardwareMock.profile = unifiedMac
      renderGate([unconnectedCloud()])

      await screen.findByTestId('reply-gate-recommended-lead')
      const marks = recommendedRows().map((row) =>
        row.querySelector('[data-fit]')
      )
      expect(marks.map((mark) => mark?.getAttribute('data-fit'))).toEqual([
        'ok',
        'ok',
        'ok',
        'warn',
        'no',
      ])
      // The same sentence onboarding's mark carries, in the machine's figures.
      expect(marks[0]).toHaveAccessibleName(
        /setup:recommend\.fitOk.*setup:recommend\.whyComfortable.*"size":"2\.5 GB".*"budget":"18 GB"/
      )
      expect(marks[3]).toHaveAccessibleName(
        /setup:recommend\.fitWarn.*setup:recommend\.whyTight/
      )
      expect(marks[4]).toHaveAccessibleName(
        /setup:recommend\.fitNo.*setup:recommend\.whyWontLoad/
      )
    })

    it('wears no mark while the machine is unknown, and still lists everything', async () => {
      // "We don't know" is never drawn as a warning; the rows stay, dealt by
      // publisher alone.
      renderGate([unconnectedCloud()])

      await screen.findByTestId('reply-gate-recommended-lead')
      const rows = recommendedRows()
      expect(rows).toHaveLength(5)
      expect(document.querySelector('[data-fit]')).toBeNull()
      expect(rows[1]).toHaveTextContent('Nemotron 3.5 Lightning')
      expect(rows[2]).toHaveTextContent('Qwen3.5 9B')
    })

    it('puts the size on each Download, and the verb alone when the card has none', async () => {
      sourcesMock.staffPicks = [
        staffPick('SomeLab/Foo-7B-GGUF', { title: 'Foo 7B', size: '' }),
      ]
      renderGate([unconnectedCloud()])

      const lead = await screen.findByTestId('reply-gate-recommended-lead')
      expect(
        within(lead).getByRole('button', {
          name: 'chat:replyGate.downloadLabel:{"name":"Qwen3.5 4B"}',
        })
      ).toHaveTextContent('chat:replyGate.downloadSize:{"size":"2.5 GB"}')
      const other = screen.getByTestId('reply-gate-recommended-other')
      expect(
        within(other).getByRole('button', {
          name: 'chat:replyGate.downloadLabel:{"name":"Foo 7B"}',
        })
      ).toHaveTextContent(/^chat:replyGate\.download$/)
      expect(other.querySelector('[data-fit]')).toBeNull()
    })
  })

  it('hides the subscription route where the sign-in cannot run', async () => {
    mocks.chatgptSubscriptionAvailable = false
    renderGate([
      localProvider([model('a'), model('b')]),
      unconnectedCloud(),
      subscriptionProvider(),
    ])

    await screen.findByText(/chat:replyGate\.startingTitle/)
    expect(
      screen.queryByRole('button', {
        name: 'setup:cloudStep.subscriptionTrigger',
      })
    ).toBeNull()
  })

  it('reports the impression with the device context that shaped it', async () => {
    renderGate([localProvider([model('a'), model('b')]), cloudProvider()])

    await waitFor(() =>
      expect(capturedEvent('reply_model_gate_shown')).toBeDefined()
    )
    expect(capturedEvent('reply_model_gate_shown')).toMatchObject({
      branch: 'auto_start',
      local_model_count: 2,
      cloud_provider_count: 1,
      has_cloud_connection: true,
      hardware_tier: 'vram_8',
    })
    // `status` is typed as a number globally in PostHog; a string written there
    // is ingested as null.
    expect(capturedEvent('reply_model_gate_shown')).not.toHaveProperty('status')
  })

  it('records a give-up as a dismissal, not as a resolution', async () => {
    const { onDismissed, onResolved, onOpenChange } = renderGate([
      unconnectedCloud(),
    ])
    await screen.findByText('chat:replyGate.emptyTitle')

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    })

    await waitFor(() => expect(onDismissed).toHaveBeenCalled())
    expect(onResolved).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(capturedEvent('reply_model_gate_outcome')).toMatchObject({
      outcome: 'dismissed',
      branch: 'none',
    })
  })

  it('does not report a dismissal when it closes on a started model', async () => {
    const { onDismissed } = renderGate([localProvider([model('only-one')])])
    await waitFor(() =>
      expect(capturedEvent('reply_model_gate_outcome')).toBeDefined()
    )

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    })

    // Closing a widget whose work is already under way is not giving up: the
    // auto-start stays the one and only outcome on record.
    expect(
      capturedEvents('reply_model_gate_outcome').map((event) => event.outcome)
    ).toEqual(['auto_start'])
    expect(onDismissed).not.toHaveBeenCalled()
  })

  describe('with a download already under way', () => {
    const inFlight = 'LiquidAI/LFM2.5-1.2B-Q4_K_M'

    it('leads with it, shows its progress, and lets it be cancelled', async () => {
      // Started from onboarding, the Hub, anywhere: the widget used to offer
      // other models to download and never mentioned this one.
      seedRunningDownload(inFlight)
      const { onResolved } = renderGate([unconnectedCloud()])

      const lead = await screen.findByTestId('reply-gate-recommended-lead')
      const rows = recommendedRows()
      expect(rows[0]).toHaveAttribute(
        'data-testid',
        'reply-gate-recommended-in-flight'
      )
      expect(rows[0]).toHaveTextContent('LFM2.5 1.2B')
      // The panel's readout: percent, bytes, time left.
      expect(rows[0]).toHaveTextContent(
        '10% · 0.16 / 1.58 GB · common:downloadPanel.left:{"eta":"1m 00s"}'
      )
      expect(rows[1]).toBe(lead)

      const cancel = within(rows[0]).getByRole('button', {
        name: 'common:cancelDownload',
      })
      expect(cancel).toHaveTextContent('common:cancel')
      // The message is armed on the transfer already running, the way it is
      // on one started from this list.
      expect(onResolved).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: 'download_in_flight',
          branch: 'none',
        })
      )

      fireEvent.click(cancel)
      expect(mocks.abortDownload).toHaveBeenCalledWith(inFlight)
      expect(useDownloadStore.getState().resumableDownloads.has(inFlight)).toBe(
        true
      )
      // The downloader confirms the stop and the store drops the entry; the
      // recommendations stay so another model can be picked.
      act(() => useDownloadStore.getState().removeDownload(inFlight))
      expect(
        screen.queryByTestId('reply-gate-recommended-in-flight')
      ).toBeNull()
      expect(screen.getByTestId('reply-gate-recommended-lead')).toBe(lead)
      expect(
        within(lead).getByRole('button', {
          name: 'chat:replyGate.downloadLabel:{"name":"Qwen3.5 4B"}',
        })
      ).toBeEnabled()
    })

    it('does not list the model twice when it is also the recommendation', async () => {
      seedRunningDownload('AtomicChat/Qwen3.5-4B-Q4_K_M')
      renderGate([unconnectedCloud()])

      const inFlightRow = await screen.findByTestId(
        'reply-gate-recommended-in-flight'
      )
      expect(inFlightRow).toHaveTextContent('Qwen3.5 4B')
      expect(screen.getAllByText('Qwen3.5 4B')).toHaveLength(1)
      expect(screen.queryByTestId('reply-gate-recommended-lead')).toBeNull()
      expect(
        screen.queryByRole('button', {
          name: 'chat:replyGate.downloadLabel:{"name":"Qwen3.5 4B"}',
        })
      ).toBeNull()
    })

    it('says so before the first byte, and while paused', async () => {
      useDownloadStore.getState().addLocalDownloadingModel(inFlight)
      renderGate([unconnectedCloud()])

      const row = await screen.findByTestId('reply-gate-recommended-in-flight')
      expect(row).toHaveTextContent('common:downloadPanel.preparing')
      expect(row).not.toHaveTextContent('%')

      seedRunningDownload(inFlight)
      act(() => useDownloadStore.getState().markPausedDownload(inFlight))
      expect(row).toHaveTextContent(
        'common:downloadPanel.paused · 0.16 / 1.58 GB'
      )
      expect(row).not.toHaveTextContent('common:downloadPanel.left')
    })

    it('leaves downloads that are not chat models out of the list', async () => {
      seedRunningDownload(EMBEDDING_MODEL_ID)
      seedRunningDownload('diffusion-model-sd15:q8')
      seedRunningDownload('mmproj-gemma4-e4b-it-f16')
      const { onResolved } = renderGate([unconnectedCloud()])

      const rows = await waitFor(() => recommendedRows())
      expect(rows[0]).toHaveAttribute(
        'data-testid',
        'reply-gate-recommended-lead'
      )
      expect(
        screen.queryByTestId('reply-gate-recommended-in-flight')
      ).toBeNull()
      expect(
        screen.queryByRole('button', { name: 'common:cancelDownload' })
      ).toBeNull()
      expect(onResolved).not.toHaveBeenCalled()
    })
  })

  describe("a recommendation that won't fit", () => {
    // The ladder steps the lead down as far as it goes and never drops it
    // for not fitting, so on an 18 GiB Mac a 19.7 GB lead is a red row —
    // the same verdict the onboarding row wears.
    const unifiedMac = {
      tier: 'unified_16',
      memoryKind: 'unified',
      budgetMib: 18 * 1024,
      systemRamMib: 18 * 1024,
      vramMib: 18 * 1024,
      hardCeiling: true,
    }
    const nemotron: CatalogModel = {
      ...catalogModel,
      model_name: 'AtomicChat/Nemotron-3.5-Lightning-30B-A3B-GGUF',
      quants: [
        {
          model_id: 'AtomicChat/Nemotron-3.5-Lightning-Q4_K_M',
          path: 'https://example.test/Nemotron-3.5-Lightning-Q4_K_M.gguf',
          file_size: '19.7 GB',
        },
      ],
    } as CatalogModel
    const recommend = (model: CatalogModel) => {
      sourcesMock.sources = [model]
      sourcesMock.recommended = [
        {
          rec: {
            modelName: model.model_name,
            descriptionKey: 'hub:recEverydayUse',
          },
          model,
        },
      ]
    }
    const confirmDialog = () =>
      screen.queryByRole('dialog', { name: 'setup:wontFitDialog.title' })
    const clickLead = async () => {
      const lead = await screen.findByTestId('reply-gate-recommended-lead')
      fireEvent.click(
        within(lead).getByRole('button', {
          name: /chat:replyGate\.downloadLabel/,
        })
      )
    }

    beforeEach(() => {
      hardwareMock.tier = 'unified_16'
      hardwareMock.profile = unifiedMac
      recommend(nemotron)
    })

    it('asks before starting it, with the reason, and keeps the widget up', async () => {
      const { onResolved } = renderGate([unconnectedCloud()])
      await clickLead()

      const dialog = confirmDialog()
      expect(dialog).not.toBeNull()
      expect(dialog).toHaveTextContent(/Nemotron/)
      // The row's own sentence, in this machine's figures.
      expect(dialog).toHaveTextContent(
        'setup:recommend.whyWontLoad:{"size":"19.7 GB","budget":"18 GB","pool":"setup:recommend.pool.unified"}'
      )
      expect(dialog).toHaveTextContent('setup:wontFitDialog.body')
      expect(mocks.pullModelWithMetadata).not.toHaveBeenCalled()
      expect(useDownloadStore.getState().localDownloadingModels.size).toBe(0)
      expect(onResolved).not.toHaveBeenCalled()
    })

    it('starts it, and resolves on that, once the user says so anyway', async () => {
      const { onResolved } = renderGate([unconnectedCloud()])
      await clickLead()

      fireEvent.click(
        screen.getByRole('button', { name: 'setup:wontFitDialog.confirm' })
      )

      expect(mocks.pullModelWithMetadata).toHaveBeenCalledWith(
        'AtomicChat/Nemotron-3.5-Lightning-Q4_K_M',
        'https://example.test/Nemotron-3.5-Lightning-Q4_K_M.gguf',
        undefined,
        '',
        true,
        false
      )
      expect(
        useDownloadStore
          .getState()
          .localDownloadingModels.has(
            'AtomicChat/Nemotron-3.5-Lightning-Q4_K_M'
          )
      ).toBe(true)
      expect(onResolved).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'download', branch: 'none' })
      )
    })

    it('leaves the offer standing when the user cancels', async () => {
      const { onResolved, onDismissed } = renderGate([unconnectedCloud()])
      await clickLead()

      fireEvent.click(screen.getByRole('button', { name: 'common:cancel' }))

      await waitFor(() => expect(confirmDialog()).toBeNull())
      expect(mocks.pullModelWithMetadata).not.toHaveBeenCalled()
      expect(useDownloadStore.getState().localDownloadingModels.size).toBe(0)
      expect(onResolved).not.toHaveBeenCalled()
      expect(onDismissed).not.toHaveBeenCalled()
      expect(
        within(screen.getByTestId('reply-gate-recommended-lead')).getByRole(
          'button',
          { name: /chat:replyGate\.downloadLabel/ }
        )
      ).toBeEnabled()
    })

    it('does not ask for a lead that merely runs tight', async () => {
      // 12 GB on 18 GiB: past half the pool, under the ceiling — yellow.
      recommend({
        ...nemotron,
        quants: [{ ...nemotron.quants[0], file_size: '12.0 GB' }],
      } as CatalogModel)
      const { onResolved } = renderGate([unconnectedCloud()])
      await clickLead()

      expect(confirmDialog()).toBeNull()
      expect(mocks.pullModelWithMetadata).toHaveBeenCalledOnce()
      expect(onResolved).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'download', branch: 'none' })
      )
    })
  })
})
