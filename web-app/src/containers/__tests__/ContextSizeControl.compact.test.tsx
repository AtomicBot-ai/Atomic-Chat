import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ThreadMessage } from '@janhq/core'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AgentContextSizeControl,
  ContextSizeControl,
} from '@/containers/ContextSizeControl'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import { useChatSessions } from '@/stores/chat-session-store'
import { seedServiceHub } from '@/test/service-hub'

/**
 * "Compact history" in the context popover: it summarizes the current
 * thread's older messages on request, and is offered only while there is
 * older history and nothing else is running.
 */

const { toast, tokens } = vi.hoisted(() => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
  tokens: { windowTokens: undefined as number | undefined },
}))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/hooks/useTokensCount', () => ({
  useTokensCount: () => ({
    tokenCount: 4096,
    maxTokens: 16384,
    windowTokens: tokens.windowTokens,
    isNearLimit: false,
    loading: false,
    calculateTokens: vi.fn(),
  }),
}))

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  global.ResizeObserver = MockResizeObserver
})

const THREAD = 'thread-1'

const threadMessage = (id: string, role: 'user' | 'assistant') =>
  ({
    id,
    role,
    thread_id: THREAD,
    content: [{ type: 'text', text: { value: id, annotations: [] } }],
  }) as unknown as ThreadMessage

const history = [
  threadMessage('u1', 'user'),
  threadMessage('a1', 'assistant'),
  threadMessage('u2', 'user'),
]

function selectProvider(provider: string, withContextSetting = true) {
  const model = {
    id: 'test-model',
    settings: withContextSetting
      ? {
          ctx_len: {
            key: 'ctx_len',
            title: 'Context Size',
            description: '',
            controller_type: 'input',
            controller_props: { value: 16384, min: 0, max: 65536, step: 1024 },
          },
        }
      : {},
  } as Model
  useModelProvider.setState({
    providers: [{ provider, models: [model], settings: [] } as ModelProvider],
    selectedProvider: provider,
    selectedModel: model,
  })
}

function seedSession(compactHistory = vi.fn()) {
  useChatSessions.setState({
    sessions: {
      [THREAD]: {
        transport: { compactHistory, getHistoryStart: () => undefined },
        chat: { messages: [{ id: 'u1' }, { id: 'a1' }, { id: 'u2' }] },
      },
    } as never,
    requestActive: {},
  })
  return compactHistory
}

const openPopover = () =>
  fireEvent.click(screen.getByRole('button', { name: /Context usage/ }))

describe('ContextSizeControl — Compact history', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tokens.windowTokens = undefined
    seedServiceHub({
      models: { getActiveModels: vi.fn().mockResolvedValue([]) } as never,
    })
    useThreads.setState({
      currentThreadId: THREAD,
      threads: {
        [THREAD]: { id: THREAD, title: 'Trip', updated: 0, metadata: {} },
      } as never,
    })
    useAppState.setState({ contextActivity: { phase: null } })
    selectProvider('llamacpp-upstream')
  })

  it('compacts the thread on request', async () => {
    const compactHistory = seedSession(
      vi.fn().mockResolvedValue({
        ok: true,
        compaction: { summarizedCount: 2 },
      })
    )
    render(<ContextSizeControl messages={history} />)
    openPopover()

    const button = screen.getByRole('button', {
      name: 'chat:contextCompaction.compact',
    })
    expect(button).toBeEnabled()
    await act(async () => {
      fireEvent.click(button)
    })

    expect(compactHistory).toHaveBeenCalledWith({
      messages: [{ id: 'u1' }, { id: 'a1' }, { id: 'u2' }],
    })
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('chat:contextCompaction.done')
    )
    // The composer and the status are released again.
    expect(useChatSessions.getState().requestActive[THREAD]).toBe(false)
    expect(useAppState.getState().contextActivity.phase).toBeNull()
  })

  it('offers task compaction inside the gauge when pi has enough history', () => {
    const onCompact = vi.fn()
    const props = { capacity: 100_000, tokens: 5_000, busy: false, onCompact }
    const { rerender } = render(<AgentContextSizeControl {...props} />)
    const button = { name: 'chat:contextCompaction.compact' }
    expect(screen.queryByRole('button', button)).toBeNull()
    openPopover()
    expect(screen.getByRole('button', button)).toBeDisabled()
    rerender(<AgentContextSizeControl {...props} tokens={25_000} busy />)
    expect(screen.getByRole('button', button)).toBeDisabled()
    rerender(<AgentContextSizeControl {...props} tokens={25_000} />)
    fireEvent.click(screen.getByRole('button', button))
    expect(onCompact).toHaveBeenCalledOnce()
  })

  it('says so when the summary could not be made', async () => {
    seedSession(vi.fn().mockResolvedValue({ ok: false, reason: 'failed' }))
    render(<ContextSizeControl messages={history} />)
    openPopover()
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'chat:contextCompaction.compact' })
      )
    })
    expect(toast.error).toHaveBeenCalledWith('chat:contextCompaction.failed')
    // A failed summary still releases the composer and clears the status.
    expect(useChatSessions.getState().requestActive[THREAD]).toBe(false)
    expect(useAppState.getState().contextActivity.phase).toBeNull()
  })

  it('is off while a request runs, or with no older history', () => {
    seedSession()
    useChatSessions.setState({ requestActive: { [THREAD]: true } })
    const { unmount } = render(<ContextSizeControl messages={history} />)
    openPopover()
    expect(
      screen.getByRole('button', { name: 'chat:contextCompaction.compact' })
    ).toBeDisabled()
    unmount()

    useChatSessions.setState({ requestActive: {} })
    render(<ContextSizeControl messages={history.slice(0, 2)} />)
    openPopover()
    expect(
      screen.getByRole('button', { name: 'chat:contextCompaction.compact' })
    ).toBeDisabled()
  })

  it('is not offered for a cloud model', () => {
    seedSession()
    selectProvider('openai')
    render(<ContextSizeControl messages={history} />)
    expect(screen.queryByRole('button', { name: /Context usage/ })).toBeNull()
    expect(screen.queryByTestId('context-compact-row')).toBeNull()
  })

  it('shows a measured window for an engine without a context setting', () => {
    seedSession()
    selectProvider('foundry-local', false)
    tokens.windowTokens = 8192
    render(<ContextSizeControl messages={history} />)

    // 4096 of the 8192 tokens the core measured the session at.
    openPopover()
    expect(screen.getAllByText('50.0%').length).toBeGreaterThan(0)
    expect(screen.getByTestId('context-compact-row')).toBeInTheDocument()
  })
})
