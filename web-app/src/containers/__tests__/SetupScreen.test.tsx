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
    engine: { import: vi.fn() },
    // Mutable so a test can put the machine in the low-spec tier.
    hardwareTier: { tier: 'standard' as 'low' | 'standard', ready: true },
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
  useResolvedRecommendedModels: () => [],
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
  default: { capture: vi.fn() },
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
    seedServiceHub()
    mocks.leftPanel.open = false
    mocks.reminder.pending = false
    mocks.hardwareTier.tier = 'standard'
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

  it('offers no Skip link, so setup is finished rather than dodged', async () => {
    const finishLocalScan = deferLocalScan()
    const { unmount } = render(<SetupScreen onSkipped={mocks.onSkipped} />)
    await finishLocalScan()

    // Leaving empty-handed still exists — it is the auto-exit timeout, covered
    // by describe('auto-exit') below — but it is no longer offered as a button.
    await screen.findByText('setup:welcomeTitle')
    expect(
      screen.queryByRole('button', { name: 'setup:skip' })
    ).not.toBeInTheDocument()
    expect(localStorage.getItem(localStorageKey.setupCompleted)).toBeNull()
    expect(mocks.onSkipped).not.toHaveBeenCalled()
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
      seedProviders([cloudProvider({ provider: 'llamacpp', base_url: undefined })])

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
      const [name, patch] = mocks.modelProviderState.updateProvider.mock.calls[0]
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

    describe('auto-exit interaction', () => {
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
        // The whole point of the feature: a user reading their provider's
        // dashboard for an API key must not have onboarding exit under them.
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

      it('re-arms the timeout once the dialog is dismissed', async () => {
        const { unmount } = await renderWithCloudProvider()

        fireEvent.click(
          screen.getByRole('button', { name: 'setup:cloudStep.trigger' })
        )
        await act(async () => {
          vi.advanceTimersByTime(60_000)
        })
        fireEvent.keyDown(document.activeElement ?? document.body, {
          key: 'Escape',
        })
        await act(async () => {
          vi.advanceTimersByTime(15_000)
        })

        expect(localStorage.getItem(localStorageKey.setupCompleted)).toBe('true')
        expect(mocks.navigate.mock.calls).toEqual([
          [{ to: '/', replace: true, search: {} }],
        ])
        unmount()
      })
    })
  })

  describe('auto-exit', () => {
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

    it('enters the chat and arms the reminder after 15 seconds', async () => {
      const { unmount } = await renderPastLocalScan()

      await act(async () => {
        vi.advanceTimersByTime(14_999)
      })
      expect(mocks.navigate).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(1)
      })

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
      // The timeout must not fire behind the finished setup and nag the user.
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
      // Still on onboarding: the timeout must not have completed setup behind
      // the import, and the reminder must not be armed for a chosen model.
      expect(localStorage.getItem(localStorageKey.setupCompleted)).toBeNull()
      expect(mocks.reminder.pending).toBe(false)
      expect(mocks.navigate.mock.calls).toHaveLength(0)
      unmount()
    })
  })
})
