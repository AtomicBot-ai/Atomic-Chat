import { act, renderHook, waitFor } from '@testing-library/react'
import { Chat, type UIMessage } from '@ai-sdk/react'
import type { ThreadMessage } from '@janhq/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { seedServiceHub } from '@/test/service-hub'
import type { EventsService } from '@/services/events/types'
import type { MessagesService } from '@/services/messages/types'
import { useChatSessions } from '@/stores/chat-session-store'
import type { CustomChatTransport } from '@/lib/custom-chat-transport'
import { useMessages } from '@/hooks/useMessages'
import {
  THREAD_MESSAGES_CHANGED_EVENT,
  resetThreadMessageSyncForTests,
  type ThreadMessagesChanged,
} from '@/lib/thread-message-sync'
import {
  THREAD_SYNC_RETRY_MS,
  reconcileThreadMessages,
  useThreadMessagesSync,
} from '@/hooks/useThreadMessagesSync'

const THREAD = 'thread-1'

const message = (
  id: string,
  role: 'user' | 'assistant',
  text: string,
  createdAt: number
): ThreadMessage =>
  ({
    id,
    object: 'thread.message',
    thread_id: THREAD,
    role,
    content: [{ type: 'text', text: { value: text, annotations: [] } }],
    status: 'ready',
    created_at: createdAt,
    completed_at: createdAt,
    metadata: {},
  }) as ThreadMessage

const firstQuestion = message('u1', 'user', 'first question', 1)
const firstAnswer = message('a1', 'assistant', 'first answer', 2)
// Written by the other window while this one still held the first exchange.
const otherWindowQuestion = message('u2', 'user', 'asked elsewhere', 3)
const otherWindowAnswer = message('a2', 'assistant', 'answered elsewhere', 4)

// One Tauri event bus shared by "both windows": an emit reaches every
// listener, the emitting window's own included, as in Tauri.
const bus = new Set<(event: { payload: ThreadMessagesChanged }) => void>()
const events = {
  emit: vi.fn(async (name: string, payload?: unknown) => {
    if (name !== THREAD_MESSAGES_CHANGED_EVENT) return
    bus.forEach((listener) =>
      listener({ payload: payload as ThreadMessagesChanged })
    )
  }),
  listen: vi.fn(
    async (
      name: string,
      handler: (event: { payload: ThreadMessagesChanged }) => void
    ) => {
      if (name === THREAD_MESSAGES_CHANGED_EVENT) bus.add(handler)
      return () => {
        bus.delete(handler)
      }
    }
  ),
}

let onDisk: ThreadMessage[] = []
const fetchMessages = vi.fn(async () => structuredClone(onDisk))

function writeFromOtherWindow(
  messages: ThreadMessage[],
  deletedIds?: string[]
) {
  onDisk = messages
  bus.forEach((listener) =>
    listener({
      payload: { threadId: THREAD, origin: 'other-window', deletedIds },
    })
  )
}

const heldIds = () =>
  useMessages
    .getState()
    .getMessages(THREAD)
    .map((m) => m.id)

/** This window's Chat for the thread, holding the given exchange. */
function openSession(messages: ThreadMessage[]) {
  useMessages.getState().setMessages(THREAD, structuredClone(messages))
  const uiMessages: UIMessage[] = messages.map((m) => ({
    id: m.id,
    role: m.role as UIMessage['role'],
    parts: [{ type: 'text', text: m.content[0].text?.value ?? '' }],
  }))
  return useChatSessions
    .getState()
    .ensureSession(
      THREAD,
      {} as CustomChatTransport,
      () => new Chat<UIMessage>({ id: THREAD, messages: uiMessages })
    )
}

const shownIds = () =>
  useChatSessions.getState().sessions[THREAD]?.chat.messages.map((m) => m.id)

