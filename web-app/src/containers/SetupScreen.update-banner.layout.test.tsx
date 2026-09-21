import { render, screen, waitFor } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import DialogAppUpdater from '@/containers/dialogs/AppUpdater'
import SetupScreen from '@/containers/SetupScreen'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useUpdateBannerSlots } from '@/stores/update-banner-store'
import {
  expectNoHorizontalOverflow,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'

const mocks = vi.hoisted(() => {
  const providers = [
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
      settings: [{ key: 'api-key', controller_type: 'input' }],
      models: [],
    },
  ]

  return {
    providers,
    navigate: vi.fn(),
    fetchSources: vi.fn(),
    refresh: vi.fn(() => Promise.resolve()),
    setLeftPanel: vi.fn(),
    updateState: {
      isUpdateAvailable: true,
      updateInfo: {
        version: '2.0.41-preview',
        body: [
          '- Rebuilt local image generation setup and model picker',
          '- Automatic recovery from GPU failures',
          '- Smoother reasoning, tool activity and sidebar resizing',
          '- Clearer app updates and project feedback',
          '- One more improvement',
        ].join('\n'),
      },
      isDownloading: false,
      downloadProgress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      remindMeLater: false,
      currentVersion: '2.0.40',
    },
  }
})

const portal = vi.hoisted(() => ({ attached: true, calls: 0 }))

vi.mock('react-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom')>()

  return {
    ...actual,
    createPortal: (...args: Parameters<typeof actual.createPortal>) => {
      portal.calls += 1
      return portal.attached ? actual.createPortal(...args) : null
    },
  }
})

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('@/hooks/useAppUpdater', () => ({
  useAppUpdater: () => ({
    updateState: mocks.updateState,
    downloadAndInstallUpdate: vi.fn(),
    setRemindMeLater: vi.fn(),
  }),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    opener: () => ({ open: vi.fn(() => Promise.resolve()) }),
    providers: () => ({ getProviders: vi.fn(() => Promise.resolve([])) }),
  }),
  getServiceHub: () => ({}),
  isServiceHubInitialized: () => true,
  initializeServiceHubStore: vi.fn(),
}))

vi.mock('@/hooks/useModelProvider', () => {
  const state = {
    providers: mocks.providers,
    getProviderByName: vi.fn(),
    selectModelProvider: vi.fn(),
    setProviders: vi.fn(),
    updateProvider: vi.fn(),
  }
  const useModelProvider = () => state
  useModelProvider.getState = () => state
  return { useModelProvider }
})

vi.mock('@/hooks/useHardwareTier', () => ({
  useHardwareTier: () => ({
    tier: 'vram_8',
    ready: true,
    profile: {
      tier: 'vram_8',
      memoryKind: 'vram',
      budgetMib: 8192,
      systemRamMib: 32768,
      vramMib: 8192,
      hardCeiling: false,
    },
  }),
}))

vi.mock('@/lib/platform/const', () => ({
  PlatformFeatures: { chatgptSubscription: true },
}))

vi.mock('@/hooks/useChatGptAuth', () => ({
  useChatGptAuth: () => ({
    state: 'disconnected',
    error: null,
    connect: vi.fn(),
    cancel: vi.fn(),
  }),
}))

vi.mock('@/containers/dialogs/AddCloudProviderDialog', () => ({
  AddCloudProviderDialog: () => null,
  selectCloudGalleryProviders: (providers: Array<{ provider: string }>) =>
    providers.filter((provider) => provider.provider !== 'chatgpt'),
}))

vi.mock('@/lib/cloud-providers', () => ({
  isProviderConnected: () => false,
}))

vi.mock('@/lib/onboarding', () => ({
  describeProviderState: () => ({
    providerState: 'none',
    providerType: null,
    selectedProvider: null,
  }),
}))

vi.mock('@/hooks/useGeneralSetting', () => {
  const state = {
    huggingfaceToken: '',
    scanLocalModels: true,
    localScanFolders: [],
  }
  const useGeneralSetting = (selector: (value: typeof state) => unknown) =>
    selector(state)
  useGeneralSetting.getState = () => state
  return { useGeneralSetting }
})

vi.mock('@/hooks/useModelSources', () => ({
  useModelSources: (selector: (state: unknown) => unknown) =>
    selector({ sources: [], fetchSources: mocks.fetchSources, loading: false }),
}))

vi.mock('@/hooks/useResolvedRecommendedModels', () => ({
  useResolvedRecommendedModels: () => [],
}))

