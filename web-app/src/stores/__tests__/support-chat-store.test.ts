import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  createConversation: vi.fn(),
  sendMessage: vi.fn(),
}))
vi.mock('@/services/support/client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/support/client')>()
  return { ...actual, ...client }
})

const diagnostics = vi.hoisted(() => ({
  meta: { app_version: '2.2.26', locale: 'en' } as Record<string, unknown>,
}))
vi.mock('@/services/support/diagnostics', () => ({
  collectSupportMeta: vi.fn(async () => ({ ...diagnostics.meta })),
  hashSupportMeta: (meta: unknown) => JSON.stringify(meta),
}))

import { SupportApiError } from '@/services/support/client'
import type { SupportWireMessage } from '@/services/support/client'
import { localStorageKey } from '@/constants/localStorage'
import { SUPPORT_MESSAGE_CACHE_LIMIT } from '@/constants/support'
import {
  SUPPORT_WRITE_TIMEOUT_MS,
  retrySupportMessage,
  selectMaxTeamSeq,
  sendSupportMessage,
  useSupportChatStore,
} from '../support-chat-store'

const wire = (
  overrides: Partial<SupportWireMessage> &
    Pick<SupportWireMessage, 'id' | 'seq'>
): SupportWireMessage => ({
  author: 'team',
  text: `message ${overrides.id}`,
  created_at: `2026-10-26T10:00:${String(overrides.seq).padStart(2, '0')}Z`,
  edited_at: null,
  deleted: false,
  ...overrides,
})

const store = () => useSupportChatStore.getState()

const reset = () =>
  useSupportChatStore.setState({
    conversationId: null,
    token: null,
    messages: [],
    lastSeq: 0,
    lastReadSeq: 0,
    metaHash: null,
    sheetOpen: false,
  })

