import { render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import SetupScreen from '@/containers/SetupScreen'
import { UpdateBanner } from '@/containers/UpdateBanner'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { settle, withTranslations } from '@/test/layout'

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
  }
})

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
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

describe('onboarding notification stacking', () => {
  beforeEach(() => {
    localStorage.clear()
    useDownloadStore.setState({
      downloads: {},
      localDownloadingModels: new Set(),
      resumableDownloads: new Set(),
      downloadOriginByModelId: {},
      downloadRequestOriginByModelId: {},
    })
  })

  it('paints the update banner above setup actions and below dialogs', async () => {
    await page.viewport(1280, 800)

    const app = (dialogOpen: boolean) =>
      withTranslations(
      <div className="flex h-screen w-screen overflow-hidden">
        <aside className="w-60 shrink-0" aria-label="Sidebar" />
        <main className="min-w-0 flex-1">
          <SetupScreen />
        </main>
        <UpdateBanner
          title="New Atomic Chat version"
          fromVersion="2.0.40"
          toVersion="2.0.41"
          remindLaterLabel="Remind me later"
          onRemindLater={vi.fn()}
          updateLabel="Update"
          onUpdate={vi.fn()}
          dismissLabel="Dismiss"
          onDismiss={vi.fn()}
          testId="app-update-banner"
        />
        <Dialog open={dialogOpen}>
          <DialogContent>
            <DialogTitle>Confirmation</DialogTitle>
          </DialogContent>
        </Dialog>
      </div>
      )

    const { rerender } = render(app(false))
    const route = await screen.findByTestId('setup-browse-hub')
    const banner = await screen.findByTestId('app-update-banner')
    await settle(document.body)

    const bannerBounds = banner.getBoundingClientRect()
    Object.assign(route.style, {
      position: 'fixed',
      left: `${bannerBounds.left}px`,
      top: `${bannerBounds.top}px`,
      width: `${bannerBounds.width}px`,
      height: `${bannerBounds.height}px`,
    })

    const routeLayer = route.closest('.z-10') as HTMLElement | null
    expect(routeLayer).not.toBeNull()
    expect(getComputedStyle(routeLayer!).zIndex).toBe('10')
    expect(getComputedStyle(banner).zIndex).toBe('40')

    const x = bannerBounds.left + bannerBounds.width / 2
    const y = bannerBounds.top + bannerBounds.height / 2
    const elementsAtOverlap = document.elementsFromPoint(x, y)
    expect(
      elementsAtOverlap.some(
        (element) => element === route || route.contains(element)
      )
    ).toBe(true)
    expect(banner.contains(document.elementFromPoint(x, y))).toBe(true)

    rerender(app(true))
    await screen.findByRole('dialog', { name: 'Confirmation' })
    const overlay = document.querySelector<HTMLElement>(
      '[data-slot="dialog-overlay"]'
    )
    expect(overlay).not.toBeNull()
    expect(getComputedStyle(overlay!).zIndex).toBe('50')
    expect(document.elementFromPoint(x, y)).toBe(overlay)
  })
})
