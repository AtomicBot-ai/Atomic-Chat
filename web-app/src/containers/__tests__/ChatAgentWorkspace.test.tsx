import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
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
  it('shows suggestions when visible and fills without submitting', async () => {
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
