import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SetupScreen from '../SetupScreen'
import { localStorageKey } from '@/constants/localStorage'
import { seedServiceHub } from '@/test/service-hub'

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
  }
})

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useModelProvider', () => {
  const state = {
    providers: [],
    getProviderByName: vi.fn(),
    selectModelProvider: vi.fn(),
    setProviders: vi.fn(),
  }
  const useModelProvider = () => state
  useModelProvider.getState = () => state
  return { useModelProvider }
})

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

  it('persists and reports a skipped setup', async () => {
    const finishLocalScan = deferLocalScan()
    const completedEvent = vi.fn()
    window.addEventListener('app:setup-completed', completedEvent)
    const { unmount } = render(<SetupScreen onSkipped={mocks.onSkipped} />)

    await finishLocalScan()
    fireEvent.click(await screen.findByRole('button', { name: 'setup:skip' }))

    expect(localStorage.getItem(localStorageKey.setupCompleted)).toBe('true')
    expect(mocks.onSkipped).toHaveBeenCalledOnce()
    expect(mocks.leftPanel.open).toBe(true)
    expect(mocks.reminder.pending).toBe(true)
    expect(completedEvent).toHaveBeenCalledOnce()
    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: '/',
        replace: true,
        search: {},
      })
    })
    unmount()
    window.removeEventListener('app:setup-completed', completedEvent)
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

    it('exits only once when the user skips first', async () => {
      const { unmount } = await renderPastLocalScan()

      fireEvent.click(screen.getByRole('button', { name: 'setup:skip' }))
      await act(async () => {
        vi.advanceTimersByTime(30_000)
      })

      expect(localStorage.getItem(localStorageKey.setupCompleted)).toBe('true')
      expect(mocks.navigate.mock.calls).toHaveLength(1)
      expect(mocks.setReminderPending.mock.calls).toEqual([[true]])
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
