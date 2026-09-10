import { TEMPORARY_CHAT_ID } from '@/constants/chat'

/**
 * Key for per-composer state (voice session, workspace roots, approval mode)
 * before a real thread exists. The home composer keys on the shared temporary
 * id; a project composer gets its own `project:<id>` key so the two composers
 * (both mountable at once) never fight over one slot. Once the thread is
 * created, `transferThreadState(composerThreadKey, threadId)` moves the slot.
 */
export const composerThreadKey = (input: {
  isComposer: boolean
  currentThreadId?: string
  projectId?: string
}): string => {
  if (!input.isComposer) {
    return input.currentThreadId ?? TEMPORARY_CHAT_ID
  }
  return input.projectId ? `project:${input.projectId}` : TEMPORARY_CHAT_ID
}
