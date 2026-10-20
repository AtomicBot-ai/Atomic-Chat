import { act, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => options,
  Link: ({
    children,
    to,
    className,
  }: {
    children: React.ReactNode
    to: string
    className?: string
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// The request channel is the core's; this page only reads the log store.
vi.mock('@/hooks/useApiServerLogFeed', () => ({
  useApiServerLogFeed: () => ({ clear: vi.fn(), hydrate: vi.fn() }),
}))
vi.mock('@/hooks/useApiServerModelNotices', () => ({
  useApiServerModelNotices: () => {},
}))

import { useApiServerLog } from '@/hooks/useApiServerLog'
import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'

import { ServerOverviewPage } from '../index'

describe('Server → Overview', () => {
  beforeEach(() => {
    useApiServerLog.getState().reset()
    useAppState.setState({ serverStatus: 'stopped' })
    useLocalApiServer.setState({
      defaultModelLocalApiServer: {
        model: 'qwen3.5-4b',
        provider: 'llamacpp-upstream',
      },
      lastServerModels: [{ model: 'gemma-4', provider: 'mlx' }],
    })
  })

  it('asks for a start while the server is stopped, and links its connection details', () => {
    render(<ServerOverviewPage />)

    expect(screen.getByText('api:overview.stoppedTitle')).toBeInTheDocument()
    expect(screen.getByText('api:overview.stoppedHint')).toBeInTheDocument()
    expect(
      screen.getByText('api:overview.connectionDetails').closest('a')
    ).toHaveAttribute('href', '/api/connections')
  })

  it('names what a running server serves', () => {
    useAppState.setState({ serverStatus: 'running' })
    render(<ServerOverviewPage />)

    expect(screen.getByText('api:overview.readyTitle')).toBeInTheDocument()
    expect(screen.getByText('gemma-4 · MLX')).toBeInTheDocument()
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
