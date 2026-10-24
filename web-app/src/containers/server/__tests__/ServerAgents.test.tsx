import { act, fireEvent, render, screen, within } from '@testing-library/react'
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
  useNavigate: () => vi.fn(),
}))

// Detection asks the shell; here the launch store says what it found.
vi.mock('@/lib/integration-agent-detection', () => ({
  detectIntegrationAgentsOnce: vi.fn(),
}))

import { useAppState } from '@/hooks/useAppState'
import { useServerSetup } from '@/hooks/useServerSetup'
import { useLaunchStore } from '@/stores/launch-store'
import { useOnboardingStore } from '@/stores/onboarding-store'

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
    useOnboardingStore.getState().reset()
  })

  it('leads with the featured agents, marking the ones set up', () => {
    render(<ServerAgents />)

    const names = screen
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent)
    expect(names.slice(0, 3)).toEqual([
      'Claude Code',
      'Codex CLI',
      'Atomic Agent',
    ])
    expect(card('Claude Code')).toHaveClass('is-connected')
    expect(card('Codex CLI')).not.toHaveClass('is-connected')
    // Only a set-up agent has a state on its card, and only on its action.
    expect(screen.queryByText('api:agents.installed')).not.toBeInTheDocument()
    expect(
      screen.queryByText('api:agents.notInstalled')
    ).not.toBeInTheDocument()
  })

  it('shows a set-up agent’s state once, on the way to its connection details, idle once the server stops', () => {
    render(<ServerAgents />)
    const claude = card('Claude Code')
    const dot = () =>
      within(claude).getByText('api:agents.configured').firstElementChild

    expect(within(claude).getAllByText('api:agents.configured')).toHaveLength(1)
    const action = within(claude).getByRole('link', {
      name: 'api:agents.configured',
    })
    expect(action).toHaveAttribute('href', '/api/connections')
    expect(action).toHaveAttribute('title', 'api:agents.connectionDetails')
    expect(dot()).toHaveClass('bg-emerald-500')

    act(() => useAppState.setState({ serverStatus: 'stopped' }))

    // Still set up — Atomic Chat never says "connected" — just not served.
    expect(
      within(claude).getByRole('link', { name: 'api:agents.configured' })
    ).toBeInTheDocument()
    expect(dot()).toHaveClass('bg-muted-foreground/50')
  })

  it('opens the guide at the agent it can configure', () => {
    render(<ServerAgents />)

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

  describe('on first-run setup’s "Pick your tool"', () => {
    const guideHint = () =>
      screen.queryByRole('region', { name: 'onboarding-server:guide.label' })
    const section = () =>
      screen.getByRole('region', { name: 'api:agents.title' })

    beforeEach(() => {
      const store = useOnboardingStore.getState()
      store.begin('full', 'server')
      store.handOff('agents')
    })

    it('points at the agent cards, and follows Configure into the setup guide', () => {
      render(<ServerAgents />)

      expect(guideHint()).toHaveTextContent(
        'onboarding-server:guide.pick.title'
      )
      expect(section()).toHaveClass('ob-agent-pick')

      fireEvent.click(
        screen.getByRole('button', {
          name: 'api:agents.configureAgent:{"name":"Codex CLI"}',
        })
      )

      expect(useOnboardingStore.getState().guide).toEqual({
        path: 'agents',
        hint: 1,
      })
      expect(guideHint()).toBeNull()
      expect(section()).not.toHaveClass('ob-agent-pick')
      expect(useServerSetup.getState().guide).toEqual({
        path: 'agent',
        agentId: 'codex',
      })
    })

    it('ends the hints when the tool picked is already set up', () => {
      render(<ServerAgents />)
      const details = within(card('Claude Code')).getByRole('link', {
        name: 'api:agents.configured',
      })
      // The router would navigate; jsdom cannot.
      details.addEventListener('click', (event) => event.preventDefault())

      fireEvent.click(details)

      expect(useOnboardingStore.getState().guide).toBeNull()
      expect(guideHint()).toBeNull()
    })

    it('ends the hints when the tool picked is set up by hand on All integrations', () => {
      render(<ServerAgents />)
      const setUp = within(card('VS Code')).getByRole('link', {
        name: /api:agents\.setUp/,
      })
      setUp.addEventListener('click', (event) => event.preventDefault())

      fireEvent.click(setUp)

      // No hint follows it there, so none is left waiting.
      expect(useOnboardingStore.getState().guide).toBeNull()
      expect(guideHint()).toBeNull()
      expect(section()).not.toHaveClass('ob-agent-pick')
    })

    it('goes away with Skip guide, leaving the cards as they were', () => {
      render(<ServerAgents />)

      fireEvent.click(
        screen.getByRole('button', { name: 'onboarding-server:guide.skip' })
      )

      expect(guideHint()).toBeNull()
      expect(section()).not.toHaveClass('ob-agent-pick')
      expect(useOnboardingStore.getState().panelDismissed).toBe(true)
    })
  })
})
