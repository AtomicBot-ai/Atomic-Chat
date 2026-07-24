import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  canSelectChatAgentMode,
  ChatAgentModeSwitch,
} from '@/containers/ChatAgentModeSwitch'
import { AgentTaskSuggestions } from '@/containers/AgentTaskSuggestions'
import { AgentApprovalModeSelect } from '@/containers/AgentApprovalModeSelect'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'chat:agentTasks.title': 'Ideas for you',
        'chat:agentTasks.findLatestNews.title': 'Find the latest news',
        'chat:agentTasks.findLatestNews.prompt': 'Latest news prompt',
        'chat:agentTasks.inspectFolder.title': 'Inspect this folder',
        'chat:agentTasks.inspectFolder.prompt': 'Inspect prompt',
        'chat:agentTasks.findLargeFiles.title': 'Find large files',
        'chat:agentTasks.findLargeFiles.prompt': 'Large files prompt',
      }
      return translations[key] ?? key
    },
  }),
}))

describe('Chat and Agent workspace controls', () => {
  it('allows mode selection only for the Home composer', () => {
    expect(canSelectChatAgentMode(true, undefined)).toBe(true)
    expect(canSelectChatAgentMode(false, undefined)).toBe(false)
    expect(canSelectChatAgentMode(undefined, undefined)).toBe(false)
    expect(canSelectChatAgentMode(true, 'project-1')).toBe(false)
  })

  it('exposes pressed state and changes the selected mode', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    render(
      <ChatAgentModeSwitch
        isAgentMode={false}
        onChange={onChange}
        chatLabel="Chat"
        agentLabel="Agent"
      />
    )

    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Agent' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )

    await user.click(screen.getByRole('button', { name: 'Agent' }))

    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('disables Agent mode and exposes the MLX restriction tooltip', () => {
    const onChange = vi.fn()

    render(
      <ChatAgentModeSwitch
        isAgentMode={false}
        onChange={onChange}
        chatLabel="Chat"
        agentLabel="Agent"
        agentDisabled
        agentDisabledTooltip="Switch to a llama.cpp model."
      />
    )

    const agentButton = screen.getByRole('button', { name: 'Agent' })
    expect(agentButton).toBeDisabled()
    expect(agentButton.parentElement).toHaveAttribute(
      'title',
      'Switch to a llama.cpp model.'
    )
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows the Agent attention dot when requested', () => {
    render(
      <ChatAgentModeSwitch
        isAgentMode={false}
        onChange={vi.fn()}
        chatLabel="Chat"
        agentLabel="Agent"
        showAgentAttention
      />
    )

    expect(screen.getByTestId('agent-mode-attention-dot')).toBeInTheDocument()
  })

  it('shows suggestions only in Agent mode and fills without submitting', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const { rerender } = render(
      <AgentTaskSuggestions visible={false} onSelect={onSelect} />
    )

    expect(
      screen.queryByRole('heading', { name: 'Ideas for you' })
    ).not.toBeInTheDocument()

    rerender(<AgentTaskSuggestions visible onSelect={onSelect} />)
    await user.click(
      screen.getByRole('button', { name: /Find the latest news/ })
    )

    expect(onSelect).toHaveBeenCalledWith('Latest news prompt')
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole('button')).toHaveLength(3)
  })

  it('switches between manual and skipped approvals', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()

    render(
      <AgentApprovalModeSelect
        mode="manual"
        onChange={onChange}
        manualSelectedLabel="Manually"
        manualLabel="Manually approve"
        manualDescription="Pause for sensitive actions."
        skipSelectedLabel="Skip All"
        skipLabel="Skip all approvals"
        skipDescription="Never pause."
      />
    )

    await user.click(screen.getByRole('button', { name: 'Manually' }))
    await user.click(screen.getByText('Skip all approvals'))

    expect(onChange).toHaveBeenCalledWith('skip')
  })
})
