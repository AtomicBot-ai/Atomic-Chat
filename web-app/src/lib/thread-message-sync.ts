/**
 * Tells the app's other windows which threads this window wrote (AC-02).
 *
 * Every window ("Open in new window" included) runs its own copy of the web
 * app — its own message store and its own AI SDK Chats — over the one set of
 * thread files on disk. A conversation continued in a second window was saved,
 * but the main window kept showing what it had loaded until a relaunch.
 *
 * So a window announces each thread it writes, once the write has landed on
 * disk, and a window showing that thread reads it back (see
 * `useThreadMessagesSync`). It also keeps count of its own writes still in
 * flight, so it never reads a thread back while it is still writing it, and
 * remembers which messages other windows deleted, so a re-read can tell a
 * message deleted elsewhere from one this window never managed to save.
 */
import { getServiceHub } from '@/hooks/useServiceHub'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'

/** Broadcast to every window through Tauri; a no-op where there is no Tauri. */
export const THREAD_MESSAGES_CHANGED_EVENT = 'atomic://thread-messages-changed'

export type ThreadMessagesChanged = {
  threadId: string
  /** Which window wrote; a window ignores what it announced itself. */
  origin: string
  /** Messages the write deleted. */
  deletedIds?: string[]
}

// Tauri delivers an event to the window that emitted it as well.
const windowOrigin = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2)}`

const pendingWrites = new Map<string, number>()
const deletedElsewhere = new Map<string, Set<string>>()
const subscribers = new Set<(threadId: string) => void>()
let listening: Promise<boolean> | undefined

/** True while a message write of this window to the thread has not landed. */
export function hasPendingThreadMessageWrites(threadId: string): boolean {
  return (pendingWrites.get(threadId) ?? 0) > 0
}

/** True when another window announced that it deleted this message. */
export function wasDeletedInAnotherWindow(
  threadId: string,
  messageId: string
): boolean {
  return deletedElsewhere.get(threadId)?.has(messageId) ?? false
}

function settleWrite(threadId: string): void {
  const left = (pendingWrites.get(threadId) ?? 1) - 1
  if (left > 0) pendingWrites.set(threadId, left)
  else pendingWrites.delete(threadId)
}

/** Tells the other windows that this thread's messages changed on disk. */
export function announceThreadMessagesChanged(
  threadId: string,
  deletedIds?: string[]
): void {
  if (threadId === TEMPORARY_CHAT_ID) return
  void Promise.resolve()
    .then(() =>
      getServiceHub()
        .events()
        .emit<ThreadMessagesChanged>(THREAD_MESSAGES_CHANGED_EVENT, {
          threadId,
          origin: windowOrigin,
          ...(deletedIds?.length ? { deletedIds } : {}),
        })
    )
    .catch((error) => {
      console.warn('Failed to tell other windows about a thread write:', error)
    })
}

/**
 * Counts `write` as in flight for the thread until it settles, and announces
 * the thread once it has succeeded (naming `deletedId` when the write was a
 * delete). Resolves and rejects as `write` does.
 */
export function trackThreadMessageWrite<T>(
  threadId: string,
  write: Promise<T> | T,
  { deletedId }: { deletedId?: string } = {}
): Promise<T> {
  pendingWrites.set(threadId, (pendingWrites.get(threadId) ?? 0) + 1)
  return Promise.resolve(write).then(
    (value) => {
      settleWrite(threadId)
      announceThreadMessagesChanged(
        threadId,
        deletedId ? [deletedId] : undefined
      )
      return value
    },
    (error) => {
      settleWrite(threadId)
      throw error
    }
  )
}

function receive(payload: ThreadMessagesChanged | undefined): void {
  if (!payload?.threadId || payload.origin === windowOrigin) return
  if (payload.deletedIds?.length) {
    const deleted = deletedElsewhere.get(payload.threadId) ?? new Set()
    payload.deletedIds.forEach((id) => deleted.add(id))
    deletedElsewhere.set(payload.threadId, deleted)
  }
  subscribers.forEach((onChange) => onChange(payload.threadId))
}

// One listener for the window's lifetime, started by the first thread page:
// deletions announced while no thread page is open must still be remembered,
// or reopening the thread would bring a deleted message back.
function ensureListening(): Promise<boolean> {
  listening ??= Promise.resolve()
    .then(() =>
      getServiceHub()
        .events()
        .listen<ThreadMessagesChanged>(THREAD_MESSAGES_CHANGED_EVENT, (event) =>
          receive(event.payload)
        )
    )
    .then(
      () => true,
      (error) => {
        console.warn(
          'Failed to listen for thread writes in other windows:',
          error
        )
        listening = undefined
        return false
      }
    )
  return listening
}

/**
 * Calls `onChange` with the id of each thread another window wrote. Resolves,
 * once the window listens, to the function that stops calling it.
 */
export async function listenForThreadMessageChanges(
  onChange: (threadId: string) => void
): Promise<() => void> {
  subscribers.add(onChange)
  await ensureListening()
  return () => {
    subscribers.delete(onChange)
  }
}

/** Forgets every write, deletion and listener; tests start from scratch. */
export function resetThreadMessageSyncForTests(): void {
  pendingWrites.clear()
  deletedElsewhere.clear()
  subscribers.clear()
  listening = undefined
}
