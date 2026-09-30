import { create } from 'zustand'

export type DeferredFirstSend = {
  id: string
  prompt: string
  downloadModelIds: string[]
  createdAt: number
}

type DeferredFirstSendState = {
  queued: DeferredFirstSend | null
  enqueue: (send: DeferredFirstSend) => void
  clear: (id?: string) => void
}

/**
 * The first message may wait several minutes for the first local model to
 * download. Keeping that promise in the route-owned composer loses it when
 * the user opens Models or Settings, so the root owns this one small queue.
 */
export const useDeferredFirstSend = create<DeferredFirstSendState>((set) => ({
  queued: null,
  enqueue: (queued) => set({ queued }),
  clear: (id) =>
    set((state) =>
      !id || state.queued?.id === id ? { queued: null } : state
    ),
}))
