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
// Codex runs on Atomic Chat's own profile, so the terminal command has to
// select it, and hand the server's key over in the variable the profile names.
const server = vi.hoisted(() => ({ apiKey: '' }))
vi.mock('@/hooks/useLocalApiServer', () => ({
  useLocalApiServer: () => ({
    serverHost: '0.0.0.0',
    serverPort: 1337,
    apiPrefix: '/v1',
    apiKey: server.apiKey,
    defaultModelLocalApiServer: { model: 'qwen3-4b' },
  }),
}))
vi.mock('@/hooks/useAppState', () => ({
  useAppState: Object.assign(
    () => ({ serverStatus: 'running', setServerStatus: vi.fn() }),
    { subscribe: vi.fn(() => vi.fn()) }
  ),
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

function mockInvoke() {
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    const bin = (args as { bin?: string } | undefined)?.bin
    if (cmd === 'detect_agent_installed') {
      return { installed: bin === 'codex', viaWsl: false, path: null }
    }
    return undefined
  })
}

async function runCodex(): Promise<string> {
  const Component = LaunchRoute.component as React.ComponentType
  render(<Component />)
  const card = screen
    .getAllByTestId('card')
    .find((c) => within(c).queryByText('Codex CLI'))!
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('detect_agent_installed', {
      bin: 'codex',
      customPath: null,
    })
  )
  fireEvent.click(within(card).getByRole('button', { name: 'launch:enable' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'open_agent_terminal',
      expect.anything()
    )
  )
  const call = vi
    .mocked(invoke)
    .mock.calls.find(([cmd]) => cmd === 'open_agent_terminal')!
  return (call[1] as { command: string }).command
}

describe('Launch page: Codex CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke()
  })

  it('starts Codex on the Atomic Chat profile, not on its shared config', async () => {
    server.apiKey = ''
    expect(await runCodex()).toBe("'codex' '--profile' 'atomic-chat'")
    expect(invoke).toHaveBeenCalledWith('configure_codex', {
      apiUrl: 'http://127.0.0.1:1337/v1',
      model: 'qwen3-4b',
      apiKey: undefined,
    })
    expect(toast.success).toHaveBeenCalledWith('launch:toast.configured', {
      description: 'launch:toast.configuredDescCodex',
      duration: 8000,
    })
  })

  it('passes the server key in the variable the profile names, quoted for the shell', async () => {
    server.apiKey = "sk-it's"
    expect(await runCodex()).toBe(
      "ATOMIC_CHAT_API_KEY='sk-it'\\''s' 'codex' '--profile' 'atomic-chat'"
    )
    expect(invoke).toHaveBeenCalledWith('configure_codex', {
      apiUrl: 'http://127.0.0.1:1337/v1',
      model: 'qwen3-4b',
      apiKey: "sk-it's",
    })
  })
})
