import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { localStorageKey } from '@/constants/localStorage'
import {
  SUPPORT_MESSAGE_CACHE_LIMIT,
  SUPPORT_MESSAGE_MAX_LENGTH,
} from '@/constants/support'
import {
  createConversation,
  isSupportApiError,
  sendMessage,
  type SupportAuthor,
  type SupportWireMessage,
} from '@/services/support/client'
import {
  collectSupportMeta,
  hashSupportMeta,
} from '@/services/support/diagnostics'

/**
 * - `sent`: the relay has it;
 * - `pending`: on its way (or queued behind another one);
 * - `failed`: not delivered; Retry sends it again under the same client id.
 */
export type SupportMessageStatus = 'sent' | 'pending' | 'failed'

export type SupportSendError = 'rate_limited' | 'network' | 'server'

export type SupportChatMessage = {
  /** The relay's id once known; until then the client id. */
  id: string
  /** Set on messages written here; the relay deduplicates sends by it. */
  clientId?: string
  /** The relay's change sequence; absent until the relay has the message. */
  seq?: number
  author: SupportAuthor
  text: string
  createdAt: string
  editedAt?: string | null
  status: SupportMessageStatus
  error?: SupportSendError
}

type SupportChatData = {
  conversationId: string | null
  token: string | null
  messages: SupportChatMessage[]
  /** Highest `seq` received from the relay; the next poll asks for what is after it. */
  lastSeq: number
  /** Highest team `seq` reported read to the relay. */
  lastReadSeq: number
  /** Fingerprint of the diagnostics the relay last received. */
  metaHash: string | null
}

type SupportChatState = SupportChatData & {
  /** Whether the chat sheet is on screen. Not persisted. */
  sheetOpen: boolean
  setSheetOpen: (open: boolean) => void
  setConversation: (
    conversationId: string,
    token: string,
    metaHash: string
  ) => void
  /** Forgets the conversation (its token was refused); unsent messages stay. */
  resetConversation: () => void
  /**
   * Applies a poll's changes: upserts by id, drops deleted messages, adopts a
   * sent message the relay echoes back, and advances `lastSeq`. Returns the
   * team messages that were not here before.
   */
  applyServerMessages: (messages: SupportWireMessage[]) => SupportChatMessage[]
  addOutgoing: (text: string) => SupportChatMessage
  markPending: (clientId: string) => void
  markSent: (clientId: string, seq: number, createdAt: string) => void
  markFailed: (clientId: string, error: SupportSendError) => void
  setMetaHash: (hash: string) => void
  setLastReadSeq: (seq: number) => void
}

const initialData: SupportChatData = {
  conversationId: null,
  token: null,
  messages: [],
  lastSeq: 0,
  lastReadSeq: 0,
  metaHash: null,
}

const isConfirmed = (message: SupportChatMessage): boolean =>
  message.status === 'sent'

const timeOf = (message: SupportChatMessage): number => {
  const time = Date.parse(message.createdAt)
  return Number.isFinite(time) ? time : 0
}

/**
 * Delivered messages in the order they were written (an edit keeps its place,
 * though it comes back under a later `seq`), then the ones not delivered yet
 * in the order they were typed. Capped from the top.
 */
const arrange = (messages: SupportChatMessage[]): SupportChatMessage[] => {
  const confirmed = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => isConfirmed(message))
    .sort(
      (a, b) =>
        timeOf(a.message) - timeOf(b.message) ||
        (a.message.seq ?? 0) - (b.message.seq ?? 0) ||
        a.index - b.index
    )
    .map(({ message }) => message)
  const unconfirmed = messages.filter((message) => !isConfirmed(message))
  const room = Math.max(0, SUPPORT_MESSAGE_CACHE_LIMIT - unconfirmed.length)
  return [...(room > 0 ? confirmed.slice(-room) : []), ...unconfirmed]
}

