import { create } from 'zustand'
import type { AgentThreadState } from '@/hooks/useAgentMode'

export type DeferredFirstSend = {
  id: string
  prompt: string
  downloadModelIds: string[]
  createdAt: number
  /**
   * New Chat's approval mode and workspace when Send was pressed. The thread
   * created later starts with exactly these, as a direct send would.
   */
  agentState?: AgentThreadState
}

type DeferredFirstSendState = {
  queued: DeferredFirstSend | null
  /**
   * The queued send New Chat's composer is completing itself, while it stays
   * mounted with it. The root stands down for it, or both would send the same
   * first message; leaving the route releases it to the root.
   */
  claimedId: string | null
  enqueue: (send: DeferredFirstSend) => void
  clear: (id?: string) => void
  claim: (id: string) => void
  release: (id: string) => void
}

/**
 * The first message may wait several minutes for the first local model to
 * download. Keeping that promise in the route-owned composer loses it when
 * the user opens Models or Settings, so the root owns this one small queue.
 */
export const useDeferredFirstSend = create<DeferredFirstSendState>((set) => ({
  queued: null,
  claimedId: null,
  enqueue: (queued) => set({ queued, claimedId: null }),
  clear: (id) =>
    set((state) =>
      !id || state.queued?.id === id ? { queued: null, claimedId: null } : state
    ),
  claim: (id) =>
    set((state) => (state.queued?.id === id ? { claimedId: id } : state)),
  release: (id) =>
    set((state) => (state.claimedId === id ? { claimedId: null } : state)),
}))