vi.mock('@/hooks/useStaffPicks', () => ({ useStaffPicks: () => [] }))
vi.mock('@/stores/recommended-models-registry-store', () => ({
  useRecommendedModelsRegistryStore: {
    getState: () => ({ refresh: mocks.refresh }),
  },
}))
vi.mock('@/stores/staff-picks-store', () => ({
  useStaffPicksStore: { getState: () => ({ refresh: mocks.refresh }) },
}))
vi.mock('@/services/models/localScan', () => ({
  scanLocalModels: vi.fn(() => Promise.resolve([])),
  collectImportedModelPaths: () => new Set(),
}))
vi.mock('@/hooks/useModelLoad', () => ({
  useModelLoad: {
    getState: () => ({
      setOnboardingActive: vi.fn(),
      deferModelSelection: vi.fn(),
    }),
  },
}))
vi.mock('@/hooks/useLeftPanel', () => ({
  useLeftPanel: { getState: () => ({ setLeftPanel: mocks.setLeftPanel }) },
}))
vi.mock('@/hooks/useOnboardingModelReminder', () => ({
  useOnboardingModelReminderStore: {
    getState: () => ({ setPending: vi.fn() }),
  },
}))
vi.mock('@/utils/switchModel', () => ({
  switchToModel: vi.fn(() => Promise.resolve()),
}))
vi.mock('@/containers/HeaderPage', () => ({
  default: () => <header className="h-12 shrink-0" />,
}))
vi.mock('posthog-js', () => ({
  default: { capture: vi.fn(), has_opted_in_capturing: () => true },
}))
vi.mock('sonner', () => ({
  toast: { dismiss: vi.fn(), error: vi.fn(), success: vi.fn() },
}))
vi.mock('@janhq/core', () => ({
  AppEvent: { onModelImported: 'onModelImported' },
  DownloadEvent: {
    onFileDownloadAndVerificationSuccess:
      'onFileDownloadAndVerificationSuccess',
  },
  EngineManager: { instance: () => ({ get: () => undefined }) },
  events: { on: vi.fn(), off: vi.fn() },
  fs: {},
  getJanDataFolderPath: vi.fn(),
  joinPath: vi.fn(),
}))

const boxesOverlap = (a: DOMRect, b: DOMRect): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

describe('SetupScreen with the app update preview', () => {
  beforeEach(() => {
    portal.attached = true
    portal.calls = 0
    localStorage.clear()
    useUpdateBannerSlots.setState({
      claimed: { download: false, app: false, engine: false },
    })
    useDownloadStore.setState({
      downloads: {},
      localDownloadingModels: new Set(),
      resumableDownloads: new Set(),
      downloadOriginByModelId: {},
      downloadRequestOriginByModelId: {},
    })
  })

  it.each(
    [1024, 1280].flatMap((width) =>
      ['16px', '20px'].flatMap((fontSize) =>
        (['light', 'dark'] as const).map((theme) => ({
          width,
          fontSize,
          theme,
        }))
      )
    )
  )(
    'keeps setup actions clear at $width px / $fontSize / $theme',
    async ({ width, fontSize, theme }) => {
      await page.viewport(width, 800)
      setFontSize(fontSize)
      setTheme(theme)

      render(
        withTranslations(
          <div className="flex h-screen w-screen overflow-hidden">
            <aside className="w-60 shrink-0" aria-label="Sidebar" />
            <main className="min-w-0 flex-1" data-testid="setup-host">
              <SetupScreen />
            </main>
            <DialogAppUpdater />
          </div>
        )
      )

      const heading = await screen.findByRole('heading', {
        name: 'Welcome to Atomic Chat!',
      })
      const banner = await screen.findByTestId('app-update-banner')
      const panel = heading.parentElement?.parentElement as HTMLElement
      await settle(document.body)
      await waitFor(() =>
        expect(boxesOverlap(panel.getBoundingClientRect(), banner.getBoundingClientRect())).toBe(
          false
        )
      )

      expect(screen.getByRole('button', { name: 'Browse Hugging Face models' })).toBeVisible()
      expect(screen.getByRole('button', { name: 'Connect ChatGPT subscription' })).toBeVisible()
      expect(screen.getByRole('button', { name: 'Add a cloud provider' })).toBeVisible()
      expectNoHorizontalOverflow(document.body)
    }
  )

  it('starts avoidance after a late portal attachment and cleans it up', async () => {
    await page.viewport(1280, 800)
    setFontSize('16px')
    setTheme('light')
    portal.attached = false

    const app = (
      <div className="flex h-screen w-screen overflow-hidden">
        <aside className="w-60 shrink-0" aria-label="Sidebar" />
        <main className="min-w-0 flex-1" data-testid="setup-host">
          <SetupScreen />
        </main>
        <DialogAppUpdater />
      </div>
    )
    const { rerender, unmount } = render(withTranslations(app))

    await waitFor(() => expect(portal.calls).toBeGreaterThan(0))
    expect(
      document.documentElement.style.getPropertyValue(
        '--update-banner-avoid-right'
      )
    ).toBe('')

    portal.attached = true
    rerender(withTranslations(app))

    const heading = await screen.findByRole('heading', {
      name: 'Welcome to Atomic Chat!',
    })
    const banner = await screen.findByTestId('app-update-banner')
    const panel = heading.parentElement?.parentElement as HTMLElement
    await waitFor(() => {
      expect(
        parseFloat(
          document.documentElement.style.getPropertyValue(
            '--update-banner-avoid-right'
          )
        )
      ).toBeGreaterThan(0)
      expect(
        parseFloat(
          document.documentElement.style.getPropertyValue(
            '--update-banner-avoid-bottom'
          )
        )
      ).toBeGreaterThan(0)
    })
    await settle(document.body)
    expect(
      boxesOverlap(
        panel.getBoundingClientRect(),
        banner.getBoundingClientRect()
      )
    ).toBe(false)

    unmount()
    expect(
      document.documentElement.style.getPropertyValue(
        '--update-banner-avoid-right'
      )
    ).toBe('')
    expect(
      document.documentElement.style.getPropertyValue(
        '--update-banner-avoid-bottom'
      )
    ).toBe('')
    expect(document.documentElement.dataset.updateBannerAvoidanceOwner).toBe(
      undefined
    )
  })
})