describe('useThreadMessagesSync (AC-02)', () => {
  beforeEach(() => {
    bus.clear()
    resetThreadMessageSyncForTests()
    vi.clearAllMocks()
    useChatSessions.getState().clearSessions()
    useMessages.setState({ messages: {} })
    onDisk = [firstQuestion, firstAnswer]
    seedServiceHub({
      events: events as unknown as EventsService,
      messages: {
        fetchMessages,
        createMessage: vi.fn(async (m: ThreadMessage) => m),
        modifyMessage: vi.fn(async (m: ThreadMessage) => m),
        deleteMessage: vi.fn(async () => undefined),
      } as unknown as MessagesService,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reopening a thread whose Chat is in memory shows what another window wrote', async () => {
    openSession([firstQuestion, firstAnswer])
    onDisk = [
      firstQuestion,
      firstAnswer,
      otherWindowQuestion,
      otherWindowAnswer,
    ]

    renderHook(() => useThreadMessagesSync(THREAD))

    await waitFor(() => expect(shownIds()).toEqual(['u1', 'a1', 'u2', 'a2']))
    expect(
      useMessages
        .getState()
        .getMessages(THREAD)
        .map((m) => m.id)
    ).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('picks up a write another window announces while the thread is open', async () => {
    openSession([firstQuestion, firstAnswer])
    renderHook(() => useThreadMessagesSync(THREAD))
    await waitFor(() => expect(events.listen).toHaveBeenCalled())
    await waitFor(() => expect(bus.size).toBe(1))

    act(() =>
      writeFromOtherWindow([
        firstQuestion,
        firstAnswer,
        otherWindowQuestion,
        otherWindowAnswer,
      ])
    )

    await waitFor(() => expect(shownIds()).toEqual(['u1', 'a1', 'u2', 'a2']))
  })

  it('announces its own writes without reading them back', async () => {
    openSession([firstQuestion, firstAnswer])
    renderHook(() => useThreadMessagesSync(THREAD))
    await waitFor(() => expect(bus.size).toBe(1))
    fetchMessages.mockClear()

    act(() => {
      useMessages.getState().addMessage(otherWindowQuestion)
    })

    await waitFor(() =>
      expect(events.emit).toHaveBeenCalledWith(
        THREAD_MESSAGES_CHANGED_EVENT,
        expect.objectContaining({ threadId: THREAD })
      )
    )
    expect(fetchMessages).not.toHaveBeenCalled()
  })

  it('waits for a reply running here to finish before re-reading', async () => {
    vi.useFakeTimers()
    openSession([firstQuestion, firstAnswer])
    useChatSessions.getState().setRequestActive(THREAD, true)
    renderHook(() => useThreadMessagesSync(THREAD))
    await vi.advanceTimersByTimeAsync(0)

    onDisk = [firstQuestion, firstAnswer, otherWindowQuestion]
    act(() => writeFromOtherWindow(onDisk))
    await vi.advanceTimersByTimeAsync(THREAD_SYNC_RETRY_MS * 2)
    expect(fetchMessages).not.toHaveBeenCalled()
    expect(shownIds()).toEqual(['u1', 'a1'])

    useChatSessions.getState().setRequestActive(THREAD, false)
    await vi.advanceTimersByTimeAsync(THREAD_SYNC_RETRY_MS)

    expect(shownIds()).toEqual(['u1', 'a1', 'u2'])
  })

  it('keeps a message this window could not save, as the page load does', async () => {
    // A save that failed: held here, never written to disk.
    const unsaved = message('u-unsaved', 'user', 'not saved', 5)
    openSession([firstQuestion, firstAnswer, unsaved])
    onDisk = [firstQuestion, firstAnswer, otherWindowQuestion]

    await expect(reconcileThreadMessages(THREAD)).resolves.toBe('updated')

    expect(heldIds()).toEqual(['u1', 'a1', 'u2', 'u-unsaved'])
    expect(shownIds()).toEqual(['u1', 'a1', 'u2', 'u-unsaved'])
  })

  it('drops a reply another window regenerated, even while the page was closed', async () => {
    openSession([firstQuestion, firstAnswer])
    const page = renderHook(() => useThreadMessagesSync(THREAD))
    await waitFor(() => expect(bus.size).toBe(1))
    page.unmount()

    // The other window regenerates: deletes the old reply, saves a new one.
    const newAnswer = message('a1-new', 'assistant', 'second try', 6)
    act(() => writeFromOtherWindow([firstQuestion], ['a1']))
    act(() => writeFromOtherWindow([firstQuestion, newAnswer]))

    renderHook(() => useThreadMessagesSync(THREAD))

    await waitFor(() => expect(shownIds()).toEqual(['u1', 'a1-new']))
    expect(heldIds()).toEqual(['u1', 'a1-new'])
  })

  it('picks up an edit that keeps the message length', async () => {
    openSession([firstQuestion, firstAnswer])
    onDisk = [firstQuestion, message('a1', 'assistant', 'first ANSWER', 2)]

    await expect(reconcileThreadMessages(THREAD)).resolves.toBe('updated')

    expect(
      useMessages.getState().getMessages(THREAD)[1].content[0].text?.value
    ).toBe('first ANSWER')
  })

  it('compares an unchanged thread without serializing it', async () => {
    // An inline image the size QA threads carry. This window holds the
    // message with an `undefined` field and its keys in another order than
    // disk returns them (serde_json sorts keys and drops nothing it got).
    const image = `data:image/png;base64,${'A'.repeat(4_000_000)}`
    const onDiskImage = {
      ...message('u-img', 'user', 'look', 7),
      content: [
        { type: 'image_url', image_url: { detail: 'auto', url: image } },
      ],
    } as ThreadMessage
    const heldImage = Object.fromEntries(
      Object.entries({ ...onDiskImage, attachments: undefined }).reverse()
    ) as ThreadMessage
    openSession([firstQuestion, firstAnswer, heldImage])
    onDisk = [firstQuestion, firstAnswer, onDiskImage]
    const stringify = vi.spyOn(JSON, 'stringify')

    await expect(reconcileThreadMessages(THREAD)).resolves.toBe('unchanged')

    expect(stringify).not.toHaveBeenCalled()
    stringify.mockRestore()
  })
})
