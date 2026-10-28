import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  pollMessages: vi.fn(),
  markRead: vi.fn(),
}))
vi.mock('@/services/support/client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/support/client')>()
  return { ...actual, ...client }
})

vi.mock('@/services/support/diagnostics', () => ({
  collectSupportMeta: vi.fn(async () => ({})),
  hashSupportMeta: () => 'hash',
}))

const notifications = vi.hoisted(() => ({
  showDesktopNotification: vi.fn(async () => {}),
  desktopNotificationsEnabled: vi.fn(() => true),
  isWindowAway: vi.fn(() => false),
}))
vi.mock('@/lib/notifications', () => notifications)

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { SupportApiError } from '@/services/support/client'
import type {
  SupportPollResult,
  SupportWireMessage,
} from '@/services/support/client'
import { useSupportChatStore } from '@/stores/support-chat-store'
import {
  supportNotificationPreview,
  useSupportChatSync,
} from '../useSupportChatSync'

const teamMessage = (
  id: string,
  seq: number,
  text = `reply ${id}`
): SupportWireMessage => ({
  id,
  seq,
  author: 'team',
  text,
  created_at: '2026-10-26T10:00:00Z',
  edited_at: null,
  deleted: false,
})

/**
 * Polls answer from `answers` in turn; once they run out, a poll stays open
 * until the hook gives it up, as a long poll with nothing new does.
 */
const answers: Array<SupportPollResult | Error> = []
const signals: AbortSignal[] = []

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

