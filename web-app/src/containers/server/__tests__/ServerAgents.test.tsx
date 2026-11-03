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

// Install and Connect are measured by their own tests; here they are calls.
const actions = vi.hoisted(() => ({ install: vi.fn(), connect: vi.fn() }))
vi.mock('@/hooks/useAgentActions', () => ({
  useAgentActions: () => actions,
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
    vi.clearAllMocks()
    useAppState.setState({ serverStatus: 'running' })
    useLaunchStore.setState({
      installed: { codex: true },
      launched: {},
      phase: {},
    })
    useServerSetup.setState({
      configuredAgents: [{ id: 'claude-code', at: 1 }],
      endpointConfigured: false,
      guide: null,
      guideActive: false,
      guideRevision: 0,
    })
    useOnboardingStore.getState().reset()
  })

  it('leads with Claude Code, Codex and Atomic Agent, then OpenRouter usage, marking the ones set up', () => {
    render(<ServerAgents />)

    const names = screen
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent)
    expect(names.slice(0, 9)).toEqual([
      'Claude Code',
      'Codex CLI',
      'Atomic Agent',
      'Hermes Agent',
      'Kilo Code',
      'Cline CLI',
      'pi',
      'OpenClaw',
      'DeepSeek Harness',
    ])
    // Editors close the list.
    expect(names.slice(-3)).toEqual(['VS Code', 'JetBrains', 'Xcode'])
    expect(card('Claude Code')).toHaveClass('is-connected')
    expect(card('Codex CLI')).not.toHaveClass('is-connected')
    // Only a set-up agent has a state on its card, and only on its action.
    expect(screen.queryByText('api:agents.installed')).not.toBeInTheDocument()
    expect(
      screen.queryByText('api:agents.notInstalled')
    ).not.toBeInTheDocument()
  })

  it('keeps Connect available after launch, client exit, server restart and app restart', () => {
    render(<ServerAgents />)
    const connect = () =>
      within(card('Claude Code')).getByRole('button', {
        name: 'api:agents.connectAgent:{"name":"Claude Code"}',
      })
    fireEvent.click(connect())
    expect(actions.connect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'claude-code' })
    )

    act(() => useLaunchStore.setState({ launched: { 'claude-code': true } }))
    // There is no client-exit signal. A historical launch must not hide reopening.
    expect(connect()).toBeEnabled()
    expect(screen.queryByText('api:agents.connected')).not.toBeInTheDocument()
    act(() => useAppState.setState({ serverStatus: 'stopped' }))
    expect(connect()).toBeEnabled()
    act(() => useAppState.setState({ serverStatus: 'running' }))
    fireEvent.click(connect())
    expect(actions.connect).toHaveBeenCalledTimes(2)
    act(() => useLaunchStore.setState({ launched: {} }))
    expect(connect()).toBeEnabled()
  })

  it('installs a missing agent first, and shows the work while it runs', () => {
    useLaunchStore.setState({ installed: { codex: false } })
    const { rerender } = render(<ServerAgents />)
    const codex = card('Codex CLI')

    fireEvent.click(
      within(codex).getByRole('button', {
        name: 'api:agents.installAgent:{"name":"Codex CLI"}',
      })
    )
    expect(actions.install).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'codex' })
    )

    act(() => useLaunchStore.setState({ phase: { codex: 'installing' } }))
    rerender(<ServerAgents />)
    expect(
      within(codex).getByRole('button', { name: /api:agents\.installing/ })
    ).toBeDisabled()

    // Installed, the next step is Configure.
    act(() =>
      useLaunchStore.setState({ installed: { codex: true }, phase: {} })
    )
    rerender(<ServerAgents />)
    expect(
      within(codex).getByRole('button', {
        name: 'api:agents.configureAgent:{"name":"Codex CLI"}',
      })
    ).toBeInTheDocument()
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
      fireEvent.click(
        within(card('Claude Code')).getByRole('button', {
          name: 'api:agents.connectAgent:{"name":"Claude Code"}',
        })
      )

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