const fromWire = (
  wire: SupportWireMessage,
  previous?: SupportChatMessage
): SupportChatMessage => ({
  id: wire.id,
  ...(previous?.clientId ? { clientId: previous.clientId } : {}),
  seq: wire.seq,
  author: wire.author,
  text: wire.text,
  createdAt: wire.created_at || previous?.createdAt || new Date().toISOString(),
  editedAt: wire.edited_at,
  status: 'sent',
})

const newClientId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    return crypto.randomUUID()
  // Fallback for runtimes without randomUUID: RFC 4122 v4 from Math.random.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export const useSupportChatStore = create<SupportChatState>()(
  persist(
    (set) => ({
      ...initialData,
      sheetOpen: false,

      setSheetOpen: (open) => set({ sheetOpen: open }),

      setConversation: (conversationId, token, metaHash) =>
        set({
          conversationId,
          token,
          metaHash,
          lastSeq: 0,
          lastReadSeq: 0,
        }),

      resetConversation: () =>
        set((state) => ({
          ...initialData,
          // What the old conversation said is gone with it; what was never
          // delivered goes to the next one.
          messages: state.messages.filter((m) => !isConfirmed(m)),
        })),

      applyServerMessages: (incoming) => {
        if (incoming.length === 0) return []
        const inserted: SupportChatMessage[] = []
        set((state) => {
          let messages = state.messages.slice()
          let lastSeq = state.lastSeq
          for (const wire of incoming) {
            lastSeq = Math.max(lastSeq, wire.seq)
            const at = messages.findIndex((m) => m.id === wire.id)
            if (wire.deleted) {
              if (at !== -1) messages.splice(at, 1)
              continue
            }
            if (at !== -1) {
              messages[at] = fromWire(wire, messages[at])
              continue
            }
            // Our own message echoed back before or after its send answered:
            // the send's answer carries the same `seq`.
            const own =
              wire.author === 'user'
                ? messages.findIndex(
                    (m) => m.clientId && m.seq === wire.seq && m.id !== wire.id
                  )
                : -1
            if (own !== -1) {
              messages[own] = fromWire(wire, messages[own])
              continue
            }
            const message = fromWire(wire)
            messages.push(message)
            if (message.author === 'team') inserted.push(message)
          }
          messages = arrange(messages)
          return { messages, lastSeq }
        })
        return inserted
      },

      addOutgoing: (text) => {
        const clientId = newClientId()
        const message: SupportChatMessage = {
          id: clientId,
          clientId,
          author: 'user',
          text,
          createdAt: new Date().toISOString(),
          status: 'pending',
        }
        set((state) => ({ messages: arrange([...state.messages, message]) }))
        return message
      },

      markPending: (clientId) =>
        set((state) => ({
          messages: state.messages.map((m) =>
            m.clientId === clientId && m.status !== 'sent'
              ? { ...m, status: 'pending', error: undefined }
              : m
          ),
        })),

      markSent: (clientId, seq, createdAt) =>
        set((state) => {
          const local = state.messages.find(
            (m) => m.clientId === clientId && m.status !== 'sent'
          )
          if (!local) return state
          // The poll already brought the relay's copy: keep that one.
          const echoed = state.messages.some(
            (m) => m !== local && m.author === 'user' && m.seq === seq
          )
          const messages = echoed
            ? state.messages.filter((m) => m !== local)
            : state.messages.map((m) =>
                m === local
                  ? {
                      ...m,
                      seq,
                      createdAt: createdAt || m.createdAt,
                      status: 'sent' as const,
                      error: undefined,
                    }
                  : m
              )
          return { messages: arrange(messages) }
        }),

      markFailed: (clientId, error) =>
        set((state) => ({
          messages: state.messages.map((m) =>
            m.clientId === clientId && m.status !== 'sent'
              ? { ...m, status: 'failed', error }
              : m
          ),
        })),

      setMetaHash: (hash) => set({ metaHash: hash }),

      setLastReadSeq: (seq) =>
        set((state) => ({ lastReadSeq: Math.max(state.lastReadSeq, seq) })),
    }),
    {
      name: localStorageKey.supportChat,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state): SupportChatData => ({
        conversationId: state.conversationId,
        token: state.token,
        messages: state.messages,
        lastSeq: state.lastSeq,
        lastReadSeq: state.lastReadSeq,
        metaHash: state.metaHash,
      }),
      // A send the last session did not see through is not known to have
      // arrived: offer Retry, which the relay deduplicates.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<SupportChatData>
        return {
          ...current,
          ...saved,
          messages: Array.isArray(saved.messages)
            ? saved.messages.map((m) =>
                m.status === 'pending'
                  ? {
                      ...m,
                      status: 'failed' as const,
                      error: 'network' as const,
                    }
                  : m
              )
            : current.messages,
        }
      },
    }
  )
)

