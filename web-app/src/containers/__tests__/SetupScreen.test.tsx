import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SetupScreen from '../SetupScreen'
import { localStorageKey } from '@/constants/localStorage'
import { seedServiceHub } from '@/test/service-hub'

const mocks = vi.hoisted(() => ({
  fetchSources: vi.fn(),
  navigate: vi.fn(),
  onSkipped: vi.fn(),
  scanLocalModels: vi.fn(),
  setLeftPanel: vi.fn(),
  setOnboardingActive: vi.fn(),
}))

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
  EngineManager: { instance: () => ({ get: vi.fn() }) },
  events: { on: vi.fn(), off: vi.fn() },
}))

describe('SetupScreen', () => {
  const deferLocalScan = () => {
    let finish!: () => void
    mocks.scanLocalModels.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve([])
        })
    )
    return () => act(async () => finish())
  }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    seedServiceHub()
  })

  it('renders the production onboarding after local model discovery completes', async () => {
    const finishLocalScan = deferLocalScan()
    const { unmount } = render(<SetupScreen />)

    expect(screen.getByText('common:loading')).toBeInTheDocument()
    await finishLocalScan()
    expect(await screen.findByText('Atomic Chat')).toBeInTheDocument()
    expect(
      screen.getByText('No rate limits. No subscriptions. No cloud.')
    ).toBeInTheDocument()
    expect(mocks.fetchSources).toHaveBeenCalledOnce()
    expect(mocks.scanLocalModels).toHaveBeenCalledWith({
      enabled: true,
      extraRoots: [],
      importedPaths: new Set(),
    })
    unmount()
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
    expect(mocks.setLeftPanel).toHaveBeenCalledWith(true)
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
})
