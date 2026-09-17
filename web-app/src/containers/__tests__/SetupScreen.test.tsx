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
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import posthog from 'posthog-js'
import SetupScreen from '../SetupScreen'
import { localStorageKey } from '@/constants/localStorage'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { seedServiceHub } from '@/test/service-hub'
import { toast } from 'sonner'
import { events } from '@janhq/core'

const mocks = vi.hoisted(() => {
  // Mirrors of the two persisted stores SetupScreen writes to, so tests can
  // assert the state the rest of the app reads rather than the call itself.
  const leftPanel = { open: false }
  const reminder = { pending: false }
  return {
    fetchSources: vi.fn(),
    navigate: vi.fn(),
    onSkipped: vi.fn(),
    scanLocalModels: vi.fn(),
    leftPanel,
    setLeftPanel: vi.fn((value: boolean) => {
      leftPanel.open = value
    }),
    setOnboardingActive: vi.fn(),
    reminder,
    setReminderPending: vi.fn((value: boolean) => {
      reminder.pending = value
    }),
    refreshRegistry: vi.fn(() => Promise.resolve()),
    refreshStaffPicks: vi.fn(() => Promise.resolve()),
    pullModelWithMetadata: vi.fn(() => Promise.resolve()),
    // The real abort ends in `onFileDownloadStopped`, which the global
    // download panel answers by dropping the id from the store. The panel is
    // not rendered here, so the seed does that part itself.
    abortDownload: vi.fn(async (id: string) => {
      useDownloadStore.getState().removeLocalDownloadingModel(id)
      useDownloadStore.getState().removeDownload(id)
    }),
    // Recommendation list the picker renders; mutable so a test can offer a
    // downloadable model.
    recommended: [] as unknown[],
    // The Hub's curated picks, listed under the offer; mutable per test.
    staffPicks: [] as unknown[],
    engine: { import: vi.fn() },
    // Mutable so a test can move the machine to another rung of the ladder.
    // `profile` is what the "why this one" line reads its memory figure from.
    hardwareTier: {
      tier: 'vram_8' as string,
      profile: {
        tier: 'vram_8',
        memoryKind: 'vram',
        budgetMib: 8 * 1024,
        systemRamMib: 32 * 1024,
        vramMib: 8 * 1024,
        hardCeiling: false,
      } as Record<string, unknown> | null,
      ready: true,
    },
    switchToModel: vi.fn(() => Promise.resolve()),
    // Live provider list, mutable so a test can seed cloud providers.
    modelProviderState: {
      providers: [] as ModelProvider[],
      getProviderByName: vi.fn(),
      selectModelProvider: vi.fn(),
      setProviders: vi.fn(),
      updateProvider: vi.fn(),
    },
  }
})