/** The highest `seq` among the team's messages, or 0. */
export const selectMaxTeamSeq = (state: SupportChatData): number =>
  state.messages.reduce(
    (max, m) =>
      m.author === 'team' && m.seq !== undefined ? Math.max(max, m.seq) : max,
    0
  )

// Deliveries run one at a time, in the order they were asked for: the first
// creates the conversation the rest are sent to, and the team reads them in
// the order they were typed.
let deliveryQueue: Promise<void> = Promise.resolve()

export const SUPPORT_WRITE_TIMEOUT_MS = 30_000

/** Also settle if a transport fails to honour abort, releasing the send queue. */
async function withWriteDeadline<T>(
  write: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      write(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Support request timed out'))
          controller.abort()
        }, SUPPORT_WRITE_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const errorKind = (error: unknown): SupportSendError =>
  isSupportApiError(error, 'rate_limited')
    ? 'rate_limited'
    : isSupportApiError(error)
      ? 'server'
      : 'network'

const deliver = async (clientId: string, attempt = 0): Promise<void> => {
  const store = useSupportChatStore.getState()
  const message = store.messages.find(
    (m) => m.clientId === clientId && m.status !== 'sent'
  )
  if (!message) return

  try {
    const meta = await collectSupportMeta()
    const hash = hashSupportMeta(meta)
    let { token, metaHash } = useSupportChatStore.getState()
    if (!token) {
      const conversation = await withWriteDeadline((signal) =>
        createConversation(meta, { signal })
      )
      useSupportChatStore
        .getState()
        .setConversation(conversation.conversation_id, conversation.token, hash)
      token = conversation.token
      metaHash = hash
    }
    const withMeta = metaHash !== hash
    const result = await withWriteDeadline((signal) =>
      sendMessage(
        token,
        {
          client_id: clientId,
          text: message.text,
          ...(withMeta ? { meta } : {}),
        },
        { signal }
      )
    )
    const state = useSupportChatStore.getState()
    state.markSent(clientId, result.seq, result.created_at)
    if (withMeta) state.setMetaHash(hash)
  } catch (error) {
    if (isSupportApiError(error, 'unauthorized') && attempt === 0) {
      // The relay no longer knows this conversation: start a new one and
      // send this message there.
      useSupportChatStore.getState().resetConversation()
      return deliver(clientId, attempt + 1)
    }
    console.warn('[support] message not sent:', error)
    useSupportChatStore.getState().markFailed(clientId, errorKind(error))
  }
}

const enqueue = (clientId: string): Promise<void> => {
  const run = deliveryQueue.then(() => deliver(clientId))
  deliveryQueue = run.catch(() => undefined)
  return run
}

/**
 * Adds the message to the chat as pending and sends it. Resolves once it was
 * delivered or marked failed; never rejects.
 */
export function sendSupportMessage(text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > SUPPORT_MESSAGE_MAX_LENGTH)
    return Promise.resolve()
  const message = useSupportChatStore.getState().addOutgoing(trimmed)
  return enqueue(message.clientId!)
}

/** Sends a failed message again under the same client id. */
export function retrySupportMessage(clientId: string): Promise<void> {
  useSupportChatStore.getState().markPending(clientId)
  return enqueue(clientId)
}
