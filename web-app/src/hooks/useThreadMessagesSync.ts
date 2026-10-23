import { useEffect } from 'react'
import type { ThreadMessage } from '@janhq/core'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useMessages } from '@/hooks/useMessages'
import { isSessionBusy, useChatSessions } from '@/stores/chat-session-store'
import { useAgentRun } from '@/hooks/useAgentRun'
import { isAgentTurnActive } from '@/lib/tools/message-trace-parts'
import { convertThreadMessagesToUIMessages } from '@/lib/messages'
import {
  hasPendingThreadMessageWrites,
  listenForThreadMessageChanges,
  wasDeletedInAnotherWindow,
} from '@/lib/thread-message-sync'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'

/** How often a thread busy in this window is checked again before re-reading. */
export const THREAD_SYNC_RETRY_MS = 500

export type ThreadSyncResult =
  /** The thread was replaced with what is on disk. */
  | 'updated'
  /** What this window holds already matches the disk. */
  | 'unchanged'
  /** Busy here (a reply, tool calls, an agent run, a write): try later. */
  | 'deferred'
  /** A newer read of the same thread started; this one was dropped. */
  | 'superseded'
  /** Not a thread on disk, or it could not be read. */
  | 'skipped'

function isThreadIdle(threadId: string): boolean {
  const state = useChatSessions.getState()
  return (
    !isSessionBusy(state.sessions[threadId]) &&
    state.requestActive[threadId] !== true &&
    !isAgentTurnActive(useAgentRun.getState().getRun(threadId).status) &&
    !hasPendingThreadMessageWrites(threadId)
  )
}

// Equal as JSON: what comes back from disk has its keys in another order
// (serde_json sorts them) and none of the `undefined` fields this window held.
// Walks both values and stops at the first difference; nothing is serialized
// or copied, so an inline image costs one string comparison.
function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false
    }
    return a.every((item, index) => sameJsonValue(item, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined)
  const rightCount = Object.keys(right).filter(
    (key) => right[key] !== undefined
  ).length
  return (
    leftKeys.length === rightCount &&
    leftKeys.every((key) => sameJsonValue(left[key], right[key]))
  )
}

function sameMessages(
  a: readonly ThreadMessage[],
  b: readonly ThreadMessage[]
): boolean {
  if (a.length !== b.length) return false
  if (a.some((message, index) => message.id !== b[index]?.id)) return false
  // Newest first: a change from another window is nearly always at the end.
  for (let index = a.length - 1; index >= 0; index -= 1) {
    if (!sameJsonValue(a[index], b[index])) return false
  }
  return true
}

/**
 * What is on disk, plus the messages this window holds that never reached
 * it (a save that failed) — kept, in time order, the way the thread page's
 * own load keeps them. A message another window deleted is not kept.
 */
function withUnsavedMessages(
  threadId: string,
  onDisk: ThreadMessage[],
  held: readonly ThreadMessage[]
): ThreadMessage[] {
  const onDiskIds = new Set(onDisk.map((message) => message.id))
  const unsaved = held.filter(
    (message) =>
      !onDiskIds.has(message.id) &&
      !wasDeletedInAnotherWindow(threadId, message.id)
  )
  if (unsaved.length === 0) return onDisk
  return [...onDisk, ...unsaved].sort(
    (a, b) => (a.created_at || 0) - (b.created_at || 0)
  )
}

const latestRead = new Map<string, number>()

/**
 * Replaces this window's copy of a thread — the message store and the
 * thread's Chat — with what is on disk (plus its own unsaved messages), when
 * they differ. Never while the
 * thread is busy here: a reply streaming in, tool calls running, or this
 * window's own writes still landing.
 */
export async function reconcileThreadMessages(
  threadId: string
): Promise<ThreadSyncResult> {
  if (!threadId || threadId === TEMPORARY_CHAT_ID) return 'skipped'
  if (!isThreadIdle(threadId)) return 'deferred'

  const read = (latestRead.get(threadId) ?? 0) + 1
  latestRead.set(threadId, read)
  let onDisk: ThreadMessage[]
  try {
    onDisk = await getServiceHub().messages().fetchMessages(threadId)
  } catch (error) {
    console.warn('Failed to re-read a thread written elsewhere:', error)
    return 'skipped'
  }
  if (latestRead.get(threadId) !== read) return 'superseded'
  // Something started here while reading: what was read may be behind it.
  if (!isThreadIdle(threadId)) return 'deferred'
  // The messages service answers a failed read with an empty list, which
  // cannot be told apart from an empty thread; never blank a conversation
  // on what may be a read error.
  if (!onDisk?.length) return 'unchanged'

  const held = useMessages.getState().getMessages(threadId)
  const next = withUnsavedMessages(threadId, onDisk, held)
  if (sameMessages(next, held)) return 'unchanged'

  useMessages.getState().setMessages(threadId, next)
  const session = useChatSessions.getState().sessions[threadId]
  if (session) {
    session.chat.messages = convertThreadMessagesToUIMessages(next)
  }
  return 'updated'
}

/**
 * Keeps the thread a page shows the same as on disk while other windows write
 * it (AC-02): re-reads it when it is opened with its Chat already in memory
 * (the page's own load skips that case), and whenever another window
 * announces a write to it. A thread busy here is re-read once it is idle.
 */
export function useThreadMessagesSync(threadId: string | undefined): void {
  useEffect(() => {
    if (!threadId || threadId === TEMPORARY_CHAT_ID) return

    let disposed = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let stopListening: (() => void) | undefined

    const sync = () => {
      if (disposed) return
      if (retry !== undefined) {
        clearTimeout(retry)
        retry = undefined
      }
      void reconcileThreadMessages(threadId).then((result) => {
        if (result === 'deferred' && !disposed && retry === undefined) {
          retry = setTimeout(sync, THREAD_SYNC_RETRY_MS)
        }
      })
    }

    const session = useChatSessions.getState().sessions[threadId]
    if ((session?.chat.messages.length ?? 0) > 0) sync()

    void listenForThreadMessageChanges((changedThreadId) => {
      if (changedThreadId === threadId) sync()
    }).then((stop) => {
      if (disposed) stop()
      else stopListening = stop
    })

    return () => {
      disposed = true
      if (retry !== undefined) clearTimeout(retry)
      stopListening?.()
    }
  }, [threadId])
}