// The cloud exit calls this to register the remote provider and start the
// local proxy; unmocked it would reach the real implementation.
vi.mock('@/utils/switchModel', () => ({
  switchToModel: mocks.switchToModel,
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

// Keys render as keys, so the assertions below name what a row is rather
// than how it is worded — except the copy tests, which flip `english` on and
// read `setup:` keys back as the words the user sees.
const locale = vi.hoisted(() => ({ english: false }))

vi.mock('@/i18n/react-i18next-compat', async () => {
  const en = (await import('@/locales/en/setup.json')).default
  const t = (key: string) => {
    if (!locale.english) return key
    const [ns, path] = key.split(':')
    if (ns !== 'setup' || !path) return key
    const hit = path
      .split('.')
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        en
      )
    return typeof hit === 'string' ? hit : key
  }
  return { useTranslation: () => ({ t }) }
})

vi.mock('@/hooks/useModelProvider', () => {
  const state = mocks.modelProviderState
  const useModelProvider = () => state
  useModelProvider.getState = () => state
  return { useModelProvider }
})

// Without this the real store reports no RAM and no GPU, so the tier never
// resolves and every test below sits on the picker's loading state.
vi.mock('@/hooks/useHardwareTier', () => ({
  useHardwareTier: () => mocks.hardwareTier,
}))

// The subscription button is desktop-only in production; pin it on so the
// assertions below do not depend on the test platform.
vi.mock('@/lib/platform/const', () => ({
  PlatformFeatures: { chatgptSubscription: true },
}))

// The sign-in step asks the Rust backend for the connection status on mount.
// Held at 'disconnected' so the step renders its Connect button rather than
// completing onboarding for an account that happens to be signed in.
vi.mock('@/hooks/useChatGptAuth', () => ({
  useChatGptAuth: () => ({
    state: 'disconnected',
    error: null,
    connect: vi.fn(),
    cancel: vi.fn(),
  }),
}))

vi.mock('@/hooks/useGeneralSetting', () => {
  const state = {
    huggingfaceToken: '',
    scanLocalModels: true,
    localScanFolders: [],
  }
  const useGeneralSetting = (
    selector: (value: typeof state) => unknown
  ): unknown => selector(state)
  useGeneralSetting.getState = () => state
  return { useGeneralSetting }
})

vi.mock('@/hooks/useModelSources', () => ({
  useModelSources: (
    selector: (state: {
      sources: never[]
      fetchSources: typeof mocks.fetchSources
      loading: boolean
    }) => unknown
  ) =>
    selector({
      sources: [],
      fetchSources: mocks.fetchSources,
      loading: false,
    }),
}))

vi.mock('@/hooks/useResolvedRecommendedModels', () => ({
  useResolvedRecommendedModels: () => mocks.recommended,
}))

// Also keeps the real module's import-time background fetch out of the tests.
vi.mock('@/stores/recommended-models-registry-store', () => ({
  useRecommendedModelsRegistryStore: {
    getState: () => ({ refresh: mocks.refreshRegistry }),
  },
}))

vi.mock('@/hooks/useStaffPicks', () => ({
  useStaffPicks: () => mocks.staffPicks,
}))

// Same import-time fetch as the registry store, kept out of the tests.
vi.mock('@/stores/staff-picks-store', () => ({
  useStaffPicksStore: {
    getState: () => ({ refresh: mocks.refreshStaffPicks }),
  },
}))

vi.mock('@/services/models/localScan', () => ({
  scanLocalModels: mocks.scanLocalModels,
  collectImportedModelPaths: () => new Set(),
}))

vi.mock('@/hooks/useModelLoad', () => {
  const useModelLoad = {
    getState: () => ({
      setOnboardingActive: mocks.setOnboardingActive,
    }),
  }
  return { useModelLoad }
})

vi.mock('@/hooks/useLeftPanel', () => ({
  useLeftPanel: {
    getState: () => ({ setLeftPanel: mocks.setLeftPanel }),
  },
}))

vi.mock('@/hooks/useOnboardingModelReminder', () => ({
  useOnboardingModelReminderStore: {
    getState: () => ({ setPending: mocks.setReminderPending }),
  },
}))

vi.mock('../HeaderPage', () => ({
  default: () => <header data-testid="setup-header" />,
}))

vi.mock('posthog-js', () => ({
  // `has_opted_in_capturing` is what `queuedCapture` checks before sending;
  // without it every event would sit in the startup queue instead.
  default: { capture: vi.fn(), has_opted_in_capturing: () => true },
}))

vi.mock('sonner', () => ({
  toast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('@janhq/core', () => ({
  AppEvent: { onModelImported: 'onModelImported' },
  DownloadEvent: {
    onFileDownloadAndVerificationSuccess:
      'onFileDownloadAndVerificationSuccess',
  },
  EngineManager: { instance: () => ({ get: () => mocks.engine }) },
  events: { on: vi.fn(), off: vi.fn() },
}))

const detectedModel = {
  id: 'lmstudio/qwen3.5-4b',
  displayName: 'qwen3.5-4b.gguf',
  path: '/models/qwen3.5-4b.gguf',
  source: 'lmstudio',
  format: 'gguf',
  runnable: true,
  sizeBytes: 4 * 1024 ** 3,
}

const biggerDetectedModel = {
  id: 'lmstudio/gemma-4-12b',
  displayName: 'gemma-4-12b.gguf',
  path: '/models/gemma-4-12b.gguf',
  source: 'lmstudio',
  format: 'gguf',
  runnable: true,
  sizeBytes: 12 * 1024 ** 3,
}

const expectedImport = (model: typeof detectedModel) => [
  model.id,
  {
    modelPath: model.path,
    mmprojPath: undefined,
    source: model.source,
  },
]

describe('SetupScreen', () => {
  const deferLocalScan = (found: unknown[] = []) => {
    let finish!: () => void
    mocks.scanLocalModels.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(found)
        })
    )
    return () => act(async () => finish())
  }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    seedServiceHub({
      models: {
        pullModelWithMetadata: mocks.pullModelWithMetadata,
        abortDownload: mocks.abortDownload,
      } as unknown as Parameters<typeof seedServiceHub>[0]['models'],
    })
    // The real store, reset: the rows read their Downloading state from it.
    useDownloadStore.setState({
      downloads: {},
      localDownloadingModels: new Set(),
      resumableDownloads: new Set(),
    })
    mocks.recommended = []
    mocks.staffPicks = []
    mocks.leftPanel.open = false
    mocks.reminder.pending = false
    mocks.hardwareTier.tier = 'vram_8'
    mocks.hardwareTier.profile = {
      tier: 'vram_8',
      memoryKind: 'vram',
      budgetMib: 8 * 1024,
      systemRamMib: 32 * 1024,
      vramMib: 8 * 1024,
      hardCeiling: false,
    }
    mocks.hardwareTier.ready = true
    mocks.modelProviderState.providers = []
    // Onboarding imports never settle by default, so a test can assert on the
    // in-flight state without racing the import event handler.
    mocks.engine.import.mockReturnValue(new Promise(() => {}))
  })

  it('renders the production onboarding after local model discovery completes', async () => {
    const finishLocalScan = deferLocalScan()
    const { unmount } = render(<SetupScreen />)

    expect(screen.getByText('common:loading')).toBeInTheDocument()
    await finishLocalScan()
    expect(await screen.findByText('setup:welcomeTitle')).toBeInTheDocument()
    expect(mocks.fetchSources).toHaveBeenCalledOnce()
    expect(mocks.scanLocalModels).toHaveBeenCalledWith({
      enabled: true,
      extraRoots: [],
      importedPaths: new Set(),
    })
    unmount()
  })

  it('opens the sidebar so the model step sits next to it', async () => {
    const finishLocalScan = deferLocalScan()
    const { unmount } = render(<SetupScreen />)

    await finishLocalScan()

    expect(await screen.findByText('setup:welcomeTitle')).toBeInTheDocument()
    expect(mocks.leftPanel.open).toBe(true)
    unmount()
  })

  it('bypasses the registry cache when the model step opens', async () => {
    const finishLocalScan = deferLocalScan()
    const { unmount } = render(<SetupScreen />)

    await finishLocalScan()
    expect(await screen.findByText('setup:welcomeTitle')).toBeInTheDocument()

    // `force` is the whole point: a cache written before the manifest changed
    // is served without any network call, so onboarding would offer models the
    // manifest no longer lists. The list under the offer is the Hub's
    // manifest, so it gets the same treatment.
    expect(mocks.refreshRegistry.mock.calls).toEqual([[{ force: true }]])
    expect(mocks.refreshStaffPicks.mock.calls).toEqual([[{ force: true }]])
    unmount()
  })

  describe('auto-start of a model found on disk', () => {
    it('launches the smallest candidate instead of offering a download', async () => {
      const finishLocalScan = deferLocalScan([
        biggerDetectedModel,
        detectedModel,
      ])
      const { unmount } = render(<SetupScreen />)

      await finishLocalScan()

      expect(
        await screen.findByText('setup:localStep.autoStarting')
      ).toBeInTheDocument()
      // The picker (and with it every Download button) is never rendered.
      expect(screen.queryByText('setup:welcomeTitle')).not.toBeInTheDocument()
      // Only the chosen model is imported here; the rest follow once it lands.
      expect(mocks.engine.import.mock.calls).toEqual([
        expectedImport(detectedModel),
      ])
      unmount()
    })

    it('tells the user which app the started model came from', async () => {
      // Not a wizard step: one line, in the chat they are about to see.
      seedServiceHub({
        models: {
          pullModelWithMetadata: mocks.pullModelWithMetadata,
        } as unknown as Parameters<typeof seedServiceHub>[0]['models'],
        providers: {
          getProviders: vi.fn().mockResolvedValue([]),
        } as unknown as Parameters<typeof seedServiceHub>[0]['providers'],
      })
      const finishLocalScan = deferLocalScan([detectedModel])
      const { unmount } = render(<SetupScreen />)
      await finishLocalScan()
      await screen.findByText('setup:localStep.autoStarting')

      const onImported = vi
        .mocked(events.on)
        .mock.calls.find(([name]) => name === 'onModelImported')?.[1] as
        | ((payload: { modelId: string }) => void)
        | undefined
      expect(onImported).toBeDefined()
      await act(async () => {
        onImported!({ modelId: detectedModel.id })
      })

      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith('setup:foundFrom')
      )
      unmount()
    })

    it('falls back to the picker when the auto-started import fails', async () => {
      mocks.engine.import.mockRejectedValueOnce(new Error('unsupported'))
      const finishLocalScan = deferLocalScan([detectedModel])
      const { unmount } = render(<SetupScreen />)

      await finishLocalScan()

      expect(await screen.findByText('setup:welcomeTitle')).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: /setup:localStep\.run/ })
      ).toBeInTheDocument()
      unmount()
    })
  })

  it('offers a visible Skip, and does nothing until it is pressed', async () => {
    // The replaced behaviour was a 15-second timer with no control: 60 % of all
    // onboarding exits took it, at a 16.2 s median. The screen now waits.
    const finishLocalScan = deferLocalScan()
    const { unmount } = render(<SetupScreen onSkipped={mocks.onSkipped} />)
    await finishLocalScan()
    await screen.findByText('setup:welcomeTitle')

    const skip = screen.getByRole('button', { name: 'setup:skip' })
    expect(localStorage.getItem(localStorageKey.setupCompleted)).toBeNull()
    expect(mocks.onSkipped).not.toHaveBeenCalled()

    fireEvent.click(skip)

    expect(localStorage.getItem(localStorageKey.setupCompleted)).toBe('true')
    expect(localStorage.getItem(localStorageKey.lastUsedModel)).toBeNull()
    // The composer's widget takes over from here, which is what makes leaving
    // empty-handed a defensible thing to offer at all — and why the corner
    // reminder stays down: it would offer the same download twice.
    expect(mocks.reminder.pending).toBe(false)
    expect(mocks.leftPanel.open).toBe(true)
    expect(mocks.onSkipped).toHaveBeenCalledOnce()
    expect(mocks.navigate.mock.calls).toEqual([
      [{ to: '/', replace: true, search: {} }],
    ])
    unmount()
  })

  describe('cloud provider', () => {
    beforeEach(() => {
      // Let the picker paint; these tests are about what happens after it does.
      mocks.scanLocalModels.mockResolvedValue([])
    })

    const apiKeySetting = {
      key: 'api-key',
      title: 'API Key',
      description: '',
      controller_type: 'input',
      controller_props: { placeholder: 'Insert API Key', value: '' },
    }

    const cloudProvider = (
      overrides: Partial<ModelProvider> = {}
    ): ModelProvider =>
      ({
        active: true,
        provider: 'openai',
        api_key: '',
        base_url: 'https://api.openai.com/v1',
        settings: [apiKeySetting],
        models: [{ id: 'gpt-5.5' }],
        ...overrides,
      }) as ModelProvider

    const seedProviders = (providers: ModelProvider[]) => {
      mocks.modelProviderState.providers = providers
    }

    const openGallery = async () => {
      const rendered = render(<SetupScreen onSkipped={mocks.onSkipped} />)
      fireEvent.click(
        await screen.findByRole('button', { name: 'setup:cloudStep.trigger' })
      )
      return rendered
    }

    it('offers only providers that take a key and talk to somebody else', async () => {
      seedProviders([
        cloudProvider(),
        // Loopback: the "cloud" is this machine.
        cloudProvider({
          provider: 'ollama',
          base_url: 'http://localhost:11434/v1',
        }),
        // Local engine.
        cloudProvider({ provider: 'llamacpp', base_url: undefined }),
        // Placeholder host — a key alone cannot make it work.
        cloudProvider({
          provider: 'azure',
          base_url: 'https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1',
        }),
      ])

      const { unmount } = await openGallery()

      expect(screen.getByText('OpenAI')).toBeInTheDocument()
      expect(screen.queryByText('Ollama')).not.toBeInTheDocument()
      expect(screen.queryByText('Azure')).not.toBeInTheDocument()
      unmount()
    })

    it('hides the trigger when there is no cloud provider to offer', async () => {
      seedProviders([
        cloudProvider({ provider: 'llamacpp', base_url: undefined }),
      ])

      const { unmount } = render(<SetupScreen onSkipped={mocks.onSkipped} />)
      await screen.findByText('setup:welcomeTitle')

      expect(
        screen.queryByRole('button', { name: 'setup:cloudStep.trigger' })
      ).not.toBeInTheDocument()
      unmount()
    })

    it('saves the key and enters the chat with that provider selected', async () => {
      seedProviders([cloudProvider()])
      const completedEvent = vi.fn()
      window.addEventListener('app:setup-completed', completedEvent)

      const { unmount } = await openGallery()
      fireEvent.click(screen.getByRole('button', { name: /OpenAI/ }))
      fireEvent.change(screen.getByLabelText('setup:cloudStep.keyLabel'), {
        target: { value: '  sk-test  ' },
      })
      fireEvent.click(
        screen.getByRole('button', { name: 'setup:cloudStep.saveKey' })
      )

      // Key is persisted, trimmed, on both the mirror and the settings entry.
      const [name, patch] =
        mocks.modelProviderState.updateProvider.mock.calls[0]
      expect(name).toBe('openai')
      expect(patch.api_key).toBe('sk-test')
      expect(patch.settings[0].controller_props.value).toBe('sk-test')

      expect(localStorage.getItem(localStorageKey.setupCompleted)).toBe('true')
      expect(
        JSON.parse(localStorage.getItem(localStorageKey.lastUsedModel) ?? '{}')
      ).toEqual({ provider: 'openai', model: 'gpt-5.5' })
      expect(completedEvent).toHaveBeenCalledOnce()
      expect(mocks.leftPanel.open).toBe(true)
      // A configured key is a finished setup, not an abandoned one.
      expect(mocks.reminder.pending).toBe(false)
      // The dialog closes and the screen changes at once, so the confirmation
      // toast is the only thing telling the user the key was actually stored.
      expect(toast.success).toHaveBeenCalledWith('setup:cloudStep.saved')

      await waitFor(() => {
        expect(mocks.navigate).toHaveBeenCalledWith({
          to: '/',
          replace: true,
          search: { threadModel: { id: 'gpt-5.5', provider: 'openai' } },
        })
      })
      unmount()
      window.removeEventListener('app:setup-completed', completedEvent)
    })

    it('completes without picking a model when the provider ships none', async () => {
      seedProviders([cloudProvider({ models: [] })])

      const { unmount } = await openGallery()
      fireEvent.click(screen.getByRole('button', { name: /OpenAI/ }))
      fireEvent.change(screen.getByLabelText('setup:cloudStep.keyLabel'), {
        target: { value: 'sk-test' },
      })
      fireEvent.click(
        screen.getByRole('button', { name: 'setup:cloudStep.saveKey' })
      )

      expect(localStorage.getItem(localStorageKey.setupCompleted)).toBe('true')
      expect(localStorage.getItem(localStorageKey.lastUsedModel)).toBeNull()
      await waitFor(() => {
        expect(mocks.navigate).toHaveBeenCalledWith({
          to: '/',
          replace: true,
          search: {},
        })
      })
      unmount()
    })

    describe('nothing exits on its own', () => {
      beforeEach(() => {
        vi.useFakeTimers()
      })

      afterEach(() => {
        vi.useRealTimers()
      })

      const renderWithCloudProvider = async () => {
        seedProviders([cloudProvider()])
        mocks.scanLocalModels.mockResolvedValue([])
        const rendered = render(<SetupScreen onSkipped={mocks.onSkipped} />)
        await act(async () => {})
        return rendered
      }

      it('never navigates away while the dialog is open', async () => {
        // A user reading their provider's dashboard for an API key must not
        // have onboarding exit under them.
        const { unmount } = await renderWithCloudProvider()

        fireEvent.click(
          screen.getByRole('button', { name: 'setup:cloudStep.trigger' })
        )
        await act(async () => {
          vi.advanceTimersByTime(60_000)
        })

        expect(localStorage.getItem(localStorageKey.setupCompleted)).toBeNull()
        expect(mocks.reminder.pending).toBe(false)
        expect(mocks.navigate.mock.calls).toHaveLength(0)
        unmount()
      })

      it('stays put after the dialog is dismissed, however long it waits', async () => {
        // The regression guard for the removed 15s timer: closing the dialog
        // used to re-arm a clock that then walked the user out empty-handed.
        const { unmount } = await renderWithCloudProvider()

        fireEvent.click(
          screen.getByRole('button', { name: 'setup:cloudStep.trigger' })
        )
        fireEvent.keyDown(document.activeElement ?? document.body, {
          key: 'Escape',
        })
        await act(async () => {
          vi.advanceTimersByTime(120_000)
        })

        expect(localStorage.getItem(localStorageKey.setupCompleted)).toBeNull()
        expect(mocks.reminder.pending).toBe(false)
        expect(mocks.navigate.mock.calls).toHaveLength(0)
        unmount()
      })
    })
  })

  describe('recommended download', () => {
    const recommendation = {
      rec: {
        modelName: 'AtomicChat/Qwen3.5-4B-GGUF',
        descriptionKey: 'hub:recEverydayUse',
      },
      model: {
        model_name: 'AtomicChat/Qwen3.5-4B-GGUF',
        developer: 'AtomicChat',
        quants: [
          {
            model_id: 'Qwen3.5-4B-Q4_K_M',
            path: 'https://hf.co/AtomicChat/Qwen3.5-4B-GGUF/q4_k_m.gguf',
            file_size: '2.50 GB',
          },
        ],
        mmproj_models: [],
      },
    }

    beforeEach(() => {
      vi.useFakeTimers()
      mocks.recommended = [recommendation]
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    const renderPicker = async () => {
      mocks.scanLocalModels.mockResolvedValue([])
      const rendered = render(<SetupScreen />)
      await act(async () => {})
      return rendered
    }

    it('names the model in plain language, without the packaging', async () => {
      const { unmount } = await renderPicker()

      expect(screen.getByText(/Qwen3\.5 4B/)).toBeInTheDocument()
      // The repo id and the "Everyday use" blurb are both gone: neither tells a
      // first-time user anything they can act on.
      expect(screen.queryByText(/GGUF/)).not.toBeInTheDocument()
      expect(screen.queryByText('hub:recEverydayUse')).not.toBeInTheDocument()
      unmount()
    })

    const variantId = 'Qwen3.5-4B-Q4_K_M'

    // What the library looks like once the download has landed: the local
    // provider lists the model under the id the row tracks.
    const installInLibrary = (id: string) => {
      const provider = { provider: 'llamacpp-upstream', models: [{ id }] }
      mocks.modelProviderState.providers = [provider as never]
      mocks.modelProviderState.getProviderByName.mockImplementation(
        (name: string) => (name === provider.provider ? provider : undefined)
      )
    }

    afterEach(() => {
      mocks.modelProviderState.getProviderByName.mockReset()
    })

    it('turns the button into a single Downloading… pill that cancels', async () => {
      const { unmount } = await renderPicker()
      const slot = screen.getByRole('button', { name: /hub:download/ })
        .parentElement as HTMLElement

      fireEvent.click(screen.getByRole('button', { name: /hub:download/ }))

      expect(mocks.pullModelWithMetadata).toHaveBeenCalledOnce()
      // One control where the button was: it reads Downloading… and cancels.
      const cancel = screen.getByRole('button', {
        name: 'common:cancelDownload',
      })
      expect(cancel).toHaveTextContent('setup:downloading')
      expect(cancel).toBeEnabled()
      expect(
        screen.queryByRole('button', { name: /hub:download/ })
      ).not.toBeInTheDocument()
      // Nothing stacks under it: no "starting" line, no handoff notice, so
      // the row is as tall as it was with the Download button.
      expect(
        screen.queryByText('setup:downloadPreparing')
      ).not.toBeInTheDocument()
      expect(
        screen.queryByText('setup:downloadStartedOpening')
      ).not.toBeInTheDocument()
      expect(slot.querySelectorAll('p')).toHaveLength(0)

      // Progress, once known, sits on the same line as the pill.
      await act(async () => {
        useDownloadStore
          .getState()
          .updateProgress(
            variantId,
            0.12,
            variantId,
            200 * 1024 ** 2,
            1.6 * 1024 ** 3
          )
      })
      const progress = screen.getByText(/^12% · /)
      expect(progress.parentElement).toBe(cancel.parentElement)
      expect(slot.querySelectorAll('p')).toHaveLength(0)
      unmount()
    })

    it('stays on the screen while the download runs, however long it takes', async () => {
      const { unmount } = await renderPicker()

      fireEvent.click(screen.getByRole('button', { name: /hub:download/ }))
      await act(async () => {
        vi.advanceTimersByTime(30_000)
      })

      expect(screen.getByText('setup:welcomeTitle')).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'common:cancelDownload' })
      ).toBeInTheDocument()
      expect(mocks.navigate).not.toHaveBeenCalled()
      expect(localStorage.getItem(localStorageKey.setupCompleted)).toBeNull()
      unmount()
    })

    it('puts the Download button back when the download is cancelled', async () => {
      const { unmount } = await renderPicker()

      fireEvent.click(screen.getByRole('button', { name: /hub:download/ }))
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: 'common:cancelDownload' })
        )
      })

      expect(mocks.abortDownload).toHaveBeenCalledWith(variantId)
      const download = screen.getByRole('button', { name: /hub:download/ })
      expect(download).toBeEnabled()
      expect(
        screen.queryByRole('button', { name: 'common:cancelDownload' })
      ).not.toBeInTheDocument()
      // The list is still here: the same row, or another, can be started.
      fireEvent.click(download)
      expect(mocks.pullModelWithMetadata).toHaveBeenCalledTimes(2)
      await act(async () => {
        vi.advanceTimersByTime(30_000)
      })
      expect(mocks.navigate).not.toHaveBeenCalled()
      expect(screen.getByText('setup:welcomeTitle')).toBeInTheDocument()
      unmount()
    })

    it('enters the chat once the model has landed in the library', async () => {
      const { rerender, unmount } = await renderPicker()

      fireEvent.click(screen.getByRole('button', { name: /hub:download/ }))
      await act(async () => {
        vi.advanceTimersByTime(3_000)
      })
      expect(mocks.navigate).not.toHaveBeenCalled()

      // The bytes land: the panel drops the transfer, the provider lists it.
      installInLibrary(variantId)
      await act(async () => {
        useDownloadStore.getState().removeLocalDownloadingModel(variantId)
      })
      rerender(<SetupScreen />)
      await act(async () => {})

      expect(mocks.leftPanel.open).toBe(true)
      expect(mocks.navigate.mock.calls).toHaveLength(1)
      expect(mocks.navigate.mock.calls[0][0].search.threadModel).toEqual({
        id: variantId,
        provider: 'llamacpp-upstream',
      })
      expect(
        JSON.parse(localStorage.getItem(localStorageKey.lastUsedModel) ?? '{}')
          .model
      ).toBe(variantId)
      // A picked model is a finished setup — the reminder must stay disarmed.
      expect(mocks.reminder.pending).toBe(false)

      // Once. Later renders with the model still in the library do nothing.
      rerender(<SetupScreen />)
      await act(async () => {})
      expect(mocks.navigate.mock.calls).toHaveLength(1)
      unmount()
    })

    it('enters the chat when the import event lands before the library does', async () => {
      seedServiceHub({
        models: {
          pullModelWithMetadata: mocks.pullModelWithMetadata,
          abortDownload: mocks.abortDownload,
        } as unknown as Parameters<typeof seedServiceHub>[0]['models'],
        providers: {
          getProviders: vi.fn().mockResolvedValue([]),
        } as unknown as Parameters<typeof seedServiceHub>[0]['providers'],
      })
      const { unmount } = await renderPicker()

      fireEvent.click(screen.getByRole('button', { name: /hub:download/ }))
      const onImported = vi
        .mocked(events.on)
        .mock.calls.find(([name]) => name === 'onModelImported')?.[1] as
        | ((payload: { modelId: string }) => void)
        | undefined
      expect(onImported).toBeDefined()
      await act(async () => {
        onImported!({ modelId: variantId })
      })

      // The handler awaits the provider refresh before it navigates.
      await act(async () => {})
      expect(mocks.navigate.mock.calls).toHaveLength(1)
      expect(mocks.navigate.mock.calls[0][0].search.threadModel).toEqual({
        id: variantId,
        provider: 'llamacpp-upstream',
      })
      // Reported as the download exit it is, not as an import of a model
      // another app left on disk.
      expect(vi.mocked(posthog.capture)).toHaveBeenCalledWith(
        'onboarding_completed',
        expect.objectContaining({ exit_path: 'download_started' })
      )
      unmount()
    })

    it('lets a download that lands after Skip be, and leaves the chat alone', async () => {
      const { rerender, unmount } = await renderPicker()

      fireEvent.click(screen.getByRole('button', { name: /hub:download/ }))
      fireEvent.click(screen.getByRole('button', { name: 'setup:skip' }))
      expect(mocks.navigate.mock.calls).toHaveLength(1)

      installInLibrary(variantId)
      rerender(<SetupScreen />)
      await act(async () => {})

      expect(mocks.navigate.mock.calls).toHaveLength(1)
      expect(
        mocks.navigate.mock.calls[0][0].search?.threadModel
      ).toBeUndefined()
      unmount()
    })
  })

  describe('the offer, then the Hub picks', () => {
    const ladderModel = {
      rec: {
        modelName: 'AtomicChat/Qwen3.5-4B-GGUF',
        descriptionKey: 'hub:recEverydayUse',
        quant: 'Q4_K_M',
      },
      model: {
        model_name: 'AtomicChat/Qwen3.5-4B-GGUF',
        developer: 'AtomicChat',
        quants: [
          {
            model_id: 'Qwen3.5-4B-Q4_K_M',
            path: 'https://hf.co/AtomicChat/Qwen3.5-4B-GGUF/q4_k_m.gguf',
            file_size: '2.52 GB',
          },
        ],
        mmproj_models: [],
      },
    }

    // A further rung of the registry ladder: stepped down to when the offer
    // does not fit, never a second row on the screen.
    const otherModel = {
      rec: {
        modelName: 'AtomicChat/Qwen3.5-9B-GGUF',
        descriptionKey: 'hub:recEverydayUse',
        quant: 'Q4_K_M',
      },
      model: {
        model_name: 'AtomicChat/Qwen3.5-9B-GGUF',
        developer: 'AtomicChat',
        quants: [
          {
            model_id: 'Qwen3.5-9B-Q4_K_M',
            path: 'https://hf.co/AtomicChat/Qwen3.5-9B-GGUF/q4_k_m.gguf',
            file_size: '5.24 GB',
          },
        ],
        mmproj_models: [],
      },
    }

    // A Hub staff pick as `useStaffPicks` resolves it: the manifest entry
    // plus the catalog card, with one quant.
    const staffPick = (
      repo: string,
      card: { title: string; size: string; summary?: string; icon?: string }
    ) => {
      const [developer, name] = repo.split('/')
      return {
        pick: {
          model_name: repo,
          title: card.title,
          summary: card.summary,
          icon: card.icon,
          format: 'gguf',
        },
        model: {
          model_name: repo,
          developer,
          quants: [
            {
              model_id: `${name}-Q4_K_M`,
              path: `https://hf.co/${repo}/q4_k_m.gguf`,
              file_size: card.size,
            },
          ],
          mmproj_models: [],
        },
      }
    }

    const gemma = staffPick('AtomicChat/gemma-4-12B-it-GGUF', {
      title: 'Gemma 4 12B',
      size: '7.30 GB',
      summary: 'Mid-size Gemma 4 with vision and long-context support.',
      icon: 'gemma',
    })
    const nemotron = staffPick(
      'AtomicChat/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF',
      {
        title: 'Nemotron 3.5 Lightning',
        size: '19.70 GB',
        icon: 'nvidia',
      }
    )

    const renderPicker = async () => {
      mocks.scanLocalModels.mockResolvedValue([])
      const rendered = render(<SetupScreen />)
      await act(async () => {})
      return rendered
    }

    const downloadButtons = () =>
      screen.getAllByRole('button', { name: /hub:download/ })

    beforeEach(() => {
      mocks.recommended = [ladderModel, otherModel]
      mocks.staffPicks = [gemma, nemotron]
    })

    it('leads with the offer and lists the Hub picks under it, plainly secondary', async () => {
      // The offer alone (d29b99b85) left a user who wanted anything else with
      // Skip and an empty chat. The Hub's picks come back under it — but as
      // the Hub's rows with a secondary button, not as a second offer.
      const { unmount } = await renderPicker()

      expect(screen.getByText(/Qwen3\.5 4B/)).toBeInTheDocument()
      // One heading over one list; one badge, on the offer; the offer's
      // button is the only primary one, but no taller than the rest — a
      // bigger pill broke the column of buttons it sits in.
      expect(screen.getAllByText('setup:recommend.title')).toHaveLength(1)
      expect(screen.getAllByText('setup:recommend.badge')).toHaveLength(1)
      const buttons = downloadButtons()
      expect(buttons).toHaveLength(3)
      expect(buttons[0]).toHaveAttribute('data-variant', 'default')
      expect(buttons[0]).toHaveAttribute('data-size', 'sm')

      // The picks read as the Hub shows them: its title and its summary.
      expect(screen.getByText('Gemma 4 12B')).toBeInTheDocument()
      expect(
        screen.getByText(
          'Mid-size Gemma 4 with vision and long-context support.'
        )
      ).toBeInTheDocument()
      expect(screen.getByText('Nemotron 3.5 Lightning')).toBeInTheDocument()
      expect(buttons[1]).toHaveAttribute('data-variant', 'secondary')
      expect(buttons[1]).toHaveAttribute('data-size', 'sm')
      expect(buttons[2]).toHaveAttribute('data-variant', 'secondary')
      unmount()
    })

    it('keeps the rest of the registry ladder out of the list', async () => {
      // The list is the Hub's, not the manifest's tail. The manifest's other
      // rungs are what the recommender steps down through when the offer
      // does not fit; shown as rows they were the 6-to-11-row comparison
      // table the single offer replaced.
      const { unmount } = await renderPicker()

      expect(screen.queryByText(/Qwen3\.5 9B/)).not.toBeInTheDocument()
      unmount()
    })

    it('does not list the offer a second time when it is also a Hub pick', async () => {
      mocks.staffPicks = [
        staffPick('AtomicChat/Qwen3.5-4B-GGUF', {
          title: 'Qwen3.5 4B',
          size: '2.52 GB',
        }),
        gemma,
      ]
      const { unmount } = await renderPicker()

      expect(screen.getAllByText(/Qwen3\.5 4B/)).toHaveLength(1)
      expect(downloadButtons()).toHaveLength(2)
      unmount()
    })

    it('deals the picks so two from one publisher never sit together', async () => {
      // The manifest groups a family's sizes; a scrolling list of five Gemma
      // rows then five Qwen rows reads as a catalogue, not a choice. The
      // offer counts as the row above the list: it is Qwen here, so the
      // first pick may not be.
      mocks.staffPicks = [
        staffPick('AtomicChat/Qwen3.6-27B-GGUF', {
          title: 'Qwen3.6 27B',
          size: '14.0 GB',
          icon: 'qwen',
        }),
        gemma,
        staffPick('unsloth/Qwen3.5-35B-A3B-GGUF', {
          title: 'Qwen3.5 35B A3B',
          size: '21.3 GB',
          icon: 'qwen',
        }),
      ]
      const { unmount } = await renderPicker()

      const names = screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent?.replace(/ ·.*$/, '').trim())
      expect(names).toEqual([
        'Qwen3.5 4B',
        'Gemma 4 12B',
        'Qwen3.6 27B',
        'Qwen3.5 35B A3B',
      ])
      unmount()
    })

    it('lists every Hub pick, however large, and holds a place for one still resolving', async () => {
      // The list is the Hub's, not a second recommender: a pick this Mac
      // cannot load stays listed, as it is in Models. A pick whose card has
      // not come back yet keeps its row too, so the list is complete from the
      // first paint and fills in — as the registry rows always have.
      mocks.hardwareTier.tier = 'unified_16'
      mocks.hardwareTier.profile = {
        tier: 'unified_16',
        memoryKind: 'unified',
        budgetMib: 18 * 1024,
        systemRamMib: 18 * 1024,
        vramMib: 18 * 1024,
        hardCeiling: true,
      }
      mocks.staffPicks = [
        gemma,
        nemotron,
        {
          pick: {
            model_name: 'unsloth/DeepSeek-V4-Flash-GGUF',
            title: 'DeepSeek V4 Flash',
            format: 'gguf',
          },
          model: null,
        },
      ]
      const { unmount } = await renderPicker()

      expect(screen.getByText('Gemma 4 12B')).toBeInTheDocument()
      // 19.7 GB on an 18 GiB Mac: listed all the same.
      expect(screen.getByText('Nemotron 3.5 Lightning')).toBeInTheDocument()
      expect(screen.getByText('DeepSeek V4 Flash')).toBeInTheDocument()
      expect(screen.getByText('setup:modelUnavailable')).toBeInTheDocument()
      const buttons = downloadButtons()
      expect(buttons).toHaveLength(4)
      expect(buttons[3]).toBeDisabled()
      unmount()
    })

    it('starts a listed pick the way it starts the offer', async () => {
      vi.useFakeTimers()
      try {
        const { unmount } = await renderPicker()

        fireEvent.click(downloadButtons()[1])

        expect(mocks.pullModelWithMetadata).toHaveBeenCalledOnce()
        expect(mocks.pullModelWithMetadata.mock.calls[0][0]).toBe(
          'gemma-4-12B-it-GGUF-Q4_K_M'
        )
        // That row alone turns into the Downloading… pill; the offer's
        // button stays, so the user can still change their mind.
        expect(
          screen.getByRole('button', { name: 'common:cancelDownload' })
        ).toHaveTextContent('setup:downloading')
        expect(downloadButtons()).toHaveLength(2)
        expect(
          screen.queryByText('setup:downloadStartedOpening')
        ).not.toBeInTheDocument()
        // Position 1: the row after the offer, the same index its impression
        // carried.
        expect(vi.mocked(posthog.capture)).toHaveBeenCalledWith(
          'recommended_model_clicked',
          expect.objectContaining({ position: 1 })
        )

        await act(async () => {
          vi.advanceTimersByTime(3_000)
        })

        // No timed handoff: the list stays until the bytes land.
        expect(mocks.navigate).not.toHaveBeenCalled()
        expect(screen.getByText('setup:welcomeTitle')).toBeInTheDocument()
        unmount()
      } finally {
        vi.useRealTimers()
      }
    })

    it('reports every row it paints as an impression, in the order painted', async () => {
      const { unmount } = await renderPicker()

      const shown = vi
        .mocked(posthog.capture)
        .mock.calls.filter(([event]) => event === 'recommended_model_shown')
        .map(([, props]) => props as Record<string, unknown>)
      expect(shown.map((props) => [props.position, props.section])).toEqual([
        [0, 'pending'],
        [1, 'pending'],
        [2, 'pending'],
      ])
      unmount()
    })

    it('reports a pick that resolves after the first paint, once', async () => {
      // The Hub resolves picks the seed catalog does not carry with one
      // Hugging Face round-trip each, so a row can sit as a placeholder after
      // the screen painted. It gets its impression when its card lands — a
      // placeholder has no id to attribute a click to — and only then.
      const lfm = staffPick('LiquidAI/LFM2.5-1.2B-Instruct-GGUF', {
        title: 'LFM2.5 1.2B',
        size: '697 MB',
      })
      mocks.staffPicks = [gemma, nemotron, { pick: lfm.pick, model: null }]
      const { rerender, unmount } = await renderPicker()
      expect(screen.getByText('LFM2.5 1.2B')).toBeInTheDocument()
      vi.mocked(posthog.capture).mockClear()
      const shown = () =>
        vi
          .mocked(posthog.capture)
          .mock.calls.filter(([event]) => event === 'recommended_model_shown')
          .map(([, props]) => props as Record<string, unknown>)

      mocks.staffPicks = [gemma, nemotron, lfm]
      rerender(<SetupScreen />)
      await act(async () => {})

      // A placeholder cannot be judged, so it waits at the bottom; 697 MB on
      // an 8 GiB card fits, so the resolved card moves up above the two
      // yellow rows — which are reported again at their new index.
      expect(shown().map((props) => [props.position, props.section])).toEqual([
        [1, 'pending'],
        [2, 'pending'],
        [3, 'pending'],
      ])

      // Painting the same list again is not a new impression.
      rerender(<SetupScreen />)
      await act(async () => {})
      expect(shown()).toHaveLength(3)
      unmount()
    })

    it('lists the picks on their own when the registry has no offer', async () => {
      // No manifest, or every rung already installed, used to mean nothing to
      // download at all: Skip and an empty chat. The picks stand on their own
      // under the list's own heading, with nothing promoted above them.
      mocks.recommended = []
      const { unmount } = await renderPicker()

      expect(
        screen.queryByText('setup:recommend.badge')
      ).not.toBeInTheDocument()
      expect(screen.getAllByText('setup:recommend.title')).toHaveLength(1)
      const buttons = downloadButtons()
      expect(buttons).toHaveLength(2)
      expect(buttons[0]).toHaveAttribute('data-variant', 'secondary')
      expect(buttons[1]).toHaveAttribute('data-variant', 'secondary')

      // Positions start at 0: there is no offer to leave room for.
      const positions = vi
        .mocked(posthog.capture)
        .mock.calls.filter(([event]) => event === 'recommended_model_shown')
        .map(([, props]) => (props as Record<string, unknown>).position)
      expect(positions).toEqual([0, 1])

      fireEvent.click(buttons[0])
      expect(vi.mocked(posthog.capture)).toHaveBeenCalledWith(
        'recommended_model_clicked',
        expect.objectContaining({ position: 0 })
      )
      unmount()
    })

    it('reports no impressions while an auto-start hides the picker', async () => {
      // A model found on disk is started without the picker ever painting.
      // Rows behind the status line were not seen, so they get no impression
      // for a click to divide by.
      const finishLocalScan = deferLocalScan([detectedModel])
      const { unmount } = render(<SetupScreen />)
      await finishLocalScan()
      expect(
        await screen.findByText('setup:localStep.autoStarting')
      ).toBeInTheDocument()

      expect(
        vi.mocked(posthog.capture).mock.calls.map(([event]) => event)
      ).not.toContain('recommended_model_shown')
      unmount()
    })

    it('says why this model, in terms of the memory it will live in', async () => {
      // "Recommended" on its own is not a reason. The badge's tooltip names
      // the pool the weights go into, because 8 GB of VRAM and 8 GB of unified
      // memory are not the same 8 GB. It is not a line under the name: the
      // offer's row carries the badge there instead.
      const { unmount } = await renderPicker()

      // 2.52 GB against an 8 GiB card is under half the budget.
      expect(
        screen.getByTitle(/setup:recommend\.whyComfortable/)
      ).toHaveTextContent('setup:recommend.badge')
      expect(
        screen.queryByText(/setup:recommend\.whyComfortable/)
      ).not.toBeInTheDocument()
      unmount()
    })

    it('warns instead of hiding the model when it overshoots a card', async () => {
      // Windows/Linux only: llama.cpp spills into system RAM, so this is a
      // speed warning. Gating on VRAM would refuse models that demonstrably
      // load more than half the time even at a 2x overshoot.
      mocks.hardwareTier.profile = {
        tier: 'vram_2',
        memoryKind: 'vram',
        budgetMib: 2 * 1024,
        systemRamMib: 16 * 1024,
        vramMib: 2 * 1024,
        hardCeiling: false,
      }
      const { unmount } = await renderPicker()

      expect(
        screen.getByTitle(/setup:recommend\.whySpills/)
      ).toBeInTheDocument()
      expect(downloadButtons()[0]).toBeEnabled()
      unmount()
    })

    it('explains a CPU-only machine by its CPU, not by its RAM', async () => {
      // The old rule read "x86 without a GPU → low spec" and picked by RAM,
      // which is how a 128 GiB workstation got an 8 GiB laptop's advice. What
      // binds here is throughput, and the line has to say so.
      mocks.hardwareTier.tier = 'cpu_only'
      mocks.hardwareTier.profile = {
        tier: 'cpu_only',
        memoryKind: 'system',
        budgetMib: 128 * 1024,
        systemRamMib: 128 * 1024,
        vramMib: 0,
        hardCeiling: false,
      }
      const { unmount } = await renderPicker()

      expect(
        screen.getByTitle(/setup:recommend\.whyCpuOnly/)
      ).toBeInTheDocument()
      unmount()
    })

    it('offers the rest of Hugging Face as a row that leaves for the Hub', async () => {
      const { unmount } = await renderPicker()

      fireEvent.click(
        screen.getByRole('button', {
          name: /setup:cloudStep\.huggingFaceTrigger/,
        })
      )

      // Onboarding is done — the Hub takes over, and the composer's widget
      // asks again if the user comes back empty-handed.
      expect(localStorage.getItem('setup-completed')).toBe('true')
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: '/hub/',
        replace: true,
      })
      unmount()
    })

    it('offers the subscription as its own row, wearing the ChatGPT mark', async () => {
      // Signing in is not a key you paste. Of 153 users who connected any
      // cloud provider, 144 activated — and `during_onboarding = true` had
      // fired for seven devices in the product's history, because this route
      // lived under an "or" divider or, for the subscription, nowhere at all.
      mocks.modelProviderState.providers = [
        {
          active: true,
          provider: 'chatgpt',
          api_key: '',
          base_url: 'https://chatgpt.com/backend-api/codex',
          settings: [],
          models: [],
        },
      ] as unknown as ModelProvider[]
      const { unmount } = await renderPicker()

      const trigger = screen.getByRole('button', {
        name: /setup:cloudStep\.subscriptionTrigger/,
      })
      // The brand mark is what makes the named route recognisable at a glance.
      // It leads the row, as a model's logo does; the button only says what
      // pressing it does.
      expect(trigger.parentElement?.querySelector('svg')).not.toBeNull()

      fireEvent.click(trigger)

      // Straight to the sign-in, not to a gallery the user has to search.
      expect(
        await screen.findByRole('button', {
          name: 'setup:cloudStep.subscriptionConnect',
        })
      ).toBeInTheDocument()
      unmount()
    })

    describe('in the words the user reads', () => {
      // A hint is one clamped line. Under the 520 px onboarding column the
      // card leaves it about 260 px beside the mark, the gaps and the
      // width-reserving button — some 40 characters of 12 px Inter. The old
      // provider hint, 52 characters, ended in an ellipsis.
      const HINT_BUDGET = 40

      const renderRoutes = async () => {
        mocks.modelProviderState.providers = [
          {
            active: true,
            provider: 'chatgpt',
            api_key: '',
            base_url: 'https://chatgpt.com/backend-api/codex',
            settings: [],
            models: [],
          },
          {
            active: true,
            provider: 'openai',
            api_key: '',
            base_url: 'https://api.openai.com/v1',
            settings: [
              {
                key: 'api-key',
                title: 'API Key',
                description: '',
                controller_type: 'input',
                controller_props: { value: '' },
              },
            ],
            models: [{ id: 'gpt-5.5' }],
          },
        ] as unknown as ModelProvider[]
        return renderPicker()
      }

      beforeEach(() => {
        locale.english = true
      })

      afterEach(() => {
        locale.english = false
        ;(globalThis as Record<string, unknown>).IS_MACOS = false
      })

      it('leads the Hugging Face row with the name and keeps its line plain', async () => {
        const { unmount } = await renderRoutes()
        const row = screen.getByTestId('setup-browse-hub')

        // "Hugging Face" is what the eye scans for, so the title opens with it.
        expect(within(row).getByText(/^Hugging Face/)).toHaveTextContent(
          'Hugging Face models'
        )
        // Plain words: no GGUF, no MLX, nothing to know before pressing Browse.
        expect(within(row).getByText('Add any model')).toBeInTheDocument()
        expect(row).not.toHaveTextContent(/GGUF|MLX/)
        // The button shows the verb; assistive tech hears the whole action.
        expect(
          within(row).getByRole('button', {
            name: 'Browse Hugging Face models',
          })
        ).toBeInTheDocument()
        unmount()
      })

      it('keeps the Hugging Face line plain on macOS too, where MLX builds also run', async () => {
        ;(globalThis as Record<string, unknown>).IS_MACOS = true
        const { unmount } = await renderRoutes()
        const row = screen.getByTestId('setup-browse-hub')

        expect(within(row).getByText('Add any model')).toBeInTheDocument()
        expect(row).not.toHaveTextContent(/GGUF|MLX/)
        unmount()
      })

      it('names the cloud providers on one short line, like every hint in the list', async () => {
        const { unmount } = await renderRoutes()

        expect(screen.getByText('Cloud provider')).toBeInTheDocument()
        expect(
          screen.getByRole('button', { name: 'Add a cloud provider' })
        ).toBeInTheDocument()
        expect(screen.getByText('ChatGPT subscription')).toBeInTheDocument()
        expect(
          screen.getByRole('button', { name: 'Connect ChatGPT subscription' })
        ).toBeInTheDocument()

        for (const hint of [
          'Add any model',
          'Sign in, no API key needed',
          'OpenRouter, Anthropic, Gemini, OpenAI',
        ]) {
          const line = screen.getByText(hint)
          expect(line.textContent?.length).toBeLessThanOrEqual(HINT_BUDGET)
        }
        unmount()
      })
    })

    describe('fit indicator', () => {
      // An 18 GiB Mac: Metal's 85 % ceiling is a hard one, so a model past it
      // will not load at all, not merely run slowly.
      const unifiedMac = {
        tier: 'unified_16',
        memoryKind: 'unified',
        budgetMib: 18 * 1024,
        systemRamMib: 18 * 1024,
        vramMib: 18 * 1024,
        hardCeiling: true,
      }
      const unresolved = {
        pick: {
          model_name: 'unsloth/DeepSeek-V4-Flash-GGUF',
          title: 'DeepSeek V4 Flash',
          format: 'gguf',
        },
        model: null,
      }
      const fitMarks = () =>
        screen.queryAllByRole('button', { name: /setup:recommend\.fit/ })

      // Radix positions an open tooltip with a ResizeObserver jsdom lacks.
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

      it('marks each row with how it fits this machine, and says why on the mark', async () => {
        // The one badge said why the offer fits; every other row left the
        // user to work out from a size whether it would run. Now each row
        // wears a mark whose name is the same sentence the badge carries —
        // and a row whose size is unknown wears none: "we don't know" is
        // not a warning.
        mocks.hardwareTier.tier = 'unified_16'
        mocks.hardwareTier.profile = unifiedMac
        mocks.staffPicks = [gemma, nemotron, unresolved]
        const { unmount } = await renderPicker()

        const marks = fitMarks()
        expect(marks).toHaveLength(3)
        // 2.52 GB and 7.3 GB on 18 GiB: under half the pool.
        expect(marks[0]).toHaveAttribute('data-fit', 'ok')
        expect(marks[0]).toHaveAccessibleName(
          /setup:recommend\.fitOk.*setup:recommend\.whyComfortable/
        )
        expect(marks[1]).toHaveAttribute('data-fit', 'ok')
        // 19.7 GB will not load on an 18 GiB Mac.
        expect(marks[2]).toHaveAttribute('data-fit', 'no')
        expect(marks[2]).toHaveAccessibleName(
          /setup:recommend\.fitNo.*setup:recommend\.whyWontLoad/
        )
        // Every mark sits on the name side of its row, not in the button
        // column, and the unresolved row has none.
        const rows = screen.getAllByRole('heading', { level: 2 })
        expect(rows).toHaveLength(4)
        marks.forEach((mark, index) => {
          expect(rows[index].parentElement).toContainElement(mark)
        })
        expect(rows[3].parentElement?.querySelector('[data-fit]')).toBeNull()
        unmount()
      })

      it('paints a model that overshoots a card yellow, not red', async () => {
        // On Windows/Linux llama.cpp spills into system RAM: slower, but it
        // runs. Yellow for both "tight" and "spills" — one warning colour,
        // with the sentence telling the two apart.
        mocks.staffPicks = [gemma, nemotron]
        const { unmount } = await renderPicker()

        const marks = fitMarks()
        // 7.3 GB on an 8 GiB card: fits, with little room.
        expect(marks[1]).toHaveAttribute('data-fit', 'warn')
        expect(marks[1]).toHaveAccessibleName(
          /setup:recommend\.fitWarn.*setup:recommend\.whyTight/
        )
        // 19.7 GB on an 8 GiB card: spills, still runs.
        expect(marks[2]).toHaveAttribute('data-fit', 'warn')
        expect(marks[2]).toHaveAccessibleName(
          /setup:recommend\.fitWarn.*setup:recommend\.whySpills/
        )
        unmount()
      })

      it('shows no mark at all when the machine has not been measured', async () => {
        mocks.hardwareTier.profile = null
        mocks.staffPicks = [gemma, nemotron]
        const { unmount } = await renderPicker()

        expect(screen.getByText(/Qwen3\.5 4B/)).toBeInTheDocument()
        expect(fitMarks()).toHaveLength(0)
        unmount()
      })

      it('judges a CPU-only machine by its memory on the mark, while the badge still speaks of the CPU', async () => {
        // The badge explains the offer by the constraint that binds — CPU
        // throughput. The mark is a memory fit and says so in memory terms,
        // because on this machine that is what it measured.
        mocks.hardwareTier.tier = 'cpu_only'
        mocks.hardwareTier.profile = {
          tier: 'cpu_only',
          memoryKind: 'system',
          budgetMib: 128 * 1024,
          systemRamMib: 128 * 1024,
          vramMib: 0,
          hardCeiling: false,
        }
        const { unmount } = await renderPicker()

        expect(
          screen.getByTitle(/setup:recommend\.whyCpuOnly/)
        ).toBeInTheDocument()
        expect(fitMarks()[0]).toHaveAccessibleName(
          /setup:recommend\.whyComfortable/
        )
        unmount()
      })

      it('lists the picks by fit — green, yellow, red, unknown — with the offer still first', async () => {
        // The Hub's order put a 20 GB model above a 7 GB one on a machine
        // that can only run the second. Within a colour the publisher deal
        // still applies; across colours it does not reorder.
        mocks.hardwareTier.tier = 'unified_16'
        mocks.hardwareTier.profile = unifiedMac
        mocks.staffPicks = [
          unresolved,
          nemotron,
          staffPick('AtomicChat/Qwen3.6-27B-GGUF', {
            title: 'Qwen3.6 27B',
            size: '14.0 GB',
            icon: 'qwen',
          }),
          gemma,
        ]
        const { unmount } = await renderPicker()

        const names = screen
          .getAllByRole('heading', { level: 2 })
          .map((heading) => heading.textContent?.replace(/ ·.*$/, '').trim())
        expect(names).toEqual([
          'Qwen3.5 4B',
          'Gemma 4 12B',
          'Qwen3.6 27B',
          'Nemotron 3.5 Lightning',
          'DeepSeek V4 Flash',
        ])
        expect(fitMarks().map((mark) => mark.getAttribute('data-fit'))).toEqual(
          ['ok', 'ok', 'warn', 'no']
        )
        unmount()
      })

      it('opens the reason on keyboard focus, not only under the pointer', async () => {
        mocks.staffPicks = [gemma]
        const { unmount } = await renderPicker()

        const [mark] = fitMarks()
        act(() => mark.focus())
        expect(mark).toHaveFocus()
        const tip = await screen.findByRole('tooltip')
        expect(tip).toHaveTextContent('setup:recommend.whyComfortable')
        unmount()
      })
    })

    describe("a download that won't fit", () => {
      // The 18 GiB Mac again: Nemotron at 19.7 GB is past Metal's ceiling
      // and wears the red mark; Gemma at 7.3 GB fits.
      const unifiedMac = {
        tier: 'unified_16',
        memoryKind: 'unified',
        budgetMib: 18 * 1024,
        systemRamMib: 18 * 1024,
        vramMib: 18 * 1024,
        hardCeiling: true,
      }
      const nemotronVariant =
        'NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF-Q4_K_M'

      beforeEach(() => {
        mocks.hardwareTier.tier = 'unified_16'
        mocks.hardwareTier.profile = unifiedMac
        mocks.staffPicks = [gemma, nemotron]
      })

      const expectNothingStarted = () => {
        expect(mocks.pullModelWithMetadata).not.toHaveBeenCalled()
        expect(useDownloadStore.getState().localDownloadingModels.size).toBe(0)
      }

      it("asks before downloading a red row, and says why in the machine's own figures", async () => {
        // Danny clicked Download on a red row of a 64 GB M5 Max and the
        // transfer simply began: nothing said the file would never load.
        const { unmount } = await renderPicker()
        // Offer, Gemma, Nemotron — the red one is last.
        fireEvent.click(downloadButtons()[2])

        const dialog = screen.getByRole('dialog')
        expect(dialog).toHaveTextContent('setup:wontFitDialog.title')
        expect(dialog).toHaveTextContent('Nemotron 3.5 Lightning')
        expect(dialog).toHaveTextContent('setup:recommend.whyWontLoad')
        expect(dialog).toHaveTextContent('setup:wontFitDialog.body')
        // Cancel is the default answer: Enter does the safe thing.
        expect(
          within(dialog).getByRole('button', { name: 'common:cancel' })
        ).toHaveFocus()
        expectNothingStarted()
        unmount()
      })

      it('starts the download, as before, once the user says so anyway', async () => {
        const { unmount } = await renderPicker()
        fireEvent.click(downloadButtons()[2])

        fireEvent.click(
          screen.getByRole('button', { name: 'setup:wontFitDialog.confirm' })
        )

        await waitFor(() =>
          expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        )
        expect(mocks.pullModelWithMetadata).toHaveBeenCalledOnce()
        expect(mocks.pullModelWithMetadata.mock.calls[0][0]).toBe(
          nemotronVariant
        )
        // The row reads Downloading… as a green row's would; the other two
        // still offer.
        expect(
          screen.getByRole('button', { name: 'common:cancelDownload' })
        ).toHaveTextContent('setup:downloading')
        expect(downloadButtons()).toHaveLength(2)
        unmount()
      })

      it('leaves the row as it was when the user cancels', async () => {
        const { unmount } = await renderPicker()
        fireEvent.click(downloadButtons()[2])

        fireEvent.click(screen.getByRole('button', { name: 'common:cancel' }))

        await waitFor(() =>
          expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        )
        expectNothingStarted()
        expect(downloadButtons()).toHaveLength(3)
        expect(
          screen.queryByRole('button', { name: 'common:cancelDownload' })
        ).not.toBeInTheDocument()
        unmount()
      })

      it('starts a row that fits at once, with no question', async () => {
        const { unmount } = await renderPicker()
        // Gemma, 7.3 GB on 18 GiB: green.
        fireEvent.click(downloadButtons()[1])

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(mocks.pullModelWithMetadata).toHaveBeenCalledOnce()
        expect(mocks.pullModelWithMetadata.mock.calls[0][0]).toBe(
          'gemma-4-12B-it-GGUF-Q4_K_M'
        )
        expect(
          screen.getByRole('button', { name: 'common:cancelDownload' })
        ).toBeInTheDocument()
        unmount()
      })

      it('starts a yellow row at once too: it will run, and the mark already says how', async () => {
        // On an 8 GiB card Nemotron spills into system RAM — slower, not
        // refused — and a question there would cry wolf.
        mocks.hardwareTier.tier = 'vram_8'
        mocks.hardwareTier.profile = {
          tier: 'vram_8',
          memoryKind: 'vram',
          budgetMib: 8 * 1024,
          systemRamMib: 32 * 1024,
          vramMib: 8 * 1024,
          hardCeiling: false,
        }
        const { unmount } = await renderPicker()
        expect(
          screen.getAllByRole('button', { name: /setup:recommend\.fit/ })[2]
        ).toHaveAttribute('data-fit', 'warn')

        fireEvent.click(downloadButtons()[2])

        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(mocks.pullModelWithMetadata).toHaveBeenCalledOnce()
        expect(mocks.pullModelWithMetadata.mock.calls[0][0]).toBe(
          nemotronVariant
        )
        expect(
          screen.getByRole('button', { name: 'common:cancelDownload' })
        ).toBeInTheDocument()
        unmount()
      })
    })
  })

  describe('leaving without a model', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    const renderPastLocalScan = async (found: unknown[] = []) => {
      mocks.scanLocalModels.mockResolvedValue(found)
      const rendered = render(<SetupScreen onSkipped={mocks.onSkipped} />)
      await act(async () => {})
      return rendered
    }

    it('waits indefinitely rather than walking the user out', async () => {
      const { unmount } = await renderPastLocalScan()

      await act(async () => {
        vi.advanceTimersByTime(5 * 60_000)
      })

      expect(localStorage.getItem(localStorageKey.setupCompleted)).toBeNull()
      expect(mocks.reminder.pending).toBe(false)
      expect(mocks.navigate).not.toHaveBeenCalled()
      unmount()
    })

    it('enters the chat without arming the reminder when Skip is pressed', async () => {
      const { unmount } = await renderPastLocalScan()

      fireEvent.click(screen.getByRole('button', { name: 'setup:skip' }))

      expect(localStorage.getItem(localStorageKey.setupCompleted)).toBe('true')
      expect(localStorage.getItem(localStorageKey.lastUsedModel)).toBeNull()
      expect(mocks.reminder.pending).toBe(false)
      // Pressing a button and running out a clock are different acts; the
      // legacy `skipped` and the retired `timeout` must not be reused.
      expect(vi.mocked(posthog.capture)).toHaveBeenCalledWith(
        'onboarding_completed',
        expect.objectContaining({ exit_path: 'dismissed' })
      )
      expect(mocks.leftPanel.open).toBe(true)
      expect(mocks.navigate.mock.calls).toEqual([
        [{ to: '/', replace: true, search: {} }],
      ])
      unmount()
    })

    it('exits only once when the user connects a provider first', async () => {
      mocks.modelProviderState.providers = [
        {
          active: true,
          provider: 'openai',
          api_key: '',
          base_url: 'https://api.openai.com/v1',
          settings: [
            {
              key: 'api-key',
              title: 'API Key',
              description: '',
              controller_type: 'input',
              controller_props: { value: '' },
            },
          ],
          models: [{ id: 'gpt-5.5' }],
        },
      ] as ModelProvider[]
      const { unmount } = await renderPastLocalScan()

      fireEvent.click(
        screen.getByRole('button', { name: 'setup:cloudStep.trigger' })
      )
      fireEvent.click(screen.getByRole('button', { name: /OpenAI/ }))
      fireEvent.change(screen.getByLabelText('setup:cloudStep.keyLabel'), {
        target: { value: 'sk-test' },
      })
      fireEvent.click(
        screen.getByRole('button', { name: 'setup:cloudStep.saveKey' })
      )
      await act(async () => {
        vi.advanceTimersByTime(30_000)
      })

      expect(localStorage.getItem(localStorageKey.setupCompleted)).toBe('true')
      expect(mocks.navigate.mock.calls).toHaveLength(1)
      // Nothing must fire behind the finished setup and nag the user.
      expect(mocks.reminder.pending).toBe(false)
      unmount()
    })

    it('never cuts an in-flight local import short', async () => {
      // A detected model auto-starts, so the import is already in flight here.
      const { unmount } = await renderPastLocalScan([detectedModel])

      await act(async () => {
        vi.advanceTimersByTime(30_000)
      })

      expect(mocks.engine.import.mock.calls).toEqual([
        expectedImport(detectedModel),
      ])
      // Still on onboarding: nothing may complete setup behind the import, and
      // the reminder must not be armed for a chosen model.
      expect(localStorage.getItem(localStorageKey.setupCompleted)).toBeNull()
      expect(mocks.reminder.pending).toBe(false)
      expect(mocks.navigate.mock.calls).toHaveLength(0)
      unmount()
    })
  })
})
