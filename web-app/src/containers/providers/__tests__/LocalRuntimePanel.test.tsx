/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

// The panel reads this build-time constant to decide whether MLX exists on
// this host; pin it so the Apple-only row is exercised on every CI platform.
vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).IS_MACOS = true
})

import { LocalRuntimePanel } from '../LocalRuntimePanel'
import { seedServiceHub } from '@/test/service-hub'
import type { ModelsService } from '@/services/models/types'
import type { ProvidersService } from '@/services/providers/types'

let mockProviders: any[] = []
const mockUpdateProvider = vi.fn()
const mockSetProviders = vi.fn()
const mockGetProviders = vi.fn()
const mockNavigate = vi.fn()

const turboquantUpdater = {
  checkForEngineUpdate: vi.fn(),
  downloadRecommendedBackend: vi.fn().mockResolvedValue(undefined),
  refreshBackendCatalog: vi.fn().mockResolvedValue(undefined),
  recheckOptimalBackend: vi.fn(),
  selectManualBackend: vi.fn().mockResolvedValue(undefined),
  listInstalledBackends: vi.fn().mockResolvedValue([]),
  deleteBackend: vi.fn().mockResolvedValue(undefined),
  installBackend: vi.fn().mockResolvedValue(undefined),
  recommendationPhase: 'idle',
}
const upstreamUpdater = {
  ...turboquantUpdater,
  checkForEngineUpdate: vi.fn(),
  downloadRecommendedBackend: vi.fn().mockResolvedValue(undefined),
  refreshBackendCatalog: vi.fn().mockResolvedValue(undefined),
}

vi.mock('@/hooks/useBackendUpdater', () => ({
  useBackendUpdater: (config?: { providerId?: string }) =>
    config?.providerId === 'llamacpp' ? turboquantUpdater : upstreamUpdater,
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: () => ({
    providers: mockProviders,
    updateProvider: mockUpdateProvider,
    setProviders: mockSetProviders,
  }),
}))

vi.mock('@/hooks/useBackendMismatch', () => ({
  useBackendMismatch: () => ({ pending: null }),
}))

vi.mock('@/hooks/useLlamacppDevices', () => ({
  useLlamacppDevices: { getState: () => ({ fetchDevices: vi.fn() }) },
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: any) => options?.defaultValue ?? key,
  }),
}))

vi.mock('@/containers/ProvidersAvatar', () => ({
  default: ({ provider }: { provider: { provider: string } }) => (
    <div data-testid="providers-avatar" data-provider={provider.provider} />
  ),
}))

// Radix's dropdown needs real pointer events to open, which jsdom does not
// provide. A native select keeps the contract under test — which value reaches
// `onChange` — without fighting the primitive.
vi.mock('@/containers/dynamicControllerSetting/DropdownControl', () => ({
  DropdownControl: ({
    value,
    options = [],
    onChange,
  }: {
    value: string
    options?: Array<{ value: string | number; name: string }>
    onChange: (value: string | number) => void
  }) => (
    <select
      data-testid="version-dropdown"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.name}
        </option>
      ))}
    </select>
  ),
}))

vi.mock('@/containers/dialogs/ManageEnginePacksDialog', () => ({
  ManageEnginePacksDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="packs-dialog" /> : null,
}))

const toastSuccess = vi.fn()
const toastInfo = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (...args: any[]) => toastSuccess(...args),
    info: (...args: any[]) => toastInfo(...args),
    error: vi.fn(),
  },
}))

const engine = (provider: string, versionBackend: string) => ({
  provider,
  active: true,
  models: [],
  settings: [
    {
      key: 'version_backend',
      title: 'Backend',
      description: '',
      controller_type: 'dropdown',
      controller_props: {
        value: versionBackend,
        options: [{ value: versionBackend, name: versionBackend }],
      },
    },
  ],
})

