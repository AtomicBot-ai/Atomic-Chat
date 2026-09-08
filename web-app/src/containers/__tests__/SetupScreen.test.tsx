import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SetupScreen from '../SetupScreen'
import { localStorageKey } from '@/constants/localStorage'
import { seedServiceHub } from '@/test/service-hub'
import { toast } from 'sonner'

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
    pullModelWithMetadata: vi.fn(() => Promise.resolve()),
    // Recommendation list the picker renders; mutable so a test can offer a
    // downloadable model.
    recommended: [] as unknown[],
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

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

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

vi.mock('@/hooks/useDownloadStore', () => ({
  useDownloadStore: () => ({
    downloads: {},
    localDownloadingModels: new Set(),
    resumableDownloads: new Set(),
    addLocalDownloadingModel: vi.fn(),
    removeLocalDownloadingModel: vi.fn(),
    markResumableDownload: vi.fn(),
    clearResumableDownload: vi.fn(),
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
      } as unknown as Parameters<typeof seedServiceHub>[0]['models'],
    })
    mocks.recommended = []
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
    expect(screen.getByText('setup:welcomeSubtitle')).toBeInTheDocument()
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
    // manifest no longer lists.
    expect(mocks.refreshRegistry.mock.calls).toEqual([[{ force: true }]])
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
    // empty-handed a defensible thing to offer at all.
    expect(mocks.reminder.pending).toBe(true)
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

    it('holds the started download on screen for 3s before entering the chat', async () => {
      const { unmount } = await renderPicker()

      fireEvent.click(screen.getByRole('button', { name: /hub:download/ }))

      expect(mocks.pullModelWithMetadata).toHaveBeenCalledOnce()
      expect(
        screen.getByText('setup:downloadStartedOpening')
      ).toBeInTheDocument()

      await act(async () => {
        vi.advanceTimersByTime(2_999)
      })
      expect(mocks.navigate).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(1)
      })

      expect(mocks.leftPanel.open).toBe(true)
      expect(mocks.navigate.mock.calls).toHaveLength(1)
      expect(mocks.navigate.mock.calls[0][0].search.threadModel.id).toBe(
        'Qwen3.5-4B-Q4_K_M'
      )
      // A picked model is a finished setup — the reminder must stay disarmed.
      expect(mocks.reminder.pending).toBe(false)
      unmount()
    })

    it('enters the chat exactly once, however long the download runs', async () => {
      const { unmount } = await renderPicker()

      fireEvent.click(screen.getByRole('button', { name: /hub:download/ }))
      await act(async () => {
        vi.advanceTimersByTime(30_000)
      })

      expect(mocks.navigate.mock.calls).toHaveLength(1)
      expect(
        JSON.parse(localStorage.getItem(localStorageKey.lastUsedModel) ?? '{}')
          .model
      ).toBe('Qwen3.5-4B-Q4_K_M')
      expect(mocks.reminder.pending).toBe(false)
      unmount()
    })
  })

  describe('one offer, everything else behind a disclosure', () => {
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

    const renderPicker = async () => {
      mocks.scanLocalModels.mockResolvedValue([])
      const rendered = render(<SetupScreen />)
      await act(async () => {})
      return rendered
    }

    beforeEach(() => {
      mocks.recommended = [ladderModel, otherModel]
    })

    it('leads with one model and hides the rest', async () => {
      // The manifest used to serve two per tier plus whatever the scanners
      // found; shipped launches have shown 6, 10 and 11 rows. A first screen
      // whose job is "start chatting" should not open with a comparison table.
      const { unmount } = await renderPicker()

      expect(screen.getByText(/Qwen3\.5 4B/)).toBeInTheDocument()
      expect(screen.queryByText(/Qwen3\.5 9B/)).not.toBeInTheDocument()

      fireEvent.click(
        screen.getByRole('button', { name: /setup:recommend\.otherOptions/ })
      )

      expect(screen.getByText(/Qwen3\.5 9B/)).toBeInTheDocument()
      unmount()
    })

    it('says why this model, in terms of the memory it will live in', async () => {
      // "Recommended" on its own is not a reason. The line names the pool the
      // weights go into, because 8 GB of VRAM and 8 GB of unified memory are
      // not the same 8 GB.
      const { unmount } = await renderPicker()

      // 2.52 GB against an 8 GiB card is under half the budget.
      expect(
        screen.getByText(/setup:recommend\.whyComfortable/)
      ).toBeInTheDocument()
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

      expect(screen.getByText(/setup:recommend\.whySpills/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /hub:download/ })).toBeEnabled()
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
        screen.getByText(/setup:recommend\.whyCpuOnly/)
      ).toBeInTheDocument()
      unmount()
    })

    it('offers the subscription as its own button, not as a key in the gallery', async () => {
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

      fireEvent.click(
        screen.getByRole('button', {
          name: /setup:cloudStep\.subscriptionTrigger/,
        })
      )

      // Straight to the sign-in, not to a gallery the user has to search.
      expect(
        await screen.findByRole('button', {
          name: 'setup:cloudStep.subscriptionConnect',
        })
      ).toBeInTheDocument()
      unmount()
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

    it('enters the chat and arms the reminder when Skip is pressed', async () => {
      const { unmount } = await renderPastLocalScan()

      fireEvent.click(screen.getByRole('button', { name: 'setup:skip' }))

      expect(localStorage.getItem(localStorageKey.setupCompleted)).toBe('true')
      expect(localStorage.getItem(localStorageKey.lastUsedModel)).toBeNull()
      expect(mocks.reminder.pending).toBe(true)
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
