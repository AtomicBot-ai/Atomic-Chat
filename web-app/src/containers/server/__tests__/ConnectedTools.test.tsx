import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

// Connect is measured by its own tests; here it is the call it makes.
const connect = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useAgentActions', () => ({
  useAgentActions: () => ({ install: vi.fn(), connect }),
}))

import { openUrl } from '@tauri-apps/plugin-opener'

import { useApiServerLog } from '@/hooks/useApiServerLog'
import { useAppState } from '@/hooks/useAppState'
import { useServerSetup } from '@/hooks/useServerSetup'
import { useLaunchStore } from '@/stores/launch-store'

import { ConnectedTools } from '../ConnectedTools'

describe('Connections, connected tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppState.setState({ serverStatus: 'running' })
    useServerSetup.setState({
      configuredAgents: [],
      endpointConfigured: false,
      guide: null,
      guideActive: false,
    })
    useLaunchStore.setState({
      installed: {},
      opened: {},
      connected: {},
      phase: {},
    })
    useApiServerLog.getState().reset()
  })

  /** Disconnect asks first; this answers it. */
  const confirmDisconnect = () =>
    fireEvent.click(
      screen.getByRole('button', { name: 'api:connected.disconnectAction' })
    )

  it('says when nothing is connected, and adds a connection through the guide', () => {
    render(<ConnectedTools />)

    expect(screen.getByText('api:connected.empty')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'api:connected.add' }))
    expect(useServerSetup.getState().guide).toEqual({ path: 'choose' })
    expect(navigate).toHaveBeenCalledWith({ to: '/api/' })
  })

  it('lists the tools set up here and the custom application, ready while the server runs', () => {
    useServerSetup.setState({
      configuredAgents: [{ id: 'codex', at: 1 }],
      endpointConfigured: true,
    })
    render(<ConnectedTools />)

    expect(screen.getByText('Codex CLI')).toBeInTheDocument()
    expect(screen.getByText('api:connected.endpoint')).toBeInTheDocument()
    expect(screen.getAllByText('api:connected.ready')).toHaveLength(2)
  })

  it('connects a tool again: opened, then connected once the server hears from it', () => {
    useServerSetup.setState({ configuredAgents: [{ id: 'codex', at: 1 }] })
    const { rerender } = render(<ConnectedTools />)

    fireEvent.click(
      screen.getByRole('button', {
        name: 'api:connected.connectAgent:{"name":"Codex CLI"}',
      })
    )
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'codex' })
    )

    // Opening a window is not a connection.
    act(() => useLaunchStore.getState().markOpened('codex', 'qwen'))
    rerender(<ConnectedTools />)
    expect(screen.getByText('api:connected.opened')).toBeInTheDocument()
    expect(screen.queryByText('api:connected.connected')).toBeNull()

    act(() =>
      useApiServerLog.getState().applyBatch([
        {
          t: 'start',
          entry: {
            kind: 'request',
            id: 'r1',
            seq: 1,
            startedAt: Date.now() + 1,
            status: 'in_flight',
            method: 'POST',
            endpoint: 'responses',
            model: 'qwen',
            stream: true,
          },
        },
      ])
    )
    rerender(<ConnectedTools />)
    expect(screen.getByText('api:connected.connected')).toBeInTheDocument()

    // While it connects, the button waits.
    act(() => useLaunchStore.setState({ phase: { codex: 'connecting' } }))
    rerender(<ConnectedTools />)
    expect(
      screen.getByRole('button', {
        name: 'api:connected.connectAgent:{"name":"Codex CLI"}',
      })
    ).toBeDisabled()
  })

  it('does not call a tool whose app is missing ready, and links its download', () => {
    useServerSetup.setState({
      configuredAgents: [
        { id: 'zcode', at: 1 },
        { id: 'kilo', at: 2 },
      ],
    })
    useLaunchStore.setState({ installed: { zcode: false, kilo: false } })
    render(<ConnectedTools />)

    expect(screen.getByText('api:connected.appMissing')).toBeInTheDocument()
    expect(screen.getByText('api:connected.notInstalled')).toBeInTheDocument()
    expect(screen.queryByText('api:connected.ready')).toBeNull()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'api:agents.downloadAgent:{"name":"ZCode"}',
      })
    )
    expect(openUrl).toHaveBeenCalledWith('https://zcode.z.ai')
    // Kilo is installed from here: Connect offers that.
    expect(
      screen.queryByRole('button', {
        name: 'api:agents.downloadAgent:{"name":"Kilo Code"}',
      })
    ).toBeNull()
  })

  it('asks before disconnecting, and Cancel leaves the tool set up', () => {
    useServerSetup.setState({ configuredAgents: [{ id: 'vscode', at: 1 }] })
    render(<ConnectedTools />)

    const disconnect = screen.getByRole('button', {
      name: 'api:connected.forget:{"name":"VS Code"}',
    })
    // A word, not an icon.
    expect(disconnect).toHaveTextContent('api:connected.disconnectAction')
    fireEvent.click(disconnect)

    expect(
      screen.getByText('api:connected.disconnectTitle:{"name":"VS Code"}')
    ).toBeInTheDocument()
    expect(screen.getByText('api:connected.forgetHint')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'api:connected.cancel' })
    )

    expect(useServerSetup.getState().configuredAgents).toEqual([
      { id: 'vscode', at: 1 },
    ])
    expect(invoke).not.toHaveBeenCalled()
  })

  it('only forgets a tool it cannot undo: its own settings are not touched', () => {
    useServerSetup.setState({
      configuredAgents: [{ id: 'vscode', at: 1 }],
      endpointConfigured: true,
    })
    useAppState.setState({ serverStatus: 'stopped' })
    render(<ConnectedTools />)
    expect(screen.getAllByText('api:connected.serverStopped')).toHaveLength(2)

    fireEvent.click(
      screen.getByRole('button', {
        name: 'api:connected.forget:{"name":"VS Code"}',
      })
    )
    confirmDisconnect()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'api:connected.forget:{"name":"api:connected.endpoint"}',
      })
    )
    confirmDisconnect()

    expect(invoke).not.toHaveBeenCalled()
    expect(useServerSetup.getState()).toMatchObject({
      configuredAgents: [],
      endpointConfigured: false,
    })
    expect(screen.getByText('api:connected.empty')).toBeInTheDocument()
  })

  it('disconnects Codex for real before the row goes', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined)
    useServerSetup.setState({ configuredAgents: [{ id: 'codex', at: 1 }] })
    render(<ConnectedTools />)

    fireEvent.click(
      screen.getByRole('button', {
        name: 'api:connected.disconnect:{"name":"Codex CLI"}',
      })
    )
    // The question says what Disconnect does to Codex.
    expect(screen.getByText('api:connected.disconnectHint')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalled()
    confirmDisconnect()

    expect(invoke).toHaveBeenCalledWith('disconnect_agent', { agentId: 'codex' })
    await waitFor(() =>
      expect(useServerSetup.getState().configuredAgents).toEqual([])
    )
  })

  it('keeps Codex listed and says why when the disconnect fails', async () => {
    vi.mocked(invoke).mockRejectedValue('config.toml changed meanwhile')
    useServerSetup.setState({ configuredAgents: [{ id: 'codex', at: 1 }] })
    render(<ConnectedTools />)

    fireEvent.click(
      screen.getByRole('button', {
        name: 'api:connected.disconnect:{"name":"Codex CLI"}',
      })
    )
    confirmDisconnect()

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'api:connected.disconnectFailed:{"name":"Codex CLI"}',
        { description: 'config.toml changed meanwhile', duration: 15000 }
      )
    )
    expect(useServerSetup.getState().configuredAgents).toEqual([
      { id: 'codex', at: 1 },
    ])
    expect(screen.getByText('Codex CLI')).toBeInTheDocument()
  })
})
