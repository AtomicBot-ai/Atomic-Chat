import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  Link: ({
    children,
    to,
    hash,
    className,
    ...rest
  }: {
    children: React.ReactNode
    to: string
    hash?: string
    className?: string
  }) => (
    <a href={hash ? `${to}#${hash}` : to} className={className} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// The request channel, the agent probe and the server are the shell's.
vi.mock('@/hooks/useApiServerLogFeed', () => ({
  useApiServerLogFeed: () => ({ clear: vi.fn(), hydrate: vi.fn() }),
}))
vi.mock('@/hooks/useApiServerModelNotices', () => ({
  useApiServerModelNotices: () => {},
}))
vi.mock('@/lib/integration-agent-detection', () => ({
  detectIntegrationAgentsOnce: vi.fn(),
}))
vi.mock('@/hooks/useLocalApiServerControl', () => ({
  useLocalApiServerControl: () => ({
    status: 'stopped',
    isRunning: false,
    isModelLoading: false,
    isBusy: false,
    start: vi.fn(),
    stop: vi.fn(),
    toggle: vi.fn(),
    refreshStatus: vi.fn(),
  }),
}))
vi.mock('@/hooks/useServiceHub', () => ({ useServiceHub: () => ({}) }))

import { useApiServerLog } from '@/hooks/useApiServerLog'
import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useServerSetup } from '@/hooks/useServerSetup'

import { ServerOverviewPage } from '../index'

const SET_UP = {
  setupDone: true,
  setupDismissed: false,
  guide: null,
  guideActive: false,
  guideRevision: 0,
}

describe('Server → Overview', () => {
  beforeEach(() => {
    useApiServerLog.getState().reset()
    useAppState.setState({ serverStatus: 'running' })
    useLocalApiServer.setState({
      defaultModelLocalApiServer: {
        model: 'qwen3.5-4b',
        provider: 'llamacpp-upstream',
      },
      lastServerModels: [],
    })
    useServerSetup.setState(SET_UP)
  })

  it('opens with the setup guide on a first visit', () => {
    useServerSetup.setState({ setupDone: false })
    render(<ServerOverviewPage />)

    expect(
      screen.getByRole('region', { name: 'api:guide.label' })
    ).toBeInTheDocument()
    expect(screen.getByText('api:guide.chooseTitle')).toBeInTheDocument()
    expect(
      screen.queryByText('api:overview.readyTitle')
    ).not.toBeInTheDocument()
  })

  it('names what the server serves once set up, and opens the guide on request', () => {
    useLocalApiServer.setState({
      lastServerModels: [{ model: 'gemma-4', provider: 'mlx' }],
    })
    render(<ServerOverviewPage />)

    expect(screen.getByText('api:overview.readyTitle')).toBeInTheDocument()
    expect(screen.getByText('gemma-4 · MLX')).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: /api:overview\.guideMe/ })
    )
    expect(screen.getByText('api:guide.chooseTitle')).toBeInTheDocument()
  })

  it('lists the agents and tools under the strip', () => {
    render(<ServerOverviewPage />)

    expect(
      screen.getByRole('region', { name: 'api:agents.title' })
    ).toBeInTheDocument()
    expect(screen.getByTestId('server-all-integrations')).toHaveAttribute(
      'href',
      '/launch/'
    )
  })

  it('lists the latest requests and events, newest first, with the way to Activity', () => {
    render(<ServerOverviewPage />)
    expect(screen.getByText('api:overview.noActivity')).toBeInTheDocument()

    act(() => {
      useApiServerLog.getState().hydrate([
        {
          kind: 'request',
          id: 'b',
          seq: 2,
          startedAt: Date.now(),
          status: 'error',
          method: 'GET',
          endpoint: 'models',
          model: null,
          stream: false,
          httpStatus: 401,
        },
        {
          kind: 'event',
          id: 'a',
          seq: 1,
          startedAt: Date.now() - 1000,
          level: 'info',
          title: 'Model loaded',
        },
      ])
    })

    const rows = within(
      screen.getByText('api:overview.activityTitle').closest('details')!
    ).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('GET /models · 401'),
      expect.stringContaining('Model loaded'),
    ])
    expect(
      screen.getByText('api:overview.openActivity').closest('a')
    ).toHaveAttribute('href', '/api/activity')
  })
})
