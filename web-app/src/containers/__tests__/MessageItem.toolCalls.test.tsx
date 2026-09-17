import { render, screen } from '@testing-library/react'
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
  it('lists every call of a finished turn without a disclosure to open', () => {
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

    expect(screen.getByText('web_search_exa')).toBeVisible()
    expect(screen.getByText('nemotron news')).toBeVisible()
    expect(screen.getByText('os.fs.read')).toBeVisible()
    expect(screen.getByText('notes.md')).toBeVisible()
    expect(screen.queryByText(/activity\.workedFor/)).not.toBeInTheDocument()
    expect(screen.queryByText(/activity\.calledTool/)).not.toBeInTheDocument()
  })

  it('lets a running call be the only live indicator', () => {
    renderLast(
      {
        id: 'a2',
        role: 'assistant',
        parts: [search('t1', 'input-available', 'nemotron ultra')],
      },
      'streaming'
    )

    expect(screen.getByText('nemotron ultra')).toBeInTheDocument()
    expect(screen.queryByText('activity.working')).not.toBeInTheDocument()
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
    expect(screen.getByText('web_search_exa')).toBeInTheDocument()
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

    expect(
      screen.getByText('llm: model server returned 400')
    ).toBeInTheDocument()
  })
})
