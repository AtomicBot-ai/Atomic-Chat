import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useServerSetup } from '@/hooks/useServerSetup'
import { ServerControlPanel } from '../ServerControlPanel'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: any) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => navigate,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/utils', () => ({
  getProviderTitle: (provider: string) => `title:${provider}`,
}))

const control = vi.hoisted(() => ({
  status: 'stopped' as 'stopped' | 'pending' | 'running',
  isRunning: false,
  isBusy: false,
  start: vi.fn(),
  stop: vi.fn(),
  toggle: vi.fn(),
}))
vi.mock('@/hooks/useLocalApiServerControl', () => ({
  useLocalApiServerControl: () => control,
}))

const server = vi.hoisted(() => ({
  defaultModelLocalApiServer: null as null | {
    model: string
    provider: string
  },
  lastServerModels: [] as { model: string; provider: string }[],
}))
vi.mock('@/hooks/useLocalApiServer', () => ({
  useLocalApiServer: (selector: (state: typeof server) => unknown) =>
    selector(server),
}))

const setStatus = (status: typeof control.status) => {
  control.status = status
  control.isRunning = status !== 'stopped'
  control.isBusy = status === 'pending'
}

describe('ServerControlPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setStatus('stopped')
    server.defaultModelLocalApiServer = null
    server.lastServerModels = []
    control.start.mockResolvedValue(undefined)
    control.stop.mockResolvedValue(undefined)
    control.toggle.mockResolvedValue(undefined)
    useServerSetup.setState({
      setupDone: true,
      guide: null,
      guideActive: false,
      configuredAgents: [],
      endpointConfigured: false,
    })
  })

  it('starts a stopped server', async () => {
    render(<ServerControlPanel />)

    const power = screen.getByTestId('server-panel-power')
    expect(power).toHaveTextContent('common:navigation.serverStart')
    await userEvent.click(power)

    expect(control.toggle).toHaveBeenCalledTimes(1)
  })

  it('offers only Stop while running: saving a change applies it, so there is no Restart', async () => {
    setStatus('running')
    render(<ServerControlPanel />)

    const power = screen.getByTestId('server-panel-power')
    expect(power).toHaveTextContent('common:navigation.serverStop')
    expect(
      screen.queryByRole('button', { name: /restart/i })
    ).not.toBeInTheDocument()
    await userEvent.click(power)

    // The control's stop is the turn-off that also unloads the models.
    expect(control.toggle).toHaveBeenCalledTimes(1)
  })

  it('opens Engine & model from the engine and model, and Connections below them', () => {
    render(<ServerControlPanel />)

    expect(
      screen.getByText('common:navigation.engine').closest('a')
    ).toHaveAttribute('href', '/api/model')
    expect(
      screen.getByText('common:navigation.model').closest('a')
    ).toHaveAttribute('href', '/api/model')
    expect(
      screen.getByText('common:navigation.connections').closest('a')
    ).toHaveAttribute('href', '/api/connections')
  })

  it('locks the power button while the server is starting', () => {
    setStatus('pending')
    render(<ServerControlPanel />)

    const power = screen.getByTestId('server-panel-power')
    expect(power).toHaveTextContent('common:navigation.serverStarting')
    expect(power).toBeDisabled()
  })

  it('shows the model the next start will load', () => {
    server.defaultModelLocalApiServer = {
      model: 'qwen3.5-4b',
      provider: 'llamacpp-upstream',
    }
    render(<ServerControlPanel />)

    expect(screen.getByText('title:llamacpp-upstream')).toBeInTheDocument()
    expect(screen.getByText('qwen3.5-4b')).toBeInTheDocument()
  })

  it('shows what a running server actually loaded', () => {
    setStatus('running')
    server.defaultModelLocalApiServer = {
      model: 'qwen3.5-4b',
      provider: 'llamacpp-upstream',
    }
    server.lastServerModels = [{ model: 'gemma-4-e2b', provider: 'mlx' }]
    render(<ServerControlPanel />)

    expect(screen.getByText('title:mlx')).toBeInTheDocument()
    expect(screen.getByText('gemma-4-e2b')).toBeInTheDocument()
  })

  it('says when no model is chosen', () => {
    render(<ServerControlPanel />)

    expect(screen.getAllByText('common:navigation.notSelected')).toHaveLength(2)
  })

  it('opens the setup guide on Overview instead of starting a server never set up', async () => {
    useServerSetup.setState({ setupDone: false })
    render(<ServerControlPanel />)

    await userEvent.click(screen.getByTestId('server-panel-power'))

    expect(control.toggle).not.toHaveBeenCalled()
    expect(useServerSetup.getState().guideActive).toBe(true)
    expect(navigate).toHaveBeenCalledWith({ to: '/api/' })
  })

  it('counts the tools set up to use the server', () => {
    useServerSetup.setState({
      configuredAgents: [
        { id: 'codex', at: 1 },
        { id: 'claude-code', at: 2 },
      ],
      endpointConfigured: true,
    })
    render(<ServerControlPanel />)

    expect(
      screen.getByText('common:navigation.connectionsCount')
    ).toBeInTheDocument()
  })
})
