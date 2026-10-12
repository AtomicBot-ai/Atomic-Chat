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
    const bridge = (window as unknown as Record<string, unknown>)
      .__TAURI_INTERNALS__
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
      ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ =
        bridge
    }
  })

  it('shows each finished call directly with one details disclosure', async () => {
    renderLast(
      {
        id: 'flat',
        role: 'assistant',
        parts: [
          search('first', 'output-available', 'news'),
          {
            type: 'tool-os.fs.read',
            toolCallId: 'second',
            state: 'output-error',
            input: { path: 'notes.md' },
            errorText: 'File disappeared',
          } as UIMessage['parts'][number],
          { type: 'text', text: 'Here is the news.' },
        ],
      },
      'ready'
    )
    const group = screen.getByTestId('tool-activity-group')
    const calls = within(group).getAllByRole('button')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toHaveTextContent('web_search_exa')
    expect(calls[1]).toHaveTextContent('os.fs.read')
    expect(calls[1]).toHaveTextContent('toolCall.actions.read.error')
    for (const call of calls)
      expect(call).toHaveAttribute('aria-expanded', 'false')
    expect(
      screen.queryByText(
        /activity\.completedActions|activity\.workedFor|activity\.calledTool/
      )
    ).toBeNull()
    await userEvent.click(calls[1])
    expect(calls[1]).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Parameters')).toBeInTheDocument()
    expect(screen.getByText('File disappeared')).toBeInTheDocument()
    expect(calls[0]).toHaveAttribute('aria-expanded', 'false')
  })

  it('preserves a call disclosure when another call streams in', async () => {
    const first = search('first', 'output-available', 'first query')
    const item = (parts: UIMessage['parts']) => (
      <MessageItem
        message={{ id: 'stream', role: 'assistant', parts }}
        isFirstMessage={false}
        isLastMessage
        status="streaming"
        requestActive
      />
    )
    const { rerender } = render(item([first]))
    const firstRow = screen.getByRole('button', { name: /web_search_exa/ })
    await userEvent.click(firstRow)
    rerender(
      item([
        first,
        {
          type: 'tool-os.fs.read',
          toolCallId: 'second',
          state: 'input-available',
          input: { path: 'notes.md' },
        } as UIMessage['parts'][number],
      ])
    )
    expect(screen.getByRole('button', { name: /web_search_exa/ })).toBe(
      firstRow
    )
    expect(firstRow).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /os.fs.read/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(document.querySelectorAll('.animate-spin')).toHaveLength(1)
    expect(screen.queryByText('activity.working')).toBeNull()
  })

  it('keeps reasoning live through tool results and answer streaming, then stops its timer', () => {
    vi.useFakeTimers()
    const thought: UIMessage['parts'][number] = {
      type: 'reasoning',
      text: 'Plan.',
      state: 'done',
    }
    const item = (parts: UIMessage['parts'], active: boolean) => (
      <MessageItem
        message={{ id: 'lifecycle', role: 'assistant', parts }}
        isFirstMessage={false}
        isLastMessage
        status={active ? 'streaming' : 'ready'}
        requestActive={active}
      />
    )
    const { rerender } = render(item([thought], true))
    expect(screen.getByRole('status')).toHaveTextContent('activity.working')
    act(() => vi.advanceTimersByTime(2000))
    expect(screen.getByText('activity.thinkingFor 2')).toBeInTheDocument()
    const first = search('first', 'input-available', 'lookup')
    rerender(item([thought, first], true))
    const row = screen.getByRole('button', { name: /web_search_exa/ })
    expect(row).toHaveTextContent('toolCall.withContext')
    const result = search('first', 'output-available', 'lookup')
    for (const parts of [
      [thought, result],
      [thought, result, { type: 'text', text: 'Answer' } as const],
    ]) {
      rerender(item(parts, true))
      act(() => vi.advanceTimersByTime(2000))
      expect(screen.getByRole('button', { name: /web_search_exa/ })).toBe(row)
      expect(
        screen.queryByText(/activity\.thoughtFor|activity\.completedActions/)
      ).toBeNull()
    }
    rerender(item([thought, result, { type: 'text', text: 'Answer.' }], false))
    expect(screen.getByText('activity.thoughtFor 6')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(10000))
    expect(screen.getByText('activity.thoughtFor 6')).toBeInTheDocument()
    expect(
      screen.queryByText(/activity\.thinkingFor|activity\.working/)
    ).toBeNull()
    expect(document.querySelectorAll('.animate-spin')).toHaveLength(0)
  })

  it.each(['awaiting_approval', 'awaiting_folder_access'])(
    'keeps %s visibly waiting without claiming execution',
    (agentStatus) => {
      render(
        <MessageItem
          message={{
            id: 'waiting',
            role: 'assistant',
            metadata: {
              agent_run: {
                run_id: 'pending',
                status: agentStatus,
                tools: [],
                loops: [],
              },
            },
            parts: [search('pending', 'input-available', 'lookup')],
          }}
          isFirstMessage={false}
          isLastMessage
          status="ready"
          requestActive={false}
        />
      )
      const row = screen.getByRole('button', { name: /web_search_exa/ })
      expect(row).toHaveTextContent('activity.working')
      expect(document.querySelectorAll('.animate-spin')).toHaveLength(0)
      expect(
        screen.queryByText(/toolCall\.withContext|activity\.completedActions/)
      ).toBeNull()
    }
  )

  it.each(['finished', 'failed', 'cancelled'])(
    'stops stale input spinners for a %s agent turn',
    (agentStatus) => {
      const item = (status: string) => (
        <MessageItem
          message={{
            id: 'terminal',
            role: 'assistant',
            metadata: {
              agent_run: { run_id: 'terminal', status, tools: [], loops: [] },
            },
            parts: [
              { type: 'reasoning', text: 'Plan.', state: 'streaming' },
              search('stale', 'input-available', 'lookup'),
            ],
          }}
          isFirstMessage={false}
          isLastMessage
          status="streaming"
          requestActive
        />
      )
      const { rerender } = render(item('running'))
      expect(document.querySelectorAll('.animate-spin')).toHaveLength(1)
      rerender(item(agentStatus))
      expect(
        screen.getByRole('button', { name: 'web_search_exa' })
      ).toBeInTheDocument()
      expect(document.querySelectorAll('.animate-spin')).toHaveLength(0)
      expect(screen.getAllByText(/activity\.thoughtFor/)).toHaveLength(1)
      expect(
        screen.queryByText(/activity\.thinkingFor|activity\.working/)
      ).toBeNull()
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
