import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

vi.mock('@tanstack/react-router', () => ({
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
}))

// Detection asks the shell; here the launch store says what it found.
vi.mock('@/lib/integration-agent-detection', () => ({
  detectIntegrationAgentsOnce: vi.fn(),
}))

import { useAppState } from '@/hooks/useAppState'
import { useServerSetup } from '@/hooks/useServerSetup'
import { useLaunchStore } from '@/stores/launch-store'

import { ServerAgents } from '../ServerAgents'

const card = (name: string) =>
  screen.getByRole('heading', { name }).closest('article') as HTMLElement

describe('Overview, agents and tools', () => {
  beforeEach(() => {
    useAppState.setState({ serverStatus: 'running' })
    useLaunchStore.setState({ installed: { codex: true } })
    useServerSetup.setState({
      configuredAgents: [{ id: 'claude-code', at: 1 }],
      endpointConfigured: false,
      guide: null,
      guideActive: false,
      guideRevision: 0,
    })
  })

  it('leads with the featured agents and says what Atomic Chat knows about each', () => {
    render(<ServerAgents />)

    const names = screen
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent)
    expect(names.slice(0, 3)).toEqual([
      'Claude Code',
      'Codex CLI',
      'Atomic Agent',
    ])
    expect(
      within(card('Claude Code')).getByText('api:agents.configured')
    ).toBeInTheDocument()
    expect(
      within(card('Codex CLI')).getByText('api:agents.installed')
    ).toBeInTheDocument()
    expect(
      within(card('Atomic Agent')).getByText('api:agents.notInstalled')
    ).toBeInTheDocument()
  })

  it('opens the guide at the agent it can configure, and connection details once set up', () => {
    render(<ServerAgents />)

    expect(
      within(card('Claude Code'))
        .getByText('api:agents.connectionDetails')
        .closest('a')
    ).toHaveAttribute('href', '/api/connections')

    fireEvent.click(
      screen.getByRole('button', {
        name: 'api:agents.configureAgent:{"name":"Codex CLI"}',
      })
    )
    expect(useServerSetup.getState()).toMatchObject({
      guide: { path: 'agent', agentId: 'codex' },
      guideActive: true,
    })
  })

  it('sends an editor set up by hand to its card on All integrations', () => {
    render(<ServerAgents />)

    expect(
      within(card('VS Code')).getByText('api:agents.setUp').closest('a')
    ).toHaveAttribute('href', '/launch/#vscode')
    expect(screen.getByTestId('server-all-integrations')).toHaveAttribute(
      'href',
      '/launch/'
    )
  })

  it('filters by name or description, and says when nothing matches', () => {
    render(<ServerAgents />)

    fireEvent.change(screen.getByLabelText('api:agents.search'), {
      target: { value: 'codex' },
    })
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    ).toContain('Codex CLI')

    fireEvent.change(screen.getByLabelText('api:agents.search'), {
      target: { value: 'no such tool' },
    })
    expect(
      screen.getByText('api:agents.noMatch:{"query":"no such tool"}')
    ).toBeInTheDocument()
  })

  it('opens the guide at the endpoint for the user’s own application', () => {
    render(<ServerAgents />)

    fireEvent.click(
      screen.getByRole('button', { name: /api:agents\.endpointTitle/ })
    )
    expect(useServerSetup.getState().guide).toEqual({ path: 'endpoint' })
  })
})