describe('LocalRuntimePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    turboquantUpdater.recommendationPhase = 'idle'
    upstreamUpdater.recommendationPhase = 'idle'
    mockProviders = [
      engine('llamacpp-upstream', 'b10344/win-cpu-x64'),
      engine('llamacpp', 'b10344-1.2.0/win-cpu-x64'),
    ]
    mockGetProviders.mockResolvedValue([])
    seedServiceHub({
      providers: {
        getProviders: mockGetProviders,
        updateSettings: vi.fn().mockResolvedValue(undefined),
      } as unknown as ProvidersService,
      models: {
        stopAllModels: vi.fn().mockResolvedValue(undefined),
        getActiveModels: vi.fn().mockResolvedValue([]),
      } as unknown as ModelsService,
    })
  })

  it('lists TurboQuant before upstream regardless of store order', () => {
    render(<LocalRuntimePanel />)

    const order = screen
      .getAllByTestId('providers-avatar')
      .map((node) => node.getAttribute('data-provider'))

    expect(order).toEqual(['llamacpp', 'llamacpp-upstream'])
  })

  // The snapshot the app boots with is taken while the engines are still
  // resolving their catalogs, so it can carry a one-entry version list where
  // several builds are installed. Opening the page must replace it.
  it('re-reads the engines on open, so a short boot snapshot cannot hide installed builds', async () => {
    const fullList = [
      { value: 'b10269-1.5.0/macos-arm64', name: 'b10269-1.5.0' },
      { value: 'b10269-1.5.1/macos-arm64', name: 'b10269-1.5.1' },
    ]
    mockGetProviders.mockResolvedValue([
      {
        ...engine('llamacpp', 'b10269-1.5.1/macos-arm64'),
        settings: [
          {
            key: 'version_backend',
            title: 'Backend',
            description: '',
            controller_type: 'dropdown',
            controller_props: {
              value: 'b10269-1.5.1/macos-arm64',
              options: fullList,
            },
          },
        ],
      },
    ])

    render(<LocalRuntimePanel />)

    await waitFor(() => {
      const pushed = mockSetProviders.mock.calls[0]?.[0]
      expect(pushed?.[0]?.settings?.[0]?.controller_props?.options).toEqual(
        fullList
      )
    })
  })

  it('leaves Foundation Models out: it is a macOS feature, not a runtime', () => {
    mockProviders = [
      ...mockProviders,
      engine('foundation-models', 'macos-26/system'),
    ]

    render(<LocalRuntimePanel />)

    const listed = screen
      .getAllByTestId('providers-avatar')
      .map((node) => node.getAttribute('data-provider'))

    expect(listed).toEqual(['llamacpp', 'llamacpp-upstream'])
  })

  it('shows the bundled MLX version as a list entry, like every other engine', () => {
    mockProviders = [engine('mlx', 'mlxvlm-macos-arm64-0e33b66 / macos-arm64')]

    render(<LocalRuntimePanel />)

    const dropdown = screen.getByTestId('version-dropdown')
    expect(dropdown).toHaveValue('mlxvlm-macos-arm64-0e33b66 / macos-arm64')
    expect(
      screen.getByRole('option', {
        name: 'mlxvlm-macos-arm64-0e33b66 / macos-arm64',
      })
    ).toBeInTheDocument()
  })

  it('asks both llama.cpp providers on a single update check', async () => {
    turboquantUpdater.checkForEngineUpdate.mockResolvedValue({
      updateAvailable: false,
      targetBackend: null,
    })
    upstreamUpdater.checkForEngineUpdate.mockResolvedValue({
      updateAvailable: false,
      targetBackend: null,
    })

    render(<LocalRuntimePanel />)
    fireEvent.click(screen.getByText('settings:checkForBackendUpdates'))

    await waitFor(() => {
      expect([
        turboquantUpdater.checkForEngineUpdate.mock.calls.length,
        upstreamUpdater.checkForEngineUpdate.mock.calls.length,
      ]).toEqual([1, 1])
    })
    expect(toastSuccess.mock.calls[0]?.[0]).toBe(
      'settings:noBackendUpdateAvailable'
    )
  })

  it('downloads the update through the provider that offered it', async () => {
    turboquantUpdater.checkForEngineUpdate.mockResolvedValue({
      updateAvailable: true,
      targetBackend: 'b10400-1.3.0/win-cpu-x64',
    })
    upstreamUpdater.checkForEngineUpdate.mockResolvedValue({
      updateAvailable: false,
      targetBackend: null,
    })

    render(<LocalRuntimePanel />)
    fireEvent.click(screen.getByText('settings:checkForBackendUpdates'))

    await waitFor(() => {
      expect(
        turboquantUpdater.downloadRecommendedBackend.mock.calls[0]?.[0]
      ).toBe('b10400-1.3.0/win-cpu-x64')
    })
    // Each provider owns its own backend tree; an update offered by one must
    // never be downloaded through the other.
    expect(upstreamUpdater.downloadRecommendedBackend.mock.calls).toHaveLength(
      0
    )
  })

  it('routes a "latest" pick through the extension instead of persisting it', () => {
    mockProviders = [
      {
        ...engine('llamacpp-upstream', 'b10344/win-cpu-x64'),
        settings: [
          {
            key: 'version_backend',
            title: 'Backend',
            description: '',
            controller_type: 'dropdown',
            controller_props: {
              value: 'b10344/win-cpu-x64',
              options: [
                { value: 'latest/win-cpu-x64', name: 'Latest (CPU)' },
                { value: 'b10344/win-cpu-x64', name: 'b10344/win-cpu-x64' },
              ],
            },
          },
        ],
      },
    ]

    render(<LocalRuntimePanel />)
    fireEvent.change(screen.getByTestId('version-dropdown'), {
      target: { value: 'latest/win-cpu-x64' },
    })

    expect(upstreamUpdater.selectManualBackend.mock.calls[0]?.[0]).toBe(
      'latest/win-cpu-x64'
    )
    // The sentinel is not a release tag; persisting it would point the engine
    // at a download URL that cannot exist.
    expect(mockUpdateProvider.mock.calls).toHaveLength(0)
  })

  it('navigates to the provider page from the Models link', () => {
    render(<LocalRuntimePanel />)

    fireEvent.click(screen.getAllByText('provider:runtime.models')[0])

    expect(mockNavigate.mock.calls[0]?.[0]).toMatchObject({
      params: { providerName: 'llamacpp' },
    })
  })

  it('opens the installed packs dialog', () => {
    render(<LocalRuntimePanel />)

    expect(screen.queryByTestId('packs-dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('provider:packs.manage'))
    expect(screen.getByTestId('packs-dialog')).toBeInTheDocument()
  })
})
