import type { Chat, UIMessage } from '@ai-sdk/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomChatTransport } from '@/lib/custom-chat-transport'
import { useChatSessions } from '@/stores/chat-session-store'

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
