import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ServerControlPanel } from '../ServerControlPanel'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, className }: any) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
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

const { hub, restart } = vi.hoisted(() => ({
  hub: { app: () => ({}) },
  restart: vi.fn(),
}))
vi.mock('@/hooks/useServiceHub', () => ({ useServiceHub: () => hub }))
vi.mock('@/hooks/useRemoteAccess', () => ({ restartLocalApiServer: restart }))

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
    restart.mockResolvedValue(true)
  })

  it('starts a stopped server', async () => {
    render(<ServerControlPanel />)

    const power = screen.getByTestId('server-panel-power')
    expect(power).toHaveTextContent('common:navigation.serverStart')
    await userEvent.click(power)

    expect(control.toggle).toHaveBeenCalledTimes(1)
    // Nothing to restart while it is stopped.
    expect(
      screen.getByRole('button', { name: 'common:navigation.serverRestart' })
    ).toBeDisabled()
  })

  it('offers Stop while running and restarts through the shared restart, loading the chosen model', async () => {
    setStatus('running')
    render(<ServerControlPanel />)

    expect(screen.getByTestId('server-panel-power')).toHaveTextContent(
      'common:navigation.serverStop'
    )
    await act(async () => {
      await userEvent.click(
        screen.getByRole('button', { name: 'common:navigation.serverRestart' })
      )
    })

    // The shared path also brings back a tunnel that was online.
    expect(restart).toHaveBeenCalledWith(hub, control, { ensureModel: true })
    expect(control.toggle).not.toHaveBeenCalled()
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

  it('locks both actions while the server is starting', () => {
    setStatus('pending')
    render(<ServerControlPanel />)

    const power = screen.getByTestId('server-panel-power')
    expect(power).toHaveTextContent('common:navigation.serverStarting')
    expect(power).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'common:navigation.serverRestart' })
    ).toBeDisabled()
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
})
