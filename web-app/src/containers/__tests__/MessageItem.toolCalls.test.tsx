import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { MessageItem } from '../MessageItem'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: (s: unknown) => unknown) =>
    selector({ selectedModel: { id: 'test-model' } }),
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (selector: (s: unknown) => unknown) =>
    selector({ disableReasoning: false }),
}))

const search = (
  id: string,
  state: string,
  query: string
): UIMessage['parts'][number] =>
  ({
    type: 'tool-web_search_exa',
    toolCallId: id,
    state,
    input: { query },
    ...(state === 'output-available' ? { output: [] } : {}),
  }) as UIMessage['parts'][number]

const renderLast = (message: UIMessage, status: 'ready' | 'streaming') =>
  render(
    <MessageItem
      message={message}
      isFirstMessage={false}
      isLastMessage
      status={status}
    />
  )

beforeEach(() => {
  seedServiceHub()
})

// ATO-529: every call used to hide behind "Worked for" → "Called N tools".
describe('MessageItem tool calls', () => {
  it('groups a finished turn and reveals individually expandable calls', async () => {
    renderLast(
      {
        id: 'a1',
        role: 'assistant',
        metadata: { activityDurationMs: 4_000 },
        parts: [
          search('t1', 'output-available', 'nemotron news'),
          {
            type: 'tool-os.fs.read',
            toolCallId: 't2',
            state: 'output-available',
            input: { path: 'notes.md' },
            output: { content: 'hi' },
          } as UIMessage['parts'][number],
          { type: 'text', text: 'Here is the news.' },
        ],
      },
      'ready'
    )

    const group = screen.getByTestId('tool-activity-group')
    const activity = within(group).getByRole('button', { expanded: false })
    expect(activity).toHaveTextContent('activity.completedActions')
    expect(activity.querySelector('svg')).toHaveClass('size-[18px]')
    expect(within(group).getAllByRole('button')).toHaveLength(1)
    await userEvent.click(activity)
    expect(
      within(group).getAllByRole('button', { expanded: false })
    ).toHaveLength(2)
    expect(screen.queryByText('web_search_exa')).not.toBeInTheDocument()
    expect(screen.queryByText('os.fs.read')).not.toBeInTheDocument()
    expect(screen.queryByText(/activity\.workedFor/)).not.toBeInTheDocument()
    expect(screen.queryByText(/activity\.calledTool/)).not.toBeInTheDocument()
  })

  it('keeps a running call compact until the user opens its timeline', async () => {
    renderLast(
      {
        id: 'a2',
        role: 'assistant',
        parts: [search('t1', 'input-available', 'nemotron ultra')],
      },
      'streaming'
    )

    expect(screen.getByTestId('tool-activity-group')).toHaveAttribute(
      'data-state',
      'closed'
    )
    expect(
      within(screen.getByTestId('tool-activity-group')).getAllByRole('button')
    ).toHaveLength(1)
    expect(document.querySelectorAll('.animate-spin')).toHaveLength(0)
    expect(screen.queryByText('activity.working')).not.toBeInTheDocument()
    expect(
      within(screen.getByTestId('tool-activity-group')).getByRole('button')
        .textContent
    ).toContain('toolCall')

    await userEvent.click(
      within(screen.getByTestId('tool-activity-group')).getByRole('button')
    )
    expect(screen.getByTestId('tool-activity-group')).toHaveAttribute(
      'data-state',
      'open'
    )
    expect(document.querySelectorAll('.animate-spin')).toHaveLength(1)
  })

  it('shows Working between calls, and drops it once the answer streams', () => {
    const between: UIMessage = {
      id: 'a3',
      role: 'assistant',
      parts: [search('t1', 'output-available', 'nemotron')],
    }
    const { rerender } = renderLast(between, 'streaming')
    expect(screen.getByText('activity.working')).toBeInTheDocument()

    rerender(
      <MessageItem
        message={{
          ...between,
          parts: [...between.parts, { type: 'text', text: 'Nemotron is' }],
        }}
        isFirstMessage={false}
        isLastMessage
        status="streaming"
      />
    )
    expect(screen.queryByText('activity.working')).not.toBeInTheDocument()
    expect(screen.queryByText('web_search_exa')).not.toBeInTheDocument()
  })

  it('shows why an agent run failed without a click', () => {
    renderLast(
      {
        id: 'a4',
        role: 'assistant',
        metadata: {
          agent_run: {
            run_id: 'run-1',
            status: 'failed',
            tools: [],
            loops: [],
            error: { category: 'llm', message: 'model server returned 400' },
          },
        },
        parts: [],
      },
      'ready'
    )

    expect(screen.getByTestId('agent-error-card')).toHaveTextContent(
      'chat:agentError.genericTitle'
    )
    expect(screen.queryByText('model server returned 400')).not.toBeInTheDocument()
  })
})
