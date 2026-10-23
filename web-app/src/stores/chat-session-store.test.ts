import type { Chat, UIMessage } from '@ai-sdk/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomChatTransport } from '@/lib/custom-chat-transport'
import { useChatSessions } from '@/stores/chat-session-store'

// Whether the reply counts as watched, and what the OS would be told. The
// focus and Settings gates are `notifyUnlessWatching`'s own.
const notify = vi.hoisted(() => vi.fn())
vi.mock('@/lib/notifications', () => ({ notifyUnlessWatching: notify }))

function createChat(messages: UIMessage[]): Chat<UIMessage> {
  return {
    messages,
    status: 'ready',
    stop: vi.fn(),
  } as unknown as Chat<UIMessage>
}

describe('chat session message routing', () => {
  beforeEach(() => {
    useChatSessions.getState().clearSessions()
  })

  it('updates only the addressed thread session', () => {
    const threadAMessage: UIMessage = {
      id: 'thread-a-user',
      role: 'user',
      parts: [{ type: 'text', text: 'Thread A' }],
    }
    const threadBMessage: UIMessage = {
      id: 'thread-b-user',
      role: 'user',
      parts: [{ type: 'text', text: 'Thread B' }],
    }
    const agentMessage: UIMessage = {
      id: 'agent-run-a',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Finished in thread A' }],
    }
    const transport = {} as CustomChatTransport
    const chatA = createChat([threadAMessage])
    const chatB = createChat([threadBMessage])

    useChatSessions
      .getState()
      .ensureSession('thread-a', transport, () => chatA)
    useChatSessions
      .getState()
      .ensureSession('thread-b', transport, () => chatB)

    useChatSessions.getState().upsertMessage('thread-a', agentMessage)

    expect(chatA.messages).toEqual([threadAMessage, agentMessage])
    expect(chatB.messages).toEqual([threadBMessage])
  })
})

describe('isAnyChatBusy', () => {
  beforeEach(() => {
    useChatSessions.getState().clearSessions()
  })

  it('reports streaming sessions and sessions with pending tool calls', async () => {
    const { isAnyChatBusy } = await import('@/stores/chat-session-store')
    const transport = {} as CustomChatTransport
    const store = useChatSessions.getState()

    expect(isAnyChatBusy()).toBe(false)

    store.ensureSession('thread-a', transport, () => createChat([]))
    store.ensureSession('thread-b', transport, () => createChat([]))
    expect(isAnyChatBusy()).toBe(false)

    store.updateStatus('thread-b', 'streaming')
    expect(isAnyChatBusy()).toBe(true)

    store.updateStatus('thread-b', 'ready')
    expect(isAnyChatBusy()).toBe(false)

    // A finished stream whose tool calls are still executing is busy too.
    useChatSessions.getState().sessions['thread-a'].data.tools.push({
      toolCallId: 'call-1',
      toolName: 'search',
      input: {},
    } as never)
    expect(isAnyChatBusy()).toBe(true)
  })
})

describe('reply-ready notification', () => {
  const transport = {} as CustomChatTransport
  const question: UIMessage = {
    id: 'q',
    role: 'user',
    parts: [{ type: 'text', text: 'Plan a trip' }],
  }
  const finish = (sessionId: string, status: 'ready' | 'error' = 'ready') => {
    useChatSessions.getState().updateStatus(sessionId, 'streaming')
    useChatSessions.getState().updateStatus(sessionId, status)
  }

  beforeEach(() => {
    useChatSessions.getState().clearSessions()
    notify.mockClear()
  })

  afterEach(() => window.history.replaceState(null, '', '/'))

  it('counts a reply as watched only on its own thread page', () => {
    useChatSessions
      .getState()
      .ensureSession(
        'thread-a',
        transport,
        () => createChat([question]),
        'Trip'
      )

    window.history.replaceState(null, '', '/threads/thread-a')
    finish('thread-a')
    window.history.replaceState(null, '', '/settings/general')
    finish('thread-a')

    expect(notify.mock.calls).toEqual([
      [true, 'Reply ready', '"Trip" finished generating'],
      [false, 'Reply ready', '"Trip" finished generating'],
    ])
  })

  it('announces a background first send while another thread is open', () => {
    const store = useChatSessions.getState()
    store.ensureSession('thread-a', transport, () => createChat([question]))
    // DeferredFirstSendProvider binds its thread last, which makes it the
    // active conversation although the page still shows thread A.
    store.ensureSession('thread-b', transport, () => createChat([question]))
    window.history.replaceState(null, '', '/threads/thread-a')

    finish('thread-b')

    expect(useChatSessions.getState().activeConversationId).toBe('thread-b')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toBe(false)
  })

  it('stays quiet for a turn that failed', () => {
    useChatSessions
      .getState()
      .ensureSession('thread-a', transport, () => createChat([question]))

    finish('thread-a', 'error')

    expect(useChatSessions.getState().sessions['thread-a'].status).toBe('error')
    expect(notify).not.toHaveBeenCalled()
  })
})