describe('support chat store', () => {
  afterEach(() => vi.useRealTimers())
  beforeEach(() => {
    reset()
    client.createConversation.mockReset()
    client.sendMessage.mockReset()
    diagnostics.meta = { app_version: '2.2.26', locale: 'en' }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  describe('applyServerMessages', () => {
    it('upserts by id, keeps an edit in place and tracks the highest seq', () => {
      const fresh = store().applyServerMessages([
        wire({ id: 'a', seq: 1 }),
        wire({ id: 'b', seq: 2 }),
      ])
      expect(fresh.map((m) => m.id)).toEqual(['a', 'b'])

      const again = store().applyServerMessages([
        wire({
          id: 'a',
          seq: 3,
          text: 'edited',
          created_at: '2026-10-26T10:00:01Z',
          edited_at: '2026-10-26T10:05:00Z',
        }),
      ])

      expect(again).toEqual([])
      expect(store().messages.map((m) => [m.id, m.text])).toEqual([
        ['a', 'edited'],
        ['b', 'message b'],
      ])
      expect(store().lastSeq).toBe(3)
      expect(selectMaxTeamSeq(store())).toBe(3)
    })

    it('drops deleted messages but still advances lastSeq', () => {
      store().applyServerMessages([
        wire({ id: 'a', seq: 1 }),
        wire({ id: 'b', seq: 2 }),
      ])
      store().applyServerMessages([wire({ id: 'a', seq: 4, deleted: true })])

      expect(store().messages.map((m) => m.id)).toEqual(['b'])
      expect(store().lastSeq).toBe(4)

      // A deletion of a message never seen does not add it.
      const fresh = store().applyServerMessages([
        wire({ id: 'z', seq: 5, deleted: true }),
      ])
      expect(fresh).toEqual([])
      expect(store().messages.map((m) => m.id)).toEqual(['b'])
      expect(store().lastSeq).toBe(5)
    })

    it('adopts the echo of a sent message, whichever arrives first', () => {
      const first = store().addOutgoing('one')
      store().markSent(first.clientId!, 10, '2026-10-26T10:00:10Z')
      store().applyServerMessages([
        wire({ id: 's-10', seq: 10, author: 'user', text: 'one' }),
      ])

      const second = store().addOutgoing('two')
      store().applyServerMessages([
        wire({ id: 's-11', seq: 11, author: 'user', text: 'two' }),
      ])
      store().markSent(second.clientId!, 11, '2026-10-26T10:00:11Z')

      expect(store().messages.map((m) => [m.id, m.text, m.status])).toEqual([
        ['s-10', 'one', 'sent'],
        ['s-11', 'two', 'sent'],
      ])
      expect(store().messages[0].clientId).toBe(first.clientId)
    })

    it('keeps at most the cache limit, newest last', () => {
      store().applyServerMessages(
        Array.from({ length: SUPPORT_MESSAGE_CACHE_LIMIT + 5 }, (_, i) =>
          wire({
            id: `m${i}`,
            seq: i + 1,
            created_at: new Date(Date.UTC(2026, 9, 26, 10, 0, i)).toISOString(),
          })
        )
      )

      const ids = store().messages.map((m) => m.id)
      expect(ids).toHaveLength(SUPPORT_MESSAGE_CACHE_LIMIT)
      expect(ids[0]).toBe('m5')
      expect(ids.at(-1)).toBe(`m${SUPPORT_MESSAGE_CACHE_LIMIT + 4}`)
    })
  })

  describe('sending', () => {
    it.each(['creation', 'send'] as const)(
      'expires a blackholed %s, aborts it and releases the next message',
      async (stage) => {
        vi.useFakeTimers()
        client.createConversation.mockResolvedValue({
          conversation_id: 'fresh',
          token: 'tok',
        })
        client.sendMessage.mockResolvedValue({
          seq: 2,
          created_at: '2026-10-28T12:00:00Z',
        })
        const stalled =
          stage === 'creation' ? client.createConversation : client.sendMessage
        let release!: (value: unknown) => void
        stalled.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = resolve
            })
        )
        const first = sendSupportMessage('one')
        const second = sendSupportMessage('two')
        await vi.advanceTimersByTimeAsync(SUPPORT_WRITE_TIMEOUT_MS + 1)
        await Promise.all([first, second])
        expect(store().messages.map((m) => m.status)).toEqual([
          'sent',
          'failed',
        ])
        const failed = store().messages.find((m) => m.text === 'one')!
        expect(failed.error).toBe('network')
        const signal =
          stalled.mock.calls[0][stage === 'creation' ? 1 : 2].signal
        expect(signal.aborted).toBe(true)
        // A late response must not overwrite the conversation or acknowledge a timed-out send.
        release(
          stage === 'creation'
            ? { conversation_id: 'stale', token: 'stale' }
            : { seq: 1, created_at: '' }
        )
        await vi.advanceTimersByTimeAsync(1)
        expect(store().conversationId).toBe('fresh')
        expect(store().messages.find((m) => m.text === 'one')?.status).toBe(
          'failed'
        )
        client.sendMessage.mockResolvedValue({
          seq: 1,
          created_at: '2026-10-28T11:59:59Z',
        })
        await retrySupportMessage(failed.clientId!)
        expect(client.sendMessage.mock.calls.at(-1)?.[1].client_id).toBe(
          failed.clientId
        )
        expect(store().messages.map((m) => m.status)).toEqual(['sent', 'sent'])
      }
    )

    it('reconciles a late server echo with a retry under the same client id', async () => {
      vi.useFakeTimers()
      client.createConversation.mockResolvedValue({
        conversation_id: 'c',
        token: 'tok',
      })
      client.sendMessage.mockImplementationOnce(() => new Promise(() => {}))
      const sending = sendSupportMessage('delayed')
      await vi.advanceTimersByTimeAsync(SUPPORT_WRITE_TIMEOUT_MS + 1)
      await sending
      const clientId = store().messages[0].clientId!
      store().applyServerMessages([
        wire({ id: 'server-copy', seq: 7, author: 'user', text: 'delayed' }),
      ])
      client.sendMessage.mockResolvedValue({ seq: 7, created_at: '' })
      await retrySupportMessage(clientId)
      expect(store().messages).toHaveLength(1)
      expect(store().messages[0]).toMatchObject({
        id: 'server-copy',
        status: 'sent',
      })
    })

    it('creates the conversation on the first send with the diagnostics', async () => {
      client.createConversation.mockResolvedValue({
        conversation_id: 'c-1',
        token: 'tok',
      })
      client.sendMessage.mockResolvedValue({
        seq: 1,
        created_at: '2026-10-26T10:00:00Z',
      })

      const sending = sendSupportMessage('  Hello there  ')
      expect(store().messages).toMatchObject([
        { author: 'user', text: 'Hello there', status: 'pending' },
      ])
      await sending

      expect(client.createConversation).toHaveBeenCalledWith(diagnostics.meta, {
        signal: expect.any(AbortSignal),
      })
      const [token, body] = client.sendMessage.mock.calls[0]
      expect(token).toBe('tok')
      // The conversation already carries the diagnostics.
      expect(body).toEqual({
        client_id: store().messages[0].clientId,
        text: 'Hello there',
      })
      expect(store()).toMatchObject({ conversationId: 'c-1', token: 'tok' })
      expect(store().messages[0]).toMatchObject({ status: 'sent', seq: 1 })
    })

    it('attaches the diagnostics again only when they changed', async () => {
      useSupportChatStore.setState({
        conversationId: 'c-1',
        token: 'tok',
        metaHash: JSON.stringify(diagnostics.meta),
      })
      client.sendMessage.mockResolvedValue({ seq: 1, created_at: '' })

      await sendSupportMessage('same machine')
      expect(client.sendMessage.mock.calls[0][1].meta).toBeUndefined()

      diagnostics.meta = { ...diagnostics.meta, model: 'qwen3-4b' }
      client.sendMessage.mockResolvedValue({ seq: 2, created_at: '' })
      await sendSupportMessage('new model')

      expect(client.sendMessage.mock.calls[1][1].meta).toEqual(diagnostics.meta)
      expect(store().metaHash).toBe(JSON.stringify(diagnostics.meta))
      expect(client.createConversation).not.toHaveBeenCalled()
    })

    it('marks a rate-limited message failed and retries it under the same client id', async () => {
      useSupportChatStore.setState({
        conversationId: 'c-1',
        token: 'tok',
        metaHash: JSON.stringify(diagnostics.meta),
      })
      client.sendMessage.mockRejectedValueOnce(new SupportApiError(429, 'slow'))

      await sendSupportMessage('Hi')
      const failed = store().messages[0]
      expect(failed).toMatchObject({ status: 'failed', error: 'rate_limited' })

      client.sendMessage.mockResolvedValueOnce({ seq: 4, created_at: '' })
      await retrySupportMessage(failed.clientId!)

      expect(client.sendMessage).toHaveBeenCalledTimes(2)
      expect(client.sendMessage.mock.calls[1][1].client_id).toBe(
        failed.clientId
      )
      expect(store().messages).toMatchObject([{ status: 'sent', seq: 4 }])
    })

    it('marks a message failed when the relay cannot be reached', async () => {
      client.createConversation.mockRejectedValue(
        new TypeError('Failed to fetch')
      )

      await sendSupportMessage('Hi')

      expect(store().messages).toMatchObject([
        { status: 'failed', error: 'network' },
      ])
      expect(store().token).toBeNull()
    })

    it('starts a new conversation when the token is refused', async () => {
      useSupportChatStore.setState({
        conversationId: 'old',
        token: 'stale',
        metaHash: 'x',
        lastSeq: 40,
      })
      store().applyServerMessages([wire({ id: 'old-1', seq: 41 })])
      client.sendMessage
        .mockRejectedValueOnce(new SupportApiError(401, 'gone'))
        .mockResolvedValueOnce({ seq: 1, created_at: '' })
      client.createConversation.mockResolvedValue({
        conversation_id: 'new',
        token: 'fresh',
      })

      await sendSupportMessage('Still there?')

      expect(client.sendMessage.mock.calls.map((call) => call[0])).toEqual([
        'stale',
        'fresh',
      ])
      expect(store()).toMatchObject({
        conversationId: 'new',
        token: 'fresh',
        lastSeq: 0,
      })
      expect(store().messages.map((m) => [m.text, m.status])).toEqual([
        ['Still there?', 'sent'],
      ])
    })

    it('ignores an empty message', async () => {
      await sendSupportMessage('   ')
      expect(store().messages).toEqual([])
      expect(client.createConversation).not.toHaveBeenCalled()
    })
  })

  it('offers Retry for a send the last session did not finish', async () => {
    localStorage.setItem(
      localStorageKey.supportChat,
      JSON.stringify({
        version: 1,
        state: {
          conversationId: 'c-1',
          token: 'tok',
          messages: [
            {
              id: 'cid',
              clientId: 'cid',
              author: 'user',
              text: 'lost?',
              createdAt: '2026-10-26T10:00:00Z',
              status: 'pending',
            },
          ],
          lastSeq: 3,
          lastReadSeq: 2,
          metaHash: 'h',
        },
      })
    )

    await useSupportChatStore.persist.rehydrate()

    expect(store()).toMatchObject({
      token: 'tok',
      lastSeq: 3,
      sheetOpen: false,
    })
    expect(store().messages).toMatchObject([
      { clientId: 'cid', status: 'failed', error: 'network' },
    ])
    localStorage.removeItem(localStorageKey.supportChat)
  })
})
