import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const connect = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/useAgentActions', () => ({
  useAgentActions: () => ({ connect, install: vi.fn() }),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}))

import { INTEGRATION_AGENTS } from '@/constants/integrations'
import {
  reopenAgentsAfterSwitch,
  useAgentSwitchQuestion,
} from '@/utils/agentSwitchGuard'

import AgentSwitchDialog from './AgentSwitchDialog'

const agent = (id: string) => INTEGRATION_AGENTS.find((a) => a.id === id)!

function ask(cloudProvider: string | null = null) {
  const resolve = vi.fn()
  act(() => {
    useAgentSwitchQuestion.setState({
      pending: {
        agents: [agent('claude-code'), agent('codex')],
        model: 'Gemma 4 E4B',
        cloudProvider,
        key: 'llamacpp-upstream::gemma',
        answer: Promise.resolve(false),
        resolve,
        claimed: false,
      },
    })
  })
  return resolve
}

describe('AgentSwitchDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAgentSwitchQuestion.setState({ pending: null })
  })

  it('shows nothing until a switch asks', () => {
    render(<AgentSwitchDialog />)
    expect(screen.queryByTestId('agent-switch-dialog')).toBeNull()
  })

  it('names the running agents and the model, and restarts them on confirm', () => {
    render(<AgentSwitchDialog />)
    const resolve = ask()

    expect(screen.getByText('Claude Code')).toBeTruthy()
    expect(screen.getByText('Codex CLI')).toBeTruthy()
    expect(screen.getByText(/api:agentSwitch.title .*Gemma 4 E4B/)).toBeTruthy()
    // A local model names no provider to bill.
    expect(screen.queryByText(/api:agentSwitch.cloud/)).toBeNull()

    fireEvent.click(
      screen.getByRole('button', { name: 'api:agentSwitch.confirm' })
    )
    expect(resolve).toHaveBeenCalledWith(true)
    expect(screen.queryByTestId('agent-switch-dialog')).toBeNull()
  })

  it('says where a cloud model sends the agents', () => {
    render(<AgentSwitchDialog />)
    ask('OpenAI')
    expect(screen.getByText(/api:agentSwitch.cloud .*OpenAI/)).toBeTruthy()
  })

  it('answers no on Cancel and on Escape', () => {
    render(<AgentSwitchDialog />)
    const cancelled = ask()
    fireEvent.click(
      screen.getByRole('button', { name: 'api:agentSwitch.cancel' })
    )
    expect(cancelled).toHaveBeenCalledWith(false)
    expect(useAgentSwitchQuestion.getState().pending).toBeNull()
    expect(screen.queryByTestId('agent-switch-dialog')).toBeNull()

    const escaped = ask()
    fireEvent.keyDown(screen.getByTestId('agent-switch-dialog'), {
      key: 'Escape',
    })
    expect(escaped).toHaveBeenCalledWith(false)
    expect(useAgentSwitchQuestion.getState().pending).toBeNull()
    expect(screen.queryByTestId('agent-switch-dialog')).toBeNull()
  })

  it('lends the switch the Connect action to open the agents again, while mounted', async () => {
    const opened: string[] = []
    connect.mockImplementation(async (a: { id: string }) => {
      opened.push(a.id)
    })
    const served = { modelId: 'gemma', providerName: 'llamacpp-upstream' }
    const { unmount } = render(<AgentSwitchDialog />)

    await reopenAgentsAfterSwitch([agent('codex')], served)
    expect(opened).toEqual(['codex'])

    // Unmounted, the dialog takes its Connect back: nothing opens.
    unmount()
    await reopenAgentsAfterSwitch([agent('claude-code')], served)
    expect(opened).toEqual(['codex'])
  })
})
