import { create } from 'zustand'
import { getServiceHub } from '@/hooks/useServiceHub'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import {
  UNSUPPORTED_CHAT_EXEC_STATUS,
  type ChatExecStatus,
} from '@/services/chat-exec/types'

type ChatExecStatusState = {
  /** `null` until the first answer from the backend. */
  status: ChatExecStatus | null
}

/**
 * What chat can run on this machine and whether it is sandboxed. The backend
 * probes once per session (on Windows that starts a test container), so the
 * answer is fetched early and kept; the transport reads it to build the
 * `run_command` / `run_script` descriptions, the approval dialog to say
 * where a call will run.
 */
export const useChatExecStatus = create<ChatExecStatusState>()(() => ({
  status: null,
}))

let inFlight: Promise<ChatExecStatus> | null = null

/** The kept status, fetching it the first time. */
export function ensureChatExecStatus(): Promise<ChatExecStatus> {
  const current = useChatExecStatus.getState().status
  if (current) return Promise.resolve(current)
  return refreshChatExecStatus()
}

/**
 * Ask again — after a run, since a sandbox that failed to start is dropped
 * for the rest of the session and the next approval must say so.
 */
export function refreshChatExecStatus(): Promise<ChatExecStatus> {
  if (!PlatformFeatures[PlatformFeature.CHAT_EXEC]) {
    useChatExecStatus.setState({ status: UNSUPPORTED_CHAT_EXEC_STATUS })
    return Promise.resolve(UNSUPPORTED_CHAT_EXEC_STATUS)
  }
  if (!inFlight) {
    const request = fetchStatus()
    inFlight = request
    void request.finally(() => {
      if (inFlight === request) inFlight = null
    })
  }
  return inFlight
}

async function fetchStatus(): Promise<ChatExecStatus> {
  try {
    const status = await getServiceHub().chatExec().status()
    useChatExecStatus.setState({ status })
    return status
  } catch (error) {
    console.warn('Could not read what chat can run:', error)
    useChatExecStatus.setState({ status: UNSUPPORTED_CHAT_EXEC_STATUS })
    return UNSUPPORTED_CHAT_EXEC_STATUS
  }
}
