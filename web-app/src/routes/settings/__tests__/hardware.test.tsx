import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { ServiceHub } from '@/services'
import { seedServiceHub } from '@/test/service-hub'

const hardwareService = {
  getHardwareInfo: vi.fn().mockResolvedValue(null),
  getSystemUsage: vi.fn().mockResolvedValue(null),
  refreshHardwareInfo: vi.fn().mockResolvedValue(undefined),
}

// Mock all the dependencies with minimal implementation
vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="header-page">{children}</div>
  ),
}))

vi.mock('@/containers/Card', () => ({
  Card: ({
    title,
    children,
  }: {
    title?: string
    children: React.ReactNode
  }) => (
    <div data-testid="card">
      {title && <div>{title}</div>}
      {children}
    </div>
  ),
  CardItem: ({
    title,
    actions,
  }: {
    title?: string
    actions?: React.ReactNode
  }) => (
    <div data-testid="card-item">
      {title && <div>{title}</div>}
      {actions}
    </div>
  ),
}))

vi.mock('@/components/ui/switch', () => ({
  Switch: ({ checked }: { checked: boolean }) => (
    <input data-testid="switch" type="checkbox" checked={checked} readOnly />
  ),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// The store's state is mutable so a test can hand the page facts from the
// core (`source`) and a usage poll that disagrees with them on GPU count.
const hardwareStore = vi.hoisted(() => {
  const defaults = () => ({
    hardwareData: {
      os_type: 'windows',
      os_name: 'Windows 11',
      cpu: {
        name: 'Intel i7',
        arch: 'x64',
        core_count: 8,
        extensions: ['SSE'],
      },
      total_memory: 16384,
      gpus: [] as Array<Record<string, unknown>>,
      source: undefined as 'probe' | 'override' | undefined,
      probed_at: undefined as number | undefined,
    },
    systemUsage: {
      cpu: 50,
      used_memory: 8192,
      total_memory: 16384,
      gpus: [] as Array<{ uuid: string; used_memory: number; total_memory: number }>,
    },
  })
  return { state: defaults(), reset: () => Object.assign(hardwareStore.state, defaults()) }
})

vi.mock('@/hooks/useHardware', () => ({
  useHardware: () => ({
    hardwareData: hardwareStore.state.hardwareData,
    systemUsage: hardwareStore.state.systemUsage,
    setHardwareData: vi.fn(),
    updateSystemUsage: vi.fn(),
    pollingPaused: false,
  }),
}))

vi.mock('@/hooks/useLlamacppDevices', () => ({
  useLlamacppDevices: () => ({
    devices: [
      {
        id: 'gpu0',
        name: 'RTX 3080',
        mem: 10240,
        free: 8192,
        activated: true,
      },
    ],
    loading: false,
    error: null,
    activatedDevices: new Set(['gpu0']),
    toggleDevice: vi.fn(),
    fetchDevices: vi.fn(),
  }),
  getState: () => ({ setActivatedDevices: vi.fn() }),
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: () => ({
    providers: [{ provider: 'llamacpp-upstream' }],
    getProviderByName: vi.fn(() => ({
      settings: [{ key: 'device', controller_props: { value: 'gpu0' } }],
    })),
  }),
}))

vi.mock('@/services/hardware', () => ({
  getHardwareInfo: vi.fn(() => Promise.resolve({})),
  getSystemUsage: vi.fn(() => Promise.resolve({})),
}))

vi.mock('@/services/models', () => ({ stopAllModels: vi.fn() }))
vi.mock('@/lib/utils', () => ({
  formatMegaBytes: (mb: number) => `${mb} MB`,
  cn: (...classes: any[]) => classes.filter(Boolean).join(' '),
  LOCAL_LLAMACPP_PROVIDER: 'llamacpp-upstream',
}))
vi.mock('@/utils/number', () => ({ toNumber: (n: number) => n }))
vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: vi.fn() }))
vi.mock('@/constants/routes', () => ({
  route: {
    settings: {
      hardware: '/settings/hardware',
    },
    systemMonitor: '/monitor',
  },
}))
vi.mock('@/constants/windows', () => ({
  windowKey: { systemMonitorWindow: 'monitor' },
}))
vi.mock('@tabler/icons-react', () => ({
  IconDeviceDesktopAnalytics: () => <div data-testid="icon" />,
}))