describe('useSupportChatSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    answers.length = 0
    signals.length = 0
    client.pollMessages.mockReset()
    client.pollMessages.mockImplementation(
      (_token: string, _query: unknown, options: { signal: AbortSignal }) => {
        signals.push(options.signal)
        const next = answers.shift()
        if (next instanceof Error) return Promise.reject(next)
        if (next) return Promise.resolve(next)
        return new Promise(() => {})
      }
    )
    client.markRead.mockReset()
    client.markRead.mockResolvedValue(undefined)
    notifications.showDesktopNotification.mockClear()
    notifications.desktopNotificationsEnabled.mockReturnValue(true)
    notifications.isWindowAway.mockReturnValue(false)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    useSupportChatStore.setState({
      conversationId: 'c-1',
      token: 'tok',
      messages: [],
      lastSeq: 0,
      lastReadSeq: 0,
      metaHash: 'hash',
      sheetOpen: false,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('stays idle without a conversation', async () => {
    useSupportChatStore.setState({ conversationId: null, token: null })
    renderHook(() => useSupportChatSync())
    await advance(5000)

    expect(client.pollMessages).not.toHaveBeenCalled()
    expect(signals).toHaveLength(0)
  })

  it('notifies once per team reply while the chat is closed', async () => {
    answers.push(
      { status: 'open', messages: [teamMessage('a', 1, 'Hi, we are on it')] },
      // The same reply edited: not a new message.
      {
        status: 'open',
        messages: [{ ...teamMessage('a', 2, 'Hi, we are on it!') }],
      }
    )
    renderHook(() => useSupportChatSync())
    await flush()

    expect(client.pollMessages).toHaveBeenCalledWith(
      'tok',
      { after: 0, wait: 25 },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(notifications.showDesktopNotification).toHaveBeenCalledTimes(1)
    expect(notifications.showDesktopNotification).toHaveBeenCalledWith(
      'common:support.teamName',
      'Hi, we are on it'
    )
    expect(client.markRead).not.toHaveBeenCalled()
    expect(useSupportChatStore.getState().lastSeq).toBe(2)
    // The next poll asks for what is after the last change.
    expect(client.pollMessages).toHaveBeenLastCalledWith(
      'tok',
      { after: 2, wait: 25 },
      expect.anything()
    )
  })

  it('notifies when the chat is open but the window is away, and does not mark read', async () => {
    useSupportChatStore.setState({ sheetOpen: true })
    notifications.isWindowAway.mockReturnValue(true)
    answers.push({ status: 'open', messages: [teamMessage('a', 1)] })

    renderHook(() => useSupportChatSync())
    await flush()

    expect(notifications.showDesktopNotification).toHaveBeenCalledTimes(1)
    expect(client.markRead).not.toHaveBeenCalled()
    expect(useSupportChatStore.getState().lastReadSeq).toBe(0)
  })

  it('respects the notifications switch', async () => {
    notifications.desktopNotificationsEnabled.mockReturnValue(false)
    answers.push({ status: 'open', messages: [teamMessage('a', 1)] })

    renderHook(() => useSupportChatSync())
    await flush()

    expect(notifications.showDesktopNotification).not.toHaveBeenCalled()
    // The reply still lands in the chat.
    expect(useSupportChatStore.getState().messages.map((m) => m.id)).toEqual([
      'a',
    ])
  })

  it('marks replies read instead of notifying while the chat is watched', async () => {
    useSupportChatStore.setState({ sheetOpen: true })
    answers.push({ status: 'open', messages: [teamMessage('a', 3)] })

    renderHook(() => useSupportChatSync())
    await flush()

    expect(notifications.showDesktopNotification).not.toHaveBeenCalled()
    expect(client.markRead).toHaveBeenCalledWith('tok', 3)
    expect(useSupportChatStore.getState().lastReadSeq).toBe(3)
  })

  it('marks everything read when the chat opens', async () => {
    renderHook(() => useSupportChatSync())
    act(() => {
      useSupportChatStore.getState().applyServerMessages([teamMessage('a', 5)])
    })
    await flush()
    expect(client.markRead).not.toHaveBeenCalled()

    act(() => useSupportChatStore.getState().setSheetOpen(true))
    await flush()

    expect(client.markRead).toHaveBeenCalledTimes(1)
    expect(client.markRead).toHaveBeenCalledWith('tok', 5)
    expect(useSupportChatStore.getState().lastReadSeq).toBe(5)
  })

  it('backs off while the relay cannot be reached', async () => {
    answers.push(
      new TypeError('Failed to fetch'),
      new TypeError('Failed to fetch'),
      new TypeError('Failed to fetch')
    )
    renderHook(() => useSupportChatSync())
    await flush()
    expect(client.pollMessages).toHaveBeenCalledTimes(1)

    await advance(999)
    expect(client.pollMessages).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(client.pollMessages).toHaveBeenCalledTimes(2)

    await advance(1999)
    expect(client.pollMessages).toHaveBeenCalledTimes(2)
    await advance(1)
    expect(client.pollMessages).toHaveBeenCalledTimes(3)

    await advance(4000)
    expect(client.pollMessages).toHaveBeenCalledTimes(4)
    // Failures leave the conversation in place for the next attempt.
    expect(useSupportChatStore.getState().token).toBe('tok')
  })

  it('gives up a poll the relay holds past its wait', async () => {
    renderHook(() => useSupportChatSync())
    await flush()
    expect(client.pollMessages).toHaveBeenCalledTimes(1)

    await advance(35_000)
    expect(signals[0].aborted).toBe(true)
    await advance(1000)
    expect(client.pollMessages).toHaveBeenCalledTimes(2)
  })

  it('forgets the conversation when the relay refuses its token', async () => {
    useSupportChatStore.getState().applyServerMessages([teamMessage('a', 1)])
    answers.push(new SupportApiError(401, 'gone'))

    renderHook(() => useSupportChatSync())
    await flush()

    expect(useSupportChatStore.getState()).toMatchObject({
      conversationId: null,
      token: null,
      messages: [],
      lastSeq: 0,
    })
    await advance(120_000)
    expect(client.pollMessages).toHaveBeenCalledTimes(1)
  })

  it('stops polling on unmount', async () => {
    const { unmount } = renderHook(() => useSupportChatSync())
    await flush()
    expect(signals[0].aborted).toBe(false)

    unmount()
    await flush()

    expect(signals[0].aborted).toBe(true)
    await advance(120_000)
    expect(client.pollMessages).toHaveBeenCalledTimes(1)
  })
})

describe('supportNotificationPreview', () => {
  it('keeps a short reply as one line', () => {
    expect(supportNotificationPreview('Hello\n\nthere  ')).toBe('Hello there')
  })

  it('cuts a long reply to about 100 characters', () => {
    const preview = supportNotificationPreview('word '.repeat(60))
    expect(preview.length).toBeLessThanOrEqual(100)
    expect(preview.endsWith('…')).toBe(true)
  })
})
