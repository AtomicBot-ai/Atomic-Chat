import { act, renderHook, waitFor } from '@testing-library/react'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}))

/** A transport whose every request answers EDIT_OK and ends. */
vi.mock('@/lib/custom-chat-transport', () => {
  class FakeTransport implements ChatTransport<UIMessage> {
    constructor(
      _systemMessage?: string,
      private readonly threadId?: string
    ) {}
    getThreadId() {
      return this.threadId
    }
    updateSystemMessage() {}
    setOnTokenUsage() {}
    invalidateToolsCache() {}
    async refreshTools() {}
    setContinueFromContent() {}
    async updateRagToolsAvailability() {}
    async sendMessages() {
      const chunks: UIMessageChunk[] = [
        { type: 'start' },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'EDIT_OK' },
        { type: 'text-end', id: 't' },
        { type: 'finish' },
      ]
      return new ReadableStream<UIMessageChunk>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        },
      })
    }
    async reconnectToStream() {
      return null
    }
  }
  return { CustomChatTransport: FakeTransport }
})

import { useChatSessions } from '@/stores/chat-session-store'
import { useChat } from '../use-chat'

// ATO-538: a thread's Chat is created once and reused by every later mount of
// the thread page. Its callbacks were the first mount's, so after the page
// remounted (Settings, the Hub or a new chat, and back) a finished reply
// cleared the Working flag of a page that no longer existed: Enter stayed
// blocked until Stop.
describe('useChat across remounts of the same thread', () => {
  beforeEach(() => {
    useChatSessions.getState().clearSessions()
  })

  it('finishes a turn in the page that is mounted now, not the one that created the Chat', async () => {
    const firstFinish = vi.fn()
    const first = renderHook(() =>
      useChat({ sessionId: 'thread-a', onFinish: firstFinish })
    )
    const created = useChatSessions.getState().sessions['thread-a']?.chat
    first.unmount()

    const secondFinish = vi.fn()
    const secondToolCall = vi.fn()
    const second = renderHook(() =>
      useChat({
        sessionId: 'thread-a',
        onFinish: secondFinish,
        onToolCall: secondToolCall,
      })
    )
    expect(useChatSessions.getState().sessions['thread-a']?.chat).toBe(created)

    await act(async () => {
      await second.result.current.sendMessage({
        text: 'Reply with exactly EDIT_OK.',
      })
    })

    await waitFor(() => expect(secondFinish).toHaveBeenCalledTimes(1))
    expect(secondFinish.mock.calls[0]?.[0]).toMatchObject({
      isAbort: false,
      message: {
        role: 'assistant',
        parts: [{ type: 'text', text: 'EDIT_OK' }],
      },
    })
    expect(firstFinish).not.toHaveBeenCalled()
    expect(second.result.current.status).toBe('ready')
  })

  it('asks the latest render whether to send a tool follow-up', async () => {
    // The first mount's answer would send one more request (once, so a
    // regression fails here instead of looping).
    let staleAsked = 0
    renderHook(() =>
      useChat({
        sessionId: 'thread-b',
        sendAutomaticallyWhen: () => ++staleAsked === 1,
      })
    ).unmount()
    const latest = vi.fn(() => false)
    const { result } = renderHook(() =>
      useChat({ sessionId: 'thread-b', sendAutomaticallyWhen: latest })
    )

    await act(async () => {
      await result.current.sendMessage({ text: 'hi' })
    })

    await waitFor(() => expect(latest).toHaveBeenCalled())
    expect(staleAsked).toBe(0)
    expect(
      result.current.messages.filter((m) => m.role === 'assistant')
    ).toHaveLength(1)
  })
})

describe('the per-thread request flag', () => {
  beforeEach(() => {
    useChatSessions.getState().clearSessions()
  })

  it('belongs to one thread and goes with its session', () => {
    const sessions = useChatSessions.getState()
    sessions.setRequestActive('thread-a', true)
    expect(useChatSessions.getState().requestActive).toEqual({
      'thread-a': true,
    })

    // Another thread on the same page is not blocked by it.
    expect(useChatSessions.getState().requestActive['thread-b']).toBeUndefined()

    renderHook(() => useChat({ sessionId: 'thread-a' })).unmount()
    useChatSessions.getState().removeSession('thread-a')
    expect(useChatSessions.getState().requestActive).toEqual({})
  })
})
