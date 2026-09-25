import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { MessageItem } from '../MessageItem'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { count?: number }) =>
      values?.count === undefined ? key : `${key} ${values.count}`,
  }),
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
afterEach(() => vi.useRealTimers())

// ATO-529: every call used to hide behind "Worked for" → "Called N tools".
describe('MessageItem tool calls', () => {
  it('renders a malformed bold home-relative Agent file path as an opener link', async () => {
    const path = '/Users/atomic/Desktop/uncensored-ai-models.pdf'
    const openPath = vi.fn().mockResolvedValue(undefined)
    seedServiceHub({
      opener: {
        open: vi.fn().mockResolvedValue(undefined),
        openPath,
        revealItemInDir: vi.fn().mockResolvedValue(undefined),
      },
    })

    renderLast(
      {
        id: 'agent-file-link',
        role: 'assistant',
        metadata: {
          agent_run: {
            run_id: 'run-file-link',
            status: 'finished',
            tools: [],
            loops: [],
          },
        },
        parts: [
          {
            type: 'tool-os.fs.write',
            toolCallId: 'write-file',
            state: 'output-available',
            input: { path, content: 'pdf' },
            output: { ok: true },
          } as UIMessage['parts'][number],
          {
            type: 'text',
            text: '👉 ** ~/Desktop/uncensored-ai-models.pdf**',
          },
        ],
      },
      'ready'
    )

    const link = screen.getByRole('link', {
      name: 'uncensored-ai-models.pdf',
    })
    expect(link).toHaveAttribute(
      'href',
      `https://atomic.local/open-file?path=${encodeURIComponent(path)}`
    )
    expect(link.closest('[data-streamdown="strong"]')).toBeInTheDocument()

    await userEvent.click(link)
    expect(openPath).toHaveBeenCalledWith(path)
  })

  it('intercepts a restored local folder link without Agent metadata', async () => {
    const path = '/Users/atomic/Desktop/выборы 2026'
    const href = `https://atomic.local/open-file?path=${encodeURIComponent(path)}`
    const openPath = vi.fn().mockResolvedValue(undefined)
    const open = vi.fn().mockResolvedValue(undefined)
    seedServiceHub({
      opener: {
        open,
        openPath,
        revealItemInDir: vi.fn().mockResolvedValue(undefined),
      },
    })

    renderLast(
      {
        id: 'restored-local-folder-link',
        role: 'assistant',
        parts: [{ type: 'text', text: `[${href}](${href})` }],
      },
      'ready'
    )

    const link = screen.getByRole('link', { name: 'выборы 2026' })
    expect(link).toHaveAttribute('href', href)
    expect(link).not.toHaveAttribute('target')

    await userEvent.click(link)
    expect(openPath).toHaveBeenCalledWith(path)
    expect(open).not.toHaveBeenCalled()
  })

  it('keeps an ordinary https link external', () => {
    renderLast(
      {
        id: 'ordinary-web-link',
        role: 'assistant',
        parts: [
          { type: 'text', text: '[OpenAI](https://www.openai.com/docs)' },
        ],
      },
      'ready'
    )

    expect(screen.getByRole('link', { name: 'OpenAI' })).toHaveAttribute(
      'href',
      'https://www.openai.com/docs'
    )
    expect(screen.getByRole('link', { name: 'OpenAI' })).toHaveAttribute(
      'target',
      '_blank'
    )
  })

  it('blocks the pseudo URL without invoking a native path opener on web', async () => {
    const path = '/Users/atomic/Desktop/report.pdf'
    const href = `https://atomic.local/open-file?path=${encodeURIComponent(path)}`
    const openPath = vi.fn().mockResolvedValue(undefined)
    const open = vi.fn().mockResolvedValue(undefined)
    seedServiceHub({
      opener: {
        open,
        openPath,
        revealItemInDir: vi.fn().mockResolvedValue(undefined),
      },
    })
    const bridge = (
      window as unknown as Record<string, unknown>
    ).__TAURI_INTERNALS__
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

    try {
      renderLast(
        {
          id: 'web-local-file-link',
          role: 'assistant',
          parts: [{ type: 'text', text: `[report.pdf](${href})` }],
        },
        'ready'
      )

      // Still the local-file link, not an ordinary external one.
      const link = screen.getByRole('link', { name: 'report.pdf' })
      expect(link).toHaveAttribute('href', href)
      expect(link).not.toHaveAttribute('target')

      let followed: boolean | undefined
      window.addEventListener(
        'click',
        (event) => {
          followed = !event.defaultPrevented
        },
        { once: true }
      )
      await userEvent.click(link)
      expect(openPath).not.toHaveBeenCalled()
      expect(open).not.toHaveBeenCalled()
      // The browser is not sent to the pseudo URL either.
      expect(followed).toBe(false)
    } finally {
      ;(
        window as unknown as Record<string, unknown>
      ).__TAURI_INTERNALS__ = bridge
    }
  })

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
    const chevron = activity.querySelector('.lucide-chevron-right')!
    expect(activity).toHaveTextContent('activity.completedActions')
    expect(activity.querySelector('svg')).toHaveClass('size-[18px]')
    expect(chevron.parentElement).toHaveClass(
      'inline-flex',
      'min-w-0',
      'items-center'
    )
    expect(chevron.previousElementSibling).toHaveClass('truncate')
    expect(chevron.previousElementSibling).not.toHaveClass('flex-1')
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

  it('tracks the newest live action, then settles stale calls into a completed summary', () => {
    const message: UIMessage = {
      id: 'a-live',
      role: 'assistant',
      parts: [
        search('t1', 'input-available', 'nemotron ultra'),
        {
          type: 'tool-os.fs.read',
          toolCallId: 't2',
          state: 'input-available',
          input: { path: 'notes.md' },
        } as UIMessage['parts'][number],
      ],
    }
    const { rerender } = renderLast(message, 'streaming')
    const liveButton = within(
      screen.getByTestId('tool-activity-group')
    ).getByRole('button')
    expect(liveButton).toHaveTextContent('toolCall.actions.read.running')
    expect(liveButton.querySelector('.lucide-file-text')).toBeInTheDocument()

    rerender(
      <MessageItem
        message={message}
        isFirstMessage={false}
        isLastMessage
        status="ready"
      />
    )
    const doneButton = within(
      screen.getByTestId('tool-activity-group')
    ).getByRole('button')
    expect(doneButton).toHaveTextContent('activity.completedActions')
    expect(doneButton.querySelector('.lucide-list-checks')).toBeInTheDocument()
  })

  it('never reports completion between sequential calls, reasoning, or answer streaming', () => {
    vi.useFakeTimers()
    const renderTurn = (
      parts: UIMessage['parts'],
      requestActive: boolean,
      metadata?: UIMessage['metadata']
    ) => (
      <MessageItem
        message={{
          id: 'a-monotonic-activity',
          role: 'assistant',
          parts,
          metadata,
        }}
        isFirstMessage={false}
        isLastMessage
        status={requestActive ? 'streaming' : 'ready'}
        requestActive={requestActive}
      />
    )
    const activity = () =>
      within(screen.getByTestId('tool-activity-group')).getByRole('button')
    let elapsed = 0
    let reasoningHeader: HTMLElement | undefined
    let activityHeader: HTMLElement | undefined
    const expectLive = (label: string, icon = 'loader-circle') => {
      act(() => vi.advanceTimersByTime(2_000))
      elapsed += 2
      expect(activity()).toHaveTextContent(label)
      expect(activity().querySelector(`.lucide-${icon}`)).toBeInTheDocument()
      expect(activity()).not.toHaveTextContent('activity.completedActions')
      const thinking = screen.getByRole('button', {
        name: `activity.thinkingFor ${elapsed}`,
      })
      reasoningHeader ??= thinking
      activityHeader ??= activity()
      expect(thinking).toBe(reasoningHeader)
      expect(activity()).toBe(activityHeader)
      expect(thinking.querySelector('.text-transparent')).toBeNull()
      expect(screen.queryByText(/activity\.thoughtFor/)).toBeNull()
    }

    const initialReasoning: UIMessage['parts'] = [
      {
        type: 'reasoning',
        text: 'Plan the first lookup.',
        state: 'streaming',
      },
    ]
    const { rerender } = render(renderTurn(initialReasoning, true))
    expect(screen.getByText('activity.thinkingFor 1')).toBeInTheDocument()
    expectLive('activity.working')
    expect(screen.queryByText(/activity\.thoughtFor/)).not.toBeInTheDocument()

    const firstRunning: UIMessage['parts'] = [
      { ...initialReasoning[0], state: 'done' },
      search('t1', 'input-available', 'first lookup'),
    ]
    rerender(renderTurn(firstRunning, true))
    expectLive('toolCall.withContext', 'globe')
    expect(screen.getByText(/activity\.thinkingFor/)).toBeInTheDocument()

    const firstResult: UIMessage['parts'] = [
      firstRunning[0],
      search('t1', 'output-available', 'first lookup'),
    ]
    rerender(renderTurn(firstResult, true))
    expectLive('toolCall.withContext', 'globe')

    const reasoningGap: UIMessage['parts'] = [
      ...firstResult,
      {
        type: 'reasoning',
        text: 'Interpret the first result.',
        state: 'streaming',
      },
    ]
    rerender(renderTurn(reasoningGap, true))
    expectLive('toolCall.withContext', 'globe')

    const secondRunning: UIMessage['parts'] = [
      firstResult[0],
      firstResult[1],
      { ...reasoningGap[2], state: 'done' },
      {
        type: 'tool-os.fs.read',
        toolCallId: 't2',
        state: 'input-available',
        input: { path: 'notes.md' },
      } as UIMessage['parts'][number],
    ]
    rerender(renderTurn(secondRunning, true))
    expectLive('toolCall.actions.read.running', 'file-text')

    const awaitingApproval: UIMessage['parts'] = [
      secondRunning[0],
      secondRunning[1],
      secondRunning[2],
      {
        ...secondRunning[3],
        state: 'output-available',
        output: 'Notes',
      } as UIMessage['parts'][number],
    ]
    rerender(
      renderTurn(awaitingApproval, false, {
        agent_run: {
          run_id: 'run-awaiting',
          status: 'awaiting_approval',
          tools: [],
          loops: [],
        },
      })
    )
    expectLive('activity.working')
    expect(screen.getByText(/activity\.thinkingFor/)).toBeInTheDocument()

    const answerStreaming: UIMessage['parts'] = [
      ...awaitingApproval,
      { type: 'text', text: 'Final answer is streaming' },
    ]
    rerender(renderTurn(answerStreaming, true))
    expectLive('toolCall.actions.read.success', 'file-text')

    rerender(
      renderTurn(
        [...awaitingApproval, { type: 'text', text: 'Final answer.' }],
        false
      )
    )
    expect(activity()).toBe(activityHeader)
    expect(activity().querySelector('.lucide-list-checks')).toBeInTheDocument()
    expect(screen.getAllByText('activity.completedActions 2')).toHaveLength(1)
    expect(screen.getAllByText(`activity.thoughtFor ${elapsed}`)).toHaveLength(
      1
    )
    expect(screen.queryByText(/activity\.thinkingFor/)).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(10_000))
    expect(screen.getAllByText(`activity.thoughtFor ${elapsed}`)).toHaveLength(
      1
    )
    expect(screen.getAllByText('activity.completedActions 2')).toHaveLength(1)
  })

  it('keeps the most recent concrete step through answer streaming and completes with the turn', () => {
    const between: UIMessage = {
      id: 'a3',
      role: 'assistant',
      parts: [search('t1', 'output-available', 'nemotron')],
    }
    const { rerender } = renderLast(between, 'streaming')
    expect(screen.getByText('toolCall.withContext')).toBeInTheDocument()
    expect(screen.queryByText('activity.working')).not.toBeInTheDocument()

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
    expect(screen.getByText('toolCall.withContext')).toBeInTheDocument()
    expect(screen.queryByText('activity.working')).not.toBeInTheDocument()
    expect(
      screen.queryByText('activity.completedActions')
    ).not.toBeInTheDocument()
    expect(screen.queryByText('web_search_exa')).not.toBeInTheDocument()

    rerender(
      <MessageItem
        message={{
          ...between,
          parts: [
            ...between.parts,
            { type: 'text', text: 'Nemotron is done.' },
          ],
        }}
        isFirstMessage={false}
        isLastMessage
        status="ready"
      />
    )
    expect(screen.getByText(/activity\.completedActions/)).toBeInTheDocument()
  })

  it('updates the live headline across streamed results and errors instead of reverting to Working', () => {
    const item = (parts: UIMessage['parts']) => (
      <MessageItem
        message={{ id: 'streamed-tools', role: 'assistant', parts }}
        isFirstMessage={false}
        isLastMessage
        status="streaming"
        requestActive
      />
    )
    const searchRunning = search(
      'search-1',
      'input-available',
      'latest news'
    )
    const searchResult = search('search-1', 'output-available', 'latest news')
    const readRunning = {
      type: 'tool-os.fs.read',
      toolCallId: 'read-1',
      state: 'input-available',
      input: { path: 'notes.md' },
    } as UIMessage['parts'][number]
    const readError = {
      ...readRunning,
      state: 'output-error',
      errorText: 'File disappeared',
    } as UIMessage['parts'][number]
    const activity = () =>
      within(screen.getByTestId('tool-activity-group')).getByRole('button')

    const { rerender } = render(item([]))
    expect(activity()).toHaveTextContent('activity.working')

    rerender(item([searchRunning]))
    expect(activity()).toHaveTextContent('toolCall.withContext')
    expect(activity().querySelector('.lucide-globe')).toBeInTheDocument()

    rerender(item([searchResult]))
    expect(activity()).toHaveTextContent('toolCall.withContext')
    expect(activity().querySelector('.lucide-globe')).toBeInTheDocument()

    // A stale input state from an older call must not win over the newer step.
    rerender(item([searchRunning, readRunning]))
    expect(activity()).toHaveTextContent('toolCall.actions.read.running')
    expect(activity().querySelector('.lucide-file-text')).toBeInTheDocument()

    rerender(item([searchRunning, readError]))
    expect(activity()).toHaveTextContent('toolCall.actions.read.error')
    expect(activity().querySelector('.lucide-file-text')).toHaveClass(
      'text-destructive'
    )
    expect(screen.queryByText('activity.working')).not.toBeInTheDocument()
  })

  it.each(['awaiting_approval', 'awaiting_folder_access'])(
    'keeps %s live without claiming the pending tool is running',
    (agentStatus) => {
      render(
        <MessageItem
          message={{
            id: 'pending-tool',
            role: 'assistant',
            metadata: {
              agent_run: {
                run_id: 'pending',
                status: agentStatus,
                tools: [],
                loops: [],
              },
            },
            parts: [
              {
                type: 'reasoning',
                text: 'Waiting for permission.',
                state: 'done',
              },
              search('pending', 'input-available', 'pending lookup'),
            ],
          }}
          isFirstMessage={false}
          isLastMessage
          status="ready"
          requestActive={false}
        />
      )

      const header = within(
        screen.getByTestId('tool-activity-group')
      ).getByRole('button')
      expect(header).toHaveTextContent('activity.working')
      expect(header.querySelector('.lucide-loader-circle')).toBeInTheDocument()
      expect(screen.getByText(/activity\.thinkingFor/)).toBeInTheDocument()
      expect(
        screen.queryByText(/activity\.completedActions|activity\.thoughtFor/)
      ).toBeNull()
    }
  )

  it.each(['finished', 'failed', 'cancelled'])(
    'settles a %s agent turn even while request flags and tool inputs are stale',
    (agentStatus) => {
      const message: UIMessage = {
        id: 'terminal-agent',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'Plan.', state: 'streaming' },
          search('stale', 'input-available', 'lookup'),
        ],
      }
      const item = (runStatus: string) => (
        <MessageItem
          message={{
            ...message,
            metadata: {
              agent_run: {
                run_id: 'terminal',
                status: runStatus,
                tools: [],
                loops: [],
              },
            },
          }}
          isFirstMessage={false}
          isLastMessage
          status="streaming"
          requestActive
        />
      )
      const { rerender } = render(item('running'))
      expect(screen.getByText(/activity\.thinkingFor/)).toBeInTheDocument()
      rerender(item(agentStatus))

      expect(screen.getAllByText('activity.completedActions 1')).toHaveLength(1)
      expect(screen.getAllByText(/activity\.thoughtFor/)).toHaveLength(1)
      expect(
        screen.queryByText(/activity\.thinkingFor|activity\.working/)
      ).toBeNull()
      rerender(item(agentStatus))
      expect(screen.getAllByText('activity.completedActions 1')).toHaveLength(1)
    }
  )

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
    expect(
      screen.queryByText('model server returned 400')
    ).not.toBeInTheDocument()
    expect(screen.queryByText('activity.working')).not.toBeInTheDocument()
  })
})