// Mock the route structure properly
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => config,
}))

// Mock platform utils to enable hardware monitoring
vi.mock('@/lib/platform/utils', () => ({
  isPlatformTauri: () => true,
  getUnavailableFeatureMessage: () => 'Feature not available',
}))

// Mock PlatformGuard to always render children
vi.mock('@/lib/platform/PlatformGuard', () => ({
  PlatformGuard: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))

global.IS_MACOS = false

// Import the actual component after all mocks are set up
import { Route } from '../hardware'

describe('Hardware Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hardwareStore.reset()
    seedServiceHub({
      hardware: hardwareService as ReturnType<ServiceHub['hardware']>,
      window: {
        openSystemMonitorWindow: vi.fn().mockResolvedValue(undefined),
      } as ReturnType<ServiceHub['window']>,
      models: {
        stopAllModels: vi.fn().mockResolvedValue(undefined),
        getActiveModels: vi.fn().mockResolvedValue([]),
      } as ReturnType<ServiceHub['models']>,
    })
    global.IS_MACOS = false
  })

  it('renders hardware settings page', async () => {
    const Component = Route.component as React.ComponentType
    render(<Component />)

    await waitFor(() => {
      expect(
        screen.queryByText('Loading hardware information...')
      ).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('header-page')).toBeInTheDocument()
  })

  it('displays OS information', async () => {
    const Component = Route.component as React.ComponentType
    render(<Component />)

    await waitFor(() => {
      expect(screen.getByText('settings:hardware.os')).toBeInTheDocument()
      expect(screen.getByText('Windows')).toBeInTheDocument()
    })
  })

  it.each([
    ['macos', 'macOS'],
    ['linux', 'Linux'],
    ['ios', 'iOS'],
    ['android', 'Android'],
  ])('names the %s platform %s', async (osType, name) => {
    hardwareStore.state.hardwareData.os_type = osType
    const Component = Route.component as React.ComponentType
    render(<Component />)

    await waitFor(() => {
      expect(screen.getByText(name)).toBeInTheDocument()
    })
    expect(screen.queryByText(osType)).not.toBeInTheDocument()
  })

  it('shows an unknown platform id as the core reported it', async () => {
    hardwareStore.state.hardwareData.os_type = 'freebsd'
    const Component = Route.component as React.ComponentType
    render(<Component />)

    await waitFor(() => {
      expect(screen.getByText('freebsd')).toBeInTheDocument()
    })
  })

  it('displays CPU information', async () => {
    const Component = Route.component as React.ComponentType
    render(<Component />)

    await waitFor(() => {
      expect(screen.getByText('settings:hardware.cpu')).toBeInTheDocument()
      expect(screen.getByText('Intel i7')).toBeInTheDocument()
    })
  })

  it('displays memory information', async () => {
    const Component = Route.component as React.ComponentType
    render(<Component />)

    await waitFor(() => {
      expect(screen.getByText('settings:hardware.memory')).toBeInTheDocument()
    })
  })

  it('displays GPU devices on non-macOS', async () => {
    global.IS_MACOS = false
    const Component = Route.component as React.ComponentType
    render(<Component />)

    await waitFor(() => {
      expect(screen.getByText('GPUs')).toBeInTheDocument()
      expect(screen.getByText('RTX 3080')).toBeInTheDocument()
    })
  })

  it('hides GPU devices on macOS', async () => {
    global.IS_MACOS = true
    const Component = Route.component as React.ComponentType
    render(<Component />)

    await waitFor(() => {
      expect(screen.queryByText('GPUs')).not.toBeInTheDocument()
    })
  })

  describe('detection source', () => {
    it('names the core probe as the source of the facts', async () => {
      hardwareStore.state.hardwareData.source = 'probe'
      const Component = Route.component as React.ComponentType
      render(<Component />)

      await waitFor(() => {
        expect(
          screen.getByText('settings:hardware.detectionSource.probe')
        ).toBeInTheDocument()
      })
      expect(
        screen.queryByText('settings:hardware.detectionSource.override')
      ).not.toBeInTheDocument()
    })

    it('names an injected override as the source of the facts', async () => {
      hardwareStore.state.hardwareData.source = 'override'
      const Component = Route.component as React.ComponentType
      render(<Component />)

      await waitFor(() => {
        expect(
          screen.getByText('settings:hardware.detectionSource.override')
        ).toBeInTheDocument()
      })
    })

    it('says nothing about the source when the facts carry none', async () => {
      const Component = Route.component as React.ComponentType
      render(<Component />)

      await waitFor(() => {
        expect(screen.getByText('GPUs')).toBeInTheDocument()
      })
      expect(
        screen.queryByText('settings:hardware.detectionSource.probe')
      ).not.toBeInTheDocument()
      expect(
        screen.queryByText('settings:hardware.detectionSource.override')
      ).not.toBeInTheDocument()
    })
  })

  describe('detection gap', () => {
    const usageRow = (uuid: string) => ({
      uuid,
      used_memory: 1024,
      total_memory: 8192,
    })

    it('warns when the usage poll sees more GPUs than the core', async () => {
      hardwareStore.state.hardwareData.source = 'probe'
      hardwareStore.state.hardwareData.gpus = []
      hardwareStore.state.systemUsage.gpus = [usageRow('a'), usageRow('b')]
      const Component = Route.component as React.ComponentType
      render(<Component />)

      await waitFor(() => {
        expect(
          screen.getByText('settings:hardware.detectionGap')
        ).toBeInTheDocument()
      })
    })

    it('stays quiet when the core sees at least as many GPUs as the poll', async () => {
      hardwareStore.state.hardwareData.source = 'probe'
      hardwareStore.state.hardwareData.gpus = [{ name: 'GPU', uuid: 'a' }]
      hardwareStore.state.systemUsage.gpus = [usageRow('a')]
      const Component = Route.component as React.ComponentType
      render(<Component />)

      await waitFor(() => {
        expect(screen.getByText('GPUs')).toBeInTheDocument()
      })
      expect(
        screen.queryByText('settings:hardware.detectionGap')
      ).not.toBeInTheDocument()
    })
  })

  // QA 2.2.23 #14: macOS read 50 for both usage bars while the rows showed
  // other percentages, and neither bar had a name.
  describe('usage meters', () => {
    it('names the CPU and memory meters and announces the percentages the rows show', async () => {
      hardwareStore.state.systemUsage.cpu = 19.123
      hardwareStore.state.systemUsage.used_memory = 10745
      const Component = Route.component as React.ComponentType
      render(<Component />)

      const cpu = await screen.findByRole('progressbar', {
        name: 'system-monitor:cpuUsage',
      })
      expect(cpu).toHaveAttribute('aria-valuenow', '19.123')
      expect(cpu).toHaveAttribute('aria-valuemin', '0')
      expect(cpu).toHaveAttribute('aria-valuemax', '100')
      expect(cpu).toHaveAttribute('aria-valuetext', '19.12%')
      expect(screen.getByText('19.12%')).toBeInTheDocument()

      const memory = screen.getByRole('progressbar', {
        name: 'system-monitor:memoryUsage',
      })
      // 10745 of 16384 MB.
      expect(Number(memory.getAttribute('aria-valuenow'))).toBeCloseTo(65.58, 2)
      expect(memory).toHaveAttribute('aria-valuetext', '65.58%')
      expect(screen.getByText('65.58%')).toBeInTheDocument()
    })

    it('follows the next usage poll', async () => {
      const Component = Route.component as React.ComponentType
      const { rerender } = render(<Component />)
      const cpu = await screen.findByRole('progressbar', {
        name: 'system-monitor:cpuUsage',
      })
      expect(cpu).toHaveAttribute('aria-valuetext', '50.00%')

      hardwareStore.state.systemUsage = {
        ...hardwareStore.state.systemUsage,
        cpu: 73.5,
        used_memory: 4096,
      }
      rerender(<Component />)

      // The mocked store hands out new setters on every render, which reruns
      // the page's initial load; wait it out before reading the meters.
      await waitFor(() => {
        expect(
          screen.getByRole('progressbar', { name: 'system-monitor:cpuUsage' })
        ).toHaveAttribute('aria-valuetext', '73.50%')
      })
      expect(
        screen.getByRole('progressbar', { name: 'system-monitor:cpuUsage' })
      ).toHaveAttribute('aria-valuenow', '73.5')
      expect(screen.getByText('73.50%')).toBeInTheDocument()
      expect(
        screen.getByRole('progressbar', { name: 'system-monitor:memoryUsage' })
      ).toHaveAttribute('aria-valuetext', '25.00%')
    })
  })
})
