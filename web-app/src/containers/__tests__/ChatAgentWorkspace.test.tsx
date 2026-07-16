import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  canSelectChatAgentMode,
  ChatAgentModeSwitch,
} from '@/containers/ChatAgentModeSwitch'
import { AgentTaskSuggestions } from '@/containers/AgentTaskSuggestions'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'chat:agentTasks.title': 'Ideas for you',
        'chat:agentTasks.organizeDesktop.title': 'Organize desktop files',
        'chat:agentTasks.organizeDesktop.prompt': 'Organize prompt',
        'chat:agentTasks.reviewProject.title': 'Review project changes',
        'chat:agentTasks.reviewProject.prompt': 'Review prompt',
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
      screen.getByRole('button', { name: /Organize desktop files/ })
    )

    expect(onSelect).toHaveBeenCalledWith('Organize prompt')
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole('button')).toHaveLength(3)
  })
})
