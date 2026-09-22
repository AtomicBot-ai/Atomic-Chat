import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { useLaunchStore } from '@/stores/launch-store'
import { Route as LaunchRoute } from '../index'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: { component: unknown }) => config,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'macos' }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
vi.mock('@/utils/localApiServerControl', () => ({
  startLocalApiServer: vi.fn(),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock('@/containers/Card', () => ({
  Card: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="card">{children}</div>
  ),
}))
vi.mock('@/containers/LocalApiServerStatusRow', () => ({
  LocalApiServerStatusRow: () => null,
}))
vi.mock('@/hooks/useLocalApiServer', () => ({
  useLocalApiServer: () => ({
    serverHost: '0.0.0.0',
    serverPort: 1337,
    apiPrefix: '/v1',
    apiKey: '',
    defaultModelLocalApiServer: { model: 'qwen3-4b' },
  }),
}))
vi.mock('@/hooks/useAppState', () => ({
  useAppState: () => ({ serverStatus: 'running', setServerStatus: vi.fn() }),
}))
vi.mock('@/hooks/useProxyConfig', () => ({
  useProxyConfig: {
    getState: () => ({
      proxyEnabled: false,
      proxyUrl: '',
      proxyUsername: '',
      proxyPassword: '',
      noProxy: '',
    }),
  },
}))
vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: {
    getState: () => ({ markIntegrationsBadgeSeen: vi.fn() }),
  },
}))
// Stable across renders: the page re-fetches running models whenever the hub
// identity changes.
const serviceHub = {
  models: () => ({ getActiveModels: async () => ['qwen3-4b'] }),
}
vi.mock('@/hooks/useServiceHub', () => ({ useServiceHub: () => serviceHub }))

const APP_PATH = '/Applications/ZCode.app/Contents/MacOS/ZCode'

function mockInvoke(zcode: { installed: boolean; path?: string }) {
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    const bin = (args as { bin?: string } | undefined)?.bin
    switch (cmd) {
      case 'detect_agent_installed':
        return bin === 'zcode'
          ? {
              installed: zcode.installed,
              viaWsl: false,
              path: zcode.path ?? null,
            }
          : { installed: false, viaWsl: false, path: null }
      case 'launch_zcode':
        return { installed: zcode.installed, launched: zcode.installed }
      default:
        return undefined
    }
  })
}

async function runZcode() {
  const Component = LaunchRoute.component as React.ComponentType
  render(<Component />)
  const card = screen
    .getAllByTestId('card')
    .find((c) => within(c).queryByText('ZCode'))!
  // Detection resolves asynchronously; Run reads the result through the store.
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('detect_agent_installed', {
      bin: 'zcode',
      customPath: null,
    })
  )
  fireEvent.click(within(card).getByRole('button', { name: 'launch:enable' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('launch_zcode', expect.anything())
  )
}

describe('Launch page: ZCode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes the provider without installing anything, then reports a missing app', async () => {
    mockInvoke({ installed: false })
    await runZcode()

    // The bind-all host is rewritten to loopback and the /v1 root is kept.
    expect(invoke).toHaveBeenCalledWith('configure_zcode', {
      apiUrl: 'http://127.0.0.1:1337/v1',
      model: 'qwen3-4b',
      apiKey: undefined,
    })
    expect(invoke).toHaveBeenCalledWith('launch_zcode', { path: null })
    const commands = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd)
    expect(commands).not.toContain('install_agent')
    expect(commands).not.toContain('open_agent_terminal')

    expect(toast.success).toHaveBeenCalledWith('launch:toast.configured', {
      description: 'launch:toast.configuredDescZcode',
      duration: 8000,
    })
    expect(toast.info).toHaveBeenCalledWith('launch:toast.zcodeNotInstalled', {
      description: 'launch:toast.zcodeNotInstalledDesc',
      duration: 10000,
    })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('opens the detected desktop app and stays quiet about installing', async () => {
    mockInvoke({ installed: true, path: APP_PATH })
    await runZcode()

    expect(invoke).toHaveBeenCalledWith('launch_zcode', { path: APP_PATH })
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()

    // The card reads the app as present, and the Run ends back at an idle
    // button rather than in an install phase or a terminal hand-off.
    const card = screen
      .getAllByTestId('card')
      .find((c) => within(c).queryByText('ZCode'))!
    expect(within(card).getByText('launch:installed')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        within(card).getByRole('button', { name: 'launch:enable' })
      ).toBeEnabled()
    )
    expect(useLaunchStore.getState().binPath.zcode).toBe(APP_PATH)
    expect(useLaunchStore.getState().phase.zcode).toBeUndefined()
    const commands = vi.mocked(invoke).mock.calls.map(([cmd]) => cmd)
    expect(commands).not.toContain('install_agent')
    expect(commands).not.toContain('open_agent_terminal')
  })
})
